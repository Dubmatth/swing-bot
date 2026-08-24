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
