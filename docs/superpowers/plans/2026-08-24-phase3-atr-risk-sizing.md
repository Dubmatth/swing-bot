# Phase 3 — Sizing par risque ATR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un sizing de position par risque (« risquer X % du capital sur N×ATR »), en plafond additionnel au-dessus du plafond fraction fixe de la Phase 2 — jamais en remplacement — et démontrer que ça normalise l'exposition entre paires de volatilité différente sans jamais dépasser le plafond de sécurité déjà prouvé.

**Architecture:** `Intent.enter` gagne un champ optionnel `stopDistance` (calculé par la stratégie via sa propre `Atr`, comme `maCrossover` calcule déjà sa propre `Sma`) ; une nouvelle stratégie de référence `createAtrRiskCrossover` l'émet ; le runner le propage via `order-requested.stopDistance` et l'utilise pour resserrer (jamais élargir) le budget déjà plafonné par `min(cash, équité/maxConcurrentPositions)`.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas d'étape de build), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-24-phase3-atr-risk-sizing-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`.
- `exactOptionalPropertyTypes: true` — un champ `foo?: T` interdit d'écrire `foo: undefined` explicitement dans un literal objet ; utiliser un spread conditionnel (`...(x !== undefined ? { foo: x } : {})`) pour propager une valeur potentiellement absente d'un objet à un autre.
- Commentaires et messages d'erreur en français, cohérents avec le style existant.
- `stopDistance` (Intent, `order-requested`) est optionnel et rétrocompatible : absent ⇒ comportement du runner identique bit-à-bit à la Phase 2. `maCrossover.ts` n'est pas modifié.
- Le plafond fraction fixe de la Phase 2 (`min(cash, équité/maxConcurrentPositions)`) reste calculé en premier et toujours actif ; le sizing par risque ne peut que réduire le budget final (`Math.min`), jamais l'augmenter.
- `riskPerTradePct` (nouveau champ obligatoire de `BacktestOptions`) doit être un nombre fini strictement positif, validé au même endroit que `maxConcurrentPositions`.
- Une `stopDistance` non finie ou non positive fournie par une stratégie est refusée proprement (`order-rejected`, raison contenant `stopDistance`) — jamais un `throw` qui interromprait tout le backtest.
- Commande de test par fichier : `node --experimental-strip-types --test test/<fichier>.test.ts`. Commande globale : `npm test` (`npm run typecheck` pour la vérification de types).

---

## Task 1: `Intent.stopDistance` et stratégie de référence `createAtrRiskCrossover`

**Files:**
- Modify: `src/strategy/types.ts`
- Create: `src/strategy/atrRiskCrossover.ts`
- Test: `test/atrRiskCrossover.test.ts`

**Interfaces:**
- Consumes : `BarView`, `Strategy`, `StrategyContext`, `Position` (`src/strategy/types.ts`, existant sauf `Intent` modifié dans cette tâche) ; `Sma`, `Atr` (`src/strategy/indicators.ts`, existant, inchangé).
- Produces :
  - `Intent` étendu : `{ kind: 'enter'; symbol: string; reason: string; stopDistance?: number }`
  - `interface AtrRiskCrossoverParams { readonly symbol: string; readonly fast: number; readonly slow: number; readonly atrPeriod: number; readonly atrMultiplier: number }`
  - `function createAtrRiskCrossover(params: AtrRiskCrossoverParams): Strategy`

- [ ] **Step 1: Modifier `src/strategy/types.ts`**

Trouver :

```ts
export type Intent =
  | { readonly kind: 'enter'; readonly symbol: string; readonly reason: string }
  | { readonly kind: 'exit'; readonly symbol: string; readonly reason: string }
  | { readonly kind: 'hold' };
```

Remplacer par :

```ts
export type Intent =
  | {
      readonly kind: 'enter';
      readonly symbol: string;
      readonly reason: string;
      /** Distance de stop en prix (pas en %), pour le sizing par risque du runner. Optionnel. */
      readonly stopDistance?: number;
    }
  | { readonly kind: 'exit'; readonly symbol: string; readonly reason: string }
  | { readonly kind: 'hold' };
```

Rien d'autre dans ce fichier ne change.

- [ ] **Step 2: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/atrRiskCrossover.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createAtrRiskCrossover } from '../src/strategy/atrRiskCrossover.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

