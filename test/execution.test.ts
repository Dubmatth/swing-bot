import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FEES,
  simulateBuy,
  simulateSell,
} from '../src/backtest/execution.ts';
import type { ExecutionOptions } from '../src/backtest/execution.ts';

const OPTS: ExecutionOptions = { fees: DEFAULT_FEES, slippageBps: 10 };

test("simulateBuy : le slippage majore le prix d'exécution", () => {
  const fill = simulateBuy(1000, 100, OPTS);
  assert.ok(fill.price > 100, `attendu prix > 100, obtenu ${fill.price}`);
  assert.ok(
    Math.abs(fill.price - 100 * 1.001) < 1e-9,
    `attendu 100.1 (slippage 10 bps), obtenu ${fill.price}`,
  );
});

test('simulateBuy : quantité et frais consomment exactement le cash disponible', () => {
  const cash = 1000;
  const fill = simulateBuy(cash, 100, OPTS);
  const spent = fill.quantity * fill.price + fill.fee;
  assert.ok(Math.abs(spent - cash) < 1e-9, `attendu ${cash} dépensé, obtenu ${spent}`);
});

test('simulateBuy : cash nul ou négatif lève', () => {
  assert.throws(() => simulateBuy(0, 100, OPTS), /[Cc]ash/);
  assert.throws(() => simulateBuy(-10, 100, OPTS), /[Cc]ash/);
});

test('simulateBuy : prix de référence invalide lève', () => {
  assert.throws(() => simulateBuy(1000, 0, OPTS), /[Pp]rix/);
  assert.throws(() => simulateBuy(1000, -5, OPTS), /[Pp]rix/);
});

test("simulateSell : le slippage minore le prix d'exécution", () => {
  const fill = simulateSell(1, 100, OPTS);
  assert.ok(fill.price < 100, `attendu prix < 100, obtenu ${fill.price}`);
  assert.ok(
    Math.abs(fill.price - 100 * 0.999) < 1e-9,
    `attendu 99.9 (slippage 10 bps), obtenu ${fill.price}`,
  );
});

test('simulateSell : le fee est proportionnel au produit de la vente', () => {
  const quantity = 2;
  const fill = simulateSell(quantity, 100, OPTS);
  const expectedFee = quantity * fill.price * (DEFAULT_FEES.takerBps / 10_000);
  assert.ok(Math.abs(fill.fee - expectedFee) < 1e-9, `attendu fee ${expectedFee}, obtenu ${fill.fee}`);
});

test('simulateSell : quantité nulle ou négative lève', () => {
  assert.throws(() => simulateSell(0, 100, OPTS), /[Qq]uantité/);
  assert.throws(() => simulateSell(-1, 100, OPTS), /[Qq]uantité/);
});
