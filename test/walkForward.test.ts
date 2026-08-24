import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import type { Strategy, StrategyContext } from '../src/strategy/types.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

function seriesFrom(closes: number[]): BarSeries {
  const c = emptyColumns();
  closes.forEach((close, i) => {
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(SYMBOL, 240, c);
}

interface Params {
  readonly mode: 'flat' | 'buyhold';
}

/** 'flat' ne trade jamais (rendement 0) ; 'buyhold' entre dès que possible et ne sort jamais. */
function strategyFactory(params: Params): Strategy {
  if (params.mode === 'flat') {
    return {
      name: 'flat',
      warmup: 1,
      params: {},
      decide: (_ctx: StrategyContext) => [{ kind: 'hold' }],
    };
  }
  return {
    name: 'buyhold',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      return ctx.positions.has(SYMBOL)
        ? [{ kind: 'hold' }]
        : [{ kind: 'enter', symbol: SYMBOL, reason: 'test' }];
    },
  };
}

const BACKTEST_OPTIONS = {
  initialCash: 1000,
  fees: DEFAULT_FEES,
  slippageBps: 10,
  maxConcurrentPositions: 1,
  riskPerTradePct: 1,
};

test('runWalkForward : sélectionne le meilleur rendement in-sample, mesure hors échantillon avec les mêmes paramètres', () => {
  const closes = [
    // train (bars 0-5) : hausse continue après l'entrée — buyhold doit gagner in-sample
    100, 100, 110, 130, 160, 200,
    // test (bars 6-11) : baisse continue après l'entrée — buyhold doit perdre hors échantillon
    200, 200, 180, 150, 110, 60,
  ];
  const series = new Map([[SYMBOL, seriesFrom(closes)]]);

  const result = runWalkForward(series, {
    trainBars: 6,
    testBars: 6,
    paramGrid: [{ mode: 'flat' }, { mode: 'buyhold' }],
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });

  assert.equal(result.folds.length, 1);
  const fold = result.folds[0]!;
  assert.equal(fold.foldIndex, 0);
  assert.equal(fold.selectedParams.mode, 'buyhold');
  assert.ok(fold.inSampleReturn > 0, `attendu un rendement in-sample positif, obtenu ${fold.inSampleReturn}`);
  assert.ok(
    fold.outOfSampleReturn < 0,
    `attendu un rendement hors échantillon négatif, obtenu ${fold.outOfSampleReturn}`,
  );
});

test('runWalkForward : découpe la série en folds glissants successifs', () => {
  const closes = Array.from({ length: 24 }, () => 100);
  const series = new Map([[SYMBOL, seriesFrom(closes)]]);

  const result = runWalkForward(series, {
    trainBars: 6,
    testBars: 6,
    paramGrid: [{ mode: 'flat' as const }],
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });

  assert.equal(result.folds.length, 3);
  assert.deepEqual(result.folds.map((f) => f.foldIndex), [0, 1, 2]);
});

test('runWalkForward : lève si la grille de paramètres est vide', () => {
  const series = new Map([[SYMBOL, seriesFrom(Array.from({ length: 12 }, () => 100))]]);
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 6,
        testBars: 6,
        paramGrid: [],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /au moins un jeu de paramètres/,
  );
});

test('runWalkForward : lève si trainBars ou testBars est invalide', () => {
  const series = new Map([[SYMBOL, seriesFrom(Array.from({ length: 12 }, () => 100))]]);
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 0,
        testBars: 6,
        paramGrid: [{ mode: 'flat' as const }],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /trainBars/,
  );
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 6,
        testBars: -1,
        paramGrid: [{ mode: 'flat' as const }],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /testBars/,
  );
});

test('runWalkForward : lève si la série est trop courte pour un seul fold', () => {
  const series = new Map([[SYMBOL, seriesFrom(Array.from({ length: 8 }, () => 100))]]);
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 6,
        testBars: 6,
        paramGrid: [{ mode: 'flat' as const }],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /insuffisant/,
  );
});

test('runWalkForward : lève si aucun jeu de paramètres ne produit un rendement in-sample fini', () => {
  // Prix d'ouverture corrompu (Infinity) sur la barre 3 : une stratégie qui
  // entre en position à t=1 puis sort à t=2 déclenche un fill de vente au
  // prix Infinity. `applySellFill` calcule alors
  // `cash += quantity*Infinity - Infinity`, soit `Infinity - Infinity = NaN`
  // — le cash du portefeuille devient NaN sans qu'aucun garde-fou
  // (`simulateSell`, `applySellFill`) ne lève, puisque Infinity est un prix
  // de référence positif valide à leurs yeux. L'équité finale et donc
  // `inSampleReturn` sont NaN. Ceci exerce bien le nouveau garde-fou
  // `bestParams === undefined` de `runWalkForward` — pas la validation de
  // `createPortfolio`/`totalReturn` (celles-ci lèvent sur des entrées
  // invalides comme `initialCash <= 0`, elles ne produisent jamais un
  // résultat non fini à partir d'entrées valides).
  const closes = [100, 100, 100, Infinity, 100, 100, 100, 100, 100, 100, 100, 100];
  const series = new Map([[SYMBOL, seriesFrom(closes)]]);

  const strategy: Strategy = {
    name: 'nan-inducer',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      const t = ctx.views.get(SYMBOL)!.t;
      if (t === 1) return [{ kind: 'enter', symbol: SYMBOL, reason: 'test' }];
      if (t === 2 && ctx.positions.has(SYMBOL)) {
        return [{ kind: 'exit', symbol: SYMBOL, reason: 'test' }];
      }
      return [{ kind: 'hold' }];
    },
  };

  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 6,
        testBars: 6,
        paramGrid: [{ mode: 'flat' as const }],
        strategyFactory: () => strategy,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /aucun rendement in-sample fini/,
  );
});