function seriesFrom(closes: number[]): BarSeries {
  const c = emptyColumns();
  closes.forEach((close, i) => {
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(SYMBOL, 240, c);
}

function ctxFor(closes: number[], position?: Position): StrategyContext {
  const series = seriesFrom(closes);
  const view = new BarView(series, series.length - 1);
  const positions = new Map<string, Position>();
  if (position) positions.set(SYMBOL, position);
  return { views: new Map([[SYMBOL, view]]), positions, now: view.time(0) };
}

test('createAtrRiskCrossover : warmup vaut le max(slow, atrPeriod), params exposés', () => {
  const s = createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 2 });
  assert.equal(s.warmup, 4);
  assert.deepEqual(s.params, { fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 2 });

  const s2 = createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 6, atrMultiplier: 2 });
  assert.equal(s2.warmup, 6);
});

test('createAtrRiskCrossover : période fast invalide lève', () => {
  assert.throws(
    () => createAtrRiskCrossover({ symbol: SYMBOL, fast: 0, slow: 4, atrPeriod: 3, atrMultiplier: 2 }),
    /fast/,
  );
});

test('createAtrRiskCrossover : période slow <= fast lève', () => {
  assert.throws(
    () => createAtrRiskCrossover({ symbol: SYMBOL, fast: 5, slow: 5, atrPeriod: 3, atrMultiplier: 2 }),
    /slow/,
  );
});

test('createAtrRiskCrossover : période ATR invalide lève dès la construction', () => {
  assert.throws(
    () => createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 0, atrMultiplier: 2 }),
    /ATR/,
  );
});

test('createAtrRiskCrossover : atrMultiplier invalide lève', () => {
  assert.throws(
    () => createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 0 }),
    /atrMultiplier/,
  );
});

test("decide : signal d'entrée porte un stopDistance = atrMultiplier × ATR", () => {
  const s = createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 2 });
  // sma(2)=25 > sma(4)=17.5 (mêmes valeurs que le fixture maCrossover existant).
  // ATR(3) sur les 3 dernières barres [10,10,40] : TR=[0,0,30] → moyenne mobile
  // bootstrap de Wilder sur n<=période → acc final = 30/3 = 10.
  const ctx = ctxFor([10, 10, 10, 40]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
  assert.ok(intents[0]?.kind === 'enter' && Math.abs(intents[0].stopDistance! - 20) < 1e-9);
});

test('decide : signal de sortie ne porte pas de stopDistance', () => {
  const s = createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 2 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 40, entryTime: 0 };
  const ctx = ctxFor([40, 10, 10, 10], position); // sma(2)=10 < sma(4)=17.5
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
  assert.ok(!('stopDistance' in intents[0]!));
});

