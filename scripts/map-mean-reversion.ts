/**
 * Cartographie la sensibilité de mean-reversion à ses paramètres, sur la
 * période complète, sans sélection walk-forward (0 degré de liberté par
 * point). Objectif : vérifier si la zone "modérée" qui a donné +0,19% en
 * walk-forward est un vrai plateau de résultats voisins cohérents, ou un
 * pic isolé — auquel cas ce serait du bruit, comme le +57% de
 * period=80/entryK=4 s'est révélé l'être une fois passé au walk-forward.
 *
 * Usage : node --experimental-strip-types scripts/map-mean-reversion.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { totalReturn } from '../src/backtest/metrics.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

const PERIODS = [20, 30, 40, 50, 60, 70, 80];
const ENTRY_KS = [2, 2.5, 3, 3.5, 4];

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('rendement net (%) sur la période complète, colonnes = entryK, lignes = period\n');
  const header = 'period\\entryK  ' + ENTRY_KS.map((k) => k.toString().padStart(8)).join('');
  console.log(header);

  for (const period of PERIODS) {
    const row: string[] = [];
    for (const entryK of ENTRY_KS) {
      const strategy = combineStrategies(
        UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, period, entryK })),
      );
      const result = runBacktest(series, strategy, BACKTEST_OPTIONS);
      const ret = totalReturn(result.equityCurve, BACKTEST_OPTIONS.initialCash) * 100;
      row.push(ret.toFixed(1).padStart(8));
    }
    console.log(`${String(period).padStart(13)}  ${row.join('')}`);
  }

  console.log('\nnombre de trades, même grille\n');
  console.log(header);
  for (const period of PERIODS) {
    const row: string[] = [];
    for (const entryK of ENTRY_KS) {
      const strategy = combineStrategies(
        UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, period, entryK })),
      );
      const result = runBacktest(series, strategy, BACKTEST_OPTIONS);
      row.push(String(result.portfolio.trades.length).padStart(8));
    }
    console.log(`${String(period).padStart(13)}  ${row.join('')}`);
  }
}

await main();
