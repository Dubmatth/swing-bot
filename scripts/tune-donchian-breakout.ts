/**
 * Évalue par walk-forward le breakout Donchian/Turtle (Phase 10) sur les 20
 * paires réelles de l'univers. Grille exploratoire (pas 0-DoF — découverte
 * d'une nouvelle famille, comme le premier passage sur le suivi de tendance
 * et la Phase 9), calibrée directement en bougies 4h avec une marge
 * confortable sous TEST_BARS=180 : convertir naïvement la référence
 * historique (20/55 JOURS) donnerait entryPeriod≈330 bougies 4h, largement
 * supérieur à TEST_BARS et ferait échouer runBacktest immédiatement
 * (length < warmup+2) — même piège que la dilution repérée en Phase 9.
 *
 * Instrumentation additionnelle (suite à la revue finale de branche) :
 *  - détail par combinaison (entryPeriod, exitPeriod) effectivement
 *    sélectionnée par le walk-forward : nombre de folds, moyenne hors
 *    échantillon, folds gagnants — pour rendre reproductible depuis le
 *    dépôt le détail cité dans le README plutôt que de reposer sur un
 *    calcul à la main sur les lignes imprimées par fold (même leçon que
 *    a4c8b68) ;
 *  - moyenne hors échantillon en excluant le meilleur fold (outlier), avec
 *    son index et sa valeur imprimés pour que l'exclusion soit auditable
 *    depuis la sortie du script, pas seulement affirmée en prose ;
 *  - détection des fenêtres de test « plates » (aucun trade exécuté, courbe
 *    d'équité strictement égale à initialCash sur toute la fenêtre) par
 *    combinaison sélectionnée — le contrôle anti-dilution basé sur le
 *    nombre de barres de décision ne prouve pas à lui seul qu'un fold a
 *    réellement tradé.
 *
 * Usage : node --experimental-strip-types scripts/tune-donchian-breakout.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import type { BarSeries } from '../src/data/series.ts';
import { sliceSeries } from '../src/data/series.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createDonchianBreakout } from '../src/strategy/donchianBreakout.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface DonchianParams {
  readonly entryPeriod: number;
  readonly exitPeriod: number;
}

// Paires alignées (ratio ~3:1, convention Turtle historique) plutôt qu'un
// produit cartésien complet — voir la spec pour la justification.
const PARAM_GRID: DonchianParams[] = [
  { entryPeriod: 30, exitPeriod: 10 },
  { entryPeriod: 60, exitPeriod: 20 },
  { entryPeriod: 120, exitPeriod: 40 },
];

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

const TRAIN_BARS = 1095;
const TEST_BARS = 180;

function paramKey(p: DonchianParams): string {
  return `entryPeriod=${p.entryPeriod}/exitPeriod=${p.exitPeriod}`;
}

function sliceMap(series: ReadonlyMap<string, BarSeries>, from: number, to: number): Map<string, BarSeries> {
  const sliced = new Map<string, BarSeries>();
  for (const [symbol, s] of series) sliced.set(symbol, sliceSeries(s, from, to));
  return sliced;
}

/**
 * Rejoue la fenêtre de test d'un fold (mêmes bornes que runWalkForward :
 * testFrom = foldIndex*testBars + trainBars, testTo = testFrom+testBars)
 * avec la combinaison réellement sélectionnée pour ce fold, et vérifie si
 * la courbe d'équité est restée strictement égale à initialCash du début à
 * la fin — signe qu'aucun trade n'a été exécuté sur cette fenêtre (tout
 * round-trip complet déplacerait le rendement de zéro exactement, ne
 * serait-ce qu'à cause des frais/slippage).
 */
