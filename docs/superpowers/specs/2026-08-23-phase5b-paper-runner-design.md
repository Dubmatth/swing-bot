# Phase 5b — Runner de trading papier

Statut : approuvé (décisions actées en conversation le 2026-08-23).

## Objectif et critère de sortie

Brancher une boucle de décision réelle sur le pipeline de données live
construit en Phase 5a : recevoir les bougies closes des 20 paires de
l'univers en continu, appeler `Strategy.decide()` (même contrat qu'en
backtest), simuler des fills papier immédiats, tenir un portefeuille qui
survit à un redémarrage. Aucun ordre réel n'est jamais envoyé à Kraken —
décision actée avant la scission de ce chantier en Phase 5a/5b, non
renégociable dans cette phase.

Critère de sortie : le runner tourne en continu, reçoit des bougies live
pour les 20 paires, produit des décisions et des fills papier cohérents
avec la logique déjà validée du backtest (mêmes fonctions d'exécution et de
sizing, pas de logique dupliquée ni divergente), persiste son état après
chaque fill, et reprend cet état correctement après un redémarrage —
démontré par des tests déterministes sur des séquences de bougies
synthétiques, sans jamais dépendre d'un vrai serveur Kraken.

Hors périmètre (reporté) :
- Tout ordre réel envoyé à Kraken — trading papier uniquement.
- Rattrapage de bougies manquées pendant une coupure WebSocket prolongée,
  au-delà de ce que l'amorçage REST du redémarrage couvre naturellement.
- Alertes, monitoring, notifications.
- Remplacement du candidat de stratégie provisoire (`mean-reversion`,
  `period=70-80, entryK=4`) par une stratégie validée — le runner est
  conçu pour accepter n'importe quelle `Strategy` sans changement
  d'architecture, mais trouver une meilleure stratégie reste un chantier
  séparé (voir README, section « Recherche de stratégie »).
- Gestion des clés API, sécurité opérationnelle, suivi fiscal — hors
  périmètre tant qu'aucun ordre réel n'est envisagé.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Portée multi-paires | Les 20 paires de l'univers dès cette phase, une instance `LiveBarSource`/`liveSeriesBuilder` par paire, orchestrées par le runner | Le candidat de stratégie provisoire n'a été validé par walk-forward que sur les 20 paires combinées ; le tester sur un sous-ensemble ne prouverait rien de comparable |
| Amorçage (warmup) | Récupérer les dernières bougies via l'API REST Kraken (`/0/public/OHLC`) au démarrage, avant de brancher le WebSocket | Le dump historique déjà téléchargé (`data/kraken-ohlcvt/`) s'arrête ~8 mois avant aujourd'hui — l'utiliser créerait une discontinuité qui fausserait les indicateurs au démarrage. `/0/public/OHLC` a toujours été documenté dans ce projet comme le mécanisme d'amorçage temps réel (voir `krakenCsv.ts`) |
| Mapping des symboles (WS / REST / interne) | Résolu dynamiquement au démarrage via `/0/public/AssetPairs`, jamais codé en dur dans `universe.ts` | Évite une troisième convention de nommage ad hoc (dette signalée en fin de Phase 5a) ; `/0/public/AssetPairs` donne à la fois le nom WS (`wsname`) et la clé REST pour chaque paire, et sert aussi de garde-fou anti-délistage déjà prévu par `validateUniverse` |
| Réutilisation de la logique de sizing/exécution | Extraction d'une fonction pure `sizeBuyOrder` depuis `runner.ts` (actuellement inline), utilisée par le backtest **et** le runner papier | Le commentaire déjà présent dans `runner.ts` annonce cette réutilisation ; dupliquer le calcul à la main créerait un risque de dérive entre backtest et live, exactement ce que le projet évite partout ailleurs |
| Persistance | Fichiers locaux : snapshot JSON du portefeuille + journal de trades JSONL append-only, sous `data/live-state/` (déjà ignoré par git) | Cohérent avec l'absence de dépendance runtime du projet ; pas besoin d'une base de données pour un usage mono-processus |
| Persistance : granularité | Snapshot réécrit après chaque fill ; le journal ne reçoit qu'un ajout, jamais de réécriture | Ne perdre au pire que l'événement en cours si le processus s'arrête brutalement |