test('decide : hold si fast > slow mais déjà en position', () => {
  const s = createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 2 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor([10, 10, 10, 40], position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : hold si fast < slow et pas de position', () => {
  const s = createAtrRiskCrossover({ symbol: SYMBOL, fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 2 });
  const ctx = ctxFor([40, 10, 10, 10]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : symbole absent du contexte renvoie hold sans lever', () => {
  const s = createAtrRiskCrossover({ symbol: 'AUTRE', fast: 2, slow: 4, atrPeriod: 3, atrMultiplier: 2 });
  const ctx = ctxFor([10, 10, 10, 40]);
  assert.doesNotThrow(() => s.decide(ctx));
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});
```

- [ ] **Step 3: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/atrRiskCrossover.test.ts`
Expected: FAIL — `src/strategy/atrRiskCrossover.ts` n'existe pas.

- [ ] **Step 4: Implémenter**

Créer `src/strategy/atrRiskCrossover.ts` :

```ts
/**
 * Stratégie de référence : croisement de deux moyennes mobiles simples,
 * avec sizing par risque basé sur l'ATR.
 *
 * Même logique de signal que maCrossover.ts (voir ce fichier pour le détail
 * du contrat de pureté — decide() recalcule tout à chaque appel, sans état
 * interne persistant) ; maCrossover.ts lui-même n'est pas modifié. Cette
 * variante calcule en plus une distance de stop (atrMultiplier × ATR)
 * transmise au runner via Intent.stopDistance, qui l'utilise pour
 * dimensionner la position par risque plutôt qu'en fraction fixe pure (voir
 * runner.ts). C'est la motivation d'origine du commentaire de la classe Atr
 * dans indicators.ts : normaliser l'exposition entre une paire peu volatile
 * et une paire trois fois plus volatile.
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';
import { Atr, Sma } from './indicators.ts';

export interface AtrRiskCrossoverParams {
  readonly symbol: string;
  readonly fast: number;
  readonly slow: number;
  readonly atrPeriod: number;
  readonly atrMultiplier: number;
}

function sma(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

function atr(view: BarView, period: number): number {
  const a = new Atr(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    a.update(view.high(ago), view.low(ago), view.close(ago));
  }
  return a.value;
}

export function createAtrRiskCrossover(params: AtrRiskCrossoverParams): Strategy {
  const { symbol, fast, slow, atrPeriod, atrMultiplier } = params;
  if (!Number.isInteger(fast) || fast < 1) {
    throw new RangeError(`Période fast invalide : ${fast}`);
  }
  if (!Number.isInteger(slow) || slow <= fast) {
    throw new RangeError(`Période slow invalide : ${slow} (doit être > fast=${fast})`);
  }
  if (!Number.isInteger(atrPeriod) || atrPeriod < 1) {
    throw new RangeError(`Période ATR invalide : ${atrPeriod}`);
  }
  if (!(atrMultiplier > 0)) {
    throw new RangeError(`atrMultiplier invalide : ${atrMultiplier}`);
  }

  const warmup = Math.max(slow, atrPeriod);

  return {
    name: 'atr-risk-crossover',
    warmup,
    params: { fast, slow, atrPeriod, atrMultiplier },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const fastVal = sma(view, fast);
      const slowVal = sma(view, slow);
      const hasPosition = ctx.positions.has(symbol);

      if (!hasPosition && fastVal > slowVal) {
        const atrVal = atr(view, atrPeriod);
        return [{
          kind: 'enter',
          symbol,
          reason: `sma(${fast})=${fastVal.toFixed(4)} > sma(${slow})=${slowVal.toFixed(4)}`,
          stopDistance: atrMultiplier * atrVal,
        }];
      }
      if (hasPosition && fastVal < slowVal) {
        return [{
          kind: 'exit',
          symbol,
          reason: `sma(${fast})=${fastVal.toFixed(4)} < sma(${slow})=${slowVal.toFixed(4)}`,
        }];
      }
      return [{ kind: 'hold' }];
    },
  };
}
```

**Point de conception important** (déjà résolu, transcrire tel quel) : la
validation de `atrPeriod` doit se faire explicitement au constructeur, pas
en laissant `new Atr(atrPeriod)` lever paresseusement à l'intérieur de
`atr()` — sinon un `atrPeriod` invalide ne serait détecté qu'au premier
appel de `decide()` où un signal d'entrée se déclenche (voire jamais, si
aucun signal ne se déclenche pendant tout le backtest), ce qui romprait la
validation eager que `maCrossover` applique déjà à `fast`/`slow`.

- [ ] **Step 5: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/atrRiskCrossover.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (l'ajout du champ optionnel `stopDistance` à `Intent` ne casse aucun test existant — aucun ne construit de literal `Intent` incompatible avec un champ en plus, optionnel)

- [ ] **Step 7: Commit**

```bash
git add src/strategy/types.ts src/strategy/atrRiskCrossover.ts test/atrRiskCrossover.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): Intent.stopDistance + createAtrRiskCrossover

Champ optionnel et rétrocompatible sur Intent.enter — maCrossover.ts
n'est pas modifié, zéro risque sur les fixtures Phase 1/2 déjà mergées.
La nouvelle stratégie recalcule son ATR à chaque appel de decide()
(même discipline de pureté que maCrossover), et valide atrPeriod dès
la construction plutôt que de laisser new Atr() lever paresseusement
au premier signal.
EOF
)"
```

---

## Task 2: Runner — sizing par risque en plafond additionnel

**Files:**
- Modify: `src/backtest/events.ts`
- Modify: `src/backtest/runner.ts`
- Modify: `test/runner.test.ts`
- Modify: `test/phase1.test.ts`
- Modify: `test/phase2.test.ts`

**Interfaces:**
- Consumes : `Intent.stopDistance` (Task 1, optionnel) ; `simulateBuy`, `simulateSell`, `FeeSchedule` (`src/backtest/execution.ts`, existant, inchangé) ; `applyBuyFill`, `applySellFill`, `createPortfolio`, `portfolioEquity` (`src/backtest/portfolio.ts`, existant, inchangé).
- Produces :
  - `BacktestEvent`'s `order-requested` étendu : `{ kind: 'order-requested'; symbol: string; side: 'buy' | 'sell'; reason: string; stopDistance?: number }`
  - `BacktestOptions` étendu : `{ initialCash: number; fees: FeeSchedule; slippageBps: number; maxConcurrentPositions: number; riskPerTradePct: number }`
  - `runBacktest` : signature inchangée par ailleurs, comportement identique bit-à-bit à la Phase 2 quand aucun intent ne porte de `stopDistance`.

- [ ] **Step 1: Modifier `src/backtest/events.ts`**

Trouver :

```ts
  | { readonly kind: 'order-requested'; readonly symbol: string; readonly side: 'buy' | 'sell'; readonly reason: string }
```

Remplacer par :

```ts
  | {
      readonly kind: 'order-requested';
      readonly symbol: string;
      readonly side: 'buy' | 'sell';
      readonly reason: string;
      /** Distance de stop transmise depuis Intent.enter, pour le sizing par risque. Absent côté vente. */
      readonly stopDistance?: number;
    }
```

Rien d'autre dans ce fichier ne change.

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

/** Émet enter(a) au démarrage, puis rotation exit(a)+enter(b) dans l'ordre donné dès que a est ouverte. */
function rotateStrategy(a: string, b: string, exitFirst: boolean): Strategy {
  return {
    name: 'test-rotate',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      const hasA = ctx.positions.has(a);
      const hasB = ctx.positions.has(b);
      if (!hasA && !hasB) {
        return [{ kind: 'enter', symbol: a, reason: 'init' }];
      }
      if (hasA && !hasB) {
        const exitIntent: Intent = { kind: 'exit', symbol: a, reason: 'rotate' };
        const enterIntent: Intent = { kind: 'enter', symbol: b, reason: 'rotate' };
        return exitFirst ? [exitIntent, enterIntent] : [enterIntent, exitIntent];
      }
      return [{ kind: 'hold' }];
    },
  };
}

/** Émet toujours un enter avec le stopDistance donné (undefined = pas de sizing par risque). */
function enterWithStopStrategy(stopDistance?: number): Strategy {
  return {
    name: 'test-enter-with-stop',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      if (ctx.positions.has(SYMBOL)) return [{ kind: 'hold' }];
      return [{
        kind: 'enter',
        symbol: SYMBOL,
        reason: 'test',
        ...(stopDistance !== undefined ? { stopDistance } : {}),
      }];
    },
  };
}

