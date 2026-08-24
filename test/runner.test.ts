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
