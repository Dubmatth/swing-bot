/**
 * Évalue si le filtre de régime de volatilité (Task 1) améliore le
 * candidat déjà validé (period=70-80, entryK=4, sans filtre de
 * tendance/volume). Grille volontairement étroite, calibrée sur la
 * distribution réelle du coefficient de variation std/sma — voir la
 * spec, section « Décisions actées ».
 *
 * Instrumentation additionnelle (suite à la revue finale de branche) :
 *  - compte les tentatives d'entrée réelles (sans filtre) sur les 37
 *    fenêtres de test, et leur ratio std/sma, pour rendre reproductibles
 *    depuis le dépôt les chiffres cités dans le README (nombre de
 *    tentatives, nombre bloquées par seuil) plutôt que de reposer sur une
 *    instrumentation jetable non committée ;
 *  - vérifie l'égalité bit-à-bit à maxVolatilityRatio=0,09 en comparant le
 *    rendement de chaque fold en pleine précision, pas seulement le résumé
 *    arrondi à 2 décimales.
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion-volatility.ts
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
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import { RollingStd, Sma } from '../src/strategy/indicators.ts';
import type { BarView, Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';

interface Params {
  readonly period: number;
  readonly entryK: number;
  readonly maxVolatilityRatio?: number;
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
const VOLATILITY_GRID = [0.06, 0.075, 0.09] as const;

function strategyFactory(params: Params): Strategy {
  return combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...params })),
  );
}

/** Rendement hors échantillon de chaque fold, en pleine précision. */
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
  const folds = computeFolds(series, params);
  const n = folds.length;
  const meanOut = folds.reduce((s, v) => s + v, 0) / n;
  const win = folds.filter((v) => v > 0).length;
  console.log(`${label.padEnd(55)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}`);
  return folds;
}

// ---------------------------------------------------------------------------
// Instrumentation : tentatives d'entrée réelles et leur ratio std/sma
// (Finding « Important » #1 et #3 de la revue finale de branche).
// ---------------------------------------------------------------------------

/** Duplication délibérée de `sma`/`std` internes à meanReversion.ts : script
 * d'analyse, pas de code de production — pas de couplage à l'implémentation
 * interne d'un module qu'on ne veut pas exporter juste pour ce script. */
function smaAt(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) s.update(view.close(ago));
  return s.value;
}

function stdAt(view: BarView, period: number): number {
  const s = new RollingStd(period);
  for (let ago = period - 1; ago >= 0; ago--) s.update(view.close(ago));
  return s.value;
}

interface EntryAttempt {
  readonly ratio: number;
  readonly symbol: string;
  readonly time: number;
}

/** Vidé avant chaque passage instrumenté par `collectEntryAttempts`. */
let entryAttempts: EntryAttempt[] = [];

/**
 * Enveloppe une stratégie mono-paire SANS filtre de volatilité : quand elle
 * émet 'enter', calcule indépendamment le ratio std/sma de cette barre et
 * l'accumule dans `entryAttempts`. Permet de mesurer la distribution du
 * ratio *conditionnelle à une tentative d'entrée réelle* — distribution bien
 * plus resserrée que la distribution inconditionnelle sur toutes les barres
 * qui a servi à calibrer VOLATILITY_GRID (voir README).
 */
function withEntryRatioLogging(symbol: string, period: number, entryK: number): Strategy {
  const inner = createMeanReversion({ symbol, period, entryK });
  return {
    ...inner,
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents = inner.decide(ctx);
      for (const intent of intents) {
        if (intent.kind === 'enter') {
          const view = ctx.views.get(symbol);
          if (view) {
            entryAttempts.push({ ratio: stdAt(view, period) / smaAt(view, period), symbol, time: ctx.now });
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
 * trainBars/testBars), avec la version SANS filtre instrumentée, pour
 * capter le ratio std/sma de chaque tentative d'entrée réelle
 * (!hasPosition && prix < seuil). Seules les fenêtres de test comptent :
 * le filtre ne peut jamais bloquer quoi que ce soit pendant l'entraînement
 * (ces fenêtres ne sont jamais mesurées hors échantillon).
 */
function collectEntryAttempts(series: ReadonlyMap<string, BarSeries>, period: number): EntryAttempt[] {
  entryAttempts = [];
  const strategy = combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => withEntryRatioLogging(symbol, period, 4)),
  );
  const firstSeries = series.values().next().value;
  if (!firstSeries) throw new Error('collectEntryAttempts : au moins une série requise');
  const length = firstSeries.length;
  for (let foldIndex = 0; ; foldIndex++) {
    const testFrom = foldIndex * TEST_BARS + TRAIN_BARS;
    const testTo = testFrom + TEST_BARS;
    if (testTo > length) break;
    runBacktest(sliceMap(series, testFrom, testTo), strategy, BACKTEST_OPTIONS);
  }
  return entryAttempts;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function reportEntryAttempts(series: ReadonlyMap<string, BarSeries>, period: number): void {
  const attempts = collectEntryAttempts(series, period);
  const ratios = attempts.map((a) => a.ratio);
  console.log(
    `period=${period} : ${attempts.length} tentatives d'entrée réelles sur les 37 fenêtres de test ` +
      `(médiane ratio=${median(ratios).toFixed(4)}, max=${Math.max(...ratios).toFixed(4)})`,
  );
  for (const threshold of VOLATILITY_GRID) {
    const blocked = ratios.filter((r) => r > threshold).length;
    console.log(`  seuil=${threshold} -> ${blocked} tentative(s) bloquée(s)`);
  }
}

function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`maxAbsDiff : longueurs différentes (${a.length} vs ${b.length})`);
  }
  return Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
}

function reportBitExactness(period: number, reference: readonly number[], filtered09: readonly number[]): void {
  console.log(`period=${period} :`);
  console.log(`  référence   (pleine précision) : [${reference.join(', ')}]`);
  console.log(`  filtré=0,09 (pleine précision) : [${filtered09.join(', ')}]`);
  console.log(`  max(|diff|) sur ${reference.length} folds = ${maxAbsDiff(reference, filtered09)}`);
}

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('Référence (sans filtre de régime de volatilité) :');
  const reference70 = runSingle(series, 'period=70, entryK=4', { period: 70, entryK: 4 });
  const reference80 = runSingle(series, 'period=80, entryK=4', { period: 80, entryK: 4 });

  console.log('\nAvec filtre de régime de volatilité :');
  const filtered09: Record<number, number[]> = {};
  for (const period of [70, 80]) {
    for (const maxVolatilityRatio of VOLATILITY_GRID) {
      const folds = runSingle(
        series,
        `period=${period}, entryK=4, maxVolatilityRatio=${maxVolatilityRatio}`,
        { period, entryK: 4, maxVolatilityRatio },
      );
      if (maxVolatilityRatio === 0.09) filtered09[period] = folds;
    }
  }

  console.log("\nTentatives d'entrée réelles (sans filtre, mêmes 37 fenêtres de test) :");
  reportEntryAttempts(series, 70);
  reportEntryAttempts(series, 80);

  console.log('\nÉgalité bit-à-bit à maxVolatilityRatio=0,09 (pleine précision, par fold) :');
  reportBitExactness(70, reference70, filtered09[70]!);
  reportBitExactness(80, reference80, filtered09[80]!);
}

await main();
