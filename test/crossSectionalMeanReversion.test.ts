import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createCrossSectionalMeanReversion } from '../src/strategy/crossSectionalMeanReversion.ts';

const STEP = 14_400; // 4h en secondes, comme test/meanReversion.test.ts

function seriesFrom(symbol: string, closes: number[]): BarSeries {
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
  return freezeSeries(symbol, 240, c);
}

function multiCtx(
  closesBySymbol: Readonly<Record<string, number[]>>,
  positions: ReadonlyMap<string, Position> = new Map(),
): StrategyContext {
  const views = new Map<string, BarView>();
  let now = 0;
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    const view = new BarView(seriesFrom(symbol, closes), closes.length - 1);
    views.set(symbol, view);
    now = view.time(0);
  }
  return { views, positions, now };
}

test('createCrossSectionalMeanReversion : lève si period est invalide (non entier)', () => {
  assert.throws(
    () => createCrossSectionalMeanReversion({ period: 2.5, entryK: 1 }),
    /Période/,
  );
});

test('createCrossSectionalMeanReversion : lève si period est invalide (< 2)', () => {
  assert.throws(
    () => createCrossSectionalMeanReversion({ period: 1, entryK: 1 }),
    /Période/,
  );
});

test('createCrossSectionalMeanReversion : lève si entryK est invalide (<= 0)', () => {
  assert.throws(
    () => createCrossSectionalMeanReversion({ period: 4, entryK: 0 }),
    /entryK/,
  );
});

test('createCrossSectionalMeanReversion : warmup vaut period, params exposés', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  assert.equal(s.warmup, 4);
  assert.deepEqual(s.params, { period: 4, entryK: 1 });
});

test('decide : univers vide -> hold, sans exception', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx: StrategyContext = { views: new Map(), positions: new Map(), now: 0 };
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

// Fenêtre plate : sma=10, std=0, threshold=10 -> price=10 n'est jamais < threshold (strict).
const FLAT_CLOSES = [10, 10, 10, 10, 10];

test("decide : aucune entrée si le prix n'est pas sous le seuil, pas de position -> hold", () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx = multiCtx({ SYMFLAT: FLAT_CLOSES });
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : sortie si price >= sma, avec position ouverte', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const position: Position = { symbol: 'SYMFLAT', side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = multiCtx({ SYMFLAT: FLAT_CLOSES }, new Map([['SYMFLAT', position]]));
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

// SYMA : fenêtre [10,9,8,6] (period=4, ago=0..3) -> sma=8.25, écart-type≈1.479,
// seuil≈6.771, prix=6 < seuil -> éligible, z-score=(8.25-6)/1.479≈1.521.
const SYMA_CLOSES = [10, 10, 9, 8, 6];
// SYMB : fenêtre [10,10,9,3] -> sma=8, écart-type≈2.915, seuil≈5.085,
// prix=3 < seuil -> éligible, z-score=(8-3)/2.915≈1.715 — PLUS survendu que SYMA.
const SYMB_CLOSES = [10, 10, 10, 9, 3];

test('decide : une seule paire éligible, pas de position -> enter', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx = multiCtx({ SYMA: SYMA_CLOSES });
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : pas de nouvelle entrée si une position est déjà ouverte, même sous le seuil', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const position: Position = { symbol: 'SYMA', side: 'long', quantity: 1, entryPrice: 6, entryTime: 0 };
  const ctx = multiCtx({ SYMA: SYMA_CLOSES }, new Map([['SYMA', position]]));
  const intents = s.decide(ctx);
  // price=6 < sma=8.25 : pas de sortie (price < sma) ; position déjà ouverte : pas
  // d'entrée -> hold.
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : deux paires éligibles, entrées triées par z-score décroissant (la plus survendue en premier)', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx = multiCtx({ SYMA: SYMA_CLOSES, SYMB: SYMB_CLOSES });
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'enter');
  assert.equal(intents[0]?.kind === 'enter' && intents[0].symbol, 'SYMB');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMA');
});

test('decide : une sortie et des entrées sur la même bougie -> la sortie est retournée en premier', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const position: Position = { symbol: 'SYMFLAT', side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = multiCtx(
    { SYMFLAT: FLAT_CLOSES, SYMA: SYMA_CLOSES, SYMB: SYMB_CLOSES },
    new Map([['SYMFLAT', position]]),
  );
  const intents = s.decide(ctx);
  assert.equal(intents.length, 3);
  assert.equal(intents[0]?.kind, 'exit');
  assert.equal(intents[0]?.kind === 'exit' && intents[0].symbol, 'SYMFLAT');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMB');
  assert.equal(intents[2]?.kind, 'enter');
  assert.equal(intents[2]?.kind === 'enter' && intents[2].symbol, 'SYMA');
});
