import test from 'node:test';
import assert from 'node:assert/strict';

import type { ClosedBar, LiveBarSource } from '../src/live/liveBarSource.ts';
import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import { createPaperRunner } from '../src/live/paperRunner.ts';
import { createPortfolio } from '../src/backtest/portfolio.ts';
import type { Trade } from '../src/backtest/portfolio.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';

const SYMBOL_A = 'AEUR';
const SYMBOL_B = 'BEUR';
const STEP = 14_400;

function bar(symbol: string, i: number, close: number): ClosedBar {
  return { symbol, time: i * STEP, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

function createSyntheticSource(): LiveBarSource & { emit(bar: ClosedBar): void } {
  let callback: ((bar: ClosedBar) => void) | undefined;
  return {
    start(cb: (bar: ClosedBar) => void): void {
      callback = cb;
    },
    stop(): void {
      callback = undefined;
    },
    emit(b: ClosedBar): void {
      callback?.(b);
    },
  };
}

/** Stratégie de test déterministe : entre au-dessus du seuil, sort à/sous le seuil. */
function testStrategy(threshold: number): Strategy {
  return {
    name: 'test-strategy',
    warmup: 0,
    params: { threshold },
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents: Intent[] = [];
      for (const [symbol, view] of ctx.views) {
        const hasPosition = ctx.positions.has(symbol);
        const price = view.close(0);
        if (!hasPosition && price > threshold) {
          intents.push({ kind: 'enter', symbol, reason: `${price} > ${threshold}` });
        } else if (hasPosition && price <= threshold) {
          intents.push({ kind: 'exit', symbol, reason: `${price} <= ${threshold}` });
        }
      }
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}

function setup(threshold: number, maxConcurrentPositions = 1) {
  const sourceA = createSyntheticSource();
  const sourceB = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const builderB = createLiveSeriesBuilder(SYMBOL_B, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];

  const runner = createPaperRunner({
    strategy: testStrategy(threshold),
    sources: new Map([[SYMBOL_A, sourceA], [SYMBOL_B, sourceB]]),
    builders: new Map([[SYMBOL_A, builderA], [SYMBOL_B, builderB]]),
    portfolio,
    options: { maxConcurrentPositions, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  return { runner, sourceA, sourceB, portfolio, fills };
}

test('paperRunner : applique un fill d\'achat quand la stratégie émet enter', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // 60 > 50 -> enter

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.side, 'buy');
});

test('paperRunner : applique un fill de vente quand la stratégie émet exit', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter
  sourceA.emit(bar(SYMBOL_A, 1, 40)); // 40 <= 50 -> exit

  assert.equal(portfolio.positions.size, 0);
  assert.equal(fills.length, 2);
  assert.equal(fills[1]?.side, 'sell');
});

test('paperRunner : ignore un enter si le plafond de positions est atteint', () => {
  const { portfolio, fills, sourceA, sourceB } = setup(50, 1);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter A, plafond=1 atteint
  sourceB.emit(bar(SYMBOL_B, 0, 60)); // voudrait entrer B aussi, refusé

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));
  assert.equal(fills.length, 1);
});

test('paperRunner : ignore un enter si une position est déjà ouverte sur ce symbole', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter
  sourceA.emit(bar(SYMBOL_A, 1, 70)); // toujours > 50, mais déjà en position -> hold

  assert.equal(portfolio.positions.size, 1);
  assert.equal(fills.length, 1);
});

test('paperRunner : decide() considère toutes les paires ayant déjà une bougie, pas seulement celle qui vient de clôturer', () => {
  const { portfolio, fills, sourceA, sourceB } = setup(50, 2);
  sourceB.emit(bar(SYMBOL_B, 0, 30)); // B a une bougie mais reste sous le seuil
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // déclenche decide() ; B est visible dans ctx.views

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));

  sourceB.emit(bar(SYMBOL_B, 1, 60)); // B franchit le seuil à son tour -> enter B
  assert.equal(portfolio.positions.size, 2);
  assert.equal(fills.length, 2);
});

test('paperRunner : stop() détache les sources, plus aucun fill après', () => {
  const { runner, portfolio, fills, sourceA } = setup(50);
  runner.stop();
  sourceA.emit(bar(SYMBOL_A, 0, 60));

  assert.equal(portfolio.positions.size, 0);
  assert.equal(fills.length, 0);
});

