# Phase 5a — Pipeline de données live

Statut : approuvé (décisions actées en conversation le 2026-08-24).

## Objectif et critère de sortie

Construire le pipeline qui transforme le flux WebSocket temps réel de
Kraken en une `BarSeries` valide et croissante, avec une détection
correcte de la clôture de bougie — préalable indispensable à tout runner
live (papier ou réel), et premier sous-projet d'un chantier plus large
(voir Phase 5b pour la boucle de décision qui consommera ce pipeline).

**Défi méthodologique explicite** : toute la rigueur du projet jusqu'ici
repose sur des tests déterministes, sans réseau. Un client WebSocket casse
ce principe par nature. La réponse : séparer la **source de barres**
(interface `LiveBarSource`) de tout le reste. `KrakenOhlcSource` (la vraie
connexion) est la seule pièce du système qui échappe à `npm test` — vérifiée
manuellement en la faisant tourner, jamais automatiquement. Tout le reste
(détection de clôture, construction de série) est testé via une source
synthétique injectable qui rejoue des séquences de messages construites à
la main.

Critère de sortie : la détection de clôture de bougie et la construction
de `BarSeries` sont couvertes par des tests déterministes exhaustifs
(bougie qui se met à jour en place, changement de `interval_begin`,
doublon/rejeu après reconnexion), et `KrakenOhlcSource` compile et respecte
l'interface `LiveBarSource` — sans jamais être exercée par un test
automatisé contre un vrai serveur.

Hors périmètre (reporté à la Phase 5b ou au-delà) :
- Toute logique de décision, d'exécution ou de portefeuille — ce
  sous-projet ne fait que produire une `BarSeries` à jour, rien d'autre.
