# Phase 2 — Backtest multi-paires et allocation de capital — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Généraliser le moteur de backtest de la Phase 1 (mono-pair) pour qu'il tourne sur plusieurs paires simultanément avec une allocation de capital en fraction fixe, et prouver que le capital disponible n'est jamais dépassé.

**Architecture:** `portfolioEquity` (nouveau, dans `portfolio.ts`) donne l'équité totale marquée au marché ; `combineStrategies` (nouveau) assemble des stratégies mono-pair existantes en une seule stratégie multi-paires sans toucher à leur code ; `runBacktest` passe d'une `BarSeries` unique à une `Map<symbole, BarSeries>`, avec un plafond `maxConcurrentPositions` et un budget par entrée = `min(cash, équité/maxConcurrentPositions)`.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas d'étape de build), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-23-phase2-multi-pair-allocation-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build — chaque `.ts` s'exécute tel quel via `--experimental-strip-types`.
- `verbatimModuleSyntax: true` — séparer les imports de types (`import type { ... }`) des imports de valeurs.
- `erasableSyntaxOnly: true` — pas d'enum, pas de propriétés de paramètre de constructeur, pas de namespace.
- `noUnusedLocals: true` — aucun import ou variable inutilisé.
- Commentaires et messages d'erreur en français, cohérents avec le style existant.
- Allocation : fraction fixe `1/maxConcurrentPositions` de l'équité totale connue au début de la barre de décision (pas de recalcul après chaque fill intra-barre).
- Signaux au-delà du plafond, sur un symbole déjà positionné, ou avec un budget nul : refusés proprement (`order-rejected`), jamais de `throw` ni de mise en file d'attente.
- Ordre de validation d'un `order-requested` : (1) symbole connu du runner, (2) côté achat seulement — plafond de positions concurrentes, (3) côté achat seulement — position déjà ouverte sur ce symbole, (4) côté achat seulement — budget alloué positif, (5) barre suivante non synthétique, (6) exécution.
- Rupture de compatibilité assumée : `runBacktest` prend désormais `series: ReadonlyMap<string, BarSeries>` (plus une `BarSeries` seule) — `test/runner.test.ts` et `test/phase1.test.ts` sont mis à jour dans ce plan.
- Commande de test par fichier : `node --experimental-strip-types --test test/<fichier>.test.ts`. Commande globale : `npm test` (`npm run typecheck` pour la vérification de types).

---

## Task 1: `portfolioEquity` et garde de coût sûre vis-à-vis de NaN

**Files:**
- Modify: `src/backtest/portfolio.ts`
- Modify: `test/portfolio.test.ts`

**Interfaces:**
- Consumes : `Position`, `Fill`, `Portfolio` (existants, inchangés).
- Produces :
  - `function portfolioEquity(p: Portfolio, markPrices: ReadonlyMap<string, number>): number`

