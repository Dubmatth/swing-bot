# Phase 3 — Sizing par risque ATR

Statut : approuvé (décisions actées en conversation le 2026-08-24).

## Objectif et critère de sortie

Ajouter un sizing de position basé sur le risque (« risquer X % du capital
sur une distance de N×ATR »), en plafond additionnel au-dessus du plafond
fraction fixe de la Phase 2 — jamais en remplacement. Démontrer que ce
sizing normalise correctement l'exposition entre deux paires de volatilité
différente (position plus petite sur la paire la plus volatile, pour un
risque égal) **sans jamais dépasser** le plafond fraction fixe déjà prouvé
par `test/phase2.test.ts`. C'est la motivation d'origine du commentaire de
`Atr` dans `src/strategy/indicators.ts` (« risquer 1 % du capital sur une
distance de N×ATR normalise l'exposition entre BTC/EUR et une altcoin trois
fois plus volatile, ce qu'un stop en pourcentage fixe ne fait pas »),
jusqu'ici jamais câblée à un sizing réel.

Hors périmètre (reporté) :
- Slippage dépendant de la volatilité (ATR) — reste un bps fixe
  (`src/backtest/execution.ts`), sujet distinct du sizing.
- Stop-loss réellement exécuté (le `stopDistance` sert uniquement au calcul
  de taille de position ; aucun ordre stop n'est simulé — une position
  n'est encore fermée que par un `Intent` `'exit'` de la stratégie, comme
  avant).
- Modification de `maCrossover.ts` — reste inchangé, aucune fixture
  numérique Phase 1/2 déjà mergée n'est retouchée.
- Ordres limites / distinction maker vs taker, live-runner, backtest sur
  l'univers réel des 20 paires — inchangés depuis les phases précédentes.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Qui calcule la distance de stop | La stratégie, via un champ optionnel `stopDistance` sur `Intent` (`kind: 'enter'`) | Cohérent avec le commentaire d'origine d'`indicators.ts` ; différentes stratégies peuvent choisir des règles de stop différentes |
| Interaction avec le plafond Phase 2 | Le plafond fraction fixe reste actif en permanence ; le sizing par risque ne peut que réduire le budget, jamais l'augmenter | Préserve l'invariant de capital déjà prouvé sans retoucher `runner.ts` au-delà du calcul de quantité |
| Strategie de référence | Nouvelle strategie `createAtrRiskCrossover`, `maCrossover.ts` inchangé | Zéro risque sur les fixtures Phase 1/2 déjà mergées |

## Architecture

### 1. Contrat `Intent` étendu (`src/strategy/types.ts`)

```ts
export type Intent =
  | {
      readonly kind: 'enter';
      readonly symbol: string;
      readonly reason: string;
      /** Distance de stop en prix (pas en %), pour le sizing par risque. Optionnel. */
      readonly stopDistance?: number;
    }
  | { readonly kind: 'exit'; readonly symbol: string; readonly reason: string }
  | { readonly kind: 'hold' };
```

Changement rétrocompatible : `stopDistance` absent ⇒ comportement du runner
identique bit-à-bit à la Phase 2 (voir §3). Aucune stratégie existante
(`maCrossover`, tous les tests Phase 1/2) n'a besoin d'être modifiée.

### 2. Nouvelle stratégie de référence (`src/strategy/atrRiskCrossover.ts`, nouveau)

```ts
export interface AtrRiskCrossoverParams {
  readonly symbol: string;
  readonly fast: number;
  readonly slow: number;
  readonly atrPeriod: number;
  readonly atrMultiplier: number;   // ex. 2 → stop à 2×ATR
}

export function createAtrRiskCrossover(params: AtrRiskCrossoverParams): Strategy
```

- Même logique de signal que `maCrossover` (recalculée à chaque appel de
  `decide()` depuis `BarView`, sans état interne persistant — même
  discipline de pureté).
- Calcule en plus `Atr(atrPeriod)` sur la fenêtre disponible (feed
  `high(ago)/low(ago)/close(ago)` pour `ago = atrPeriod-1..0`, comme
  `maCrossover` le fait déjà pour `Sma`).
- `warmup = Math.max(slow, atrPeriod)`.
- Sur un signal `enter`, ajoute `stopDistance: atrMultiplier * atrValue` à
  l'intent. `atrMultiplier` doit être un nombre positif (validé au
  constructeur, `RangeError` sinon, même style que `fast`/`slow`).
- `atrPeriod` validé comme un entier positif (même style que la classe
  `Atr` elle-même, qui lève déjà pour une période invalide — la stratégie
  n'a pas besoin de dupliquer cette validation, `new Atr(atrPeriod)` la
  fait déjà lever au bon moment).

### 3. Runner : sizing par risque en plafond additionnel (`src/backtest/runner.ts`)

`BacktestOptions` gagne un champ :

```ts
export interface BacktestOptions {
  readonly initialCash: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
  readonly maxConcurrentPositions: number;
  readonly riskPerTradePct: number;   // nouveau, ex. 0.01 = 1 %
}
```

Validé au même endroit que `maxConcurrentPositions` : `riskPerTradePct`
doit être un nombre fini strictement positif (pas de borne haute imposée —
un appelant qui met 2.0 pour « risquer 200 % » se tire dans le pied
volontairement, ce n'est pas au runner de l'en empêcher), `RangeError`
sinon.

`BacktestEvent`'s `order-requested` (dans `src/backtest/events.ts`) gagne
un champ optionnel pour transporter la valeur depuis l'intent jusqu'au
traitement de l'ordre :

