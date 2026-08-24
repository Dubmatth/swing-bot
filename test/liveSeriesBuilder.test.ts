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

test('createLiveSeriesBuilder : lève si une barre reçue a un timestamp non croissant', () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  builder.append(bar(2000, 100));
  builder.append(bar(1000, 110)); // antérieure à la précédente
  assert.throws(() => builder.current(), /croissant/);
});

test('createLiveSeriesBuilder : lève si une barre reçue est pour un autre symbole', () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  assert.throws(() => builder.append(bar(1000, 100, 'AUTRE')), /AUTRE/);
});
