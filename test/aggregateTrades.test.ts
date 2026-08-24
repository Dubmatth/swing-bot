import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateTrades, parseTradeLine } from '../src/data/aggregateTrades.ts';
import type { Trade } from '../src/data/aggregateTrades.ts';
import type { Interval } from '../src/data/series.ts';

const SYMBOL = 'TESTEUR';

function trade(time: number, price: number, volume = 1): Trade {
  return { time, price, volume };
}

test('parseTradeLine : parse une ligne valide', () => {
  const t = parseTradeLine(SYMBOL, '1608041345,88.9,1.5', 1);
  assert.deepEqual(t, { time: 1608041345, price: 88.9, volume: 1.5 });
});

test('parseTradeLine : lève si le nombre de champs est incorrect', () => {
  assert.throws(() => parseTradeLine(SYMBOL, '1608041345,88.9', 1), /attendu 3/);
});

test('parseTradeLine : lève sur un prix invalide', () => {
  assert.throws(() => parseTradeLine(SYMBOL, '1608041345,abc,1.5', 1), /prix invalide/);
  assert.throws(() => parseTradeLine(SYMBOL, '1608041345,0,1.5', 1), /prix invalide/);
  assert.throws(() => parseTradeLine(SYMBOL, '1608041345,-1,1.5', 1), /prix invalide/);
});

test('parseTradeLine : lève sur un volume négatif ou non fini, mais accepte un volume nul', () => {
  assert.throws(() => parseTradeLine(SYMBOL, '1608041345,88.9,-1', 1), /volume invalide/);
  assert.throws(() => parseTradeLine(SYMBOL, '1608041345,88.9,abc', 1), /volume invalide/);
  const t = parseTradeLine(SYMBOL, '1608041345,88.9,0.0', 1);
  assert.equal(t.volume, 0);
});

test('parseTradeLine : lève sur un timestamp invalide', () => {
  assert.throws(() => parseTradeLine(SYMBOL, '0,88.9,1.5', 1), /timestamp invalide/);
});

test('aggregateTrades : agrège les transactions d\'une seule fenêtre en une bougie', async () => {
  const trades = [trade(0, 100), trade(1000, 110), trade(3599, 90)];
  const series = await aggregateTrades(SYMBOL, trades, [60]);
  const bars = series.get(60);
  assert.ok(bars);
  assert.equal(bars.length, 1);
  assert.equal(bars.time[0], 0);
  assert.equal(bars.open[0], 100);
  assert.equal(bars.high[0], 110);
  assert.equal(bars.low[0], 90);
  assert.equal(bars.close[0], 90);
  assert.equal(bars.trades[0], 3);
});

test('aggregateTrades : ferme une bougie dès qu\'une transaction change de fenêtre', async () => {
  const step = 60 * 60; // interval=60 minutes
  const trades = [
    trade(0, 100),
    trade(1000, 105),
    trade(step, 200), // nouvelle fenêtre
    trade(step + 500, 210),
  ];
  const series = await aggregateTrades(SYMBOL, trades, [60]);
  const bars = series.get(60);
  assert.ok(bars);
  assert.equal(bars.length, 2);
  assert.equal(bars.time[0], 0);
  assert.equal(bars.close[0], 105);
  assert.equal(bars.time[1], step);
  assert.equal(bars.open[1], 200);
  assert.equal(bars.close[1], 210);
});

test('aggregateTrades : une fenêtre sans transaction ne produit aucune bougie synthétique', async () => {
  const step = 60 * 60;
  const trades = [trade(0, 100), trade(3 * step, 300)]; // fenêtres 1 et 2 vides
  const series = await aggregateTrades(SYMBOL, trades, [60]);
  const bars = series.get(60);
  assert.ok(bars);
  assert.equal(bars.length, 2);
  assert.equal(bars.time[0], 0);
  assert.equal(bars.time[1], 3 * step);
});

test('aggregateTrades : agrège plusieurs intervalles en un seul passage', async () => {
  const intervals: readonly Interval[] = [60, 240];
  const step60 = 60 * 60;
  const trades = [
    trade(0, 100),
    trade(step60, 200), // nouvelle bougie de 60min, toujours dans la même bougie de 240min
    trade(4 * step60, 300), // nouvelle bougie de 240min aussi
  ];
  const series = await aggregateTrades(SYMBOL, trades, intervals);
  const bars60 = series.get(60);
  const bars240 = series.get(240);
  assert.ok(bars60);
  assert.ok(bars240);
  assert.equal(bars60.length, 3);
  assert.equal(bars240.length, 2);
});

test('aggregateTrades : inclut la dernière bougie même incomplète en fin de flux', async () => {
  const trades = [trade(0, 100), trade(10, 105)];
  const series = await aggregateTrades(SYMBOL, trades, [1440]);
  const bars = series.get(1440);
  assert.ok(bars);
  assert.equal(bars.length, 1);
  assert.equal(bars.close[0], 105);
});

test('aggregateTrades : lève si une transaction arrive hors ordre', async () => {
  const trades = [trade(1000, 100), trade(500, 90)];
  await assert.rejects(aggregateTrades(SYMBOL, trades, [60]), /hors ordre/);
});

test('aggregateTrades : lève si aucune transaction n\'est fournie', async () => {
  await assert.rejects(aggregateTrades(SYMBOL, [], [60]), /aucune transaction/);
});

test('aggregateTrades : lève si aucun intervalle n\'est demandé', async () => {
  await assert.rejects(aggregateTrades(SYMBOL, [trade(0, 100)], []), /aucun intervalle/);
});

test('aggregateTrades : lève si des intervalles dupliqués sont demandés', async () => {
  await assert.rejects(aggregateTrades(SYMBOL, [trade(0, 100)], [60, 60]), /dupliqués/);
});