- [ ] **Step 1: Écrire les tests (échouent — `portfolioEquity` n'existe pas encore, et le test NaN échoue avec le code actuel)**

Ajouter à la fin de `test/portfolio.test.ts` (après le dernier `test(...)` existant) :

```ts
import { portfolioEquity } from '../src/backtest/portfolio.ts';

test('portfolioEquity : cash seul quand aucune position ouverte', () => {
  const p = createPortfolio(1000);
  assert.equal(portfolioEquity(p, new Map()), 1000);
});

test('portfolioEquity : cash + valeur de marché des positions ouvertes', () => {
  const p = createPortfolio(1000);
  applyBuyFill(p, 'AEUR', { price: 100, quantity: 5, fee: 10 }, 1);
  applyBuyFill(p, 'BEUR', { price: 50, quantity: 4, fee: 5 }, 1);
  const marks = new Map([
    ['AEUR', 110],
    ['BEUR', 40],
  ]);
  const expectedCash = 1000 - (5 * 100 + 10) - (4 * 50 + 5);
  const expected = expectedCash + 5 * 110 + 4 * 40;
  assert.ok(Math.abs(portfolioEquity(p, marks) - expected) < 1e-9);
});

test('portfolioEquity : prix de marque manquant pour une position ouverte lève', () => {
  const p = createPortfolio(1000);
  applyBuyFill(p, 'AEUR', { price: 100, quantity: 5, fee: 10 }, 1);
  assert.throws(() => portfolioEquity(p, new Map()), /marque/);
});

test('applyBuyFill : un fill dont le coût est NaN lève plutôt que de corrompre le cash', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: Infinity, quantity: 0, fee: NaN };
  assert.throws(() => applyBuyFill(p, 'TESTEUR', fill, 1), /dépasse le cash/);
  assert.equal(p.cash, 1000);
});
```

Note : l'import de `portfolioEquity` doit être fusionné avec l'import existant en haut du fichier (`import { applyBuyFill, applySellFill, createPortfolio } from '../src/backtest/portfolio.ts';` devient `import { applyBuyFill, applySellFill, createPortfolio, portfolioEquity } from '../src/backtest/portfolio.ts';`) plutôt que dupliqué en bas de fichier — `verbatimModuleSyntax` n'interdit pas deux imports du même module mais c'est un style plus propre à respecter.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/portfolio.test.ts`
Expected: FAIL — `portfolioEquity` n'est pas exporté par `portfolio.ts` ; le test NaN échoue car `p.cash` devient `NaN` au lieu de lever.

- [ ] **Step 3: Implémenter**

Dans `src/backtest/portfolio.ts`, remplacer la ligne de garde de coût dans `applyBuyFill` :

```ts
  const cost = fill.quantity * fill.price + fill.fee;
  if (cost > p.cash + 1e-6) {
```

par :

```ts
  const cost = fill.quantity * fill.price + fill.fee;
  if (!(cost <= p.cash + 1e-6)) {
```

(`!(cost <= ...)` est `true` pour `NaN`, contrairement à `cost > ...` qui est `false` pour `NaN` — un fill corrompu ne peut plus silencieusement empoisonner `p.cash`.)

Ajouter à la fin du fichier :

```ts
/**
 * Équité totale marquée au marché : cash + valeur de marché de chaque
 * position ouverte. Lève si un prix de marque manque pour une position
 * ouverte — ne devrait jamais arriver étant donné l'alignement temporel
 * imposé par le runner sur toutes les séries.
 */
export function portfolioEquity(p: Portfolio, markPrices: ReadonlyMap<string, number>): number {
  let equity = p.cash;
  for (const position of p.positions.values()) {
    const markPrice = markPrices.get(position.symbol);
    if (markPrice === undefined) {
      throw new Error(`Prix de marque manquant pour la position ouverte sur ${position.symbol}`);
    }
    equity += position.quantity * markPrice;
  }
  return equity;
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/portfolio.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur

```bash
git add src/backtest/portfolio.ts test/portfolio.test.ts
git commit -m "$(cat <<'EOF'
feat(backtest): portfolioEquity + garde de coût sûre vis-à-vis de NaN

portfolioEquity marque au marché cash + positions ouvertes, base de
l'allocation de capital multi-paires de la Phase 2. Corrige au passage
un finding parqué de la revue finale Phase 1 : la garde de coût
d'applyBuyFill était silencieusement franchie par un coût NaN.
EOF
)"
```

---

## Task 2: Combinateur de stratégies

**Files:**
- Create: `src/strategy/combineStrategies.ts`
- Test: `test/combineStrategies.test.ts`

**Interfaces:**
- Consumes : `Intent`, `Strategy`, `StrategyContext` (`src/strategy/types.ts`, existant, inchangé).
- Produces :
  - `function combineStrategies(strategies: readonly Strategy[]): Strategy`

- [ ] **Step 1: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/combineStrategies.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';

function fixedStrategy(
  name: string,
  warmup: number,
  params: Record<string, number>,
  intents: readonly Intent[],
): Strategy {
  return {
    name,
    warmup,
    params,
    decide(_ctx: StrategyContext): readonly Intent[] {
      return intents;
    },
  };
}

const EMPTY_CTX: StrategyContext = { views: new Map(), positions: new Map(), now: 0 };

test('combineStrategies : lève si la liste est vide', () => {
  assert.throws(() => combineStrategies([]), /au moins une/);
});

test('combineStrategies : warmup est le max des sous-stratégies', () => {
  const a = fixedStrategy('a', 3, {}, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 7, {}, [{ kind: 'hold' }]);
  const combined = combineStrategies([a, b]);
  assert.equal(combined.warmup, 7);
});

test('combineStrategies : params fusionnés avec préfixe par index', () => {
  const a = fixedStrategy('a', 1, { fast: 3, slow: 7 }, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 1, { fast: 5, slow: 10 }, [{ kind: 'hold' }]);
  const combined = combineStrategies([a, b]);
  assert.deepEqual(combined.params, { '0_fast': 3, '0_slow': 7, '1_fast': 5, '1_slow': 10 });
});

test('combineStrategies : concatène les intentions non-hold de toutes les sous-stratégies', () => {
  const a = fixedStrategy('a', 1, {}, [{ kind: 'enter', symbol: 'AEUR', reason: 'a' }]);
  const b = fixedStrategy('b', 1, {}, [{ kind: 'exit', symbol: 'BEUR', reason: 'b' }]);
  const combined = combineStrategies([a, b]);
  const intents = combined.decide(EMPTY_CTX);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'enter');
  assert.equal(intents[1]?.kind, 'exit');
});

test('combineStrategies : renvoie hold si toutes les sous-stratégies renvoient hold', () => {
  const a = fixedStrategy('a', 1, {}, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 1, {}, [{ kind: 'hold' }]);
  const combined = combineStrategies([a, b]);
  const intents = combined.decide(EMPTY_CTX);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('combineStrategies : filtre les hold individuels sans perdre les intentions actionnables des autres', () => {
  const a = fixedStrategy('a', 1, {}, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 1, {}, [{ kind: 'enter', symbol: 'AEUR', reason: 'b' }]);
  const combined = combineStrategies([a, b]);
  const intents = combined.decide(EMPTY_CTX);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/combineStrategies.test.ts`
Expected: FAIL — `src/strategy/combineStrategies.ts` n'existe pas.

- [ ] **Step 3: Implémenter**

Créer `src/strategy/combineStrategies.ts` :

```ts
/**
 * Combine plusieurs stratégies mono-pair en une seule stratégie
 * multi-paires.
 *
 * `ctx` est déjà multi-paires par construction depuis la Phase 0
 * (`ctx.views: ReadonlyMap<string, BarView>` couvre déjà toutes les paires
 * chargées par le runner) — ce combinateur ne fait qu'appeler chaque
 * sous-stratégie avec le même `ctx` et concaténer leurs intentions. Chaque
 * sous-stratégie reste testable isolément, comme en Phase 1.
 */

import type { Intent, Strategy, StrategyContext } from './types.ts';

export function combineStrategies(strategies: readonly Strategy[]): Strategy {
  if (strategies.length === 0) {
    throw new RangeError('combineStrategies : au moins une stratégie requise');
  }

  const warmup = Math.max(...strategies.map((s) => s.warmup));

  const params: Record<string, number> = {};
  strategies.forEach((s, i) => {
    for (const [key, value] of Object.entries(s.params)) {
      params[`${i}_${key}`] = value;
    }
  });

  return {
    name: `combined(${strategies.map((s) => s.name).join(',')})`,
    warmup,
    params,
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents: Intent[] = [];
      for (const s of strategies) {
        for (const intent of s.decide(ctx)) {
          if (intent.kind !== 'hold') {
            intents.push(intent);
          }
        }
      }
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/combineStrategies.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur

```bash
git add src/strategy/combineStrategies.ts test/combineStrategies.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): combineStrategies — assemble des stratégies mono-pair

Réutilise ctx.views multi-paires déjà présent depuis la Phase 0. Chaque
sous-stratégie reste testable isolément ; params fusionnés avec préfixe
par index pour éviter les collisions entre instances identiques sur des
paires différentes.
EOF
)"
```

---

## Task 3: Runner généralisé au multi-paires avec allocation de capital

**Files:**
- Modify: `src/backtest/events.ts`
- Modify: `src/backtest/runner.ts`
- Modify: `test/runner.test.ts`
- Modify: `test/phase1.test.ts`

**Interfaces:**
- Consumes :
  - `portfolioEquity` (`src/backtest/portfolio.ts`, Task 1) : `(p: Portfolio, markPrices: ReadonlyMap<string, number>) => number`
  - `FeeSchedule`, `simulateBuy`, `simulateSell` (`src/backtest/execution.ts`, existant, inchangé)
  - `applyBuyFill`, `applySellFill`, `createPortfolio` (`src/backtest/portfolio.ts`, existant, inchangé)
  - `BarSeries`, `Strategy`, `StrategyContext`, `BarView` (existants, inchangés)
- Produces :
  - `interface BacktestOptions { readonly initialCash: number; readonly fees: FeeSchedule; readonly slippageBps: number; readonly maxConcurrentPositions: number }`
  - `interface BacktestResult { readonly portfolio: Portfolio; readonly equityCurve: readonly EquityPoint[]; readonly rejectedOrders: number; readonly rejectionReasons: readonly string[] }`
  - `function runBacktest(series: ReadonlyMap<string, BarSeries>, strategy: Strategy, opts: BacktestOptions): BacktestResult`

- [ ] **Step 1: Modifier `events.ts`**

Dans `src/backtest/events.ts`, remplacer la variante `bar-closed` :

```ts
export type BacktestEvent =
  | { readonly kind: 'bar-closed'; readonly symbol: string; readonly t: number }
```

par (un seul `bar-closed` par barre désormais, plus par symbole — `ctx.views` porte déjà toutes les paires) :

```ts
export type BacktestEvent =
  | {
      readonly kind: 'bar-closed';
      /** Index de barre dans la grille commune (pas un timestamp). */
      readonly t: number;
    }
```

Le reste du fichier (`order-requested`, `order-filled`, `order-rejected`) est inchangé.

- [ ] **Step 2: Réécrire `test/runner.test.ts`**

Remplacer tout le contenu de `test/runner.test.ts` par :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';
import { DEFAULT_FEES, simulateBuy, simulateSell } from '../src/backtest/execution.ts';
import { runBacktest } from '../src/backtest/runner.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

function seriesFrom(symbol: string, opens: number[], closes: number[], synthetic: number[]): BarSeries {
  const c = emptyColumns();
  opens.forEach((o, i) => {
    c.time.push(i * STEP);
    c.open.push(o);
    c.high.push(Math.max(o, closes[i]!));
    c.low.push(Math.min(o, closes[i]!));
    c.close.push(closes[i]!);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(synthetic[i]!);
  });
  return freezeSeries(symbol, 240, c);
}

/** Achète dès qu'elle est flat, vend dès qu'elle est en position — à chaque barre. */
function alwaysFlipStrategy(): Strategy {
  return {
    name: 'test-always-flip',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      const hasPosition = ctx.positions.has(SYMBOL);
      return [{ kind: hasPosition ? 'exit' : 'enter', symbol: SYMBOL, reason: 'test' } as const];
    },
  };
}

/** Émet toujours un `enter` pour un symbole étranger à l'univers du runner. */
function foreignSymbolStrategy(): Strategy {
  return {
    name: 'test-foreign-symbol',
    warmup: 1,
    params: {},
    decide(_ctx: StrategyContext) {
      return [{ kind: 'enter', symbol: 'AUTRE-SYMBOLE', reason: 'test' } as const];
    },
  };
}

/** Entre sur chaque symbole donné dès qu'il est flat — utilisé pour tester l'allocation multi-paires. */
function enterAllStrategy(symbols: readonly string[]): Strategy {
  return {
    name: 'test-enter-all',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      const intents: Intent[] = [];
      for (const symbol of symbols) {
        if (!ctx.positions.has(symbol)) {
          intents.push({ kind: 'enter', symbol, reason: 'test' });
        }
      }
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}

const EXEC_OPTS = { initialCash: 1000, fees: DEFAULT_FEES, slippageBps: 10, maxConcurrentPositions: 1 };

test('runBacktest : exécute un cycle achat puis vente au prochain open', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, opens, closes, [0, 0, 0, 0])]]);
  const strategy = alwaysFlipStrategy();

  const result = runBacktest(series, strategy, EXEC_OPTS);

  assert.equal(result.portfolio.trades.length, 2);
  assert.equal(result.portfolio.trades[0]?.side, 'buy');
  assert.equal(result.portfolio.trades[1]?.side, 'sell');
  assert.equal(result.portfolio.positions.size, 0);

  const expectedBuy = simulateBuy(1000, 110, { fees: DEFAULT_FEES, slippageBps: 10 });
  assert.ok(Math.abs((result.portfolio.trades[0]?.price ?? 0) - expectedBuy.price) < 1e-9);
  assert.ok(Math.abs((result.portfolio.trades[0]?.quantity ?? 0) - expectedBuy.quantity) < 1e-9);

  const expectedSell = simulateSell(expectedBuy.quantity, 120, { fees: DEFAULT_FEES, slippageBps: 10 });
  assert.ok(Math.abs((result.portfolio.trades[1]?.price ?? 0) - expectedSell.price) < 1e-9);

  assert.equal(result.equityCurve.length, 2);
  assert.equal(result.rejectedOrders, 0);
});

test("runBacktest : rejette l'exécution sur une barre suivante synthétique et réessaie", () => {
  const opens = [100, 100, 100, 120];
  const closes = [100, 100, 100, 120];
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, opens, closes, [0, 0, 1, 0])]]);
  const strategy = alwaysFlipStrategy();

  const result = runBacktest(series, strategy, EXEC_OPTS);

  assert.equal(result.rejectedOrders, 1);
  assert.equal(result.portfolio.trades.length, 1);
  assert.equal(result.portfolio.trades[0]?.side, 'buy');
  assert.equal(result.portfolio.positions.size, 1);
});

