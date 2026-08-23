import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';

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

test('createMaCrossover : warmup vaut la période lente, params exposés', () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 3, slow: 8 });
  assert.equal(s.warmup, 8);
  assert.deepEqual(s.params, { fast: 3, slow: 8 });
});

test('createMaCrossover : période fast invalide lève', () => {
  assert.throws(() => createMaCrossover({ symbol: SYMBOL, fast: 0, slow: 8 }), /fast/);
});

test('createMaCrossover : période slow <= fast lève', () => {
  assert.throws(() => createMaCrossover({ symbol: SYMBOL, fast: 5, slow: 5 }), /slow/);
});

test("decide : signal d'entrée quand fast > slow et pas de position", () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const ctx = ctxFor([10, 10, 10, 40]); // sma(2)=25 > sma(4)=17.5
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test("decide : hold si fast > slow mais déjà en position (pas de réentrée)", () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor([10, 10, 10, 40], position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : signal de sortie quand fast < slow et position ouverte', () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 40, entryTime: 0 };
  const ctx = ctxFor([40, 10, 10, 10], position); // sma(2)=10 < sma(4)=17.5
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test('decide : hold si fast < slow et pas de position (pas de short)', () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const ctx = ctxFor([40, 10, 10, 10]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : symbole absent du contexte renvoie hold sans lever', () => {
  const s = createMaCrossover({ symbol: 'AUTRE', fast: 2, slow: 4 });
  const ctx = ctxFor([10, 10, 10, 40]);
  assert.doesNotThrow(() => s.decide(ctx));
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});
