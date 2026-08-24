/**
 * Évalue si le filtre de volume (Task 1) améliore le candidat déjà
 * validé (period=70-80, entryK=4, sans filtre de tendance). Grille
 * volontairement étroite — voir la spec, section « Décisions actées ».
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion-volume.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Params {
  readonly period: number;
  readonly entryK: number;
  readonly volumePeriod?: number;
  readonly volumeMultiplier?: number;
}

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

const TRAIN_BARS = 1095;
const TEST_BARS = 180;

function strategyFactory(params: Params) {
  return combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...params })),
  );
}

function runSingle(
  series: Awaited<ReturnType<typeof loadUniverse>>['series'],
  label: string,
  params: Params,
): void {
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: [params], // 0 degré de liberté — un seul réglage fixe
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });
  const n = result.folds.length;
  const meanOut = result.folds.reduce((s, f) => s + f.outOfSampleReturn, 0) / n;
  const win = result.folds.filter((f) => f.outOfSampleReturn > 0).length;
  console.log(`${label.padEnd(45)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}`);
}

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('Référence (sans filtre de volume) :');
  runSingle(series, 'period=70, entryK=4', { period: 70, entryK: 4 });
  runSingle(series, 'period=80, entryK=4', { period: 80, entryK: 4 });

  console.log('\nAvec filtre de volume (volumePeriod=20) :');
  for (const period of [70, 80]) {
    for (const volumeMultiplier of [1.2, 1.5, 2.0]) {
      runSingle(
        series,
        `period=${period}, entryK=4, volumeMultiplier=${volumeMultiplier}`,
        { period, entryK: 4, volumePeriod: 20, volumeMultiplier },
      );
    }
  }
}

await main();
