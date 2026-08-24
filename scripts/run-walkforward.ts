/**
 * Lance une validation walk-forward de la stratégie atr-risk-crossover sur
 * les 20 paires réelles de l'univers (données converties par
 * convert-trades.ts dans data/kraken-ohlcvt/).
 *
 * Script d'analyse exploratoire, non testé automatiquement — le mécanisme
 * walk-forward lui-même est déjà couvert par test/walkForward.test.ts et
 * test/phase4.test.ts sur données synthétiques.
 *
 * Usage : node --experimental-strip-types scripts/run-walkforward.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createAtrRiskCrossover } from '../src/strategy/atrRiskCrossover.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Params {
  readonly fast: number;
  readonly slow: number;
  readonly atrPeriod: number;
  readonly atrMultiplier: number;
}

const PARAM_GRID: readonly Params[] = [];
for (const fast of [10, 20]) {
  for (const slow of [50, 100]) {
    for (const atrMultiplier of [2, 3]) {
      PARAM_GRID.push({ fast, slow, atrPeriod: 14, atrMultiplier });
    }
  }
}

function strategyFactory(params: Params) {
  return combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => createAtrRiskCrossover({ symbol, ...params })),
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

  const trainBars = 1095; // ~6 mois à 6 bougies/jour (interval=240)
  const testBars = 180; // ~1 mois

  console.log(
    `Walk-forward : trainBars=${trainBars}, testBars=${testBars}, ` +
      `${PARAM_GRID.length} jeux de paramètres, ${UNIVERSE_SYMBOLS.length} paires combinées`,
  );

  const result = runWalkForward(series, {
    trainBars,
    testBars,
    paramGrid: PARAM_GRID,
    strategyFactory,
    backtestOptions: {
      initialCash: 10000,
      fees: DEFAULT_FEES,
      slippageBps: 5,
      maxConcurrentPositions: 5,
      riskPerTradePct: 0.01,
    },
  });

  console.log(`\n${result.folds.length} folds :\n`);
  console.log('fold  params                              in-sample   out-of-sample');
  let sumIn = 0;
  let sumOut = 0;
  for (const fold of result.folds) {
    const p = fold.selectedParams;
    const paramsStr =
      `fast=${p.fast} slow=${p.slow} atrMult=${p.atrMultiplier}`.padEnd(36);
    console.log(
      `${String(fold.foldIndex).padStart(4)}  ${paramsStr}  ` +
        `${(fold.inSampleReturn * 100).toFixed(2).padStart(8)}%   ` +
        `${(fold.outOfSampleReturn * 100).toFixed(2).padStart(8)}%`,
    );
    sumIn += fold.inSampleReturn;
    sumOut += fold.outOfSampleReturn;
  }

  const meanIn = sumIn / result.folds.length;
  const meanOut = sumOut / result.folds.length;
  console.log(`\nMoyenne in-sample  : ${(meanIn * 100).toFixed(2)}%`);
  console.log(`Moyenne out-of-sample : ${(meanOut * 100).toFixed(2)}%`);
  console.log(
    meanOut > 0
      ? `\n=> Rendement hors échantillon positif en moyenne.`
      : `\n=> Rendement hors échantillon négatif en moyenne (pas d'edge démontré après frais).`,
  );
}

await main();
