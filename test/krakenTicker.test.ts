import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTickerResponse } from '../src/live/krakenTicker.ts';
import type { KrakenPairMapping } from '../src/live/krakenAssetPairs.ts';

const MAPPINGS: readonly KrakenPairMapping[] = [
  { symbol: 'XBTEUR', wsSymbol: 'BTC/EUR', restSymbol: 'XXBTZEUR' },
  { symbol: 'ETHEUR', wsSymbol: 'ETH/EUR', restSymbol: 'XETHZEUR' },
];

test('parseTickerResponse : extrait le dernier prix négocié (champ c[0]) pour chaque paire connue', () => {
  const raw = {
    XXBTZEUR: { c: ['62000.5', '0.01'] },
    XETHZEUR: { c: ['3200.1234', '0.5'] },
  };
  const prices = parseTickerResponse(MAPPINGS, raw);
  assert.equal(prices.get('XBTEUR'), 62000.5);
  assert.equal(prices.get('ETHEUR'), 3200.1234);
});

test('parseTickerResponse : ignore une entrée absente du mapping fourni', () => {
  const raw = {
    XXBTZEUR: { c: ['62000.5', '0.01'] },
    XXRPZEUR: { c: ['0.5', '100'] }, // hors mapping fourni
  };
  const prices = parseTickerResponse(MAPPINGS, raw);
  assert.equal(prices.size, 1);
  assert.equal(prices.get('XBTEUR'), 62000.5);
});

test('parseTickerResponse : ignore une entrée malformée sans faire échouer les autres', () => {
  const raw = {
    XXBTZEUR: { c: ['62000.5', '0.01'] },
    XETHZEUR: { foo: 'bar' }, // pas de champ c
  };
  const prices = parseTickerResponse(MAPPINGS, raw);
  assert.equal(prices.size, 1);
  assert.equal(prices.has('ETHEUR'), false);
});

test('parseTickerResponse : ignore un prix non fini ou non positif', () => {
  const raw = {
    XXBTZEUR: { c: ['abc', '0.01'] },
    XETHZEUR: { c: ['-1', '0.5'] },
  };
  const prices = parseTickerResponse(MAPPINGS, raw);
  assert.equal(prices.size, 0);
});

test('parseTickerResponse : renvoie une map vide si aucun mapping fourni', () => {
  const prices = parseTickerResponse([], { XXBTZEUR: { c: ['62000.5', '0.01'] } });
  assert.equal(prices.size, 0);
});