function isFlatFold(series: ReadonlyMap<string, BarSeries>, foldIndex: number, params: DonchianParams): boolean {
  const trainFrom = foldIndex * TEST_BARS;
  const trainTo = trainFrom + TRAIN_BARS;
  const testFrom = trainTo;
  const testTo = testFrom + TEST_BARS;
  const testSeries = sliceMap(series, testFrom, testTo);
  const strategy = combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => createDonchianBreakout({ symbol, ...params })),
  );
  const result = runBacktest(testSeries, strategy, BACKTEST_OPTIONS);
  return result.equityCurve.every((p) => p.equity === BACKTEST_OPTIONS.initialCash);
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

  const start = Date.now();
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: PARAM_GRID,
    strategyFactory: (p) =>
      combineStrategies(UNIVERSE_SYMBOLS.map((symbol) => createDonchianBreakout({ symbol, ...p }))),
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

  console.log(`\n=== donchian-breakout ===`);
  console.log(`${PARAM_GRID.length} jeux de paramètres, ${n} folds, ${elapsed}s`);
  console.log(`Moyenne in-sample        : ${(meanIn * 100).toFixed(2)}%`);
  console.log(`Moyenne hors échantillon : ${(meanOut * 100).toFixed(2)}%`);
  console.log(`Folds positifs hors échantillon : ${winFolds}/${n}`);
  console.log(`Meilleur/pire fold hors échantillon : ${(best * 100).toFixed(2)}% / ${(worst * 100).toFixed(2)}%`);
  for (const fold of result.folds) {
    console.log(
      `  fold ${fold.foldIndex} : entryPeriod=${fold.selectedParams.entryPeriod} ` +
        `exitPeriod=${fold.selectedParams.exitPeriod} ` +
        `in=${(fold.inSampleReturn * 100).toFixed(2)}% out=${(fold.outOfSampleReturn * 100).toFixed(2)}%`,
    );
  }

  // -------------------------------------------------------------------
  // Détail par combinaison sélectionnée (Finding « Important » #1 de la
  // revue finale de branche).
  // -------------------------------------------------------------------
  console.log('\nDétail par combinaison sélectionnée :');
  const byCombo = new Map<string, { params: DonchianParams; folds: (typeof result.folds)[number][] }>();
  for (const fold of result.folds) {
    const key = paramKey(fold.selectedParams);
    const entry = byCombo.get(key);
    if (entry) {
      entry.folds.push(fold);
    } else {
      byCombo.set(key, { params: fold.selectedParams, folds: [fold] });
    }
  }
  for (const [key, { folds }] of byCombo) {
    const comboN = folds.length;
    const comboMeanOut = folds.reduce((s, f) => s + f.outOfSampleReturn, 0) / comboN;
    const comboWin = folds.filter((f) => f.outOfSampleReturn > 0).length;
    console.log(
      `  ${key.padEnd(30)} ${comboN}/${n} folds, moyenne hors échantillon=${(comboMeanOut * 100).toFixed(2)}%, ` +
        `gagnants=${comboWin}/${comboN}`,
    );
  }

  // -------------------------------------------------------------------
  // Moyenne hors échantillon en excluant le meilleur fold (outlier).
  // -------------------------------------------------------------------
  let bestFold = result.folds[0]!;
  for (const fold of result.folds) {
    if (fold.outOfSampleReturn > bestFold.outOfSampleReturn) bestFold = fold;
  }
  const sumOutExcludingBest = sumOut - bestFold.outOfSampleReturn;
  const meanOutExcludingBest = sumOutExcludingBest / (n - 1);
  console.log(
    `\nFold exclu (meilleur, outlier) : fold ${bestFold.foldIndex} ` +
      `(${paramKey(bestFold.selectedParams)}) = ${(bestFold.outOfSampleReturn * 100).toFixed(2)}%`,
  );
  console.log(
    `Moyenne hors échantillon en excluant ce fold (${n - 1} folds restants) : ` +
      `${(meanOutExcludingBest * 100).toFixed(2)}%`,
  );

  // -------------------------------------------------------------------
  // Fenêtres de test « plates » (aucun trade exécuté) — Finding
  // « Important » #2 de la revue finale de branche : le contrôle
  // anti-dilution basé sur le nombre de barres de décision ne prouve pas
  // à lui seul qu'un fold a réellement tradé.
  // -------------------------------------------------------------------
  console.log('\nFenêtres de test plates (aucun trade, courbe d\'équité = initialCash sur toute la fenêtre) :');
  const flatFoldIndexesByCombo = new Map<string, number[]>();
  let flatCount = 0;
  for (const fold of result.folds) {
    if (isFlatFold(series, fold.foldIndex, fold.selectedParams)) {
      flatCount++;
      const key = paramKey(fold.selectedParams);
      const list = flatFoldIndexesByCombo.get(key);
      if (list) {
        list.push(fold.foldIndex);
      } else {
        flatFoldIndexesByCombo.set(key, [fold.foldIndex]);
      }
    }
  }
  console.log(`  Total : ${flatCount}/${n} fenêtres de test sans aucun trade`);
  for (const [key, { folds }] of byCombo) {
    const flatIndexes = flatFoldIndexesByCombo.get(key) ?? [];
    console.log(
      `  ${key.padEnd(30)} ${flatIndexes.length}/${folds.length} fenêtres plates` +
        (flatIndexes.length > 0 ? ` (folds ${flatIndexes.join(', ')})` : ''),
    );
  }
}

await main();
