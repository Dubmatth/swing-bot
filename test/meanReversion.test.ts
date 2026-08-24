import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';

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

test('createMeanReversion : warmup vaut la période, params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 5, entryK: 2 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { period: 5, entryK: 2 });
});

test('createMeanReversion : période invalide lève', () => {
  assert.throws(() => createMeanReversion({ symbol: SYMBOL, period: 1, entryK: 2 }), /période/i);
});

test('createMeanReversion : entryK invalide lève', () => {
  assert.throws(() => createMeanReversion({ symbol: SYMBOL, period: 5, entryK: 0 }), /entryK/);
});

test("decide : signal d'entrée quand le prix chute sous sma - entryK·std", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  // closes 10,10,10,10 -> sma=10, std=0 ; une chute nette à 5 doit franchir le seuil.
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : hold si le prix est sous la moyenne mais pas assez pour franchir le seuil', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 3 });
  // écart-type non nul avec un seuil large : un léger creux ne suffit pas.
  const ctx = ctxFor([10, 12, 8, 10, 9]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : hold si le prix a chuté mais une position est déjà ouverte (pas de réentrée)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 5, entryTime: 0 };
  const ctx = ctxFor([10, 10, 10, 10, 5], position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : signal de sortie quand le prix revient à la moyenne, position ouverte', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 5, entryTime: 0 };
  const ctx = ctxFor([5, 10, 10, 10, 10], position); // sma(4 dernières)=10, prix=10 >= sma
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test('decide : hold si position ouverte et prix encore sous la moyenne', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 5, entryTime: 0 };
  const ctx = ctxFor([10, 10, 10, 10, 5], position); // sma=8.75, prix=5 < sma
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : symbole absent du contexte renvoie hold sans lever', () => {
  const s = createMeanReversion({ symbol: 'AUTRE', period: 4, entryK: 1 });
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  assert.doesNotThrow(() => s.decide(ctx));
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('createMeanReversion : warmup vaut max(period, trendPeriod), params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, trendPeriod: 10 });
  assert.equal(s.warmup, 10);
  assert.deepEqual(s.params, { period: 4, entryK: 1, trendPeriod: 10 });
});

test('createMeanReversion : trendPeriod <= period lève', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, trendPeriod: 4 }),
    /trendPeriod/,
  );
});

test('decide : le filtre de tendance bloque une entrée en tendance baissière de fond', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, trendPeriod: 6 });
  // Baisse continue : le seuil d'entrée à court terme est franchi, mais le
  // prix reste sous la moyenne longue (tendance baissière confirmée).
  const ctx = ctxFor([100, 95, 90, 85, 80, 75, 70, 65, 60]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : le filtre de tendance autorise une entrée quand le prix reste au-dessus de la moyenne longue', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, trendPeriod: 6 });
  // Un creux plus profond plus tôt tire la moyenne longue sous le prix
  // courant : le repli récent reste un creux local, pas une tendance de fond.
  const ctx = ctxFor([100, 100, 100, 50, 100, 100, 100, 100, 95]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : sans trendPeriod, le même repli en tendance baissière déclenche quand même une entrée', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1 });
  const ctx = ctxFor([100, 95, 90, 85, 80, 75, 70, 65, 60]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});
