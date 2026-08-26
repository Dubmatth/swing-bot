/**
 * Évalue par walk-forward le momentum cross-sectionnel (Phase 9) sur les 20
 * paires réelles de l'univers. Contrairement aux scripts de réglage fin de
 * mean-reversion (Phases 6-8, qui re-testent un filtre optionnel sur un
 * candidat déjà validé avec une grille à 0 degré de liberté), cette phase
 * explore une nouvelle famille de stratégie depuis zéro — grille
 * exploratoire avec sélection walk-forward réelle, comme le premier passage
 * sur le suivi de tendance (voir run-walkforward.ts).
 *
 * `topN` est en dehors du paramGrid walk-forward : il doit être couplé à
 * `BacktestOptions.maxConcurrentPositions` (sizeBuyOrder dimensionne chaque
 * position en fraction de equity/maxConcurrentPositions — si topN <
 * maxConcurrentPositions, le capital serait sous-déployé). runWalkForward
 * n'accepte qu'un seul BacktestOptions fixe par appel, donc un appel séparé
 * est nécessaire par valeur de topN.
 *
 * Usage : node --experimental-strip-types scripts/tune-cross-sectional-momentum.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createCrossSectionalMomentum } from '../src/strategy/crossSectionalMomentum.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { BarSeries } from '../src/data/series.ts';

interface LookbackParams {
  readonly lookbackPeriod: number;
}

const TOP_N_VALUES = [3, 5, 7];
const LOOKBACK_PERIODS = [42, 84, 168]; // ~7j, 14j, 28j à 6 bougies 4h/jour

const TRAIN_BARS = 1095;
const TEST_BARS = 180;

function runForTopN(series: ReadonlyMap<string, BarSeries>, topN: number): void {
  const backtestOptions: BacktestOptions = {
    initialCash: 10000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: topN,
    riskPerTradePct: 0.01,
  };

  const paramGrid: LookbackParams[] = LOOKBACK_PERIODS.map((lookbackPeriod) => ({ lookbackPeriod }));

  const start = Date.now();
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid,
    strategyFactory: (p) => createCrossSectionalMomentum({ lookbackPeriod: p.lookbackPeriod, topN }),
    backtestOptions,
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

  console.log(`\n=== momentum cross-sectionnel, topN=${topN} ===`);
  console.log(`${paramGrid.length} lookbackPeriod testés, ${n} folds, ${elapsed}s`);
  console.log(`Moyenne in-sample        : ${(meanIn * 100).toFixed(2)}%`);
  console.log(`Moyenne hors échantillon : ${(meanOut * 100).toFixed(2)}%`);
  console.log(`Folds positifs hors échantillon : ${winFolds}/${n}`);
  console.log(`Meilleur/pire fold hors échantillon : ${(best * 100).toFixed(2)}% / ${(worst * 100).toFixed(2)}%`);
  for (const fold of result.folds) {
    console.log(
      `  fold ${fold.foldIndex} : lookbackPeriod=${fold.selectedParams.lookbackPeriod} ` +
        `in=${(fold.inSampleReturn * 100).toFixed(2)}% out=${(fold.outOfSampleReturn * 100).toFixed(2)}%`,
    );
  }
}

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

  for (const topN of TOP_N_VALUES) {
    runForTopN(series, topN);
  }
}

await main();
