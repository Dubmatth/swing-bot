import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createDonchianBreakout } from '../src/strategy/donchianBreakout.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400; // 4h en secondes, comme test/maCrossover.test.ts

interface Bar {
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/**
 * Contrairement au helper à un seul symbole des tests existants
 * (open=high=low=close), cette stratégie lit high/low distincts de close
 * pour calculer le canal — nécessite un helper dédié avec OHLC indépendants.
 */
function seriesFromOHLC(bars: readonly Bar[]): BarSeries {
  const c = emptyColumns();
  bars.forEach((bar, i) => {
    c.time.push(i * STEP);
    c.open.push(bar.close);
    c.high.push(bar.high);
    c.low.push(bar.low);
    c.close.push(bar.close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(SYMBOL, 240, c);
}

function ctxFor(bars: readonly Bar[], position?: Position): StrategyContext {
  const series = seriesFromOHLC(bars);
  const view = new BarView(series, series.length - 1);
  const positions = new Map<string, Position>();
  if (position) positions.set(SYMBOL, position);
  return { views: new Map([[SYMBOL, view]]), positions, now: view.time(0) };
}

test('createDonchianBreakout : lève si entryPeriod est invalide (non entier)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 2.5, exitPeriod: 2 }),
    /entryPeriod/,
  );
});

test('createDonchianBreakout : lève si entryPeriod est invalide (< 1)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 0, exitPeriod: 2 }),
    /entryPeriod/,
  );
});

test('createDonchianBreakout : lève si exitPeriod est invalide (non entier)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 1.5 }),
    /exitPeriod/,
  );
});

test('createDonchianBreakout : lève si exitPeriod est invalide (< 1)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 0 }),
    /exitPeriod/,
  );
});

test('createDonchianBreakout : warmup = max(entryPeriod, exitPeriod) quand exitPeriod plus grand, params exposés', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 5 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { entryPeriod: 3, exitPeriod: 5 });
});

test('createDonchianBreakout : warmup = max(entryPeriod, exitPeriod) quand entryPeriod plus grand', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 5, exitPeriod: 2 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { entryPeriod: 5, exitPeriod: 2 });
});

// Canal d'entrée (entryPeriod=3) sur les bougies précédentes (ago=1,2,3) :
// plus-haut = max(10.2, 10.5, 10.0) = 10.5.
const ENTRY_CHANNEL_BARS: Bar[] = [
  { high: 10.0, low: 9.0, close: 9.5 },
  { high: 10.5, low: 9.2, close: 10.0 },
  { high: 10.2, low: 9.5, close: 10.0 },
];

test("decide : cassure haussière (close > plus-haut du canal) sans position -> enter", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...ENTRY_CHANNEL_BARS, { high: 11.0, low: 10.5, close: 11.0 }];
  const intents = s.decide(ctxFor(bars));
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test("decide : pas d'entrée si close égal au plus-haut du canal (cassure non stricte)", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...ENTRY_CHANNEL_BARS, { high: 10.5, low: 10.0, close: 10.5 }];
  assert.equal(s.decide(ctxFor(bars))[0]?.kind, 'hold');
});

test("decide : pas d'entrée si close inférieur au plus-haut du canal", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...ENTRY_CHANNEL_BARS, { high: 9.0, low: 8.5, close: 9.0 }];
  assert.equal(s.decide(ctxFor(bars))[0]?.kind, 'hold');
});

test("decide : pas d'entrée si une position est déjà ouverte, même en cas de cassure haussière", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  // Même cassure haussière que le premier test (close=11 > 10.5), mais une
  // position est déjà ouverte : pas de ré-entrée. Le plus-bas des 2
  // dernières bougies précédentes (ago=1,2 -> low=9.5, 9.2) vaut 9.2 ;
  // close=11 n'est pas < 9.2, donc pas de sortie non plus -> hold.
  const bars = [...ENTRY_CHANNEL_BARS, { high: 11.0, low: 10.5, close: 11.0 }];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  assert.equal(s.decide(ctxFor(bars, position))[0]?.kind, 'hold');
});

test('decide : le canal exclut la barre courante (un extremum sur la barre courante ne compte pas)', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  // Même canal que le premier test (plus-haut=10.5 sur les 3 bougies
  // précédentes), mais la bougie courante a un plus-haut extrême (50.0).
  // Si le canal incluait ago=0, le plus-haut deviendrait 50.0 et
  // close=11.0 ne casserait pas (11 < 50) -> hold à tort. Avec l'exclusion
  // correcte de la barre courante, le canal reste 10.5 -> enter.
  const bars = [...ENTRY_CHANNEL_BARS, { high: 50.0, low: 10.6, close: 11.0 }];
  const intents = s.decide(ctxFor(bars));
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

// Canal de sortie (exitPeriod=2) sur les bougies précédentes (ago=1,2) :
// plus-bas = min(9.0, 8.5) = 8.5.
const EXIT_CHANNEL_BARS: Bar[] = [
  { high: 10.0, low: 9.0, close: 9.5 },
  { high: 10.0, low: 8.5, close: 9.0 },
];
const HELD_POSITION: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 9.5, entryTime: 0 };

test('decide : cassure baissière (close < plus-bas du canal) avec position -> exit', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...EXIT_CHANNEL_BARS, { high: 8.5, low: 7.5, close: 8.0 }];
  const intents = s.decide(ctxFor(bars, HELD_POSITION));
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test('decide : pas de sortie si close égal au plus-bas du canal (cassure non stricte)', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...EXIT_CHANNEL_BARS, { high: 9.0, low: 8.5, close: 8.5 }];
  assert.equal(s.decide(ctxFor(bars, HELD_POSITION))[0]?.kind, 'hold');
});

test('decide : pas de sortie si close supérieur au plus-bas du canal', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...EXIT_CHANNEL_BARS, { high: 9.5, low: 9.0, close: 9.2 }];
  assert.equal(s.decide(ctxFor(bars, HELD_POSITION))[0]?.kind, 'hold');
});

test('decide : pas de sortie forcée sans position ouverte, même en cas de cassure baissière', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  // Une bougie supplémentaire précède EXIT_CHANNEL_BARS pour satisfaire
  // l'historique requis par le canal d'entrée (entryPeriod=3, ago=1,2,3) ;
  // elle ne change pas le canal de sortie (exitPeriod=2, ago=1,2
  // uniquement, toujours EXIT_CHANNEL_BARS). Même bougie finale que le test
  // "cassure baissière (close < plus-bas du canal) avec position -> exit"
  // ci-dessus (close=8.0 < plus-bas(2)=8.5, déclencherait une sortie si une
  // position était ouverte), mais ici sans position : la branche de sortie
  // ne doit jamais s'exécuter sans position. Le canal d'entrée (plus-haut
  // des 3 bougies précédentes = max(10.0, 10.0, 10.0) = 10.0) n'est pas non
  // plus cassé (close=8.0 < 10.0) -> hold, par construction et non par
  // accident.
  const bars = [
    { high: 10.0, low: 9.0, close: 9.5 },
    ...EXIT_CHANNEL_BARS,
    { high: 8.5, low: 7.5, close: 8.0 },
  ];
  assert.equal(s.decide(ctxFor(bars))[0]?.kind, 'hold');
});
