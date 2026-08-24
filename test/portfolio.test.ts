import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBuyFill,
  applySellFill,
  createPortfolio,
  portfolioEquity,
} from '../src/backtest/portfolio.ts';
import type { Fill } from '../src/backtest/execution.ts';

test('createPortfolio : cash initial, positions et trades vides', () => {
  const p = createPortfolio(1000);
  assert.equal(p.cash, 1000);
  assert.equal(p.positions.size, 0);
  assert.equal(p.trades.length, 0);
});

test('createPortfolio : cash initial invalide lève', () => {
  assert.throws(() => createPortfolio(0), /[Cc]ash/);
  assert.throws(() => createPortfolio(-100), /[Cc]ash/);
});

test('applyBuyFill : débite le cash, ouvre la position, journalise le trade', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: 100, quantity: 9, fee: 10 };
  applyBuyFill(p, 'TESTEUR', fill, 12345);

  assert.ok(Math.abs(p.cash - (1000 - (9 * 100 + 10))) < 1e-9);
  const position = p.positions.get('TESTEUR');
  assert.ok(position);
  assert.equal(position?.symbol, 'TESTEUR');
  assert.equal(position?.side, 'long');
  assert.equal(position?.quantity, 9);
  assert.equal(position?.entryPrice, 100);
  assert.equal(position?.entryTime, 12345);

  assert.equal(p.trades.length, 1);
  assert.equal(p.trades[0]?.side, 'buy');
});

test('applyBuyFill : achat sur une position déjà ouverte lève', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: 100, quantity: 1, fee: 1 };
  applyBuyFill(p, 'TESTEUR', fill, 1);
  assert.throws(() => applyBuyFill(p, 'TESTEUR', fill, 2), /déjà ouverte/);
});

test('applyBuyFill : un fill dont le coût dépasse le cash disponible lève', () => {
  const p = createPortfolio(100);
  const fill: Fill = { price: 100, quantity: 2, fee: 0 }; // coût 200 > cash 100
  assert.throws(() => applyBuyFill(p, 'TESTEUR', fill, 1), /dépasse le cash/);
});

test('applySellFill : crédite le cash, retire la position, journalise le trade', () => {
  const p = createPortfolio(1000);
  const buyFill: Fill = { price: 100, quantity: 9, fee: 10 };
  applyBuyFill(p, 'TESTEUR', buyFill, 1);
  const cashAfterBuy = p.cash;

  const sellFill: Fill = { price: 110, quantity: 9, fee: 9.9 };
  applySellFill(p, 'TESTEUR', sellFill, 2);

  assert.ok(Math.abs(p.cash - (cashAfterBuy + (9 * 110 - 9.9))) < 1e-9);
  assert.equal(p.positions.has('TESTEUR'), false);
  assert.equal(p.trades.length, 2);
  assert.equal(p.trades[1]?.side, 'sell');
});

test('applySellFill : vente sans position ouverte lève', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: 100, quantity: 1, fee: 1 };
  assert.throws(() => applySellFill(p, 'TESTEUR', fill, 1), /[Aa]ucune position/);
});

test('portfolioEquity : cash seul quand aucune position ouverte', () => {
  const p = createPortfolio(1000);
  assert.equal(portfolioEquity(p, new Map()), 1000);
});

test('portfolioEquity : cash + valeur de marché des positions ouvertes', () => {
  const p = createPortfolio(1000);
  applyBuyFill(p, 'AEUR', { price: 100, quantity: 5, fee: 10 }, 1);
  applyBuyFill(p, 'BEUR', { price: 50, quantity: 4, fee: 5 }, 1);
  const marks = new Map([
    ['AEUR', 110],
    ['BEUR', 40],
  ]);
  const expectedCash = 1000 - (5 * 100 + 10) - (4 * 50 + 5);
  const expected = expectedCash + 5 * 110 + 4 * 40;
  assert.ok(Math.abs(portfolioEquity(p, marks) - expected) < 1e-9);
});

test('portfolioEquity : prix de marque manquant pour une position ouverte lève', () => {
  const p = createPortfolio(1000);
  applyBuyFill(p, 'AEUR', { price: 100, quantity: 5, fee: 10 }, 1);
  assert.throws(() => portfolioEquity(p, new Map()), /marque/);
});

test('applyBuyFill : un fill dont le coût est NaN lève plutôt que de corrompre le cash', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: Infinity, quantity: 0, fee: NaN };
  assert.throws(() => applyBuyFill(p, 'TESTEUR', fill, 1), /dépasse le cash/);
  assert.equal(p.cash, 1000);
});