const EXEC_OPTS = {
  initialCash: 1000,
  fees: DEFAULT_FEES,
  slippageBps: 10,
  maxConcurrentPositions: 1,
  riskPerTradePct: 1,
};

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
    riskPerTradePct: 1,
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
    riskPerTradePct: 1,
  });

  assert.equal(result.portfolio.positions.size, 1);
  assert.equal(result.portfolio.trades.length, 1);
  assert.ok(result.rejectedOrders > 0);
  assert.ok(result.rejectionReasons.some((r) => r.includes('plafond')));
});

test('runBacktest : sous plafond saturé, exit avant enter dans la même barre permet la rotation', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([
    ['AEUR', seriesFrom('AEUR', opens, closes, [0, 0, 0, 0])],
    ['BEUR', seriesFrom('BEUR', opens, closes, [0, 0, 0, 0])],
  ]);
  const strategy = rotateStrategy('AEUR', 'BEUR', true);

  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 10,
    maxConcurrentPositions: 1,
    riskPerTradePct: 1,
  });

  assert.equal(result.rejectedOrders, 0);
  assert.equal(result.portfolio.trades.length, 3);
  assert.equal(result.portfolio.positions.size, 1);
  assert.ok(result.portfolio.positions.has('BEUR'));
});

test('runBacktest : sous plafond saturé, enter avant exit dans la même barre perd le signal (rejeté proprement)', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([
    ['AEUR', seriesFrom('AEUR', opens, closes, [0, 0, 0, 0])],
    ['BEUR', seriesFrom('BEUR', opens, closes, [0, 0, 0, 0])],
  ]);
  const strategy = rotateStrategy('AEUR', 'BEUR', false);

  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 10,
    maxConcurrentPositions: 1,
    riskPerTradePct: 1,
  });

  assert.equal(result.rejectedOrders, 1);
  assert.ok(result.rejectionReasons.some((r) => r.includes('plafond')));
  assert.equal(result.portfolio.trades.length, 2);
  assert.equal(result.portfolio.positions.size, 0);
});

test('runBacktest : appelle strategy.decide exactement une fois par barre (pas une fois par symbole)', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([
    ['AEUR', seriesFrom('AEUR', opens, closes, [0, 0, 0, 0])],
    ['BEUR', seriesFrom('BEUR', opens, closes, [0, 0, 0, 0])],
  ]);
  let calls = 0;
  const strategy: Strategy = {
    name: 'test-count-calls',
    warmup: 1,
    params: {},
    decide(_ctx: StrategyContext) {
      calls++;
      return [{ kind: 'hold' }];
    },
  };

  runBacktest(series, strategy, EXEC_OPTS);

  // t de warmup(1) à length-2(2) inclus, sur 4 barres → 2 itérations, donc 2 appels.
  assert.equal(calls, 2);
});

test('runBacktest : maxConcurrentPositions non entier lève', () => {
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, [100, 100, 110, 120], [100, 100, 110, 120], [0, 0, 0, 0])]]);
  const strategy = rotateStrategy(SYMBOL, SYMBOL, true); // stratégie quelconque, jamais exécutée : le throw a lieu avant la boucle
  assert.throws(
    () => runBacktest(series, strategy, { ...EXEC_OPTS, maxConcurrentPositions: 1.5 }),
    /maxConcurrentPositions/,
  );
});