test('runBacktest : lève si la série est trop courte pour le warmup', () => {
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, [100, 100], [100, 100], [0, 0])]]);
  const strategy = alwaysFlipStrategy();
  assert.throws(() => runBacktest(series, strategy, EXEC_OPTS), /insuffisant/);
});

test('runBacktest : rejette un intent dont le symbole ne correspond à aucune série', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, opens, closes, [0, 0, 0, 0])]]);
  const strategy = foreignSymbolStrategy();

  const result = runBacktest(series, strategy, EXEC_OPTS);

  assert.ok(result.rejectedOrders > 0);
  assert.equal(result.portfolio.trades.length, 0);
  assert.equal(result.portfolio.positions.size, 0);
});

test('runBacktest : partage le capital entre paires concurrentes selon maxConcurrentPositions', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([
    ['AEUR', seriesFrom('AEUR', opens, closes, [0, 0, 0, 0])],
    ['BEUR', seriesFrom('BEUR', opens, closes, [0, 0, 0, 0])],
  ]);
  const strategy = enterAllStrategy(['AEUR', 'BEUR']);

  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 10,
    maxConcurrentPositions: 2,
  });

  assert.equal(result.portfolio.trades.length, 2);
  assert.equal(result.portfolio.positions.size, 2);
  assert.equal(result.rejectedOrders, 0);

  const expectedFill = simulateBuy(500, 110, { fees: DEFAULT_FEES, slippageBps: 10 });
  for (const trade of result.portfolio.trades) {
    assert.ok(Math.abs(trade.price - expectedFill.price) < 1e-9);
    assert.ok(Math.abs(trade.quantity - expectedFill.quantity) < 1e-9);
  }
  assert.ok(Math.abs(result.portfolio.cash) < 1e-6);
});

