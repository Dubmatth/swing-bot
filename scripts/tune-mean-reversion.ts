/**
 * Explore des réglages moins fréquents de mean-reversion pour réduire le
 * poids des frais.
 *
 * Diagnostic préalable (voir conversation) : à period=20/entryK=2 sur
 * interval=240, la stratégie fait 2321 trades sur 3,5 ans avec 5636 refus
 * "plafond de positions concurrentes atteint" — elle génère beaucoup plus
 * de signaux que ce que maxConcurrentPositions=5 laisse exécuter, avec une
 * détention moyenne de ~59h. Les frais (6150€ sur 10000€ initiaux) dominent
 * le résultat. Ce script teste (1) un seuil d'entrée plus large / période
 * plus longue à interval=240, et (2) le même principe à interval=1440
 * (quotidien), qui réduit structurellement la fréquence de trading.
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion.ts
 */

import type { Interval } from '../src/data/series.ts';
import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface MeanReversionParams {
  readonly period: number;
  readonly entryK: number;
}

function cartesian<T>(...arrays: readonly T[][]): T[][] {
  return arrays.reduce<T[][]>(
    (acc, arr) => acc.flatMap((combo) => arr.map((x) => [...combo, x])),
    [[]],
  );
}

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

interface RunSpec {
  readonly label: string;
  readonly interval: Interval;
  readonly trainBars: number;
  readonly testBars: number;
  readonly paramGrid: readonly MeanReversionParams[];
}

const RUNS: readonly RunSpec[] = [
  {
    label: 'interval=240, entrées encore plus rares (period 50-150, entryK 3-6)',
    interval: 240,
    trainBars: 1095,
    testBars: 180,
    paramGrid: cartesian([50, 80, 100, 150], [3, 3.5, 4, 4.5, 5, 6]).map(
      ([period, entryK]) => ({ period: period!, entryK: entryK! }),
    ),
  },
  {
    label: 'interval=1440 (quotidien), fréquence structurellement réduite',
    interval: 1440,
    trainBars: 270,
    testBars: 60,
    paramGrid: cartesian([10, 20, 30], [1.5, 2, 2.5, 3]).map(([period, entryK]) => ({
      period: period!,
      entryK: entryK!,
    })),
  },
];

async function main(): Promise<void> {
  for (const run of RUNS) {
    console.log(`\n### ${run.label} ###`);
    const { series, commonStart, commonEnd } = await loadUniverse(UNIVERSE_SYMBOLS, {
      dir: 'data/kraken-ohlcvt',
      interval: run.interval,
      from: Math.floor(Date.parse('2019-01-01') / 1000),
    });
    console.log(
      `Fenêtre : ${new Date(commonStart * 1000).toISOString()} -> ` +
        `${new Date(commonEnd * 1000).toISOString()} (${series.get(UNIVERSE_SYMBOLS[0]!)!.length} bougies)`,
    );

    const start = Date.now();
    const result = runWalkForward(series, {
      trainBars: run.trainBars,
      testBars: run.testBars,
      paramGrid: run.paramGrid,
      strategyFactory: (p) =>
        combineStrategies(
          UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...p })),
        ),
      backtestOptions: BACKTEST_OPTIONS,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    let sumIn = 0;
    let sumOut = 0;
    let winFolds = 0;
    for (const fold of result.folds) {
      sumIn += fold.inSampleReturn;
      sumOut += fold.outOfSampleReturn;
      if (fold.outOfSampleReturn > 0) winFolds++;
    }
    const n = result.folds.length;
    console.log(`${run.paramGrid.length} jeux de paramètres, ${n} folds, ${elapsed}s`);
    console.log(`Moyenne in-sample     : ${((sumIn / n) * 100).toFixed(2)}%`);
    console.log(`Moyenne hors échantillon : ${((sumOut / n) * 100).toFixed(2)}%`);
    console.log(`Folds positifs hors échantillon : ${winFolds}/${n}`);
  }
}

await main();
