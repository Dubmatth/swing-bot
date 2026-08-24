/**
 * Validation walk-forward : sélectionne les meilleurs paramètres d'une
 * grille sur une fenêtre d'entraînement, puis mesure leur performance sur
 * la fenêtre suivante non vue (hors échantillon). Répété sur des fenêtres
 * glissantes à taille fixe qui couvrent la série de bout en bout, fenêtres
 * de test bord à bord sans chevauchement.
 *
 * Générique sur une strategyFactory : n'importe quelle stratégie
 * paramétrable peut être testée, ce module ne connaît aucune stratégie
 * précise.
 */

import type { BarSeries } from '../data/series.ts';
import { sliceSeries } from '../data/series.ts';
import type { Strategy } from '../strategy/types.ts';
import type { BacktestOptions } from './runner.ts';
import { runBacktest } from './runner.ts';
import { totalReturn } from './metrics.ts';

export interface WalkForwardConfig<P> {
  readonly trainBars: number;
  readonly testBars: number;
  readonly paramGrid: readonly P[];
  readonly strategyFactory: (params: P) => Strategy;
  readonly backtestOptions: BacktestOptions;
}

export interface FoldResult<P> {
  readonly foldIndex: number;
  readonly selectedParams: P;
  readonly inSampleReturn: number;
  readonly outOfSampleReturn: number;
}

export interface WalkForwardResult<P> {
  readonly folds: readonly FoldResult<P>[];
}

function sliceMap(
  series: ReadonlyMap<string, BarSeries>,
  from: number,
  to: number,
): Map<string, BarSeries> {
  const sliced = new Map<string, BarSeries>();
  for (const [symbol, s] of series) {
    sliced.set(symbol, sliceSeries(s, from, to));
  }
  return sliced;
}

export function runWalkForward<P>(
  series: ReadonlyMap<string, BarSeries>,
  config: WalkForwardConfig<P>,
): WalkForwardResult<P> {
  if (config.paramGrid.length === 0) {
    throw new RangeError('runWalkForward : au moins un jeu de paramètres requis');
  }
  if (!Number.isInteger(config.trainBars) || config.trainBars < 1) {
    throw new RangeError(`trainBars invalide : ${config.trainBars}`);
  }
  if (!Number.isInteger(config.testBars) || config.testBars < 1) {
    throw new RangeError(`testBars invalide : ${config.testBars}`);
  }

  const length = [...series.values()][0]?.length;
  if (length === undefined) {
    throw new Error('runWalkForward : au moins une série requise');
  }

  const folds: FoldResult<P>[] = [];
  for (let foldIndex = 0; ; foldIndex++) {
    const trainFrom = foldIndex * config.testBars;
    const trainTo = trainFrom + config.trainBars;
    const testFrom = trainTo;
    const testTo = testFrom + config.testBars;
    if (testTo > length) break;

    const trainSeries = sliceMap(series, trainFrom, trainTo);
    let bestParams: P = config.paramGrid[0]!;
    let bestReturn = -Infinity;
    for (const params of config.paramGrid) {
      const strategy = config.strategyFactory(params);
      const trainResult = runBacktest(trainSeries, strategy, config.backtestOptions);
      const inSampleReturn = totalReturn(trainResult.equityCurve, config.backtestOptions.initialCash);
      if (inSampleReturn > bestReturn) {
        bestReturn = inSampleReturn;
        bestParams = params;
      }
    }

    const testSeries = sliceMap(series, testFrom, testTo);
    const testStrategy = config.strategyFactory(bestParams);
    const testResult = runBacktest(testSeries, testStrategy, config.backtestOptions);
    const outOfSampleReturn = totalReturn(testResult.equityCurve, config.backtestOptions.initialCash);

    folds.push({
      foldIndex,
      selectedParams: bestParams,
      inSampleReturn: bestReturn,
      outOfSampleReturn,
    });
  }

  if (folds.length === 0) {
    throw new Error(
      `${length} barre(s), insuffisant pour au moins un fold ` +
        `(trainBars=${config.trainBars} + testBars=${config.testBars})`,
    );
  }

  return { folds };
}
