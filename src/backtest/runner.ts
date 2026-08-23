/**
 * Runner event-driven du backtest.
 *
 * Rejoue une BarSeries barre par barre à travers une file d'événements
 * typés (bar-closed → order-requested → order-filled/order-rejected). Le
 * futur live-runner alimentera la même file depuis un flux temps réel — la
 * logique d'exécution et de portefeuille est déjà écrite pour être
 * réutilisée telle quelle.
 */

import type { BarSeries } from '../data/series.ts';
import type { Strategy, StrategyContext } from '../strategy/types.ts';
import { BarView } from '../strategy/types.ts';
import type { FeeSchedule } from './execution.ts';
import { simulateBuy, simulateSell } from './execution.ts';
import type { Portfolio } from './portfolio.ts';
import { applyBuyFill, applySellFill, createPortfolio } from './portfolio.ts';
import type { BacktestEvent } from './events.ts';

export interface BacktestOptions {
  readonly initialCash: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
}

export interface BacktestResult {
  readonly portfolio: Portfolio;
  readonly equityCurve: readonly EquityPoint[];
  readonly rejectedOrders: number;
}

export function runBacktest(
  series: BarSeries,
  strategy: Strategy,
  opts: BacktestOptions,
): BacktestResult {
  if (series.length < strategy.warmup + 2) {
    throw new Error(
      `${series.symbol} : ${series.length} barre(s), insuffisant pour un warmup de ` +
        `${strategy.warmup} barre(s) avec exécution sur la barre suivante`,
    );
  }

  const symbol = series.symbol;
  const portfolio = createPortfolio(opts.initialCash);
  const equityCurve: EquityPoint[] = [];
  let rejectedOrders = 0;
  const execOpts = { fees: opts.fees, slippageBps: opts.slippageBps };

  for (let t = strategy.warmup; t <= series.length - 2; t++) {
    const queue: BacktestEvent[] = [{ kind: 'bar-closed', symbol, t }];

    while (queue.length > 0) {
      const event = queue.shift()!;

      switch (event.kind) {
        case 'bar-closed': {
          const view = new BarView(series, event.t);
          const ctx: StrategyContext = {
            views: new Map([[symbol, view]]),
            positions: portfolio.positions,
            now: series.time[event.t]!,
          };
          for (const intent of strategy.decide(ctx)) {
            if (intent.kind === 'enter') {
              if (intent.symbol !== symbol) {
                queue.push({
                  kind: 'order-rejected',
                  symbol: intent.symbol,
                  side: 'buy',
                  reason: 'symbole hors univers du runner',
                  time: series.time[event.t]!,
                });
              } else {
                queue.push({ kind: 'order-requested', symbol: intent.symbol, side: 'buy', reason: intent.reason });
              }
            } else if (intent.kind === 'exit') {
              if (intent.symbol !== symbol) {
                queue.push({
                  kind: 'order-rejected',
                  symbol: intent.symbol,
                  side: 'sell',
                  reason: 'symbole hors univers du runner',
                  time: series.time[event.t]!,
                });
              } else {
                queue.push({ kind: 'order-requested', symbol: intent.symbol, side: 'sell', reason: intent.reason });
              }
            }
          }
          break;
        }

        case 'order-requested': {
          const fillT = t + 1;
          const fillTime = series.time[fillT]!;

          if (series.synthetic[fillT] === 1) {
            queue.push({
              kind: 'order-rejected',
              symbol: event.symbol,
              side: event.side,
              reason: 'barre suivante synthétique',
              time: fillTime,
            });
            break;
          }

          const referencePrice = series.open[fillT]!;
          if (event.side === 'buy') {
            const fill = simulateBuy(portfolio.cash, referencePrice, execOpts);
            queue.push({
              kind: 'order-filled',
              symbol: event.symbol,
              side: 'buy',
              quantity: fill.quantity,
              price: fill.price,
              fee: fill.fee,
              time: fillTime,
            });
          } else {
            const position = portfolio.positions.get(event.symbol);
            if (!position) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'sell',
                reason: 'aucune position ouverte',
                time: fillTime,
              });
              break;
            }
            const fill = simulateSell(position.quantity, referencePrice, execOpts);
            queue.push({
              kind: 'order-filled',
              symbol: event.symbol,
              side: 'sell',
              quantity: fill.quantity,
              price: fill.price,
              fee: fill.fee,
              time: fillTime,
            });
          }
          break;
        }

        case 'order-filled': {
          const fill = { price: event.price, quantity: event.quantity, fee: event.fee };
          if (event.side === 'buy') {
            applyBuyFill(portfolio, event.symbol, fill, event.time);
          } else {
            applySellFill(portfolio, event.symbol, fill, event.time);
          }
          break;
        }

        case 'order-rejected': {
          rejectedOrders++;
          break;
        }
      }
    }

    const position = portfolio.positions.get(symbol);
    const markPrice = series.close[t + 1]!;
    const equity = portfolio.cash + (position ? position.quantity * markPrice : 0);
    equityCurve.push({ time: series.time[t + 1]!, equity });
  }

  return { portfolio, equityCurve, rejectedOrders };
}