test('runBacktest : riskPerTradePct invalide lève', () => {
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, [100, 100, 110, 120], [100, 100, 110, 120], [0, 0, 0, 0])]]);
  const strategy = alwaysFlipStrategy();
  assert.throws(
    () => runBacktest(series, strategy, { ...EXEC_OPTS, riskPerTradePct: 0 }),
    /riskPerTradePct/,
  );
  assert.throws(
    () => runBacktest(series, strategy, { ...EXEC_OPTS, riskPerTradePct: -1 }),
    /riskPerTradePct/,
  );
});

test('runBacktest : le sizing par risque plafonne le budget sous le plafond fraction fixe quand stopDistance est fourni', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, opens, closes, [0, 0, 0, 0])]]);
  const strategy = enterWithStopStrategy(5);

  // equitySnapshot=1000 (pas de position ouverte), riskPerTradePct=0.01,
  // stopDistance=5, referencePrice=open[2]=110 :
  // riskBudget = (1000*0.01/5)*110 = 220, plus petit que le plafond fraction
  // fixe (1000, maxConcurrentPositions=1) — c'est lui qui doit gagner.
  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 10,
    maxConcurrentPositions: 1,
    riskPerTradePct: 0.01,
  });

  assert.equal(result.portfolio.trades.length, 1);
  const expectedFill = simulateBuy(220, 110, { fees: DEFAULT_FEES, slippageBps: 10 });
  assert.ok(Math.abs((result.portfolio.trades[0]?.price ?? 0) - expectedFill.price) < 1e-9);
  assert.ok(Math.abs((result.portfolio.trades[0]?.quantity ?? 0) - expectedFill.quantity) < 1e-9);
});

test('runBacktest : rejette proprement un stopDistance invalide plutôt que de planter', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = new Map([[SYMBOL, seriesFrom(SYMBOL, opens, closes, [0, 0, 0, 0])]]);
  const strategy = enterWithStopStrategy(-5);

  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 10,
    maxConcurrentPositions: 1,
    riskPerTradePct: 0.01,
  });

  assert.equal(result.portfolio.trades.length, 0);
  assert.ok(result.rejectedOrders > 0);
  assert.ok(result.rejectionReasons.some((r) => r.includes('stopDistance')));
});
```

- [ ] **Step 3: Modifier `test/phase1.test.ts`**

Trouver (première occurrence) :

```ts
  const withFees = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 1,
  });
```

Remplacer par :

```ts
  const withFees = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 1,
    riskPerTradePct: 1,
  });
```

Trouver (deuxième occurrence) :

```ts
  const frictionless = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
    maxConcurrentPositions: 1,
  });
```

Remplacer par :

```ts
  const frictionless = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
    maxConcurrentPositions: 1,
    riskPerTradePct: 1,
  });
```

(`createMaCrossover` n'émet jamais de `stopDistance`, `riskPerTradePct` est
donc inerte ici — n'importe quelle valeur positive valide conviendrait, `1`
garde la cohérence avec `test/runner.test.ts`.)

- [ ] **Step 4: Modifier `test/phase2.test.ts`**

Trouver :

```ts
  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 2,
  });
```

Remplacer par :

```ts
  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 2,
    riskPerTradePct: 1,
  });
```

- [ ] **Step 5: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/runner.test.ts test/phase1.test.ts test/phase2.test.ts`
Expected: FAIL — `runner.ts` n'accepte pas encore `stopDistance`/`riskPerTradePct` (erreurs de type sur les nouveaux champs, comportement de rejet du sizing par risque pas encore implémenté).

