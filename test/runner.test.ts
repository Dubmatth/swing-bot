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
