/**
 * Évalue par walk-forward le breakout Donchian/Turtle (Phase 10) sur les 20
 * paires réelles de l'univers. Grille exploratoire (pas 0-DoF — découverte
 * d'une nouvelle famille, comme le premier passage sur le suivi de tendance
 * et la Phase 9), calibrée directement en bougies 4h avec une marge
 * confortable sous TEST_BARS=180 : convertir naïvement la référence
 * historique (20/55 JOURS) donnerait entryPeriod≈330 bougies 4h, largement
 * supérieur à TEST_BARS et ferait échouer runBacktest immédiatement
 * (length < warmup+2) — même piège que la dilution repérée en Phase 9.
 *
 * Usage : node --experimental-strip-types scripts/tune-donchian-breakout.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createDonchianBreakout } from '../src/strategy/donchianBreakout.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface DonchianParams {
  readonly entryPeriod: number;
  readonly exitPeriod: number;
}

// Paires alignées (ratio ~3:1, convention Turtle historique) plutôt qu'un
// produit cartésien complet — voir la spec pour la justification.
const PARAM_GRID: DonchianParams[] = [
  { entryPeriod: 30, exitPeriod: 10 },
  { entryPeriod: 60, exitPeriod: 20 },
  { entryPeriod: 120, exitPeriod: 40 },
];

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

const TRAIN_BARS = 1095;
const TEST_BARS = 180;

async function main(): Promise<void> {
  console.log(`Chargement de ${UNIVERSE_SYMBOLS.length} paires (interval=240)...`);
  const { series, commonStart, commonEnd } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });
  console.log(
    `Fenêtre commune : ${new Date(commonStart * 1000).toISOString()} -> ` +
      `${new Date(commonEnd * 1000).toISOString()} (${series.get(UNIVERSE_SYMBOLS[0]!)!.length} bougies)`,
  );

  const start = Date.now();
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: PARAM_GRID,
    strategyFactory: (p) =>
      combineStrategies(UNIVERSE_SYMBOLS.map((symbol) => createDonchianBreakout({ symbol, ...p }))),
    backtestOptions: BACKTEST_OPTIONS,
  });

  let sumIn = 0;
  let sumOut = 0;
  let winFolds = 0;
  let best = -Infinity;
  let worst = Infinity;
  for (const fold of result.folds) {
    sumIn += fold.inSampleReturn;
    sumOut += fold.outOfSampleReturn;
    if (fold.outOfSampleReturn > 0) winFolds++;
    best = Math.max(best, fold.outOfSampleReturn);
    worst = Math.min(worst, fold.outOfSampleReturn);
  }
  const n = result.folds.length;
  const meanIn = sumIn / n;
  const meanOut = sumOut / n;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n=== donchian-breakout ===`);
  console.log(`${PARAM_GRID.length} jeux de paramètres, ${n} folds, ${elapsed}s`);
  console.log(`Moyenne in-sample        : ${(meanIn * 100).toFixed(2)}%`);
  console.log(`Moyenne hors échantillon : ${(meanOut * 100).toFixed(2)}%`);
  console.log(`Folds positifs hors échantillon : ${winFolds}/${n}`);
  console.log(`Meilleur/pire fold hors échantillon : ${(best * 100).toFixed(2)}% / ${(worst * 100).toFixed(2)}%`);
  for (const fold of result.folds) {
    console.log(
      `  fold ${fold.foldIndex} : entryPeriod=${fold.selectedParams.entryPeriod} ` +
        `exitPeriod=${fold.selectedParams.exitPeriod} ` +
        `in=${(fold.inSampleReturn * 100).toFixed(2)}% out=${(fold.outOfSampleReturn * 100).toFixed(2)}%`,
    );
  }
}

await main();