## Architecture

### 1. Mapping des paires (`src/live/krakenAssetPairs.ts`, nouveau)

```ts
export interface KrakenPairMapping {
  readonly symbol: string;    // format interne, universe.ts (ex. 'XBTEUR')
  readonly wsSymbol: string;  // format WS v2 (ex. 'BTC/EUR'), issu de wsname
  readonly restSymbol: string; // clé Kraken REST pour /0/public/OHLC
}

/** Logique pure : mappe la réponse JSON déjà parsée sur l'univers fourni. */
export function parseAssetPairsResponse(
  universe: readonly PairSpec[],
  rawResult: Record<string, unknown>,
): readonly KrakenPairMapping[]

/** Câblage réseau — non testé automatiquement, comme krakenOhlcSource.ts. */
export async function fetchKrakenPairMappings(
  universe: readonly PairSpec[],
  restUrl?: string, // défaut https://api.kraken.com/0/public/AssetPairs
): Promise<readonly KrakenPairMapping[]>
```

- `parseAssetPairsResponse` cherche, pour chaque `PairSpec` de l'univers, l'entrée de `rawResult` correspondant à `symbol`, et en extrait `wsname` (→ `wsSymbol`) et la clé de l'entrée elle-même (→ `restSymbol`).
- Une paire de l'univers absente de la réponse lève — c'est un délistage, la même erreur que `validateUniverse` (`src/config/universe.ts`) détecte déjà pour un autre usage ; ce module ne remplace pas `validateUniverse`, il en réutilise le principe pour un besoin différent (mapping, pas juste présence/absence).
- Une entrée trouvée mais sans `wsname` de la forme attendue (contient `/`) lève.

**Point à vérifier en implémentation (pas supposé ici)** : cette description
suppose que la réponse `/0/public/AssetPairs` expose un champ permettant de
retrouver, pour chaque clé d'entrée, une correspondance directe avec le
`symbol` legacy de `universe.ts` (typiquement via un champ `altname`), et un
champ `wsname` au format `BASE/QUOTE`. La tâche d'implémentation doit
vérifier la forme exacte de cette réponse contre la documentation Kraken
actuelle (ou un appel réel) avant d'écrire `parseAssetPairsResponse` —
exactement la même prudence que la Phase 5a avait déjà appliquée au mapping
`wsSymbol`/`symbol` de `krakenOhlcSource.ts`, jamais résolue depuis.

### 2. Amorçage REST (`src/live/krakenRestSeed.ts`, nouveau)

```ts
export interface KrakenRestSeedConfig {
  readonly restSymbol: string;
  readonly symbol: string; // pour les erreurs et le champ ClosedBar.symbol
  readonly interval: Interval;
  readonly count: number; // nombre de bougies conservées (<= 720)
  readonly restUrl?: string; // défaut https://api.kraken.com/0/public/OHLC
}

/** Logique pure : mappe les lignes brutes déjà parsées en ClosedBar[]. */
export function parseRestOhlcResponse(
  symbol: string,
  rawRows: readonly unknown[],
): readonly ClosedBar[]

/** Câblage réseau — non testé automatiquement. */
export async function fetchSeedBars(config: KrakenRestSeedConfig): Promise<readonly ClosedBar[]>
```

