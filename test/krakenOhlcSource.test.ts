import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidOhlcEntry, processOhlcMessage } from '../src/live/krakenOhlcSource.ts';
import type { OhlcMessage } from '../src/live/krakenOhlcSource.ts';

function msg(intervalBegin: number, close: number, symbol = 'XBTEUR'): OhlcMessage {
  return { symbol, intervalBegin, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

test('processOhlcMessage : la première barre vue pour un symbole ne déclenche aucune clôture', () => {
  const tracked = new Map();
  const result = processOhlcMessage(tracked, msg(1000, 100));
  assert.equal(result, null);
});

test('processOhlcMessage : une mise à jour avec le même interval_begin ne déclenche aucune clôture', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100));
  const result = processOhlcMessage(tracked, msg(1000, 105));
  assert.equal(result, null);
});

test('processOhlcMessage : un nouvel interval_begin ferme la bougie précédente avec ses dernières valeurs connues', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100));
  processOhlcMessage(tracked, msg(1000, 105)); // mise à jour avant clôture
  const result = processOhlcMessage(tracked, msg(2000, 200)); // nouvelle bougie
  assert.ok(result);
  assert.equal(result?.time, 1000);
  assert.equal(result?.close, 105); // dernière valeur connue de la bougie 1000, pas 100
});

test('processOhlcMessage : un interval_begin déjà dépassé (rejeu/doublon) est ignoré', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100));
  processOhlcMessage(tracked, msg(2000, 200)); // ferme 1000, ouvre 2000
  const result = processOhlcMessage(tracked, msg(1000, 999)); // rejeu de la bougie déjà close
  assert.equal(result, null);
});

test('processOhlcMessage : chaque symbole a son propre état, indépendant des autres', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100, 'XBTEUR'));
  processOhlcMessage(tracked, msg(1000, 50, 'ETHEUR'));
  const resultXbt = processOhlcMessage(tracked, msg(2000, 110, 'XBTEUR'));
  const resultEth = processOhlcMessage(tracked, msg(1000, 55, 'ETHEUR'));
  assert.ok(resultXbt);
  assert.equal(resultXbt?.symbol, 'XBTEUR');
  assert.equal(resultEth, null);
});

test('isValidOhlcEntry : accepte une entrée OHLC cohérente', () => {
  assert.equal(isValidOhlcEntry(1000, 100, 110, 90, 105), true);
});

test('isValidOhlcEntry : rejette un interval_begin NaN (date invalide côté réseau)', () => {
  // Reproduit le cas d'un interval_begin syntaxiquement une string mais
  // représentant une date invalide : new Date(...).getTime() vaut NaN, ce qui
  // sans ce garde-fou déjoue silencieusement les comparaisons de
  // processOhlcMessage (NaN === x et NaN < x sont toutes deux fausses).
  assert.equal(isValidOhlcEntry(Number.NaN, 100, 110, 90, 105), false);
});

test('isValidOhlcEntry : rejette un interval_begin nul ou négatif', () => {
  assert.equal(isValidOhlcEntry(0, 100, 110, 90, 105), false);
  assert.equal(isValidOhlcEntry(-1, 100, 110, 90, 105), false);
});

test('isValidOhlcEntry : rejette un OHLC incohérent (high < low)', () => {
  assert.equal(isValidOhlcEntry(1000, 100, 90, 110, 105), false);
});

test('isValidOhlcEntry : rejette un OHLC incohérent (open hors de [low, high])', () => {
  assert.equal(isValidOhlcEntry(1000, 200, 110, 90, 105), false);
});

test('isValidOhlcEntry : rejette un prix nul ou négatif', () => {
  assert.equal(isValidOhlcEntry(1000, 0, 110, 0, 105), false);
  assert.equal(isValidOhlcEntry(1000, -1, 110, -1, 105), false);
});