test('runBacktest : rejette un signal au-delà du plafond de positions concurrentes', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([
    ['AEUR', seriesFrom('AEUR', opens, closes, [0, 0, 0, 0])],
    ['BEUR', seriesFrom('BEUR', opens, closes, [0, 0, 0, 0])],
  ]);
  const strategy = enterAllStrategy(['AEUR', 'BEUR']);

  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 10,
    maxConcurrentPositions: 1,
  });

  assert.equal(result.portfolio.positions.size, 1);
  assert.equal(result.portfolio.trades.length, 1);
  assert.ok(result.rejectedOrders > 0);
  assert.ok(result.rejectionReasons.some((r) => r.includes('plafond')));
});
```

- [ ] **Step 3: Modifier `test/phase1.test.ts`**

Remplacer :

```ts
  const withFees = runBacktest(series, strategy, {
    initialCash,
    fees: DEFAULT_FEES,
    slippageBps: 5,
  });
```

par :

```ts
  const seriesMap = new Map([[SYMBOL, series]]);
  const withFees = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 1,
  });
```

Et remplacer :

```ts
  const frictionless = runBacktest(series, strategy, {
    initialCash,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
  });
```

par :

```ts
  const frictionless = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
    maxConcurrentPositions: 1,
  });
```

- [ ] **Step 4: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/runner.test.ts test/phase1.test.ts`
Expected: FAIL — `runBacktest` a encore l'ancienne signature `(series: BarSeries, ...)`, incompatible avec une `Map` ; `events.ts` a encore `symbol` sur `bar-closed`.

