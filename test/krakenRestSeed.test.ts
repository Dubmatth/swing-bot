import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRestOhlcResponse } from '../src/live/krakenRestSeed.ts';

const SYMBOL = 'XBTEUR';

test('parseRestOhlcResponse : parse des lignes valides en ClosedBar', () => {
  const rows = [
    [1700000000, '50000.0', '50100.0', '49900.0', '50050.0', '50025.0', '1.5', 42],
    [1700014400, '50050.0', '50200.0', '50000.0', '50150.0', '50075.0', '2.0', 30],
  ];
  const bars = parseRestOhlcResponse(SYMBOL, rows);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], {
    symbol: SYMBOL, time: 1700000000, open: 50000, high: 50100, low: 49900,
    close: 50050, volume: 1.5, trades: 42,
  });
});

test('parseRestOhlcResponse : lève si une ligne n\'a pas la forme attendue', () => {
  assert.throws(() => parseRestOhlcResponse(SYMBOL, [[1700000000, '1']]), /forme inattendue/);
});

test('parseRestOhlcResponse : lève sur un champ numérique invalide', () => {
  const rows = [[1700000000, 'abc', '50100.0', '49900.0', '50050.0', '50025.0', '1.5', 42]];
  assert.throws(() => parseRestOhlcResponse(SYMBOL, rows), /invalide/);
});

test('parseRestOhlcResponse : lève sur un OHLC incohérent', () => {
  const rows = [[1700000000, '50000.0', '100.0', '49900.0', '50050.0', '50025.0', '1.5', 42]]; // high < open
  assert.throws(() => parseRestOhlcResponse(SYMBOL, rows), /incohérent/);
});
