/**
 * Critère de sortie de la Phase 4 (voir README) : le walk-forward révèle
 * l'overfitting plutôt que de le masquer.
 *
 * Marché synthétique sans structure réelle (bruit pseudo-aléatoire
 * déterministe — un générateur congruentiel linéaire à graine fixe, pas
 * de vraie randomisation, pour rester reproductible) et une grille de
 * paramètres riche (48 combinaisons fast/slow pour createMaCrossover).
 * Sur des données sans edge réel, la combinaison sélectionnée par
 * recherche in-sample capture nécessairement du bruit plutôt qu'un
 * signal — c'est le biais de sélection multiple (« choisir le meilleur
 * parmi 48 » gonfle artificiellement la performance mesurée sur les
 * données mêmes qui ont servi à choisir). Le walk-forward doit exposer ce
 * biais : le rendement moyen in-sample doit être significativement
 * meilleur que le rendement moyen hors échantillon des mêmes paramètres.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';
import type { MaCrossoverParams } from '../src/strategy/maCrossover.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

/** Générateur congruentiel linéaire — déterministe, pas Math.random. */
function lcgNoiseSeries(bars: number, seed: number, base: number, stepScale: number): BarSeries {
  const c = emptyColumns();
  let state = seed;
  let price = base;
  for (let i = 0; i < bars; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const u = state / 0x7fffffff; // [0, 1)
    price += (u - 0.5) * 2 * stepScale;
    c.time.push(i * STEP);
    c.open.push(price);
    c.high.push(price);
    c.low.push(price);
    c.close.push(price);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(SYMBOL, 240, c);
}

function buildParamGrid(): MaCrossoverParams[] {
  const grid: MaCrossoverParams[] = [];
  for (const fast of [2, 3, 4, 5, 6, 8, 10, 12]) {
    for (const slowOffset of [2, 4, 6, 10, 15, 20]) {
      grid.push({ symbol: SYMBOL, fast, slow: fast + slowOffset });
    }
  }
  return grid;
}

test("Phase 4 — critère de sortie : le walk-forward révèle l'overfitting plutôt que de le masquer", () => {
  const series = new Map([[SYMBOL, lcgNoiseSeries(400, 42, 100, 1.5)]]);
  const paramGrid = buildParamGrid();

  const result = runWalkForward(series, {
    trainBars: 90,
    testBars: 40,
    paramGrid,
    strategyFactory: (params: MaCrossoverParams) => createMaCrossover(params),
    backtestOptions: {
      initialCash: 1000,
      fees: DEFAULT_FEES,
      slippageBps: 5,
      maxConcurrentPositions: 1,
      riskPerTradePct: 1,
    },
  });

  assert.ok(
    result.folds.length >= 3,
    `attendu au moins 3 folds pour une moyenne significative, obtenu ${result.folds.length}`,
  );

  const meanInSample =
    result.folds.reduce((sum, f) => sum + f.inSampleReturn, 0) / result.folds.length;
  const meanOutOfSample =
    result.folds.reduce((sum, f) => sum + f.outOfSampleReturn, 0) / result.folds.length;

  assert.ok(
    meanInSample > meanOutOfSample,
    `attendu in-sample (${meanInSample}) > hors échantillon (${meanOutOfSample}) — ` +
      `signature attendue de l'overfitting sur données sans edge réel`,
  );
});