- Chaque ligne brute Kraken est `[time, open, high, low, close, vwap, volume, count]` — `parseRestOhlcResponse` valide chaque champ numérique (`Number.isFinite`), la cohérence OHLC (même garde-fou que `krakenCsv.ts`/`krakenOhlcSource.ts`), et lève sur toute ligne invalide plutôt que de produire un amorçage silencieusement faux.
- `fetchSeedBars` ne garde que les `count` dernières bougies renvoyées (Kraken peut en renvoyer jusqu'à 720, la stratégie n'a besoin que de son `warmup`).
- Bougies renvoyées triées par `time` croissant (propriété de l'API Kraken) — pas de tri supplémentaire, mais `liveSeriesBuilder.append()` (Phase 5a, inchangé) revalidera via `freezeSeries` de toute façon.

### 3. Extraction du sizing partagé (`src/backtest/runner.ts`, modifié)

```ts
export interface SizeBuyOrderInput {
  readonly cash: number;
  readonly equity: number;
  readonly maxConcurrentPositions: number;
  readonly riskPerTradePct: number;
  readonly referencePrice: number;
  readonly stopDistance?: number;
}

/** Budget alloué à un achat, 0 si aucun (à l'appelant de rejeter si budget <= 0). */
export function sizeBuyOrder(input: SizeBuyOrderInput): number
```

- Extrait tel quel le calcul actuellement inline dans la branche `order-requested`/`buy` de `runBacktest` (`budget = Math.min(cash, equity/maxConcurrentPositions)`, puis resserré par le budget de risque si `stopDistance` est fourni).
- `runBacktest` appelle désormais `sizeBuyOrder` au lieu de son calcul inline — comportement inchangé, tests existants de `runner.test.ts` inchangés (garantit la non-régression).
- `paperRunner.ts` appelle la même fonction — garantit que le sizing papier ne peut jamais diverger du sizing backtest sans que les deux soient modifiés ensemble.

### 4. Persistance (`src/live/statePersistence.ts`, nouveau)

```ts
export interface PersistedPortfolio {
  readonly cash: number;
  readonly positions: readonly Position[];
}

/** Logique pure de (dé)sérialisation — testable sans I/O. */
export function serializePortfolio(p: Portfolio): PersistedPortfolio
export function deserializePortfolio(data: PersistedPortfolio): Portfolio

/** I/O réel sur disque local — testable avec un répertoire temporaire
 * (déterministe, contrairement au réseau : pas de raison de le laisser
 * non testé). */
export async function savePortfolioSnapshot(path: string, p: Portfolio): Promise<void>
/** undefined si le fichier n'existe pas encore (premier démarrage). */
export async function loadPortfolioSnapshot(path: string): Promise<Portfolio | undefined>
export async function appendTradeLog(path: string, trade: Trade): Promise<void>
```

- `savePortfolioSnapshot` écrit intégralement (pas d'append) — le fichier représente toujours l'état courant complet.
- `appendTradeLog` n'ajoute qu'une ligne JSON par appel (`fs.appendFile`), jamais de réécriture — un trade déjà journalisé ne peut pas être perdu par une écriture suivante corrompue.
- `loadPortfolioSnapshot` sur fichier absent renvoie `undefined` (pas une erreur) : c'est le signal normal d'un premier démarrage, distinct d'un fichier présent mais corrompu (qui doit lever).

### 5. Boucle de décision (`src/live/paperRunner.ts`, nouveau)

```ts
export interface PaperRunnerOptions {
  readonly maxConcurrentPositions: number;
  readonly riskPerTradePct: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface PaperRunnerConfig {
  readonly strategy: Strategy;
  readonly sources: ReadonlyMap<string, LiveBarSource>;
  /** Déjà amorcés (voir krakenRestSeed) avant l'appel à start(). */
  readonly builders: ReadonlyMap<string, LiveSeriesBuilder>;
  readonly portfolio: Portfolio; // repris de statePersistence ou neuf
  readonly options: PaperRunnerOptions;
  /** Appelé après chaque fill appliqué — le point d'accroche de la persistance. */
  readonly onFill?: (trade: Trade, portfolio: Portfolio) => void;
}

export interface PaperRunner {
  start(): void;
  stop(): void;
}

export function createPaperRunner(config: PaperRunnerConfig): PaperRunner
```

- `start()` appelle `source.start(bar => onClosedBar(symbol, bar))` pour chaque paire.
- `onClosedBar(symbol, bar)` :
  1. `builders.get(symbol).append(bar)`.
  2. Reconstruit `views: Map<string, BarView>` à partir de `builders` — pour chaque symbole dont le builder a au moins une bougie (`try { builder.current() } catch { skip }` : un builder vide, seed manquée ou pas encore reçue, est ignoré sans planter, pas une exception réseau mais le même principe de tolérance).
  3. Si `views.size === 0`, rien à décider, on s'arrête là pour cet appel.
  4. `ctx = { views, positions: portfolio.positions, now: bar.time }`, puis `strategy.decide(ctx)`.
  5. Pour chaque `Intent` non-`hold`, résout le prix de référence (dernière clôture connue de `intent.symbol`, via son builder) et applique le fill immédiatement — `sizeBuyOrder` (achat) ou quantité de la position ouverte (vente), puis `simulateBuy`/`simulateSell` (`execution.ts`) et `applyBuyFill`/`applySellFill` (`portfolio.ts`), **inchangés**, exactement comme le backtest. Une contrainte violée (plafond de positions, pas de position à vendre, budget insuffisant) est simplement ignorée (équivalent papier d'un rejet — pas de log d'erreur, un « rejet » n'est pas une anomalie en live, juste une décision non exécutable ce tour-ci).
  6. Après un fill appliqué, appelle `config.onFill?.(trade, portfolio)`.
- `stop()` appelle `source.stop()` pour chaque paire.
- Différence assumée avec `runBacktest` (déjà actée) : le fill utilise le prix de la bougie qui vient de clôturer, immédiatement — pas d'attente de la bougie suivante (la contrainte anti-look-ahead du backtest n'a pas de sens sur un flux déjà temps réel).
- Testable entièrement sans réseau : les `sources` de test sont des `LiveBarSource` synthétiques (comme en Phase 5a), rejouant des séquences de `ClosedBar` construites à la main.

### 6. Point d'entrée (`scripts/run-paper.ts`, nouveau)

Assemble tout : `fetchKrakenPairMappings` → pour chaque paire, `fetchSeedBars` + `createLiveSeriesBuilder` amorcé + `createKrakenOhlcSource` (Phase 5a, inchangé) → `loadPortfolioSnapshot` (ou portefeuille neuf) → `createPaperRunner` avec la stratégie `mean-reversion` par défaut (`period=80, entryK=4`, candidat provisoire) → `onFill` branché sur `savePortfolioSnapshot` + `appendTradeLog` → `start()`. Gère `SIGINT`/`SIGTERM` pour appeler `stop()` proprement. Non testé automatiquement (assemblage + I/O réel), comme `scripts/convert-trades.ts`.

## Fichiers touchés

```
src/live/krakenAssetPairs.ts   (nouveau)
src/live/krakenRestSeed.ts     (nouveau)
src/live/statePersistence.ts   (nouveau)
src/live/paperRunner.ts        (nouveau)
src/backtest/runner.ts         (modifié — extraction de sizeBuyOrder, comportement inchangé)
scripts/run-paper.ts           (nouveau)
test/krakenAssetPairs.test.ts  (nouveau)
test/krakenRestSeed.test.ts    (nouveau)
test/statePersistence.test.ts  (nouveau)
test/paperRunner.test.ts       (nouveau)
```

`src/live/liveBarSource.ts`, `src/live/liveSeriesBuilder.ts`,
`src/live/krakenOhlcSource.ts` (Phase 5a), `src/backtest/execution.ts`,
`src/backtest/portfolio.ts`, `src/strategy/*` sont consommés tels quels, à
l'exception de l'extraction ponctuelle dans `runner.ts` ci-dessus.
