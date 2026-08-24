/**
 * Runner event-driven du backtest.
 *
 * Rejoue plusieurs BarSeries alignées sur la même grille temporelle, barre
 * par barre, à travers une file d'événements typés (bar-closed →
 * order-requested → order-filled/order-rejected). Le futur live-runner
 * alimentera la même file depuis un flux temps réel — la logique
 * d'exécution et de portefeuille est déjà écrite pour être réutilisée
 * telle quelle.
 *
 * Discipline de file : voir events.ts — tout événement mutant (order-filled)
 * passe avant tout événement en attente qui lit l'état du portefeuille.
 */

import type { BarSeries } from '../data/series.ts';
import type { Strategy, StrategyContext } from '../strategy/types.ts';
import { BarView } from '../strategy/types.ts';
import type { FeeSchedule } from './execution.ts';
import { simulateBuy, simulateSell } from './execution.ts';
import type { Portfolio } from './portfolio.ts';
import { applyBuyFill, applySellFill, createPortfolio, portfolioEquity } from './portfolio.ts';
import type { BacktestEvent } from './events.ts';

export interface BacktestOptions {
  readonly initialCash: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
  readonly maxConcurrentPositions: number;
  /** Fraction du capital risquée par trade — 0.01 = 1 %. */
  readonly riskPerTradePct: number;
}

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
}

export interface BacktestResult {
  readonly portfolio: Portfolio;
  readonly equityCurve: readonly EquityPoint[];
  readonly rejectedOrders: number;
  readonly rejectionReasons: readonly string[];
}

function marksAt(series: ReadonlyMap<string, BarSeries>, t: number): Map<string, number> {
  const marks = new Map<string, number>();
  for (const [symbol, s] of series) {
    marks.set(symbol, s.close[t]!);
  }
  return marks;
}

export interface SizeBuyOrderInput {
  readonly cash: number;
  readonly equity: number;
  readonly maxConcurrentPositions: number;
  readonly riskPerTradePct: number;
  readonly referencePrice: number;
  readonly stopDistance?: number;
}