- [ ] **Step 5: Implémenter — remplacer tout le contenu de `src/backtest/runner.ts`**

```ts
/**
 * Runner event-driven du backtest.
 *
 * Rejoue plusieurs BarSeries alignées sur la même grille temporelle, barre
 * par barre, à travers une file d'événements typés (bar-closed →
 * order-requested → order-filled/order-rejected). Le futur live-runner
 * alimentera la même file depuis un flux temps réel — la logique
 * d'exécution et de portefeuille est déjà écrite pour être réutilisée
 * telle quelle.
 */

import type { BarSeries } from '../data/series.ts';
import type { Strategy, StrategyContext } from '../strategy/types.ts';
import { BarView } from '../strategy/types.ts';
import type { FeeSchedule } from './execution.ts';
import { simulateBuy, simulateSell } from './execution.ts';
import type { Portfolio } from './portfolio.ts';
import { applyBuyFill, applySellFill, createPortfolio, portfolioEquity } from './portfolio.ts';
import type { BacktestEvent } from './events.ts';

export interface BacktestOptions {
  readonly initialCash: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
  readonly maxConcurrentPositions: number;
}

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
}

export interface BacktestResult {
  readonly portfolio: Portfolio;
  readonly equityCurve: readonly EquityPoint[];
  readonly rejectedOrders: number;
  readonly rejectionReasons: readonly string[];
}

function marksAt(series: ReadonlyMap<string, BarSeries>, t: number): Map<string, number> {
  const marks = new Map<string, number>();
  for (const [symbol, s] of series) {
    marks.set(symbol, s.close[t]!);
  }
  return marks;
}

export function runBacktest(
  series: ReadonlyMap<string, BarSeries>,
  strategy: Strategy,
  opts: BacktestOptions,
): BacktestResult {
  if (series.size === 0) {
    throw new Error('runBacktest : au moins une série requise');
  }
  if (!(opts.maxConcurrentPositions >= 1)) {
    throw new RangeError(`maxConcurrentPositions invalide : ${opts.maxConcurrentPositions}`);
  }

  const entries = [...series];
  const [firstSymbol, firstSeries] = entries[0]!;
  const length = firstSeries.length;
  for (const [symbol, s] of entries) {
    if (s.length !== length) {
      throw new Error(
        `Grille temporelle incohérente : ${symbol} a ${s.length} barre(s), ${firstSymbol} en a ${length}`,
      );
    }
    if (s.time[0] !== firstSeries.time[0] || s.time[length - 1] !== firstSeries.time[length - 1]) {
      throw new Error(
        `Grille temporelle incohérente entre ${symbol} et ${firstSymbol} : bornes temporelles différentes`,
      );
    }
  }

  if (length < strategy.warmup + 2) {
    throw new Error(
      `${length} barre(s), insuffisant pour un warmup de ${strategy.warmup} barre(s) ` +
        `avec exécution sur la barre suivante`,
    );
  }

  const portfolio = createPortfolio(opts.initialCash);
  const equityCurve: EquityPoint[] = [];
  let rejectedOrders = 0;
  const rejectionReasons: string[] = [];
  const execOpts = { fees: opts.fees, slippageBps: opts.slippageBps };
  const time = firstSeries.time;

  for (let t = strategy.warmup; t <= length - 2; t++) {
    const equitySnapshot = portfolioEquity(portfolio, marksAt(series, t));
    const queue: BacktestEvent[] = [{ kind: 'bar-closed', t }];

    while (queue.length > 0) {
      const event = queue.shift()!;

      switch (event.kind) {
        case 'bar-closed': {
          const views = new Map<string, BarView>();
          for (const [symbol, s] of series) {
            views.set(symbol, new BarView(s, event.t));
          }
          const ctx: StrategyContext = {
            views,
            positions: portfolio.positions,
            now: time[event.t]!,
          };
          for (const intent of strategy.decide(ctx)) {
            if (intent.kind === 'enter') {
              queue.push({ kind: 'order-requested', symbol: intent.symbol, side: 'buy', reason: intent.reason });
            } else if (intent.kind === 'exit') {
              queue.push({ kind: 'order-requested', symbol: intent.symbol, side: 'sell', reason: intent.reason });
            }
          }
          break;
        }

        case 'order-requested': {
          const targetSeries = series.get(event.symbol);
          if (!targetSeries) {
            queue.push({
              kind: 'order-rejected',
              symbol: event.symbol,
              side: event.side,
              reason: 'symbole hors univers du runner',
              time: time[t]!,
            });
            break;
          }

          const fillT = t + 1;
          const fillTime = targetSeries.time[fillT]!;
          let budget = 0;

          if (event.side === 'buy') {
            if (portfolio.positions.size >= opts.maxConcurrentPositions) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: 'plafond de positions concurrentes atteint',
                time: fillTime,
              });
              break;
            }
            if (portfolio.positions.has(event.symbol)) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: 'position déjà ouverte sur ce symbole',
                time: fillTime,
              });
              break;
            }
            budget = Math.min(portfolio.cash, equitySnapshot / opts.maxConcurrentPositions);
            if (!(budget > 0)) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: 'budget alloué insuffisant',
                time: fillTime,
              });
              break;
            }
          }

          if (targetSeries.synthetic[fillT] === 1) {
            queue.push({
              kind: 'order-rejected',
              symbol: event.symbol,
              side: event.side,
              reason: 'barre suivante synthétique',
              time: fillTime,
            });
            break;
          }

          const referencePrice = targetSeries.open[fillT]!;
          if (event.side === 'buy') {
            const fill = simulateBuy(budget, referencePrice, execOpts);
            queue.push({
              kind: 'order-filled',
              symbol: event.symbol,
              side: 'buy',
              quantity: fill.quantity,
              price: fill.price,
              fee: fill.fee,
              time: fillTime,
            });
          } else {
            const position = portfolio.positions.get(event.symbol);
            if (!position) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'sell',
                reason: 'aucune position ouverte',
                time: fillTime,
              });
              break;
            }
            const fill = simulateSell(position.quantity, referencePrice, execOpts);
            queue.push({
              kind: 'order-filled',
              symbol: event.symbol,
              side: 'sell',
              quantity: fill.quantity,
              price: fill.price,
              fee: fill.fee,
              time: fillTime,
            });
          }
          break;
        }

        case 'order-filled': {
          const fill = { price: event.price, quantity: event.quantity, fee: event.fee };
          if (event.side === 'buy') {
            applyBuyFill(portfolio, event.symbol, fill, event.time);
          } else {
            applySellFill(portfolio, event.symbol, fill, event.time);
          }
          break;
        }

        case 'order-rejected': {
          rejectedOrders++;
          rejectionReasons.push(event.reason);
          break;
        }
      }
    }

    equityCurve.push({
      time: time[t + 1]!,
      equity: portfolioEquity(portfolio, marksAt(series, t + 1)),
    });
  }

  return { portfolio, equityCurve, rejectedOrders, rejectionReasons };
}
```

