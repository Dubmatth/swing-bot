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
  // wsname ('XBT/EUR') est au format WS v1 : traduit en 'BTC/EUR' pour WS v2.
  assert.deepEqual(mappings[0], { symbol: 'XBTEUR', wsSymbol: 'BTC/EUR', restSymbol: 'XXBTZEUR' });
  assert.deepEqual(mappings[1], { symbol: 'ETHEUR', wsSymbol: 'ETH/EUR', restSymbol: 'XETHZEUR' });
});

test('parseAssetPairsResponse : traduit XDG (wsname v1) en DOGE (WS v2)', () => {
  const dogeUniverse: readonly PairSpec[] = [
    { symbol: 'XDGEUR', label: 'DOGE/EUR', sector: 'meme' },
  ];
  const raw = {
    XXDGZEUR: { altname: 'XDGEUR', wsname: 'XDG/EUR' },
  };
  const mappings = parseAssetPairsResponse(dogeUniverse, raw);
  assert.equal(mappings.length, 1);
  assert.deepEqual(mappings[0], { symbol: 'XDGEUR', wsSymbol: 'DOGE/EUR', restSymbol: 'XXDGZEUR' });
});

test('parseAssetPairsResponse : une paire non concernée par la table de traduction reste inchangée', () => {
  const ethUniverse: readonly PairSpec[] = [
    { symbol: 'ETHEUR', label: 'ETH/EUR', sector: 'smart-contract' },
  ];
  const raw = {
    XETHZEUR: { altname: 'ETHEUR', wsname: 'ETH/EUR' },
  };
  const mappings = parseAssetPairsResponse(ethUniverse, raw);
  assert.equal(mappings.length, 1);
  assert.deepEqual(mappings[0], { symbol: 'ETHEUR', wsSymbol: 'ETH/EUR', restSymbol: 'XETHZEUR' });
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
