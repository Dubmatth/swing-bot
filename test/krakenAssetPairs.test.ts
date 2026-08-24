import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAssetPairsResponse } from '../src/live/krakenAssetPairs.ts';
import type { PairSpec } from '../src/config/universe.ts';

const UNIVERSE: readonly PairSpec[] = [
  { symbol: 'XBTEUR', label: 'BTC/EUR', sector: 'store-of-value' },
  { symbol: 'ETHEUR', label: 'ETH/EUR', sector: 'smart-contract' },
];

test('parseAssetPairsResponse : résout le mapping pour chaque paire de l\'univers', () => {
  const raw = {
    XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR' },
    XETHZEUR: { altname: 'ETHEUR', wsname: 'ETH/EUR' },
    XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD' }, // paire hors univers, ignorée
  };
  const mappings = parseAssetPairsResponse(UNIVERSE, raw);
  assert.equal(mappings.length, 2);
  assert.deepEqual(mappings[0], { symbol: 'XBTEUR', wsSymbol: 'XBT/EUR', restSymbol: 'XXBTZEUR' });
  assert.deepEqual(mappings[1], { symbol: 'ETHEUR', wsSymbol: 'ETH/EUR', restSymbol: 'XETHZEUR' });
});

test('parseAssetPairsResponse : lève si une paire de l\'univers est absente de la réponse', () => {
  const raw = { XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR' } }; // ETHEUR manquant
  assert.throws(() => parseAssetPairsResponse(UNIVERSE, raw), /ETHEUR/);
});

test('parseAssetPairsResponse : lève si wsname n\'a pas la forme BASE/QUOTE attendue', () => {
  const raw = {
    XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBTEUR' }, // pas de '/'
    XETHZEUR: { altname: 'ETHEUR', wsname: 'ETH/EUR' },
  };
  assert.throws(() => parseAssetPairsResponse(UNIVERSE, raw), /wsname/);
});

test('parseAssetPairsResponse : ignore silencieusement une entrée sans altname/wsname exploitable', () => {
  const raw = {
    XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR' },
    XETHZEUR: { altname: 'ETHEUR', wsname: 'ETH/EUR' },
    BROKEN: { foo: 'bar' },
  };
  const mappings = parseAssetPairsResponse(UNIVERSE, raw);
  assert.equal(mappings.length, 2);
});