```ts
| {
    readonly kind: 'order-requested';
    readonly symbol: string;
    readonly side: 'buy' | 'sell';
    readonly reason: string;
    readonly stopDistance?: number;   // nouveau — présent seulement côté 'enter'
  }
```

Dans le `bar-closed` handler, la traduction `intent.kind === 'enter'` →
`order-requested` propage `intent.stopDistance` (inchangé pour `'exit'`,
qui n'en porte jamais).

**Piège `exactOptionalPropertyTypes`** (actif dans `tsconfig.json`) : un
champ `stopDistance?: number` interdit d'écrire explicitement
`stopDistance: undefined` dans un literal objet — seule l'omission complète
de la clé est acceptée. Comme `intent.stopDistance` a le type lu
`number | undefined` (toute propriété optionnelle se lit ainsi, même sous
ce flag), l'assigner directement dans le literal `order-requested` lève une
erreur de type. Construire l'événement avec un spread conditionnel :

```ts
queue.push({
  kind: 'order-requested',
  symbol: intent.symbol,
  side: 'buy',
  reason: intent.reason,
  ...(intent.stopDistance !== undefined ? { stopDistance: intent.stopDistance } : {}),
});
```

**Réordonnancement mineur** dans le traitement d'un `order-requested` :
`referencePrice = targetSeries.open[fillT]` est désormais calculé juste
après avoir confirmé que `targetSeries` existe (avant les vérifications
spécifiques à l'achat), au lieu de juste avant l'exécution — il est
nécessaire pour convertir la quantité impliquée par le risque en budget
cash. Ceci ne change aucun comportement observable : la valeur calculée
est strictement la même, seul le moment du calcul dans la fonction change.

Étape de calcul du budget, dans le traitement d'un achat (remplace l'étape
« budget » existante de la Phase 2, l'étend plutôt qu'elle ne la
remplace) :

1. `budget = min(portfolio.cash, equitySnapshot / opts.maxConcurrentPositions)`
   — identique à la Phase 2, calculé en premier, toujours actif.
2. Si `event.stopDistance !== undefined` :
   - `!(event.stopDistance > 0)` → `order-rejected` (raison :
     `stopDistance invalide`) — même philosophie défensive que le rejet
     du coût `NaN` déjà en place dans `applyBuyFill` : une valeur
     corrompue ne doit jamais atteindre `simulateBuy`.
   - Sinon : `riskBudget = (equitySnapshot * opts.riskPerTradePct / event.stopDistance) * referencePrice`,
     puis `budget = min(budget, riskBudget)`.
3. `budget <= 0` → `order-rejected` (raison : `budget alloué insuffisant`,
   inchangé depuis la Phase 2).
4. Sinon, exécution : `simulateBuy(budget, referencePrice, execOpts)`,
   inchangé.

Quand `event.stopDistance` est `undefined` (toute stratégie qui n'utilise
pas le sizing par risque), le comportement est **identique, bit-à-bit, à
la Phase 2** — `test/phase1.test.ts`, `test/phase2.test.ts` et tous les
tests `runner.test.ts` existants n'ont besoin d'aucune modification au-delà
de l'ajout du nouveau champ obligatoire `riskPerTradePct` dans leurs objets
d'options (une valeur quelconque suffit puisqu'aucun de leurs intents ne
porte de `stopDistance`).

### 4. Test du critère de sortie (`test/phase3.test.ts`, nouveau)

Deux paires synthétiques de volatilité différente sur la même grille
temporelle et avec des croisements garantis simultanés (même construction
que `test/phase2.test.ts` — signal identique, seule l'amplitude des
bougies diffère) :
- `LOWVOL` : petites bougies (ATR faible)
- `HIGHVOL` : grandes bougies (ATR élevé), même prix de clôture moyen pour
  que le signal de croisement se déclenche en même temps sur les deux

`createAtrRiskCrossover` par paire (mêmes `fast`/`slow`/`atrPeriod`/
`atrMultiplier`), combinées via `combineStrategies`, `maxConcurrentPositions`
assez grand pour ne pas être le facteur limitant sur ce scénario (le test
porte sur le sizing par risque, pas sur le plafond de concurrence — déjà
prouvé par la Phase 2), `riskPerTradePct` fixe.

Assertions :
- la position ouverte sur `LOWVOL` a un notional (`quantity × price`)
  strictement supérieur à celle sur `HIGHVOL` — l'ATR plus faible sur
  `LOWVOL` implique un `stopDistance` plus petit, donc une quantité plus
  grande pour un risque égal.
- pour chaque position ouverte (les deux paires), le notional ne dépasse
  jamais `equité/maxConcurrentPositions` au moment de l'entrée — le
  plafond de sécurité de la Phase 2 reste garanti même avec le sizing par
  risque activé.

## Fichiers touchés

```
src/strategy/types.ts             (modifié — Intent.stopDistance optionnel)
src/strategy/atrRiskCrossover.ts  (nouveau)
src/backtest/events.ts            (modifié — order-requested.stopDistance)
src/backtest/runner.ts            (modifié — riskPerTradePct, budget par risque)
test/atrRiskCrossover.test.ts     (nouveau)
test/runner.test.ts               (modifié — riskPerTradePct dans EXEC_OPTS, nouveaux tests de sizing par risque)
test/phase1.test.ts               (modifié — riskPerTradePct dans les options)
test/phase2.test.ts               (modifié — riskPerTradePct dans les options)
test/phase3.test.ts               (nouveau)
```

`maCrossover.ts`, `combineStrategies.ts`, `portfolio.ts`, `execution.ts` ne
sont pas modifiés.