test('paperRunner : ignore silencieusement une intention sur un symbole sans bougie connue', () => {
  const alwaysEnterUnknown: Strategy = {
    name: 'buggy',
    warmup: 0,
    params: {},
    decide(): readonly Intent[] {
      return [{ kind: 'enter', symbol: 'INCONNU', reason: 'test' }];
    },
  };
  const sourceA = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];
  const runner = createPaperRunner({
    strategy: alwaysEnterUnknown,
    sources: new Map([[SYMBOL_A, sourceA]]),
    builders: new Map([[SYMBOL_A, builderA]]),
    portfolio,
    options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  assert.doesNotThrow(() => sourceA.emit(bar(SYMBOL_A, 0, 60)));
  assert.equal(fills.length, 0);
  assert.equal(portfolio.positions.size, 0);
});

test('paperRunner : garde-fou du runner — ignore un enter répété sur un symbole déjà en position, même si la stratégie insiste', () => {
  // Contrairement à testStrategy (qui ne réémet jamais enter une fois en position, côté
  // stratégie), cette stratégie « mal élevée » insiste toujours : c'est bien le garde-fou du
  // RUNNER (portfolio.positions.has(intent.symbol)) qui doit bloquer le second enter.
  const alwaysEnterA: Strategy = {
    name: 'always-enter',
    warmup: 0,
    params: {},
    decide(): readonly Intent[] {
      return [{ kind: 'enter', symbol: SYMBOL_A, reason: 'insiste' }];
    },
  };
  const sourceA = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];
  const runner = createPaperRunner({
    strategy: alwaysEnterA,
    sources: new Map([[SYMBOL_A, sourceA]]),
    builders: new Map([[SYMBOL_A, builderA]]),
    portfolio,
    // maxConcurrentPositions à 2 (> 1 position réelle) : isole le garde-fou « déjà en
    // position » du garde-fou « plafond atteint », pour ne pas les confondre.
    options: { maxConcurrentPositions: 2, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  sourceA.emit(bar(SYMBOL_A, 0, 60)); // premier enter, accepté
  assert.equal(fills.length, 1);
  assert.equal(portfolio.positions.size, 1);

  // La stratégie réémet enter sur A alors qu'une position existe déjà : le runner doit
  // l'ignorer silencieusement, sans lever et sans second fill (le plafond n'est pas encore
  // atteint : c'est bien le garde-fou « déjà en position » qui doit agir ici).
  assert.doesNotThrow(() => sourceA.emit(bar(SYMBOL_A, 1, 65)));
  assert.equal(fills.length, 1);
  assert.equal(portfolio.positions.size, 1);
});

test('paperRunner : garde-fou du runner — ignore un exit sur un symbole sans position ouverte', () => {
  const alwaysExitA: Strategy = {
    name: 'always-exit',
    warmup: 0,
    params: {},
    decide(): readonly Intent[] {
      return [{ kind: 'exit', symbol: SYMBOL_A, reason: 'aucune position' }];
    },
  };
  const sourceA = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];
  const runner = createPaperRunner({
    strategy: alwaysExitA,
    sources: new Map([[SYMBOL_A, sourceA]]),
    builders: new Map([[SYMBOL_A, builderA]]),
    portfolio,
    options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  assert.doesNotThrow(() => sourceA.emit(bar(SYMBOL_A, 0, 60)));
  assert.equal(fills.length, 0);
  assert.equal(portfolio.positions.size, 0);
});

test('paperRunner : garde-fou du runner — ignore un enter si sizeBuyOrder refuse le budget', () => {
  // Avec createPortfolio (cash > 0 imposé) et budget = min(cash, equity / N), le budget fixe
  // reste toujours strictement positif tant que cash > 0 : un cash « très faible » (ex. 1 EUR)
  // produit un micro-achat valide, pas un rejet. Le seul chemin qui fait réellement échouer
  // sizeBuyOrder ici est un stopDistance invalide fourni par l'intention — c'est ce chemin
  // qu'une stratégie mal élevée peut emprunter, et c'est lui qu'on exerce.
  const badStopDistance: Strategy = {
    name: 'bad-stop-distance',
    warmup: 0,
    params: {},
    decide(): readonly Intent[] {
      return [{ kind: 'enter', symbol: SYMBOL_A, reason: 'stop invalide', stopDistance: -1 }];
    },
  };
  const sourceA = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];
  const runner = createPaperRunner({
    strategy: badStopDistance,
    sources: new Map([[SYMBOL_A, sourceA]]),
    builders: new Map([[SYMBOL_A, builderA]]),
    portfolio,
    options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  assert.doesNotThrow(() => sourceA.emit(bar(SYMBOL_A, 0, 60)));
  assert.equal(fills.length, 0);
  assert.equal(portfolio.positions.size, 0);
});

test('paperRunner : reconstruit la vue de toutes les paires connues à chaque bougie, pas seulement celle qui vient de clôturer (stratégie croisée)', () => {
  const threshold = 50;
  // Stratégie qui dépend explicitement de DEUX symboles : elle n'entre sur A que si le
  // dernier prix connu de B est aussi au-dessus du seuil. Si onClosedBar ne reconstruisait la
  // vue que pour le symbole qui vient de clôturer (régression sur l'exigence multi-symbole),
  // viewB serait absent au moment où A clôture et l'entrée serait refusée à tort.
  const crossSymbolStrategy: Strategy = {
    name: 'cross-symbol',
    warmup: 0,
    params: { threshold },
    decide(ctx: StrategyContext): readonly Intent[] {
      const viewA = ctx.views.get(SYMBOL_A);
      const viewB = ctx.views.get(SYMBOL_B);
      if (!viewA || !viewB) return [{ kind: 'hold' }];
      if (!ctx.positions.has(SYMBOL_A) && viewA.close(0) > threshold && viewB.close(0) > threshold) {
        return [{ kind: 'enter', symbol: SYMBOL_A, reason: 'A et B au-dessus du seuil' }];
      }
      return [{ kind: 'hold' }];
    },
  };

  const sourceA = createSyntheticSource();
  const sourceB = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const builderB = createLiveSeriesBuilder(SYMBOL_B, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];
  const runner = createPaperRunner({
    strategy: crossSymbolStrategy,
    sources: new Map([[SYMBOL_A, sourceA], [SYMBOL_B, sourceB]]),
    builders: new Map([[SYMBOL_A, builderA], [SYMBOL_B, builderB]]),
    portfolio,
    options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  sourceB.emit(bar(SYMBOL_B, 0, 60)); // B déjà au-dessus du seuil ; A n'a encore aucune bougie -> hold
  assert.equal(fills.length, 0);

  // Seul A vient de clôturer ici : la vue de B doit néanmoins être visible dans ctx.views.
  sourceA.emit(bar(SYMBOL_A, 0, 60));

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));
  assert.equal(fills.length, 1);
});