- Rattrapage des barres manquées pendant une coupure WebSocket (backfill
  via l'endpoint REST `/0/public/OHLC`) — une coupure produit un trou dans
  la série, journalisé, pas comblé automatiquement dans cette tranche.
- Multi-paires / alignement cross-sectionnel temps réel — mono-pair pour
  cette tranche, comme la Phase 1 l'a fait pour le backtest.
- Persistance de la série elle-même entre redémarrages du processus (voir
  Phase 5b pour la persistance du portefeuille, distincte).

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Détection de clôture | Suivi du `interval_begin` par symbole ; un changement de valeur signe la clôture de la bougie précédente | Kraken WS v2 (canal `ohlc`) n'a pas de flag « fermée » — vérifié dans la doc officielle |
| Testabilité | Interface `LiveBarSource` injectable ; `KrakenOhlcSource` (réel) jamais testée automatiquement, une source synthétique couvre toute la logique de clôture/construction | Préserve la philosophie de tests déterministes du reste du projet malgré la nature réseau du client WS |
| Dépendance WebSocket | `WebSocket` natif de Node (stable depuis Node 22.4, aucune dépendance runtime ajoutée) | Le projet n'a aujourd'hui aucune dépendance runtime (seulement des devDependencies) ; le préserver |
| Portée | Mono-pair, pas de rattrapage de coupure, pas de décision/exécution | Chaque sous-projet reste un morceau digeste, comme les phases précédentes |

## Architecture

### 1. Interface `LiveBarSource` (`src/live/liveBarSource.ts`, nouveau)

```ts
export interface ClosedBar {
  readonly symbol: string;
  /** Timestamp d'ouverture de la barre (interval_begin), en secondes epoch. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number;
}

export interface LiveBarSource {
  /** S'abonne et commence à émettre des barres closes, une par appel. */
  start(onClosedBar: (bar: ClosedBar) => void): void;
  /** Ferme la connexion proprement. */
  stop(): void;
}
```

### 2. `KrakenOhlcSource` (`src/live/krakenOhlcSource.ts`, nouveau)

```ts
export interface KrakenOhlcSourceConfig {
  /** Symbole au format Kraken WS v2 (ex. 'BTC/EUR') — voir note de mapping ci-dessous. */
  readonly wsSymbol: string;
  /** Symbole interne du projet (ex. 'XBTEUR', format `src/config/universe.ts`), utilisé dans ClosedBar.symbol. */
  readonly symbol: string;
  readonly interval: Interval;   // réutilise le type existant de src/data/series.ts (60 | 240 | 1440)
  readonly wsUrl?: string;       // par défaut wss://ws.kraken.com/v2, surchargeable pour les tests
}

export function createKrakenOhlcSource(config: KrakenOhlcSourceConfig): LiveBarSource
```

**Note de mapping (à vérifier en implémentation, pas supposée ici)** : le
canal WS v2 de Kraken utilise un format de paire de type `BTC/EUR`, tandis
que le reste du projet (`src/config/universe.ts`, les CSV REST) utilise la
nomenclature legacy Kraken (`XBTEUR`, sans séparateur, avec les codes
d'actifs historiques comme `XBT` pour Bitcoin). Ces deux formats ne sont
**pas garantis identiques** terme à terme (ex. `XBT` vs `BTC`). Plutôt que
de supposer une correspondance, `KrakenOhlcSourceConfig` sépare
explicitement `wsSymbol` (ce qu'on envoie à l'abonnement WS) de `symbol`
(ce qu'on utilise en interne, cohérent avec `universe.ts`) — la tâche
d'implémentation doit vérifier la correspondance exacte pour au moins un
symbole contre la documentation Kraken WS v2 actuelle avant de coder une
table de correspondance pour les 20 paires de l'univers.

- Se connecte via `WebSocket` natif, envoie le message d'abonnement
  (`{ method: 'subscribe', params: { channel: 'ohlc', symbol: [config.symbol], interval: config.intervalMinutes, snapshot: true } }`).
- Pour chaque message reçu de type `update`/`snapshot` sur le canal
  `ohlc` : compare `interval_begin` (converti en secondes epoch) au
  dernier `interval_begin` connu pour ce symbole.
  - Première valeur vue pour ce symbole : mémorisée, **pas émise** (on ne
    connaît pas encore son OHLCV final, la bougie peut encore évoluer).
  - Nouvelle valeur strictement supérieure à la dernière connue :
    la **précédente** est maintenant fermée — émet un `ClosedBar` avec les
    dernières valeurs OHLCV connues pour cet `interval_begin`, puis
    mémorise la nouvelle valeur comme « en cours ».
  - Valeur égale à la dernière connue (bougie en cours qui se met à jour) :
    met à jour les valeurs OHLCV mémorisées, n'émet rien.
  - Valeur inférieure ou déjà émise (rejeu après reconnexion, snapshot qui
    chevauche une barre déjà close) : ignorée silencieusement — jamais de
    double émission pour le même `interval_begin`.
- Reconnexion avec backoff exponentiel sur fermeture inattendue de la
  connexion ; un message de log signale la coupure (pas d'exception levée
  vers l'appelant — un live-runner ne doit pas planter sur un problème
  réseau transitoire, contrairement à la philosophie « échec bruyant » du
  reste du projet qui suppose un run ponctuel, pas un processus qui doit
  durer).

### 3. `liveSeriesBuilder` (`src/live/liveSeriesBuilder.ts`, nouveau)

```ts
export interface LiveSeriesBuilder {
  /** Ajoute une barre close, déjà validée temporellement croissante par l'appelant. */
  append(bar: ClosedBar): void;
  /** Snapshot courant, utilisable directement avec BarView. Lève si aucune barre n'a encore été ajoutée. */
  current(): BarSeries;
}

export function createLiveSeriesBuilder(symbol: string, interval: Interval): LiveSeriesBuilder
```

- Maintient des `MutableColumns` (déjà existant, `src/data/series.ts`) en
  interne, poussées à chaque `append`.
- `current()` appelle `freezeSeries` (déjà existant, inchangé) sur l'état
  courant — revalide au passage l'invariant de timestamps strictement
  croissants déjà garanti par `freezeSeries`, sans dupliquer cette
  validation. Chaque symbole ne reçoit une nouvelle barre qu'au rythme de
  l'intervalle configuré (ex. toutes les 4h pour `interval=240`) : reformer
  les `Float64Array` à chaque `append` est un coût négligeable à cette
  fréquence, pas la peine d'optimiser.
- Toutes les barres marquées `synthetic: 0` — ce module ne connaît pas la
  politique de trous (`gaps.ts`), une barre manquante produit un trou brut
  dans la série, pas un forward-fill. Combler les trous d'une coupure
  réseau est explicitement hors périmètre (voir plus haut).

## Fichiers touchés

```
src/live/liveBarSource.ts      (nouveau)
src/live/krakenOhlcSource.ts   (nouveau)
src/live/liveSeriesBuilder.ts  (nouveau)
test/liveBarSource.test.ts     (nouveau — source synthétique + tests de détection de clôture)
test/liveSeriesBuilder.test.ts (nouveau)
```

Aucun fichier existant n'est modifié — `MutableColumns`, `freezeSeries`,
`BarSeries` (`src/data/series.ts`) sont consommés tels quels.
