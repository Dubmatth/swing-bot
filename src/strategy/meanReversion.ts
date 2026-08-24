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
  /**
   * Période d'une moyenne longue utilisée comme filtre de tendance. Sans
   * elle (défaut), aucun filtre : la stratégie achète tout creux qui
   * franchit le seuil, y compris en tendance baissière de fond — le risque
   * classique de la réversion à la moyenne ("attraper un couteau qui
   * tombe"). Avec elle, un creux n'est acheté que si le prix reste
   * au-dessus de cette moyenne longue. N'affecte jamais la sortie.
   */
  readonly trendPeriod?: number;
  /**
   * Période de la moyenne de volume de confirmation, et multiplicateur du
   * volume moyen requis à l'entrée — capitulation réelle plutôt qu'un creux
   * sur volume ordinaire. Les deux doivent être fournis ensemble, ou pas du
   * tout (défaut : aucun filtre, comportement inchangé). N'affecte jamais
   * la sortie.
   */
  readonly volumePeriod?: number;
  readonly volumeMultiplier?: number;
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

function avgVolume(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.volume(ago));
  }
  return s.value;
}

export function createMeanReversion(params: MeanReversionParams): Strategy {
  const { symbol, period, entryK, trendPeriod, volumePeriod, volumeMultiplier } = params;
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Période invalide : ${period}`);
  }
  if (!(entryK > 0)) {
    throw new RangeError(`entryK invalide : ${entryK}`);
  }
  if (trendPeriod !== undefined && (!Number.isInteger(trendPeriod) || trendPeriod <= period)) {
    throw new RangeError(`trendPeriod invalide : ${trendPeriod} (doit être > period=${period})`);
  }
  if ((volumePeriod === undefined) !== (volumeMultiplier === undefined)) {
    throw new RangeError('volumePeriod et volumeMultiplier doivent être fournis ensemble');
  }
  if (volumePeriod !== undefined && (!Number.isInteger(volumePeriod) || volumePeriod < 2)) {
    throw new RangeError(`volumePeriod invalide : ${volumePeriod}`);
  }
  if (volumeMultiplier !== undefined && !(volumeMultiplier > 0)) {
    throw new RangeError(`volumeMultiplier invalide : ${volumeMultiplier}`);
  }

  const warmup = Math.max(period, trendPeriod ?? 0, volumePeriod ?? 0);

  return {
    name: 'mean-reversion',
    warmup,
    params: {
      period,
      entryK,
      ...(trendPeriod !== undefined ? { trendPeriod } : {}),
      ...(volumePeriod !== undefined ? { volumePeriod } : {}),
      ...(volumeMultiplier !== undefined ? { volumeMultiplier } : {}),
    },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const smaVal = sma(view, period);
      const stdVal = std(view, period);
      const price = view.close(0);
      const hasPosition = ctx.positions.has(symbol);
      const threshold = smaVal - entryK * stdVal;
      const trendOk = trendPeriod === undefined || price > sma(view, trendPeriod);
      const volumeOk =
        volumePeriod === undefined ||
        volumeMultiplier === undefined ||
        view.volume(0) >= volumeMultiplier * avgVolume(view, volumePeriod);

      if (!hasPosition && price < threshold && trendOk && volumeOk) {
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
