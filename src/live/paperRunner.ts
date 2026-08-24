/**
 * Boucle de décision réactive du runner papier : à chaque bougie close
 * reçue de n'importe quelle paire, reconstruit un StrategyContext avec les
 * vues actuelles de toutes les paires connues et appelle strategy.decide()
 * — même contrat que le backtest (src/strategy/types.ts). Contrairement au
 * backtest, le fill est immédiat, au prix de la bougie qui vient de
 * clôturer : la contrainte anti-look-ahead du backtest (fill à la bougie
 * suivante) n'a pas de sens sur un flux déjà temps réel.
 *
 * Réutilise telle quelle la logique d'exécution/portefeuille du backtest
 * (execution.ts, portfolio.ts, sizeBuyOrder de runner.ts) — jamais
 * dupliquée, pour que le sizing/fills papier ne puissent pas diverger de
 * ceux déjà validés par walk-forward.
 */

import type { BarSeries } from '../data/series.ts';
import type { Intent, Strategy, StrategyContext } from '../strategy/types.ts';
import { BarView } from '../strategy/types.ts';
import type { Portfolio, Trade } from '../backtest/portfolio.ts';
import { applyBuyFill, applySellFill, portfolioEquity } from '../backtest/portfolio.ts';
import type { FeeSchedule } from '../backtest/execution.ts';
import { simulateBuy, simulateSell } from '../backtest/execution.ts';
import { sizeBuyOrder } from '../backtest/runner.ts';
import type { ClosedBar, LiveBarSource } from './liveBarSource.ts';
import type { LiveSeriesBuilder } from './liveSeriesBuilder.ts';

export interface PaperRunnerOptions {
  readonly maxConcurrentPositions: number;
  readonly riskPerTradePct: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface PaperRunnerConfig {
  readonly strategy: Strategy;
  readonly sources: ReadonlyMap<string, LiveBarSource>;
  /** Déjà amorcés (voir krakenRestSeed) avant l'appel à start(). */
  readonly builders: ReadonlyMap<string, LiveSeriesBuilder>;
  readonly portfolio: Portfolio;
  readonly options: PaperRunnerOptions;
  /** Appelé après chaque fill appliqué — le point d'accroche de la persistance. */
  readonly onFill?: (trade: Trade, portfolio: Portfolio) => void;
}

export interface PaperRunner {
  start(): void;
  stop(): void;
}

function currentSeriesOrUndefined(builder: LiveSeriesBuilder): BarSeries | undefined {
  try {
    return builder.current();
  } catch {
    return undefined;
  }
}

function marksFrom(builders: ReadonlyMap<string, LiveSeriesBuilder>): Map<string, number> {
  const marks = new Map<string, number>();
  for (const [symbol, builder] of builders) {
    const series = currentSeriesOrUndefined(builder);
    if (series !== undefined) {
      marks.set(symbol, series.close[series.length - 1]!);
    }
  }
  return marks;
}

export function createPaperRunner(config: PaperRunnerConfig): PaperRunner {
  const { strategy, sources, builders, portfolio, options } = config;

  function applyIntent(intent: Intent, now: number): void {
    if (intent.kind === 'hold') return;

    const targetBuilder = builders.get(intent.symbol);
    const targetSeries = targetBuilder ? currentSeriesOrUndefined(targetBuilder) : undefined;
    if (targetSeries === undefined) return;
    const referencePrice = targetSeries.close[targetSeries.length - 1]!;
    const execOpts = { fees: options.fees, slippageBps: options.slippageBps };

    if (intent.kind === 'enter') {
      if (portfolio.positions.size >= options.maxConcurrentPositions) return;
      if (portfolio.positions.has(intent.symbol)) return;

      const equity = portfolioEquity(portfolio, marksFrom(builders));
      const sized = sizeBuyOrder({
        cash: portfolio.cash,
        equity,
        maxConcurrentPositions: options.maxConcurrentPositions,
        riskPerTradePct: options.riskPerTradePct,
        referencePrice,
        ...(intent.stopDistance !== undefined ? { stopDistance: intent.stopDistance } : {}),
      });
      if (!sized.ok) return;

      const fill = simulateBuy(sized.budget, referencePrice, execOpts);
      applyBuyFill(portfolio, intent.symbol, fill, now);
    } else {
      const position = portfolio.positions.get(intent.symbol);
      if (!position) return;

      const fill = simulateSell(position.quantity, referencePrice, execOpts);
      applySellFill(portfolio, intent.symbol, fill, now);
    }

    const trade = portfolio.trades[portfolio.trades.length - 1];
    if (trade) config.onFill?.(trade, portfolio);
  }

  function onClosedBar(symbol: string, bar: ClosedBar): void {
    const builder = builders.get(symbol);
    if (!builder) return;
    builder.append(bar);

    const views = new Map<string, BarView>();
    for (const [sym, b] of builders) {
      const series = currentSeriesOrUndefined(b);
      if (series !== undefined) {
        views.set(sym, new BarView(series, series.length - 1));
      }
    }
    if (views.size === 0) return;

    const ctx: StrategyContext = { views, positions: portfolio.positions, now: bar.time };
    for (const intent of strategy.decide(ctx)) {
      applyIntent(intent, bar.time);
    }
  }

  return {
    start(): void {
      for (const [symbol, source] of sources) {
        source.start((bar) => onClosedBar(symbol, bar));
      }
    },
    stop(): void {
      for (const source of sources.values()) {
        source.stop();
      }
    },
  };
}