- [ ] **Step 6: Implémenter — remplacer tout le contenu de `src/backtest/runner.ts`**

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
 *
 * Discipline de file : voir events.ts — tout événement mutant (order-filled)
 * passe avant tout événement en attente qui lit l'état du portefeuille.
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
  readonly riskPerTradePct: number;
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
  if (!Number.isInteger(opts.maxConcurrentPositions) || opts.maxConcurrentPositions < 1) {
    throw new RangeError(`maxConcurrentPositions invalide : ${opts.maxConcurrentPositions}`);
  }
  if (!Number.isFinite(opts.riskPerTradePct) || !(opts.riskPerTradePct > 0)) {
    throw new RangeError(`riskPerTradePct invalide : ${opts.riskPerTradePct}`);
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
              queue.push({
                kind: 'order-requested',
                symbol: intent.symbol,
                side: 'buy',
                reason: intent.reason,
                ...(intent.stopDistance !== undefined ? { stopDistance: intent.stopDistance } : {}),
              });
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
          const referencePrice = targetSeries.open[fillT]!;
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
            if (event.stopDistance !== undefined) {
              if (!(event.stopDistance > 0)) {
                queue.push({
                  kind: 'order-rejected',
                  symbol: event.symbol,
                  side: 'buy',
                  reason: 'stopDistance invalide',
                  time: fillTime,
                });
                break;
              }
              const riskBudget =
                ((equitySnapshot * opts.riskPerTradePct) / event.stopDistance) * referencePrice;
              budget = Math.min(budget, riskBudget);
            }
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

          if (event.side === 'buy') {
            const fill = simulateBuy(budget, referencePrice, execOpts);
            // Traité immédiatement (unshift, pas push) : un fill doit affecter le
            // portefeuille avant que le order-requested suivant de la même barre ne
            // lise portfolio.positions/cash — sinon deux achats simultanés voient
            // tous les deux le même plafond/cash non encore décrémenté.
            queue.unshift({
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
            // Voir commentaire sur la branche buy : unshift pour appliquer le fill
            // avant le order-requested suivant de la même barre.
            queue.unshift({
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

Notes de transcription :
- `referencePrice` est désormais calculé juste après la vérification de
  `targetSeries`, avant les vérifications spécifiques à l'achat — c'est le
  même calcul qu'avant (`targetSeries.open[fillT]!`), seul le moment où il
  est fait dans la fonction change (nécessaire pour convertir la quantité
  impliquée par le risque en budget cash avant la vérification de barre
  synthétique). Aucune valeur ne change.
- Les commentaires `unshift` déjà présents depuis la revue finale de la
  Phase 2 sont conservés tels quels.

- [ ] **Step 7: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/runner.test.ts test/phase1.test.ts test/phase2.test.ts`
Expected: PASS (16 + 1 + 1 tests)

- [ ] **Step 8: Suite complète et typecheck**

Run: `npm test`
Expected: tous les tests passent

Run: `npm run typecheck`
Expected: aucune erreur — vérifier en particulier qu'aucune erreur
`exactOptionalPropertyTypes` n'apparaît sur la construction de
`order-requested` (le spread conditionnel doit satisfaire le compilateur)

- [ ] **Step 9: Commit**

```bash
git add src/backtest/events.ts src/backtest/runner.ts test/runner.test.ts test/phase1.test.ts test/phase2.test.ts
git commit -m "$(cat <<'EOF'
feat(backtest): sizing par risque en plafond additionnel

order-requested.stopDistance propage Intent.stopDistance jusqu'au
traitement de l'ordre. Le plafond fraction fixe de la Phase 2 reste
calculé en premier et toujours actif ; le sizing par risque
(riskPerTradePct, nouveau champ obligatoire de BacktestOptions) ne peut
que resserrer le budget, jamais l'élargir. stopDistance invalide rejeté
proprement plutôt que de planter, même philosophie défensive que le
rejet NaN déjà en place dans applyBuyFill.
EOF
)"
```

---

## Task 3: Test du critère de sortie de la Phase 3, et mise à jour du README

**Files:**
- Create: `test/phase3.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes : `runBacktest`, `BacktestOptions`, `BacktestResult` (`src/backtest/runner.ts`, Task 2) ; `combineStrategies` (`src/strategy/combineStrategies.ts`, existant, inchangé) ; `createAtrRiskCrossover` (`src/strategy/atrRiskCrossover.ts`, Task 1) ; `DEFAULT_FEES` (`src/backtest/execution.ts`, existant, inchangé).
- Produces : rien (fichier de test terminal, pas de nouveau module source)

- [ ] **Step 1: Écrire le test**

Créer `test/phase3.test.ts` :

```ts
/**
 * Critère de sortie de la Phase 3 (voir README) : le sizing par risque ATR
 * normalise l'exposition entre paires de volatilité différente, sans
 * jamais dépasser le plafond fraction fixe déjà prouvé par
 * test/phase2.test.ts.
 *
 * Deux paires synthétiques, même niveau de prix et mêmes croisements
 * garantis simultanés (même construction que test/phase2.test.ts), mais
 * amplitude de bougie différente : LOWVOL a un ATR petit, HIGHVOL un ATR
 * grand. Pour un risque égal (riskPerTradePct fixe), un stopDistance plus
 * petit sur LOWVOL implique une quantité plus grande — exactement la
 * motivation d'origine du commentaire de la classe Atr dans
 * src/strategy/indicators.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createAtrRiskCrossover } from '../src/strategy/atrRiskCrossover.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const STEP = 14_400;

/**
 * Bougies dont le corps oscille avec une amplitude donnée (signal de
 * croisement, identique sur les deux paires), mais dont le high/low
 * s'écarte du corps d'un facteur `volatility` — c'est ce qui fait varier
 * l'ATR entre les deux paires sans changer le signal de croisement.
 */
function volatileSeries(
  symbol: string,
  bars: number,
  base: number,
  amplitude: number,
  cycleLen: number,
  volatility: number,
): BarSeries {
  const c = emptyColumns();
  for (let i = 0; i < bars; i++) {
    const close = base + amplitude * Math.sin((2 * Math.PI * i) / cycleLen);
    const spread = volatility;
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close + spread);
    c.low.push(close - spread);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(symbol, 240, c);
}

test("Phase 3 — critère de sortie : le sizing par risque normalise l'exposition entre paires de volatilité différente", () => {
  const lowVolSeries = volatileSeries('LOWVOL', 200, 100, 2, 20, 2);
  const highVolSeries = volatileSeries('HIGHVOL', 200, 100, 2, 20, 10);
  const series = new Map([
    ['LOWVOL', lowVolSeries],
    ['HIGHVOL', highVolSeries],
  ]);

  const params = { fast: 3, slow: 7, atrPeriod: 5, atrMultiplier: 2 };
  const strategy = combineStrategies([
    createAtrRiskCrossover({ symbol: 'LOWVOL', ...params }),
    createAtrRiskCrossover({ symbol: 'HIGHVOL', ...params }),
  ]);

  const maxConcurrentPositions = 5; // large : le plafond de concurrence n'est pas le facteur limitant ici
  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions,
    riskPerTradePct: 0.01,
  });

  const lowVolTrade = result.portfolio.trades.find((t) => t.symbol === 'LOWVOL' && t.side === 'buy');
  const highVolTrade = result.portfolio.trades.find((t) => t.symbol === 'HIGHVOL' && t.side === 'buy');
  assert.ok(lowVolTrade, 'attendu un achat sur LOWVOL');
  assert.ok(highVolTrade, 'attendu un achat sur HIGHVOL');

  const lowVolNotional = lowVolTrade!.quantity * lowVolTrade!.price;
  const highVolNotional = highVolTrade!.quantity * highVolTrade!.price;
  assert.ok(
    lowVolNotional > highVolNotional,
    `attendu un notional plus grand sur LOWVOL (${lowVolNotional}) que sur HIGHVOL (${highVolNotional})`,
  );

  // Aucun des deux trades ne dépasse jamais le plafond fraction fixe —
  // l'invariant de la Phase 2 reste garanti même avec le sizing par risque.
  const fixedFractionCap = 1000 / maxConcurrentPositions;
  assert.ok(
    lowVolNotional <= fixedFractionCap + 1e-6,
    `LOWVOL (${lowVolNotional}) dépasse le plafond fraction fixe (${fixedFractionCap})`,
  );
  assert.ok(
    highVolNotional <= fixedFractionCap + 1e-6,
    `HIGHVOL (${highVolNotional}) dépasse le plafond fraction fixe (${fixedFractionCap})`,
  );
});
```

- [ ] **Step 2: Lancer le test**

Run: `node --experimental-strip-types --test test/phase3.test.ts`

Les deux paires ont un signal de croisement garanti simultané (même prix
de clôture, même `fast`/`slow`) — seule l'amplitude high/low diffère, donc
seul l'ATR diffère. Si l'assertion sur les notionals échoue, vérifier que
`volatility` diffère bien assez entre les deux séries (`0.5` vs `5` ici) ;
si l'assertion sur le plafond fraction fixe échoue, c'est un signe que le
calcul de `riskBudget` dans `runner.ts` ne plafonne pas correctement contre
le budget fraction fixe (`Math.min` manquant ou dans le mauvais sens) —
dans ce cas, ne pas retoucher le test, il a détecté une régression réelle
dans Task 2 à investiguer.

Expected une fois calibré : PASS (1 test)

- [ ] **Step 3: Suite complète et typecheck**

Run: `npm test`
Expected : tous les tests passent (Phase 0 + Phase 1 + Phase 2 + Phase 3)

Run: `npm run typecheck`
Expected : aucune erreur

- [ ] **Step 4: Mettre à jour `README.md`**

- Mettre à jour le titre/intro pour refléter que la Phase 3 est terminée
  (rester concis, dans le style existant).
- Mettre à jour le nombre de tests dans la section Démarrage avec le total
  réel obtenu à l'étape 3 (lire la ligne `# tests N` dans la sortie de
  `npm test`, ne pas deviner le nombre).
- Ajouter au bloc Structure : `src/strategy/atrRiskCrossover.ts` (une ligne
  de description dans le style des entrées existantes).
- Ajouter une ligne au tableau « Ce que le code garantit » pour
  l'invariant de la Phase 3 (plafond fraction fixe jamais dépassé même
  avec le sizing par risque), citant `test/phase3.test.ts` par son nom
  littéral, dans le même format que la ligne ajoutée pour la Phase 2.
- Mettre à jour la section Suite : marquer la Phase 3 terminée, lier au
  test `test/phase3.test.ts`, et retirer de la liste « Hors périmètre,
  reporté » le point « Sizing par risque (ATR)... » (fait) — garder les
  points encore non traités (slippage par ATR, ordres limites,
  live-runner, backtest sur l'univers réel des 20 paires).

- [ ] **Step 5: Commit**

```bash
git add test/phase3.test.ts README.md
git commit -m "$(cat <<'EOF'
test(phase3): critère de sortie — le sizing ATR normalise l'exposition

Deux paires synthétiques de volatilité différente, mêmes croisements
garantis simultanés : le notional est plus grand sur la paire la moins
volatile pour un risque égal, sans jamais dépasser le plafond fraction
fixe déjà prouvé en Phase 2. README mis à jour pour la Phase 3.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — chaque section de
`docs/superpowers/specs/2026-08-24-phase3-atr-risk-sizing-design.md` est
couverte : §1 `Intent` étendu + §2 stratégie de référence → Task 1 ;
§3 runner → Task 2 ; §4 test du critère de sortie → Task 3.

**Corrections apportées pendant l'écriture du plan** (au-delà de la spec,
détectées en écrivant le code réel) :
- La spec ne précisait pas où valider `atrPeriod` — en le laissant à la
  charge de `new Atr(atrPeriod)` (appelé paresseusement à l'intérieur de
  `decide()`), un `atrPeriod` invalide ne serait détecté qu'au premier
  signal d'entrée, voire jamais si aucun ne se déclenche pendant tout le
  backtest. `atrRiskCrossover.ts` valide désormais `atrPeriod` explicitement
  au constructeur, comme `fast`/`slow`, cohérent avec le style eager de
  `maCrossover.ts`.
- La spec évoquait le piège `exactOptionalPropertyTypes` pour la
  transmission `Intent.stopDistance` → `order-requested.stopDistance` mais
  pas le calcul concret ; le spread conditionnel exact
  (`...(intent.stopDistance !== undefined ? { stopDistance: intent.stopDistance } : {})`)
  est maintenant transcrit tel quel dans le code de Task 2.
- Le premier jet du fixture de Task 3 (`volatility` de `0.5` vs `5`,
  `maxConcurrentPositions=5`) aurait laissé le plafond fraction fixe
  (`1000/5=200`) dominer le budget par risque des **deux** paires
  (`riskBudget` estimé ≈ 62 et ≈ 6, tous deux confondus sous le plafond
  seulement si le calcul avait été différent — en réalité, avec ces
  premières valeurs, `riskBudget` dépassait 200 pour la paire la moins
  volatile, donc le plafond fraction fixe l'aurait emporté et les deux
  notionals seraient sortis égaux à `200`, faisant échouer l'assertion
  `lowVolNotional > highVolNotional`). Recalculé à la main pour choisir des
  `volatility` (`2` et `10`) qui gardent `riskBudget` nettement sous le
  plafond fraction fixe pour les deux paires (~125 et ~25, contre un
  plafond de 200) — c'est le sizing par risque qui doit être le facteur
  limitant dans ce test, pas le plafond de la Phase 2 (celui-ci n'est
  vérifié que comme garde-fou, voir l'assertion dédiée).

**Cohérence des types** — vérifié que `AtrRiskCrossoverParams` (Task 1)
`{ symbol, fast, slow, atrPeriod, atrMultiplier }` est utilisé
identiquement en Task 3 ; `Intent.stopDistance` (Task 1) a exactement le
même nom et la même sémantique (prix, pas %) que
`order-requested.stopDistance` (Task 2) et que le paramètre lu dans
`runner.ts` ; `BacktestOptions.riskPerTradePct` (Task 2) est ajouté à
tous les sites d'appel existants dans les Tasks 2 et 3.

**Aucun placeholder** — chaque step contient le code complet à écrire. Le
seul point de vérification manuelle (Task 3, Step 2) porte sur une
assertion déjà entièrement écrite, avec une garantie structurelle (même
signal, seule l'amplitude high/low diffère) plutôt qu'un réglage à
itérer à l'aveugle — et une piste de diagnostic explicite si l'assertion
du plafond échoue (régression potentielle dans Task 2, pas un problème de
fixture).
