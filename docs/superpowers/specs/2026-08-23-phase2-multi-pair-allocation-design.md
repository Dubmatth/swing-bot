# Phase 2 — Backtest multi-paires et allocation de capital

Statut : approuvé (décisions actées en conversation le 2026-08-23).

## Objectif et critère de sortie

Généraliser le moteur de backtest de la Phase 1 (mono-pair) pour qu'il tourne
sur plusieurs paires simultanément, avec une politique d'allocation de
capital simple entre positions concurrentes, et démontrer que **le capital
disponible n'est jamais dépassé** : le plafond de positions concurrentes est
respecté, un signal au-delà du plafond est proprement refusé (pas de crash,
pas de corruption du portefeuille), et l'équité ne devient jamais négative.
C'est l'invariant structurel que la Phase 1, mono-pair par construction, ne
pouvait pas violer et que la Phase 2 doit maintenant garantir explicitement.

Hors périmètre (reporté) :
- Sizing fractionné par risque (ATR) — l'allocation reste une fraction fixe
  de l'équité, pas un dimensionnement par volatilité.
- Ordres limites / distinction maker vs taker.
- Rebalancement (recalcul de fraction si le nombre de positions ouvertes
  change) — la fraction est figée à l'entrée, pas recalculée en continu.
- Backtest sur l'univers réel des 20 paires (nécessite les CSV Kraken non
  versionnés) — le critère de sortie est prouvé sur données synthétiques,
  comme la Phase 1.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Allocation de capital | Fraction fixe `1/maxConcurrentPositions` de l'équité totale à l'entrée | Déterministe, simple à tester, évite qu'une paire très active n'avale tout le capital |
| Signaux au-delà du plafond | Refusés (`order-rejected`), jamais mis en file d'attente | Cohérent avec le refus sur barre synthétique de la Phase 1 |
| Stratégie multi-paires | Combinateur `combineStrategies` d'instances mono-pair existantes | Chaque instance reste testable isolément ; réutilisable par toute future stratégie |
| Signature `runBacktest` | Cassée : `series: ReadonlyMap<string, BarSeries>` | Une seule implémentation à maintenir ; les tests Phase 1 sont mis à jour |
| Portée du critère de sortie | Invariant de capital sur données synthétiques, pas performance sur l'univers réel | Sépare « le code est correct » de « la stratégie est bonne », comme la Phase 1 |

## Architecture

### 1. Portefeuille — un seul ajout (`src/backtest/portfolio.ts`)

La structure `Map<string, Position>` est déjà multi-paires depuis la
Phase 1. Seul ajout :

```ts
export function portfolioEquity(
  p: Portfolio,
  markPrices: ReadonlyMap<string, number>,
): number
```

