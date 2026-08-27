/**
 * Compare, par walk-forward ET par diagnostic de saturation du plafond,
 * le candidat mean-reversion déjà validé (Phase 6, combineStrategies,
 * ordre arbitraire de l'univers en cas de plafond atteint) à sa variante
 * cross-sectionnelle (priorité aux paires les plus survendues). Même
 * period/entryK des deux côtés, 0 degré de liberté ajouté — ce n'est pas
 * une nouvelle famille, c'est un raffinement du candidat déjà validé,
 * comme les Phases 7/8.
 *
 * Leçon des Phases 7-9 : avant d'interpréter un résultat neutre ou
 * dégradé, vérifier que le mécanisme testé a eu l'occasion de jouer. Le
 * réordonnancement par z-score ne peut avoir d'effet que si le plafond
 * maxConcurrentPositions est effectivement atteint alors que plusieurs
 * paires sont éligibles simultanément — le diagnostic ci-dessous
 * (backtest complet, hors walk-forward) compte combien de rejets sont dus
 * à « plafond de positions concurrentes atteint » pour les deux variantes.
 *
 * Usage : node --experimental-strip-types scripts/tune-cross-sectional-mean-reversion.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { createCrossSectionalMeanReversion } from '../src/strategy/crossSectionalMeanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import type { BarSeries } from '../src/data/series.ts';
import type { Strategy } from '../src/strategy/types.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Params {
  readonly period: number;
  readonly entryK: number;
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
const PERIODS = [70, 80];
const ENTRY_K = 4;

function referenceStrategy(p: Params): Strategy {
  return combineStrategies(UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...p })));
}

function crossSectionalStrategy(p: Params): Strategy {
  return createCrossSectionalMeanReversion(p);
}

function runWalkForwardSingle(
  series: ReadonlyMap<string, BarSeries>,
  label: string,
  strategyFactory: (p: Params) => Strategy,
  params: Params,
): void {
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: [params], // 0 degré de liberté
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });
  const n = result.folds.length;
  const meanOut = result.folds.reduce((s, f) => s + f.outOfSampleReturn, 0) / n;
  const win = result.folds.filter((f) => f.outOfSampleReturn > 0).length;
  console.log(`${label.padEnd(55)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}`);
}

function countCapRejections(rejectionReasons: readonly string[]): number {
  return rejectionReasons.filter((r) => r === 'plafond de positions concurrentes atteint').length;
}

function runCapacityDiagnostic(
  series: ReadonlyMap<string, BarSeries>,
  label: string,
  strategy: Strategy,
): void {
  const result = runBacktest(series, strategy, BACKTEST_OPTIONS);
  const capRejections = countCapRejections(result.rejectionReasons);
  console.log(
    `${label.padEnd(55)} rejets totaux=${result.rejectedOrders}  ` +
      `dont plafond atteint=${capRejections}  trades exécutés=${result.portfolio.trades.length}`,
  );
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

  console.log('\n=== Walk-forward : référence (combineStrategies) vs cross-sectionnelle ===');
  for (const period of PERIODS) {
    const params: Params = { period, entryK: ENTRY_K };
    runWalkForwardSingle(series, `référence period=${period}, entryK=${ENTRY_K}`, referenceStrategy, params);
    runWalkForwardSingle(
      series,
      `cross-sectionnelle period=${period}, entryK=${ENTRY_K}`,
      crossSectionalStrategy,
      params,
    );
  }

  console.log('\n=== Diagnostic de saturation du plafond (backtest complet, hors walk-forward) ===');
  for (const period of PERIODS) {
    const params: Params = { period, entryK: ENTRY_K };
    runCapacityDiagnostic(series, `référence period=${period}, entryK=${ENTRY_K}`, referenceStrategy(params));
    runCapacityDiagnostic(
      series,
      `cross-sectionnelle period=${period}, entryK=${ENTRY_K}`,
      crossSectionalStrategy(params),
    );
  }
}

await main();
