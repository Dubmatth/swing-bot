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
 * Instrumentation additionnelle (suite à la revue finale de branche sur
 * cette phase, qui a montré que le compteur ci-dessus, train+test combiné,
 * ne dit rien de ce qui se passe hors échantillon) :
 *  - un second compteur qui rejoue UNIQUEMENT les 37 fenêtres de test
 *    walk-forward (sans la portion d'entraînement — même principe que
 *    `collectEntryAttempts` dans tune-mean-reversion-volatility.ts, Phase
 *    7) pour mesurer les sorties par stop de temps réellement mesurées
 *    hors échantillon, distinctement du compteur train+test combiné ;
 *  - une comparaison en pleine précision (pas l'arrondi à 2 décimales du
 *    résumé affiché) des rendements de fold entre chaque réglage avec stop
 *    de temps et sa référence sans stop, sur les 37 folds.
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion-timestop.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import type { BarSeries } from '../src/data/series.ts';
import { sliceSeries } from '../src/data/series.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import { runBacktest } from '../src/backtest/runner.ts';
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
// runBacktest itère t de warmup à length-2 et remplit une entrée à t+1 : le
// barsHeld maximal atteignable dans une fenêtre de test isolée de TEST_BARS
// barres est (TEST_BARS-2)-(warmup+1) = TEST_BARS-3-period, soit 107 pour
// period=70 et 97 pour period=80 — voir la puce README « Stop de temps ».
const TEST_BARS = 180;

// Compteur train+test COMBINÉ (entraînement + test de chaque fold), vidé
// avant chaque run instrumenté. Historique depuis le premier commit de ce
// script — volontairement distinct du compteur test-only ci-dessous, qui ne
// rejoue que la portion mesurée hors échantillon de chaque fold.
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

/** Rendement hors échantillon de chaque fold, en pleine précision. Effet de
 * bord : incrémente `exitCounts` (train+test combiné) au passage. */
function computeFolds(series: ReadonlyMap<string, BarSeries>, params: Params): number[] {
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: [params], // 0 degré de liberté — un seul réglage fixe
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });
  return result.folds.map((f) => f.outOfSampleReturn);
}

function runSingle(series: ReadonlyMap<string, BarSeries>, label: string, params: Params): number[] {
  exitCounts = { timeStop: 0, meanReversion: 0 };
  const folds = computeFolds(series, params);
  const n = folds.length;
  const meanOut = folds.reduce((s, v) => s + v, 0) / n;
  const win = folds.filter((v) => v > 0).length;
  const counts =
    params.maxHoldBars !== undefined
      ? `  sorties (train+test combiné): retour-moyenne=${exitCounts.meanReversion} stop-de-temps=${exitCounts.timeStop}`
      : '';
  console.log(`${label.padEnd(45)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}${counts}`);
  return folds;
}

// ---------------------------------------------------------------------------
// Instrumentation : sorties par stop de temps dans les fenêtres de test
// SEULEMENT (Finding « Important » #1/#2 de la revue finale de branche) —
// même principe que `collectEntryAttempts` dans tune-mean-reversion-
// volatility.ts (Phase 7) : le compteur train+test combiné ci-dessus ne dit
// rien de ce qui se passe hors échantillon, seule la portion test de chaque
// fold est mesurée hors échantillon par runWalkForward.
// ---------------------------------------------------------------------------

/** Vidé avant chaque passage instrumenté par `collectTestOnlyExitCounts`. */
let testOnlyExitCounts = { timeStop: 0, meanReversion: 0 };

function withTestOnlyExitCounting(strategy: Strategy): Strategy {
  return {
    ...strategy,
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents = strategy.decide(ctx);
      for (const intent of intents) {
        if (intent.kind === 'exit') {
          if (intent.reason.startsWith('stop de temps')) {
            testOnlyExitCounts.timeStop++;
          } else {
            testOnlyExitCounts.meanReversion++;
          }
        }
      }
      return intents;
    },
  };
}

function sliceMap(series: ReadonlyMap<string, BarSeries>, from: number, to: number): Map<string, BarSeries> {
  const sliced = new Map<string, BarSeries>();
  for (const [symbol, s] of series) sliced.set(symbol, sliceSeries(s, from, to));
  return sliced;
}

/**
 * Rejoue les mêmes 37 fenêtres de test que runWalkForward (mêmes bornes
 * trainBars/testBars), avec une version instrumentée de la stratégie, pour
 * compter les sorties par catégorie réellement mesurées hors échantillon —
 * sans jamais rejouer la portion d'entraînement de chaque fold.
 */
function collectTestOnlyExitCounts(
  series: ReadonlyMap<string, BarSeries>,
  params: Params,
): { timeStop: number; meanReversion: number } {
  testOnlyExitCounts = { timeStop: 0, meanReversion: 0 };
  const strategy = combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => withTestOnlyExitCounting(createMeanReversion({ symbol, ...params }))),
  );
  const firstSeries = series.values().next().value;
  if (!firstSeries) throw new Error('collectTestOnlyExitCounts : au moins une série requise');
  const length = firstSeries.length;
  for (let foldIndex = 0; ; foldIndex++) {
    const testFrom = foldIndex * TEST_BARS + TRAIN_BARS;
    const testTo = testFrom + TEST_BARS;
    if (testTo > length) break;
    runBacktest(sliceMap(series, testFrom, testTo), strategy, BACKTEST_OPTIONS);
  }
  return testOnlyExitCounts;
}

function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`maxAbsDiff : longueurs différentes (${a.length} vs ${b.length})`);
  }
  return Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
}

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('Référence (sans stop de temps) :');
  const reference70 = runSingle(series, 'period=70, entryK=4', { period: 70, entryK: 4 });
  const reference80 = runSingle(series, 'period=80, entryK=4', { period: 80, entryK: 4 });
  const reference: Record<number, number[]> = { 70: reference70, 80: reference80 };

  console.log('\nAvec stop de temps :');
  const foldsByKey = new Map<string, number[]>();
  for (const period of [70, 80]) {
    for (const maxHoldBars of [75, 90, 110]) {
      const folds = runSingle(
        series,
        `period=${period}, entryK=4, maxHoldBars=${maxHoldBars}`,
        { period, entryK: 4, maxHoldBars },
      );
      foldsByKey.set(`${period}-${maxHoldBars}`, folds);
    }
  }

  console.log(
    "\nSorties par stop de temps dans les fenêtres de test SEULEMENT " +
      '(hors échantillon, sans la portion d\'entraînement de chaque fold) :',
  );
  for (const period of [70, 80]) {
    for (const maxHoldBars of [75, 90, 110]) {
      const counts = collectTestOnlyExitCounts(series, { period, entryK: 4, maxHoldBars });
      console.log(
        `  period=${period}, maxHoldBars=${maxHoldBars} -> ` +
          `stop-de-temps=${counts.timeStop} retour-moyenne=${counts.meanReversion} (sur les 37 fenêtres de test)`,
      );
    }
  }

  console.log('\nÉgalité en pleine précision (par fold, pas l\'arrondi à 2 décimales) contre la référence :');
  for (const period of [70, 80]) {
    for (const maxHoldBars of [75, 90, 110]) {
      const folds = foldsByKey.get(`${period}-${maxHoldBars}`)!;
      const diff = maxAbsDiff(reference[period]!, folds);
      console.log(`  period=${period}, maxHoldBars=${maxHoldBars} : max(|diff|) sur ${folds.length} folds = ${diff}`);
    }
  }
}

await main();