`cash + Σ position.quantity × markPrices.get(position.symbol)` sur toutes
les positions ouvertes. Lève une `Error` si un prix de marque manque pour
une position ouverte (défensif — ne devrait jamais arriver étant donné
l'alignement temporel imposé par le runner, voir §2).

### 2. Combinateur de stratégies (`src/strategy/combineStrategies.ts`, nouveau)

```ts
export function combineStrategies(strategies: readonly Strategy[]): Strategy
```

- Lève si `strategies.length === 0`.
- `warmup` = max des `warmup` des sous-stratégies.
- `params` = fusion des `params` de chaque sous-stratégie, clés préfixées
  par index (`0_fast`, `0_slow`, `1_fast`, …) pour éviter les collisions
  entre sous-stratégies identiques sur des paires différentes.
  Limitation assumée : `degreesOfFreedom` sur une stratégie combinée n'est
  pas un besoin de cette phase (aucun walk-forward encore).
- `decide(ctx)` : appelle `decide(ctx)` sur chaque sous-stratégie avec le
  **même** `ctx` (déjà multi-paires par construction depuis la Phase 0 —
  `ctx.views: ReadonlyMap<string, BarView>` couvre déjà toutes les paires),
  concatène les intentions non-`hold`. Renvoie `[{kind:'hold'}]` si aucune
  sous-stratégie n'a émis d'intention.

### 3. Runner généralisé (`src/backtest/runner.ts`)

```ts
export interface BacktestOptions {
  readonly initialCash: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
  readonly maxConcurrentPositions: number;   // nouveau
}

export function runBacktest(
  series: ReadonlyMap<string, BarSeries>,    // était BarSeries
  strategy: Strategy,
  opts: BacktestOptions,
): BacktestResult
```

**Validation d'entrée** : `series.size > 0` ; toutes les séries doivent
partager exactement la même longueur et le même tableau `time[]` (comparer
premier/dernier timestamp et longueur suffit — l'alignement complet est déjà
garanti en amont par `loadUniverse` ou par construction dans les tests).
Lève une `Error` explicite sinon, même philosophie « échec bruyant » que le
reste du projet.

**Boucle** : `t` de `strategy.warmup` à `length - 2` sur la grille commune
(`length` = longueur partagée par toutes les séries, vérifiée ci-dessus).

Pour chaque `t` :

1. Photo d'équité en tout début d'itération :
   `equitySnapshot = portfolioEquity(portfolio, marksAt(t))` où
   `marksAt(t)` associe chaque symbole à `series.get(symbol).close[t]`.
   Cette photo sert de dénominateur pour **toutes** les entrées décidées
   sur cette barre — pas de recalcul après chaque fill intra-barre.
   Simplification assumée : la taille d'une position ne dépend que de
   l'état connu à la clôture de la barre de décision, pas de l'ordre de
   traitement des fills au sein de la même barre.
2. `ctx.views` construit avec **toutes** les paires (`new BarView(series.get(s)!, t)`
   pour chaque `s`), `ctx.positions = portfolio.positions`,
   `ctx.now = time[t]` (identique sur toutes les séries par construction).
3. `strategy.decide(ctx)` → intentions, traduites en `order-requested` par
   symbole (comme en Phase 1).
4. Validation d'un `order-requested`, dans cet ordre :
   1. `!series.has(event.symbol)` → `order-rejected` (raison :
      `symbole hors univers du runner`). C'est la généralisation du garde-fou
      ajouté lors de la revue finale de la Phase 1 (qui comparait à un seul
      symbole) : désormais on vérifie l'appartenance à l'ensemble des
      symboles chargés, pas l'égalité à un symbole unique.
   2. Côté achat uniquement, `portfolio.positions.size >= opts.maxConcurrentPositions`
      → `order-rejected` (raison : `plafond de positions concurrentes atteint`).
   3. Côté achat uniquement, position déjà ouverte sur ce symbole →
      `order-rejected` (raison : `position déjà ouverte sur ce symbole`).
      Nouveau garde-fou explicite au niveau du runner : en Phase 1 ce cas
      n'était jamais atteint car la seule stratégie utilisée s'auto-gated sur
      `ctx.positions.has(symbol)`, et la protection de dernier recours vivait
      uniquement dans `applyBuyFill` sous forme de `throw`. Avec un
      combinateur de stratégies, mieux vaut un rejet propre qu'un `throw`
      qui interromprait tout le backtest sur une combinaison de stratégies
      mal conçue.
   4. Côté achat uniquement, `budget = min(portfolio.cash, equitySnapshot / opts.maxConcurrentPositions)`.
      `budget <= 0` → `order-rejected` (raison : `budget alloué insuffisant`)
      — remplace un `throw` de `simulateBuy` par un rejet propre pour ce cas
      attendu (le cash peut légitimement tomber à ~0 après plusieurs entrées).
   5. Sinon, exécution : `simulateBuy(budget, series.get(event.symbol)!.open[fillT], execOpts)`
      côté achat, logique de vente inchangée côté vente.
   Le refus sur barre synthétique (`series.get(event.symbol)!.synthetic[fillT]`)
   est inchangé dans sa logique, seulement indexé par symbole via
   `series.get(event.symbol)!` au lieu de la seule série fermée sur
   elle-même de la Phase 1.
5. Point de courbe d'équité, un par barre, marqué à `t+1` (même convention
   que le fix de revue finale de la Phase 1) :
   `{ time: sharedTime[t+1], equity: portfolioEquity(portfolio, marksAt(t+1)) }`.

**Rupture de compatibilité assumée** : `test/runner.test.ts` et
`test/phase1.test.ts` (Phase 1, déjà mergée) sont mis à jour pour passer une
`Map` à une seule entrée au lieu d'une `BarSeries` nue.

### 4. Test du critère de sortie (`test/phase2.test.ts`)

3 paires synthétiques oscillantes sur la **même** grille temporelle (même
`time[]`), combinées via `combineStrategies` (une instance `createMaCrossover`
par paire). `maxConcurrentPositions = 2` (délibérément < 3, pour forcer un
rejet par plafond dans un scénario réaliste).

Assertions :
- `result.rejectedOrders > 0` — le plafond a effectivement été atteint au
  moins une fois pendant le run (pas juste un mécanisme jamais exercé).
- `result.portfolio.positions.size <= 2` en fin de run.
- `result.equityCurve.every(p => p.equity >= 0)` — le capital disponible
  n'a jamais été dépassé, sur toute la durée du backtest, pas seulement à
  la fin.

## Fichiers touchés

```
src/backtest/portfolio.ts        (modifié — ajout portfolioEquity)
src/backtest/runner.ts           (modifié — signature multi-paires, allocation)
src/strategy/combineStrategies.ts (nouveau)
test/runner.test.ts              (modifié — nouvelle signature Map)
test/phase1.test.ts              (modifié — nouvelle signature Map)
test/portfolio.test.ts           (modifié — tests portfolioEquity)
test/combineStrategies.test.ts   (nouveau)
test/phase2.test.ts              (nouveau)
```
