import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createCrossSectionalMomentum } from '../src/strategy/crossSectionalMomentum.ts';

const STEP = 14_400; // 4h en secondes, comme test/meanReversion.test.ts
const SERIES_LENGTH = 43; // assez pour lookbackPeriod=5 et une barre de rebalancement à t=42

/**
 * Série plate à 100, sauf la dernière barre (index 42) fixée à `current`.
 * Avec lookbackPeriod=5, le rendement de formation lu à t=42 est
 * close(0)/close(5)-1 = current/closes[37]-1 = current/100-1.
 */
function flatCloses(current: number): number[] {
  const closes = new Array(SERIES_LENGTH).fill(100);
  closes[SERIES_LENGTH - 1] = current;
  return closes;
}

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
  t: number,
  positions: ReadonlyMap<string, Position> = new Map(),
): StrategyContext {
  const views = new Map<string, BarView>();
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    views.set(symbol, new BarView(seriesFrom(symbol, closes), t));
  }
  return { views, positions, now: t * STEP };
}

// t=42*STEP=604800 -> semaine 1 ; t=41*STEP=590400 -> semaine 0 : rebalancement.
// t=41 vs t=40 (576000) -> semaine 0 les deux : pas de rebalancement.
const FOUR_SYMBOL_UNIVERSE = {
  SYMA: flatCloses(130), // rendement(5) = +30 % -> rang 1
  SYMB: flatCloses(120), // rendement(5) = +20 % -> rang 2
  SYMC: flatCloses(110), // rendement(5) = +10 % -> rang 3
  SYMD: flatCloses(90), // rendement(5) = -10 % -> rang 4
};

test('createCrossSectionalMomentum : lève si lookbackPeriod est invalide (non entier)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 2.5, topN: 2 }),
    /lookbackPeriod/,
  );
});

test('createCrossSectionalMomentum : lève si lookbackPeriod est invalide (< 1)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 0, topN: 2 }),
    /lookbackPeriod/,
  );
});

test('createCrossSectionalMomentum : lève si topN est invalide (non entier)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 1.5 }),
    /topN/,
  );
});

test('createCrossSectionalMomentum : lève si topN est invalide (< 1)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 0 }),
    /topN/,
  );
});

test('createCrossSectionalMomentum : warmup vaut lookbackPeriod, params exposés', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { lookbackPeriod: 5, topN: 2 });
});

test('decide : hors barre de rebalancement, hold même si le classement changerait la composition', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  // SYMC détenu alors qu'il ne serait pas dans le top 2 si on rebalançait —
  // ne doit rien changer tant qu'on n'est pas sur une barre de rebalancement.
  const position: Position = { symbol: 'SYMC', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 };
  const positions = new Map([['SYMC', position]]);
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 41, positions);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : sur une barre de rebalancement, sélectionne le top N dans l\'ordre du classement', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  // Aucune position détenue -> deux entrées, SYMA (+30%) avant SYMB (+20%).
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 42);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'enter');
  assert.equal(intents[0]?.kind === 'enter' && intents[0].symbol, 'SYMA');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMB');
});

test('decide : sur une barre de rebalancement, sort les positions hors du nouveau top N avant les nouvelles entrées', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  // SYMB (rang 2, reste dans le top 2) et SYMD (rang 4, en sort) sont
  // détenus. Attendu : exit SYMD, puis enter SYMA. SYMB ne génère ni exit
  // ni enter (déjà détenu, reste dans le top 2 : pas de churn inutile).
  const positions = new Map<string, Position>([
    ['SYMB', { symbol: 'SYMB', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
    ['SYMD', { symbol: 'SYMD', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
  ]);
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 42, positions);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'exit');
  assert.equal(intents[0]?.kind === 'exit' && intents[0].symbol, 'SYMD');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMA');
});

test('decide : une position déjà détenue et toujours dans le top N ne génère ni exit ni enter', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  const positions = new Map<string, Position>([
    ['SYMA', { symbol: 'SYMA', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
    ['SYMB', { symbol: 'SYMB', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
  ]);
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 42, positions);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : univers plus petit que topN détient tout ce qui est disponible, sans exception', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 5 });
  const twoSymbolUniverse = { SYMA: flatCloses(130), SYMB: flatCloses(120) };
  const ctx = multiCtx(twoSymbolUniverse, 42);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents.every((i) => i.kind === 'enter'), true);
});