- [ ] **Step 6: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/runner.test.ts test/phase1.test.ts`
Expected: PASS (6 + 1 tests)

- [ ] **Step 7: Suite complète et typecheck**

Run: `npm test`
Expected: tous les tests passent

Run: `npm run typecheck`
Expected: aucune erreur

- [ ] **Step 8: Commit**

```bash
git add src/backtest/events.ts src/backtest/runner.ts test/runner.test.ts test/phase1.test.ts
git commit -m "$(cat <<'EOF'
feat(backtest): runner multi-paires avec allocation de capital

runBacktest prend désormais une Map<symbole, BarSeries> (rupture de
compatibilité assumée, tests Phase 1 mis à jour). Un seul bar-closed par
barre (ctx.views porte déjà toutes les paires depuis la Phase 0) — plus un
par symbole. Budget d'entrée = min(cash, équité/maxConcurrentPositions),
plafond et positions déjà ouvertes refusés proprement plutôt que de
planter. BacktestResult expose désormais rejectionReasons pour permettre
de distinguer la cause d'un rejet dans les tests.
EOF
)"
```

---

## Task 4: Test du critère de sortie de la Phase 2, et mise à jour du README

**Files:**
- Create: `test/phase2.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes :
  - `runBacktest`, `BacktestOptions`, `BacktestResult` (`src/backtest/runner.ts`, Task 3)
  - `combineStrategies` (`src/strategy/combineStrategies.ts`, Task 2)
  - `createMaCrossover` (`src/strategy/maCrossover.ts`, existant, inchangé)
  - `DEFAULT_FEES` (`src/backtest/execution.ts`, existant, inchangé)
