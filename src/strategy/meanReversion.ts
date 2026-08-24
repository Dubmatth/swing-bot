/**
 * Stratégie de réversion à la moyenne (bandes de Bollinger), construite
 * avec les indicateurs existants (Sma + RollingStd) — aucun nouvel
 * indicateur nécessaire.
 *
 * Logique inverse du suivi de tendance (maCrossover.ts/atrRiskCrossover.ts) :
 * on mise sur le retour à la moyenne d'un prix qui s'en est trop écarté,
 * plutôt que sur la continuation d'une tendance.
 *
 * Même contrat de pureté que les autres stratégies : decide() recalcule
 * sma/std à chaque appel depuis la BarView, sans état interne persistant.
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';
import { RollingStd, Sma } from './indicators.ts';

export interface MeanReversionParams {
  readonly symbol: string;
  readonly period: number;
  /** Multiplicateur d'écart-type du seuil d'entrée. */
  readonly entryK: number;
}

function sma(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

function std(view: BarView, period: number): number {
  const s = new RollingStd(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

export function createMeanReversion(params: MeanReversionParams): Strategy {
  const { symbol, period, entryK } = params;
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Période invalide : ${period}`);
  }
  if (!(entryK > 0)) {
    throw new RangeError(`entryK invalide : ${entryK}`);
  }

  return {
    name: 'mean-reversion',
    warmup: period,
    params: { period, entryK },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const smaVal = sma(view, period);
      const stdVal = std(view, period);
      const price = view.close(0);
      const hasPosition = ctx.positions.has(symbol);
      const threshold = smaVal - entryK * stdVal;

      if (!hasPosition && price < threshold) {
        return [{
          kind: 'enter',
          symbol,
          reason: `prix=${price.toFixed(4)} < sma(${period})-${entryK}·std=${threshold.toFixed(4)}`,
        }];
      }
      if (hasPosition && price >= smaVal) {
        return [{
          kind: 'exit',
          symbol,
          reason: `prix=${price.toFixed(4)} >= sma(${period})=${smaVal.toFixed(4)}`,
        }];
      }
      return [{ kind: 'hold' }];
    },
  };
}
