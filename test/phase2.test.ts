/**
 * Critère de sortie de la Phase 2 (voir README) : le backtest multi-paires
 * ne dépasse jamais le capital disponible.
 *
 * Trois paires synthétiques identiques (même trajectoire de prix, donc
 * croisements garantis simultanés) forcent un dépassement du plafond de
 * positions concurrentes dans un scénario réaliste. Le test prouve que ce
 * dépassement est refusé proprement (order-rejected, raison "plafond..."),
 * pas qu'il ne se produit jamais — l'invariant que la Phase 1, mono-pair
 * par construction, ne pouvait pas violer et que la Phase 2 doit
 * maintenant garantir explicitement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const STEP = 14_400;
const SYMBOLS = ['AEUR', 'BEUR', 'CEUR'];

function oscillatingSeries(
  symbol: string,
  bars: number,
  base: number,
  amplitude: number,
  cycleLen: number,
): BarSeries {
  const c = emptyColumns();
  for (let i = 0; i < bars; i++) {
    const close = base + amplitude * Math.sin((2 * Math.PI * i) / cycleLen);
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(symbol, 240, c);
}

test('Phase 2 — critère de sortie : le multi-paires ne dépasse jamais le capital disponible', () => {
  const series = new Map(
    SYMBOLS.map((symbol) => [symbol, oscillatingSeries(symbol, 200, 100, 0.2, 20)] as const),
  );
  const strategy = combineStrategies(
    SYMBOLS.map((symbol) => createMaCrossover({ symbol, fast: 3, slow: 7 })),
  );

  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 2,
  });

  assert.ok(
    result.rejectedOrders > 0,
    `attendu au moins un rejet, obtenu ${result.rejectedOrders}`,
  );
  assert.ok(
    result.rejectionReasons.some((r) => r.includes('plafond')),
    `attendu au moins un rejet par plafond parmi [${result.rejectionReasons.join(', ')}]`,
  );

  assert.ok(
    result.portfolio.positions.size <= 2,
    `attendu au plus 2 positions ouvertes, obtenu ${result.portfolio.positions.size}`,
  );

  assert.ok(
    result.equityCurve.every((p) => p.equity >= 0),
    'attendu une équité jamais négative sur toute la courbe',
  );
});
