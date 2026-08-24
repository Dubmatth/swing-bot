import test from 'node:test';
import assert from 'node:assert/strict';

import { totalReturn } from '../src/backtest/metrics.ts';
import type { EquityPoint } from '../src/backtest/runner.ts';

test('totalReturn : calcule le rendement entre le cash initial et la dernière équité', () => {
  const curve: EquityPoint[] = [
    { time: 0, equity: 1000 },
    { time: 1, equity: 1100 },
    { time: 2, equity: 1050 },
  ];
  assert.ok(Math.abs(totalReturn(curve, 1000) - 0.05) < 1e-9);
});

test('totalReturn : rendement négatif si perte', () => {
  const curve: EquityPoint[] = [{ time: 0, equity: 900 }];
  assert.ok(Math.abs(totalReturn(curve, 1000) - -0.1) < 1e-9);
});

test('totalReturn : lève si equityCurve est vide', () => {
  assert.throws(() => totalReturn([], 1000), /vide/);
});
