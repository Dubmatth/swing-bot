# Phase 1 — Moteur de backtest event-driven

Statut : approuvé (auto-mode, décisions actées en conversation le 2026-08-23).

## Objectif et critère de sortie

Faire tourner de bout en bout, sur une seule paire (BTC/EUR), une stratégie de
croisement de moyennes mobiles à travers un moteur de backtest event-driven
avec modèle de frais et slippage, et démontrer qu'elle **perd de l'argent
après frais**. Aucune exécution live, aucune stratégie de production : ce
module ne sert qu'à prouver que la mécanique (file d'événements, exécution
simulée, comptabilité de portefeuille) fonctionne et est honnête sur les
coûts de transaction.

Hors périmètre (reporté) :
- Multi-paires / allocation de capital entre positions concurrentes.
- Sizing fractionné (Phase 1 engage 100 % du cash disponible par entrée).
- Ordres limites / distinction maker vs taker à l'exécution.
- Slippage dépendant de la volatilité (ATR).
- Live-runner (le module est conçu pour être réutilisable par lui, mais ne
  l'implémente pas).

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Périmètre backtest | Un seul pair (BTC/EUR) | Prouver la boucle avant d'ajouter l'allocation multi-paires |
| Forme de la boucle | File d'événements typés (FIFO synchrone) | Réutilisable par le futur live-runner sans réécriture de la logique d'exécution/portefeuille |
| Sizing | 100 % du cash disponible par position | Un seul actif, une seule position possible à la fois |
| Slippage | Bps fixe configurable (défaut 5 bps), toujours contre soi | Suffisant pour un modèle honnête sans complexité prématurée |
| Frais | Seul `takerBps` (40 bps) est appliqué ; `makerBps` (25 bps) existe dans le type mais n'est pas utilisé | Tous les ordres sont au marché dans cette phase |

## Architecture

### 1. Événements et runner (`src/backtest/`)

```ts
// events.ts
export type BacktestEvent =
  | { kind: 'bar-closed'; symbol: string; t: number }
  | { kind: 'order-requested'; symbol: string; side: 'buy' | 'sell'; reason: string }
  | { kind: 'order-filled'; symbol: string; side: 'buy' | 'sell'; quantity: number; price: number; fee: number; t: number }
  | { kind: 'order-rejected'; symbol: string; side: 'buy' | 'sell'; reason: string; t: number };
```

`runner.ts` expose :

```ts
export interface BacktestOptions {
  readonly initialCash: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface BacktestResult {
  readonly portfolio: Portfolio;
  readonly equityCurve: readonly { readonly t: number; readonly equity: number }[];
  readonly rejectedOrders: number;
}

export function runBacktest(
  series: BarSeries,
  strategy: Strategy,
  opts: BacktestOptions,
): BacktestResult
```

Déroulé, pour `t` de `strategy.warmup` à `series.length - 2` (il faut toujours
une barre `t+1` disponible pour exécuter) :

1. File `bar-closed { symbol, t }`.
2. Construit `BarView(series, t)`, assemble `StrategyContext` (`views`,
   `positions` issu du portefeuille courant, `now = series.time[t]`), appelle
   `strategy.decide(ctx)`.
3. Chaque `Intent` `'enter'`/`'exit'` (pas `'hold'`) devient
   `order-requested { symbol, side, reason }` — `'enter'` → `'buy'`,
   `'exit'` → `'sell'`.
4. Le runner regarde la barre `t+1` (légitime : ce n'est pas la stratégie qui
   regarde le futur, c'est le constat d'un fait par le composant qui exécute).
   Si `series.synthetic[t+1] === 1`, l'ordre devient `order-rejected` — pas de
   remise en file automatique : la stratégie sera rappelée naturellement à
   l'itération `t+1` et réémettra son intention si les conditions tiennent
   toujours (voir §3, la stratégie est *level-triggered*, pas *edge-triggered*,
   ce qui rend ce retour naturel sans mécanisme de retry dédié).
5. Sinon, `simulateBuy`/`simulateSell` (selon le côté) calcule prix après
   slippage, quantité et fee sur `series.open[t+1]`, produit `order-filled`,
   qui met à jour le `Portfolio` via `applyBuyFill`/`applySellFill`.
6. Après traitement de la barre, enregistre un point de la courbe d'équité
   (`equity = cash + position.quantity * series.close[t]` si position ouverte).

Le runner est le seul endroit qui lit directement les colonnes `BarSeries`
hors `BarView` — légitime puisqu'il ne prend aucune décision de trading, il
constate des faits (barre suivante disponible, synthétique ou non) pour
exécuter une décision déjà prise.

### 2. Exécution simulée (`execution.ts`)

```ts
export interface FeeSchedule {
  readonly makerBps: number;  // 25 — non utilisé cette phase, réservé au live à ordres limites
  readonly takerBps: number;  // 40 — seul taux appliqué
}
export const DEFAULT_FEES: FeeSchedule = { makerBps: 25, takerBps: 40 };

export interface ExecutionOptions {
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface Fill {
  readonly price: number;     // après slippage
  readonly quantity: number;
  readonly fee: number;       // en EUR
}

/** Achat : engage tout le cash disponible, fee inclus dans le sizing. */
export function simulateBuy(cash: number, referencePrice: number, opts: ExecutionOptions): Fill

/** Vente : solde une quantité déjà détenue. */
export function simulateSell(quantity: number, referencePrice: number, opts: ExecutionOptions): Fill
```

- Prix après slippage : `referencePrice * (1 + slippageBps/10_000)` à
  l'achat, `referencePrice * (1 - slippageBps/10_000)` à la vente — le
  slippage joue toujours contre soi.
- **`simulateBuy` résout le sizing et le fee ensemble**, pas l'inverse :
  `quantity = cash / (execPrice * (1 + takerBps/10_000))`, puis
  `fee = quantity * execPrice * takerBps/10_000`. Par construction,
  `quantity * execPrice + fee === cash` (aux arrondis flottants près) — piège
  évité : calculer `quantity = cash / execPrice` puis ajouter le fee par-dessus
  dépenserait plus que le cash disponible.
- `simulateSell` est plus simple : `quantity` est fixée par la position
  existante, `fee = quantity * execPrice * takerBps/10_000` est simplement
  déduit du produit de la vente.

### 3. Portefeuille (`portfolio.ts`)

```ts
export interface Trade {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly price: number;
  readonly fee: number;
  readonly t: number;
}

export interface Portfolio {
  cash: number;
  readonly positions: Map<string, Position>;  // réutilise Position de strategy/types.ts
  readonly trades: Trade[];
}

export function createPortfolio(initialCash: number): Portfolio
export function applyBuyFill(p: Portfolio, symbol: string, fill: Fill, t: number): void
export function applySellFill(p: Portfolio, symbol: string, fill: Fill, t: number): void
```

- `applyBuyFill` : débite `fill.quantity * fill.price + fill.fee` (≈ tout le
  cash, par construction de `simulateBuy`), crée la `Position`
  (`entryPrice = fill.price`, `entryTime` = timestamp de la barre `t+1`
  traduit par l'appelant).
- `applySellFill` : crédite `fill.quantity * fill.price - fill.fee`, retire la
  `Position` de `positions`, journalise le `Trade`.
- Pas d'arrondi à un pas de lot (précision Kraken) — c'est un raffinement
  d'exécution live, hors périmètre du backtest.

### 4. Stratégie de référence (`src/strategy/maCrossover.ts`)

```ts
export interface MaCrossoverParams {
  readonly fast: number;  // ex. 10
  readonly slow: number;  // ex. 30, doit être > fast
}

export function createMaCrossover(params: MaCrossoverParams): Strategy
```

**Point de conception important**, tranché en relisant `types.ts` : le
contrat `Strategy.decide` interdit explicitement toute mutation, y compris
des propres champs de la stratégie (« Fonction pure. Ne doit rien muter, y
compris ses propres champs. »). Un état interne d'indicateur incrémental
(`Ema`/`Sma` mis à jour à chaque appel) violerait donc ce contrat. La
stratégie recalcule les deux moyennes **à chaque appel**, directement depuis
la fenêtre que `BarView` expose déjà (`view.close(ago)` pour
`ago = 0..period-1`), en réutilisant la classe `Sma` existante comme simple
accumulateur jetable :

```ts
function sma(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) s.update(view.close(ago));
  return s.value;
}
```

Logique *level-triggered* (pas *edge-triggered*) — condition sur l'état
courant plutôt que sur l'instant exact du croisement, ce qui la rend
tolérante à un rejet d'exécution (§1.4) sans mécanisme de retry séparé :

```ts
decide(ctx) {
  const view = ctx.views.get(symbol)!;
  const fastVal = sma(view, params.fast);
  const slowVal = sma(view, params.slow);
  const hasPosition = ctx.positions.has(symbol);
  if (!hasPosition && fastVal > slowVal) return [{ kind: 'enter', symbol, reason: 'fast > slow' }];
  if (hasPosition && fastVal < slowVal) return [{ kind: 'exit', symbol, reason: 'fast < slow' }];
  return [{ kind: 'hold' }];
}
```

`warmup = params.slow`.

### 5. Test du critère de sortie (`test/phase1.test.ts`)

Suit la convention de `phase0.test.ts` (données synthétiques générées, pas de
CSV réel — les CSV ne sont pas versionnés).

- Génère une série de clôtures oscillantes (ex. sinusoïde de faible
  amplitude autour d'un niveau constant) sur suffisamment de barres pour
  produire plusieurs croisements fast/slow — plusieurs allers-retours,
  chacun avec un edge brut faible.
- Lance `runBacktest` avec `DEFAULT_FEES` et un slippage réaliste (5 bps).
- Assertions :
  - `result.portfolio.trades.length > 1` (la boucle exécute réellement
    plusieurs cycles, pas un cas dégénéré à un seul trade).
  - `result.portfolio.cash < initialCash` une fois la position soldée
    (perte nette après frais).
  - Relance le même scénario avec `fees = { makerBps: 0, takerBps: 0 }` et
    `slippageBps = 0` : le résultat frictionless doit être meilleur que le
    résultat avec frais (`equityFrictionless > equityWithFees`). Cette
    comparaison est ce qui prouve que la perte vient des frais/slippage et
    pas d'un scénario de marché simplement défavorable — c'est le sens
    littéral du critère de sortie (« perd de l'argent **après frais** »).

## Fichiers touchés

```
src/backtest/events.ts        (nouveau)
src/backtest/execution.ts     (nouveau)
src/backtest/portfolio.ts     (nouveau)
src/backtest/runner.ts        (nouveau)
src/strategy/maCrossover.ts   (nouveau)
test/phase1.test.ts           (nouveau)
```

Aucun fichier de Phase 0 n'est modifié — le contrat `Strategy`/`BarView` est
consommé tel quel.