- Produces : rien (fichier de test terminal, pas de nouveau module source)

- [ ] **Step 1: Écrire le test**

Créer `test/phase2.test.ts` :

```ts
/**
 * Critère de sortie de la Phase 2 (voir README) : le backtest multi-paires
 * ne dépasse jamais le capital disponible.
 *
 * Trois paires synthétiques identiques (même trajectoire de prix, donc
 * croisements garantis simultanés) forcent un dépassement du plafond de
 * positions concurrentes dans un scénario réaliste. Le test prouve que ce
 * dépassement est refusé proprement (order-rejected, raison "plafond..."),
 * pas qu'il ne se produit jamais — l'invariant que la Phase 1, mono-pair
 * par construction, ne pouvait pas violer et que la Phase 2 doit
 * maintenant garantir explicitement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const STEP = 14_400;
const SYMBOLS = ['AEUR', 'BEUR', 'CEUR'];

function oscillatingSeries(
  symbol: string,
  bars: number,
  base: number,
  amplitude: number,
  cycleLen: number,
): BarSeries {
  const c = emptyColumns();
  for (let i = 0; i < bars; i++) {
    const close = base + amplitude * Math.sin((2 * Math.PI * i) / cycleLen);
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(symbol, 240, c);
}

test('Phase 2 — critère de sortie : le multi-paires ne dépasse jamais le capital disponible', () => {
  const series = new Map(
    SYMBOLS.map((symbol) => [symbol, oscillatingSeries(symbol, 200, 100, 0.2, 20)] as const),
  );
  const strategy = combineStrategies(
    SYMBOLS.map((symbol) => createMaCrossover({ symbol, fast: 3, slow: 7 })),
  );

  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 2,
  });

  assert.ok(
    result.rejectedOrders > 0,
    `attendu au moins un rejet, obtenu ${result.rejectedOrders}`,
  );
  assert.ok(
    result.rejectionReasons.some((r) => r.includes('plafond')),
    `attendu au moins un rejet par plafond parmi [${result.rejectionReasons.join(', ')}]`,
  );

  assert.ok(
    result.portfolio.positions.size <= 2,
    `attendu au plus 2 positions ouvertes, obtenu ${result.portfolio.positions.size}`,
  );

  assert.ok(
    result.equityCurve.every((p) => p.equity >= 0),
    'attendu une équité jamais négative sur toute la courbe',
  );
});
```

- [ ] **Step 2: Lancer le test**

Run: `node --experimental-strip-types --test test/phase2.test.ts`

