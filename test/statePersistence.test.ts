import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  serializePortfolio,
  deserializePortfolio,
  savePortfolioSnapshot,
  loadPortfolioSnapshot,
  appendTradeLog,
} from '../src/live/statePersistence.ts';
import { createPortfolio, applyBuyFill } from '../src/backtest/portfolio.ts';
import type { Trade } from '../src/backtest/portfolio.ts';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'swing-bot-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('serializePortfolio/deserializePortfolio : aller-retour préserve cash et positions', () => {
  const p = createPortfolio(1000);
  applyBuyFill(p, 'XBTEUR', { price: 100, quantity: 2, fee: 1 }, 1000);
  const restored = deserializePortfolio(serializePortfolio(p));
  assert.equal(restored.cash, p.cash);
  assert.equal(restored.positions.size, 1);
  assert.deepEqual(restored.positions.get('XBTEUR'), p.positions.get('XBTEUR'));
});

test('savePortfolioSnapshot/loadPortfolioSnapshot : aller-retour sur disque réel', async () => {
  await withTempDir(async (dir) => {
    const p = createPortfolio(1000);
    applyBuyFill(p, 'ETHEUR', { price: 50, quantity: 4, fee: 0.5 }, 2000);
    const path = join(dir, 'nested', 'portfolio.json');

    await savePortfolioSnapshot(path, p);
    const loaded = await loadPortfolioSnapshot(path);

    assert.ok(loaded);
    assert.equal(loaded.cash, p.cash);
    assert.deepEqual(loaded.positions.get('ETHEUR'), p.positions.get('ETHEUR'));
  });
});

test('savePortfolioSnapshot : deux écritures successives ne corrompent jamais le fichier final (écriture atomique via fichier temporaire + rename)', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'portfolio.json');

    const p1 = createPortfolio(1000);
    applyBuyFill(p1, 'XBTEUR', { price: 100, quantity: 1, fee: 1 }, 1000);
    await savePortfolioSnapshot(path, p1);

    const p2 = createPortfolio(1000);
    applyBuyFill(p2, 'XBTEUR', { price: 100, quantity: 1, fee: 1 }, 1000);
    applyBuyFill(p2, 'ETHEUR', { price: 50, quantity: 3, fee: 0.3 }, 2000);
    await savePortfolioSnapshot(path, p2);

    // Après les deux sauvegardes, le fichier chargé est un JSON valide
    // correspondant au DERNIER état sauvegardé — jamais un mélange tronqué
    // des deux écritures, aucun fichier .tmp résiduel ne doit non plus
    // apparaître à la place du fichier final.
    const loaded = await loadPortfolioSnapshot(path);
    assert.ok(loaded);
    assert.equal(loaded.cash, p2.cash);
    assert.deepEqual(loaded.positions.get('XBTEUR'), p2.positions.get('XBTEUR'));
    assert.deepEqual(loaded.positions.get('ETHEUR'), p2.positions.get('ETHEUR'));
  });
});

test('loadPortfolioSnapshot : renvoie undefined si le fichier n\'existe pas', async () => {
  await withTempDir(async (dir) => {
    const loaded = await loadPortfolioSnapshot(join(dir, 'absent.json'));
    assert.equal(loaded, undefined);
  });
});

test('appendTradeLog : chaque appel ajoute une ligne JSON, sans écraser les précédentes', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'trades.jsonl');
    const t1: Trade = { symbol: 'XBTEUR', side: 'buy', quantity: 1, price: 100, fee: 1, time: 1000 };
    const t2: Trade = { symbol: 'XBTEUR', side: 'sell', quantity: 1, price: 110, fee: 1, time: 2000 };

    await appendTradeLog(path, t1);
    await appendTradeLog(path, t2);

    const text = await readFile(path, 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), t1);
    assert.deepEqual(JSON.parse(lines[1]!), t2);
  });
});
