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
import { runBacktest } from '../src/backtest/runner.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { BarSeries } from '../src/data/series.ts';
import { sliceSeries } from '../src/data/series.ts';

interface LookbackParams {
  readonly lookbackPeriod: number;
}

const TOP_N_VALUES = [3, 5, 7];
const LOOKBACK_PERIODS = [42, 84, 168]; // ~7j, 14j, 28j à 6 bougies 4h/jour

const TRAIN_BARS = 1095;
// runBacktest itère t de warmup (=lookbackPeriod ici) à length-2 : dans une
// fenêtre de test isolée de TEST_BARS barres, seuls t ∈ [lookbackPeriod,
// TEST_BARS-2] sont des barres de décision. Pour lookbackPeriod=168, cela ne
// laisse que 11 barres (168..178) face à une frontière de rebalancement
// hebdomadaire tous les 42 barres — au plus une frontière peut y tomber, et
// souvent aucune. Voir l'instrumentation `countZeroRebalanceFolds` plus bas
// et la puce README « Momentum cross-sectionnel » (même famille de piège
// que les Phases 7 et 8, où une grille ou un mécanisme dépasse ce que le
// harnais walk-forward peut réellement mesurer hors échantillon).
const TEST_BARS = 180;

function sliceMap(series: ReadonlyMap<string, BarSeries>, from: number, to: number): Map<string, BarSeries> {
  const sliced = new Map<string, BarSeries>();
  for (const [symbol, s] of series) sliced.set(symbol, sliceSeries(s, from, to));
  return sliced;
}

/**
 * Rejoue les mêmes fenêtres de test que runWalkForward (mêmes bornes
 * trainBars/testBars), pour un (topN, lookbackPeriod) fixe, et compte
 * combien de ces fenêtres n'ont vu AUCUN rebalancement — jamais la portion
 * d'entraînement de chaque fold, même principe que
 * `collectTestOnlyExitCounts` dans tune-mean-reversion-timestop.ts (Phase 8).
 *
 * Détection : une fenêtre de test sans rebalancement produit une courbe
 * d'équité rigoureusement plate à `initialCash` (aucune position n'est
 * jamais ouverte, donc aucun frais ni P&L) — plus simple et tout aussi fiable
 * que d'instrumenter `decide()` pour compter les barres non-hold.
 */
function countZeroRebalanceFolds(
  series: ReadonlyMap<string, BarSeries>,
  topN: number,
  lookbackPeriod: number,
  backtestOptions: BacktestOptions,
): { readonly zeroRebalanceFolds: number; readonly totalFolds: number } {
  const firstSeries = series.values().next().value;
  if (!firstSeries) throw new Error('countZeroRebalanceFolds : au moins une série requise');
  const length = firstSeries.length;

  let zeroRebalanceFolds = 0;
  let totalFolds = 0;
  for (let foldIndex = 0; ; foldIndex++) {
    const testFrom = foldIndex * TEST_BARS + TRAIN_BARS;
    const testTo = testFrom + TEST_BARS;
    if (testTo > length) break;
    const strategy = createCrossSectionalMomentum({ lookbackPeriod, topN });
    const result = runBacktest(sliceMap(series, testFrom, testTo), strategy, backtestOptions);
    totalFolds++;
    if (result.equityCurve.every((p) => p.equity === backtestOptions.initialCash)) {
      zeroRebalanceFolds++;
    }
  }
  return { zeroRebalanceFolds, totalFolds };
}

function runForTopN(series: ReadonlyMap<string, BarSeries>, topN: number): void {
  const backtestOptions: BacktestOptions = {
    initialCash: 10000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: topN,
    riskPerTradePct: 0.01, // champ obligatoire mais inerte ici : createCrossSectionalMomentum n'émet jamais de stopDistance, donc sizeBuyOrder (src/backtest/runner.ts) reste toujours sur le sizing fraction fixe equity/maxConcurrentPositions.
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

  console.log(
    'Fenêtres de test sans AUCUN rebalancement (courbe d\'équité plate à ' +
      'initialCash, hors échantillon uniquement, par lookbackPeriod) :',
  );
  for (const lookbackPeriod of LOOKBACK_PERIODS) {
    const { zeroRebalanceFolds, totalFolds } = countZeroRebalanceFolds(
      series,
      topN,
      lookbackPeriod,
      backtestOptions,
    );
    console.log(`  lookbackPeriod=${lookbackPeriod} -> ${zeroRebalanceFolds}/${totalFolds} fenêtres sans rebalancement`);
  }

  const selectedForLookback = (lookbackPeriod: number) =>
    result.folds.filter((f) => f.selectedParams.lookbackPeriod === lookbackPeriod);
  for (const lookbackPeriod of LOOKBACK_PERIODS) {
    const selected = selectedForLookback(lookbackPeriod);
    if (selected.length === 0) continue;
    const idle = selected.filter((f) => f.outOfSampleReturn === 0);
    const traded = selected.filter((f) => f.outOfSampleReturn !== 0);
    const meanTraded =
      traded.length > 0 ? traded.reduce((s, f) => s + f.outOfSampleReturn, 0) / traded.length : undefined;
    console.log(
      `  lookbackPeriod=${lookbackPeriod} sélectionné par walk-forward dans ${selected.length}/${n} folds : ` +
        `${idle.length} sans rebalancement (0,00% par construction), ${traded.length} avec rebalancement` +
        (meanTraded !== undefined ? ` (moyenne hors échantillon sur ceux-ci : ${(meanTraded * 100).toFixed(2)}%)` : ''),
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