Les trois paires ont une trajectoire de prix identique (même `oscillatingSeries` appelée trois fois avec les mêmes paramètres), donc leurs croisements de moyennes mobiles se produisent exactement sur les mêmes barres — avec `maxConcurrentPositions = 2` et 3 paires signalant `enter` simultanément, un rejet par plafond est garanti dès le premier cycle. Si l'assertion sur `rejectionReasons` échoue malgré tout, vérifier que les trois séries sont bien identiques bar à bar (paramètres `oscillatingSeries` identiques) — c'est ce qui garantit la simultanéité, pas un réglage fin à itérer.

Expected : PASS (1 test)

- [ ] **Step 3: Suite complète et typecheck**

Run: `npm test`
Expected : tous les tests passent (Phase 0 + Phase 1 + Phase 2)

Run: `npm run typecheck`
Expected : aucune erreur

- [ ] **Step 4: Mettre à jour `README.md`**

- Mettre à jour le titre/intro pour refléter que la Phase 2 est terminée (rester concis, dans le style existant).
- Mettre à jour le nombre de tests dans la section Démarrage avec le total réel obtenu à l'étape 3 (lire la ligne `# tests N` dans la sortie de `npm test`, ne pas deviner le nombre).
- Ajouter au bloc Structure : `src/strategy/combineStrategies.ts` (une ligne de description dans le style des entrées existantes) ; mentionner que `portfolioEquity` a été ajouté à `src/backtest/portfolio.ts` si le format du bloc s'y prête (une ligne par fichier, pas par fonction — ne pas sur-détailler).
- Mettre à jour la section Suite : marquer la Phase 2 terminée, lier au test `test/phase2.test.ts` comme preuve du critère de sortie, et mettre à jour la liste « Hors périmètre, reporté » en retirant « Multi-paires / allocation de capital entre positions concurrentes » (fait) et en gardant les points encore non traités (sizing par risque ATR, ordres limites, live-runner, backtest sur l'univers réel des 20 paires).

- [ ] **Step 5: Commit**

```bash
git add test/phase2.test.ts README.md
git commit -m "$(cat <<'EOF'
test(phase2): critère de sortie — le multi-paires respecte le capital

Trois paires synthétiques identiques forcent un dépassement du plafond
de positions concurrentes dans un scénario réaliste ; le test prouve le
rejet propre (order-rejected, raison "plafond...") et l'absence
d'équité négative sur toute la courbe. README mis à jour pour la
Phase 2.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — chaque section de
`docs/superpowers/specs/2026-08-23-phase2-multi-pair-allocation-design.md`
est couverte : §1 portefeuille → Task 1 ; §2 combinateur → Task 2 ;
§3 runner généralisé → Task 3 ; §4 test du critère de sortie → Task 4.

**Corrections apportées pendant l'écriture du plan** (au-delà de la spec,
détectées en écrivant le code réel) :
- La spec ne mentionnait pas de modification de `src/backtest/events.ts`,
  mais pousser un `bar-closed` par symbole (comme le ferait une lecture
  littérale de la Phase 1 généralisée naïvement) aurait fait appeler
  `strategy.decide(ctx)` une fois par symbole par barre au lieu d'une
  fois par barre — `combineStrategies` aurait alors réévalué toutes ses
  sous-stratégies N fois par barre et émis des intentions dupliquées. Le
  champ `symbol` de la variante `bar-closed` est retiré : un seul
  événement par barre, `ctx.views` porte déjà toutes les paires.
- Assertion approuvée en conversation (« rejet dont la raison contient
  plafond ») nécessitait d'exposer les raisons de rejet, absentes de
  `BacktestResult` en Phase 1. Ajout de `rejectionReasons: readonly string[]`
  — clôt au passage un finding parqué de la revue finale Phase 1
  (« les raisons sont construites et jetées »).
- Profité de la modification de `portfolio.ts` (Task 1, déjà nécessaire
  pour `portfolioEquity`) pour corriger un second finding parqué de la
  revue finale Phase 1 : la garde de coût d'`applyBuyFill` était
  franchissable par un coût `NaN`.

**Cohérence des types** — vérifié que `portfolioEquity` (Task 1) a la
signature `(Portfolio, ReadonlyMap<string, number>) => number` utilisée
identiquement dans `runner.ts` (Task 3, via `marksAt`) ; `combineStrategies`
(Task 2) a la signature `(readonly Strategy[]) => Strategy` utilisée
identiquement en Task 4 ; `BacktestOptions`/`BacktestResult` (Task 3) ont
les mêmes champs dans leur définition et dans tous les sites d'appel des
Tasks 3 et 4.

**Aucun placeholder** — chaque step contient le code complet à écrire. Le
seul point de vérification manuelle (Task 4, Step 2) porte sur une
assertion déjà entièrement écrite, avec une garantie structurelle
(séries identiques ⇒ croisements simultanés) plutôt qu'un réglage à
itérer à l'aveugle.
