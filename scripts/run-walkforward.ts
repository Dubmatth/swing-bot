/**
 * Lance une validation walk-forward de plusieurs candidats de stratégie sur
 * les 20 paires réelles de l'univers (données converties par
 * convert-trades.ts dans data/kraken-ohlcvt/).
 *
 * Script d'analyse exploratoire, non testé automatiquement — le mécanisme
 * walk-forward lui-même est déjà couvert par test/walkForward.test.ts et
 * test/phase4.test.ts sur données synthétiques.
 *
 * Usage : node --experimental-strip-types scripts/run-walkforward.ts
 */

import type { BarSeries } from '../src/data/series.ts';
import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createAtrRiskCrossover } from '../src/strategy/atrRiskCrossover.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import type { Strategy } from '../src/strategy/types.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Candidate<P> {
  readonly name: string;
  readonly paramGrid: readonly P[];
  readonly strategyFactory: (params: P) => Strategy;
}

interface AtrParams {
  readonly fast: number;
  readonly slow: number;
  readonly atrPeriod: number;
  readonly atrMultiplier: number;
}

interface MaParams {
  readonly fast: number;
  readonly slow: number;
}

function cartesian<T>(...arrays: readonly T[][]): T[][] {
  return arrays.reduce<T[][]>(
    (acc, arr) => acc.flatMap((combo) => arr.map((x) => [...combo, x])),
    [[]],
  );
}

const atrGrid: AtrParams[] = cartesian([5, 10, 20], [50, 100, 150], [14, 20], [1.5, 2, 3]).map(
  ([fast, slow, atrPeriod, atrMultiplier]) => ({ fast: fast!, slow: slow!, atrPeriod: atrPeriod!, atrMultiplier: atrMultiplier! }),
);

const maGrid: MaParams[] = cartesian([10, 20, 30], [50, 100, 150]).map(([fast, slow]) => ({
  fast: fast!,
  slow: slow!,
}));

const CANDIDATES: readonly Candidate<AtrParams | MaParams>[] = [
  {
    name: 'atr-risk-crossover (grille élargie)',
    paramGrid: atrGrid,
    strategyFactory: (p) =>
      combineStrategies(
        UNIVERSE_SYMBOLS.map((symbol) =>
          createAtrRiskCrossover({ symbol, ...(p as AtrParams) }),
        ),
      ),
  },
  {
    name: 'ma-crossover (référence, sans sizing par risque)',
    paramGrid: maGrid,
    strategyFactory: (p) =>
      combineStrategies(
        UNIVERSE_SYMBOLS.map((symbol) => createMaCrossover({ symbol, ...(p as MaParams) })),
      ),
  },
];

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

const TRAIN_BARS = 1095; // ~6 mois à 6 bougies/jour (interval=240)
const TEST_BARS = 180; // ~1 mois

function runCandidate<P>(series: ReadonlyMap<string, BarSeries>, candidate: Candidate<P>): void {
  const start = Date.now();
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: candidate.paramGrid,
    strategyFactory: candidate.strategyFactory,
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

  console.log(`\n=== ${candidate.name} ===`);
  console.log(`${candidate.paramGrid.length} jeux de paramètres, ${n} folds, ${elapsed}s`);
  console.log(`Moyenne in-sample     : ${(meanIn * 100).toFixed(2)}%`);
  console.log(`Moyenne hors échantillon : ${(meanOut * 100).toFixed(2)}%`);
  console.log(`Folds positifs hors échantillon : ${winFolds}/${n}`);
  console.log(`Meilleur/pire fold hors échantillon : ${(best * 100).toFixed(2)}% / ${(worst * 100).toFixed(2)}%`);
  console.log(
    meanOut > 0
      ? `=> Rendement hors échantillon positif en moyenne.`
      : `=> Pas d'edge démontré après frais.`,
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

  for (const candidate of CANDIDATES) {
    runCandidate(series, candidate);
  }
}

await main();
