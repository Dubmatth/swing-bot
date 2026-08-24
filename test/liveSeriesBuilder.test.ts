import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import type { ClosedBar } from '../src/live/liveBarSource.ts';

const SYMBOL = 'TESTEUR';

function bar(time: number, close: number, symbol = SYMBOL): ClosedBar {
  return { symbol, time, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

test("createLiveSeriesBuilder : lève si current() est appelé avant tout append", () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  assert.throws(() => builder.current(), /aucune barre/);
});

test('createLiveSeriesBuilder : construit une BarSeries valide au fil des append', () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  builder.append(bar(1000, 100));
  let series = builder.current();
  assert.equal(series.length, 1);
  assert.equal(series.close[0], 100);

  builder.append(bar(2000, 110));
  series = builder.current();
  assert.equal(series.length, 2);
  assert.equal(series.close[1], 110);
  assert.equal(series.symbol, SYMBOL);
  assert.equal(series.interval, 240);
});

test("createLiveSeriesBuilder : ignore silencieusement une barre antérieure à la dernière connue (rejeu/doublon)", () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  builder.append(bar(2000, 100));
  builder.append(bar(1000, 110)); // antérieure à la précédente — ignorée, pas d'exception
  const series = builder.current();
  assert.equal(series.length, 1);
  assert.equal(series.time[0], 2000);
  assert.equal(series.close[0], 100);
});

test("createLiveSeriesBuilder : ignore silencieusement une barre au même timestamp que la dernière connue", () => {
  // Reproduit le cas observé en production : l'amorçage REST et le
  // snapshot WebSocket initial se référant tous les deux à la même
  // bougie « en cours », le premier message WS qui fait avancer
  // l'intervalle rejoue alors cette même bougie déjà connue.
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  builder.append(bar(2000, 100));
  builder.append(bar(2000, 999)); // même timestamp — ignorée, pas d'exception
  const series = builder.current();
  assert.equal(series.length, 1);
  assert.equal(series.close[0], 100); // la valeur d'origine, pas celle du doublon
});

test("createLiveSeriesBuilder : reprend normalement après une barre ignorée", () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  builder.append(bar(2000, 100));
  builder.append(bar(1000, 110)); // ignorée
  builder.append(bar(3000, 120)); // valide, strictement après 2000
  const series = builder.current();
  assert.equal(series.length, 2);
  assert.equal(series.time[0], 2000);
  assert.equal(series.time[1], 3000);
});

test('createLiveSeriesBuilder : lève si une barre reçue est pour un autre symbole', () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  assert.throws(() => builder.append(bar(1000, 100, 'AUTRE')), /AUTRE/);
});