export type SizeBuyOrderResult =
  | { readonly ok: true; readonly budget: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Calcule le budget alloué à un achat : plafond fraction fixe
 * (cash/N positions), resserré (jamais élargi) par un budget de risque si
 * stopDistance est fourni. Partagé entre runBacktest et le runner papier
 * (paperRunner.ts) pour qu'ils ne puissent jamais diverger sur le sizing.
 */
export function sizeBuyOrder(input: SizeBuyOrderInput): SizeBuyOrderResult {
  if (
    input.stopDistance !== undefined &&
    (!Number.isFinite(input.stopDistance) || !(input.stopDistance > 0))
  ) {
    return { ok: false, reason: 'stopDistance invalide' };
  }

  let budget = Math.min(input.cash, input.equity / input.maxConcurrentPositions);
  if (input.stopDistance !== undefined) {
    const riskBudget =
      ((input.equity * input.riskPerTradePct) / input.stopDistance) * input.referencePrice;
    budget = Math.min(budget, riskBudget);
  }

  if (!(budget > 0)) {
    return { ok: false, reason: 'budget alloué insuffisant' };
  }
  return { ok: true, budget };
}

export function runBacktest(
  series: ReadonlyMap<string, BarSeries>,
  strategy: Strategy,
  opts: BacktestOptions,
): BacktestResult {
  if (series.size === 0) {
    throw new Error('runBacktest : au moins une série requise');
  }
  if (!Number.isInteger(opts.maxConcurrentPositions) || opts.maxConcurrentPositions < 1) {
    throw new RangeError(`maxConcurrentPositions invalide : ${opts.maxConcurrentPositions}`);
  }
  if (!Number.isFinite(opts.riskPerTradePct) || !(opts.riskPerTradePct > 0)) {
    throw new RangeError(`riskPerTradePct invalide : ${opts.riskPerTradePct}`);
  }

  const entries = [...series];
  const [firstSymbol, firstSeries] = entries[0]!;
  const length = firstSeries.length;
  for (const [symbol, s] of entries) {
    if (s.length !== length) {
      throw new Error(
        `Grille temporelle incohérente : ${symbol} a ${s.length} barre(s), ${firstSymbol} en a ${length}`,
      );
    }
    if (s.time[0] !== firstSeries.time[0] || s.time[length - 1] !== firstSeries.time[length - 1]) {
      throw new Error(
        `Grille temporelle incohérente entre ${symbol} et ${firstSymbol} : bornes temporelles différentes`,
      );
    }
  }

  if (length < strategy.warmup + 2) {
    throw new Error(
      `${length} barre(s), insuffisant pour un warmup de ${strategy.warmup} barre(s) ` +
        `avec exécution sur la barre suivante`,
    );
  }

  const portfolio = createPortfolio(opts.initialCash);
  const equityCurve: EquityPoint[] = [];
  let rejectedOrders = 0;
  const rejectionReasons: string[] = [];
  const execOpts = { fees: opts.fees, slippageBps: opts.slippageBps };
  const time = firstSeries.time;

  for (let t = strategy.warmup; t <= length - 2; t++) {
    const equitySnapshot = portfolioEquity(portfolio, marksAt(series, t));
    const queue: BacktestEvent[] = [{ kind: 'bar-closed', t }];

    while (queue.length > 0) {
      const event = queue.shift()!;

      switch (event.kind) {
        case 'bar-closed': {
          const views = new Map<string, BarView>();
          for (const [symbol, s] of series) {
            views.set(symbol, new BarView(s, event.t));
          }
          const ctx: StrategyContext = {
            views,
            positions: portfolio.positions,
            now: time[event.t]!,
          };
          for (const intent of strategy.decide(ctx)) {
            if (intent.kind === 'enter') {
              queue.push({
                kind: 'order-requested',
                symbol: intent.symbol,
                side: 'buy',
                reason: intent.reason,
                ...(intent.stopDistance !== undefined ? { stopDistance: intent.stopDistance } : {}),
              });
            } else if (intent.kind === 'exit') {
              queue.push({ kind: 'order-requested', symbol: intent.symbol, side: 'sell', reason: intent.reason });
            }
          }
          break;
        }

        case 'order-requested': {
          const targetSeries = series.get(event.symbol);
          if (!targetSeries) {
            queue.push({
              kind: 'order-rejected',
              symbol: event.symbol,
              side: event.side,
              reason: 'symbole hors univers du runner',
              time: time[t]!,
            });
            break;
          }

          const fillT = t + 1;
          const fillTime = targetSeries.time[fillT]!;
          const referencePrice = targetSeries.open[fillT]!;
          let budget = 0;

          if (event.side === 'buy') {
            if (portfolio.positions.size >= opts.maxConcurrentPositions) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: 'plafond de positions concurrentes atteint',
                time: fillTime,
              });
              break;
            }
            if (portfolio.positions.has(event.symbol)) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: 'position déjà ouverte sur ce symbole',
                time: fillTime,
              });
              break;
            }
            const sized = sizeBuyOrder({
              cash: portfolio.cash,
              equity: equitySnapshot,
              maxConcurrentPositions: opts.maxConcurrentPositions,
              riskPerTradePct: opts.riskPerTradePct,
              referencePrice,
              ...(event.stopDistance !== undefined ? { stopDistance: event.stopDistance } : {}),
            });
            if (!sized.ok) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: sized.reason,
                time: fillTime,
              });
              break;
            }
            budget = sized.budget;
          }

          if (targetSeries.synthetic[fillT] === 1) {
            queue.push({
              kind: 'order-rejected',
              symbol: event.symbol,
              side: event.side,
              reason: 'barre suivante synthétique',
              time: fillTime,
            });
            break;
          }

          if (event.side === 'buy') {
            const fill = simulateBuy(budget, referencePrice, execOpts);
            // Traité immédiatement (unshift, pas push) : un fill doit affecter le
            // portefeuille avant que le order-requested suivant de la même barre ne
            // lise portfolio.positions/cash — sinon deux achats simultanés voient
            // tous les deux le même plafond/cash non encore décrémenté.
            queue.unshift({
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
            // Voir commentaire sur la branche buy : unshift pour appliquer le fill
            // avant le order-requested suivant de la même barre.
            queue.unshift({
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
          rejectionReasons.push(event.reason);
          break;
        }
      }
    }

    equityCurve.push({
      time: time[t + 1]!,
      equity: portfolioEquity(portfolio, marksAt(series, t + 1)),
    });
  }

  return { portfolio, equityCurve, rejectedOrders, rejectionReasons };
}
