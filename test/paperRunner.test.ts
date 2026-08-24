import test from 'node:test';
import assert from 'node:assert/strict';

import type { ClosedBar, LiveBarSource } from '../src/live/liveBarSource.ts';
import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import { createPaperRunner } from '../src/live/paperRunner.ts';
import { createPortfolio } from '../src/backtest/portfolio.ts';
import type { Trade } from '../src/backtest/portfolio.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';

const SYMBOL_A = 'AEUR';
const SYMBOL_B = 'BEUR';
const STEP = 14_400;

function bar(symbol: string, i: number, close: number): ClosedBar {
  return { symbol, time: i * STEP, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

function createSyntheticSource(): LiveBarSource & { emit(bar: ClosedBar): void } {
  let callback: ((bar: ClosedBar) => void) | undefined;
  return {
    start(cb: (bar: ClosedBar) => void): void {
      callback = cb;
    },
    stop(): void {
      callback = undefined;
    },
    emit(b: ClosedBar): void {
      callback?.(b);
    },
  };
}

/** Stratégie de test déterministe : entre au-dessus du seuil, sort à/sous le seuil. */
function testStrategy(threshold: number): Strategy {
  return {
    name: 'test-strategy',
    warmup: 0,
    params: { threshold },
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents: Intent[] = [];
      for (const [symbol, view] of ctx.views) {
        const hasPosition = ctx.positions.has(symbol);
        const price = view.close(0);
        if (!hasPosition && price > threshold) {
          intents.push({ kind: 'enter', symbol, reason: `${price} > ${threshold}` });
        } else if (hasPosition && price <= threshold) {
          intents.push({ kind: 'exit', symbol, reason: `${price} <= ${threshold}` });
        }
      }
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}

function setup(threshold: number, maxConcurrentPositions = 1) {
  const sourceA = createSyntheticSource();
  const sourceB = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const builderB = createLiveSeriesBuilder(SYMBOL_B, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];

  const runner = createPaperRunner({
    strategy: testStrategy(threshold),
    sources: new Map([[SYMBOL_A, sourceA], [SYMBOL_B, sourceB]]),
    builders: new Map([[SYMBOL_A, builderA], [SYMBOL_B, builderB]]),
    portfolio,
    options: { maxConcurrentPositions, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  return { runner, sourceA, sourceB, portfolio, fills };
}

test('paperRunner : applique un fill d\'achat quand la stratégie émet enter', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // 60 > 50 -> enter

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.side, 'buy');
});

test('paperRunner : applique un fill de vente quand la stratégie émet exit', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter
  sourceA.emit(bar(SYMBOL_A, 1, 40)); // 40 <= 50 -> exit

  assert.equal(portfolio.positions.size, 0);
  assert.equal(fills.length, 2);
  assert.equal(fills[1]?.side, 'sell');
});

test('paperRunner : ignore un enter si le plafond de positions est atteint', () => {
  const { portfolio, fills, sourceA, sourceB } = setup(50, 1);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter A, plafond=1 atteint
  sourceB.emit(bar(SYMBOL_B, 0, 60)); // voudrait entrer B aussi, refusé

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));
  assert.equal(fills.length, 1);
});

test('paperRunner : ignore un enter si une position est déjà ouverte sur ce symbole', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter
  sourceA.emit(bar(SYMBOL_A, 1, 70)); // toujours > 50, mais déjà en position -> hold

  assert.equal(portfolio.positions.size, 1);
  assert.equal(fills.length, 1);
});

test('paperRunner : decide() considère toutes les paires ayant déjà une bougie, pas seulement celle qui vient de clôturer', () => {
  const { portfolio, fills, sourceA, sourceB } = setup(50, 2);
  sourceB.emit(bar(SYMBOL_B, 0, 30)); // B a une bougie mais reste sous le seuil
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // déclenche decide() ; B est visible dans ctx.views

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));

  sourceB.emit(bar(SYMBOL_B, 1, 60)); // B franchit le seuil à son tour -> enter B
  assert.equal(portfolio.positions.size, 2);
  assert.equal(fills.length, 2);
});

test('paperRunner : stop() détache les sources, plus aucun fill après', () => {
  const { runner, portfolio, fills, sourceA } = setup(50);
  runner.stop();
  sourceA.emit(bar(SYMBOL_A, 0, 60));

  assert.equal(portfolio.positions.size, 0);
  assert.equal(fills.length, 0);
});

test('paperRunner : ignore silencieusement une intention sur un symbole sans bougie connue', () => {
  const alwaysEnterUnknown: Strategy = {
    name: 'buggy',
    warmup: 0,
    params: {},
    decide(): readonly Intent[] {
      return [{ kind: 'enter', symbol: 'INCONNU', reason: 'test' }];
    },
  };
  const sourceA = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];
  const runner = createPaperRunner({
    strategy: alwaysEnterUnknown,
    sources: new Map([[SYMBOL_A, sourceA]]),
    builders: new Map([[SYMBOL_A, builderA]]),
    portfolio,
    options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  assert.doesNotThrow(() => sourceA.emit(bar(SYMBOL_A, 0, 60)));
  assert.equal(fills.length, 0);
  assert.equal(portfolio.positions.size, 0);
});
