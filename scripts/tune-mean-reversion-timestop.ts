/**
 * Évalue si le stop de temps (Task 1) améliore le candidat déjà validé
 * (period=70-80, entryK=4, sans filtre d'entrée). Grille volontairement
 * étroite, calibrée sur la distribution réelle de durée de détention des
 * trades — voir la spec, section « Décisions actées ».
 *
 * Compte, pour chaque réglage, combien de sorties sont dues au stop de
 * temps vs au retour à la moyenne (nécessaire pour interpréter
 * honnêtement un résultat neutre ou dégradé — leçon de la Phase 7, où la
 * revue finale a reproché une vérification reposant sur de
 * l'instrumentation jetable non committée).
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion-timestop.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Params {
  readonly period: number;
  readonly entryK: number;
  readonly maxHoldBars?: number;
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

// Compteur module-level des sorties, vidé avant chaque run instrumenté.
let exitCounts = { timeStop: 0, meanReversion: 0 };

function withExitCounting(strategy: Strategy): Strategy {
  return {
    ...strategy,
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents = strategy.decide(ctx);
      for (const intent of intents) {
        if (intent.kind === 'exit') {
          if (intent.reason.startsWith('stop de temps')) {
            exitCounts.timeStop++;
          } else {
            exitCounts.meanReversion++;
          }
        }
      }
      return intents;
    },
  };
}

function strategyFactory(params: Params) {
  return combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => withExitCounting(createMeanReversion({ symbol, ...params }))),
  );
}

function runSingle(
  series: Awaited<ReturnType<typeof loadUniverse>>['series'],
  label: string,
  params: Params,
): void {
  exitCounts = { timeStop: 0, meanReversion: 0 };
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
  const counts =
    params.maxHoldBars !== undefined
      ? `  sorties: retour-moyenne=${exitCounts.meanReversion} stop-de-temps=${exitCounts.timeStop}`
      : '';
  console.log(`${label.padEnd(45)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}${counts}`);
}

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('Référence (sans stop de temps) :');
  runSingle(series, 'period=70, entryK=4', { period: 70, entryK: 4 });
  runSingle(series, 'period=80, entryK=4', { period: 80, entryK: 4 });

  console.log('\nAvec stop de temps :');
  for (const period of [70, 80]) {
    for (const maxHoldBars of [75, 90, 110]) {
      runSingle(
        series,
        `period=${period}, entryK=4, maxHoldBars=${maxHoldBars}`,
        { period, entryK: 4, maxHoldBars },
      );
    }
  }
}

await main();
