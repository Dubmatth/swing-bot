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
  /**
   * Seuil de coefficient de variation (std(period)/sma(period)) au-delà
   * duquel aucune entrée n'est autorisée — filtre de régime de forte
   * volatilité. Sans lui (défaut), aucun filtre. N'affecte jamais la
   * sortie. Réutilise smaVal/stdVal déjà calculés pour le seuil d'entrée :
   * pas de nouvelle fenêtre, pas de nouveau paramètre de période.
   */
  readonly maxVolatilityRatio?: number;
  /**
   * Nombre maximal de barres qu'une position peut rester ouverte avant une
   * sortie forcée, si le retour à la moyenne (price >= sma) ne s'est pas
   * encore produit. Sans lui (défaut), aucune limite — comportement actuel
   * inchangé. N'affecte jamais l'entrée. La sortie par retour à la moyenne
   * reste prioritaire si les deux conditions sont vraies en même temps.
   */
  readonly maxHoldBars?: number;
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
  const { symbol, period, entryK, trendPeriod, volumePeriod, volumeMultiplier, maxVolatilityRatio, maxHoldBars } = params;
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
  if (maxVolatilityRatio !== undefined && !(maxVolatilityRatio > 0)) {
    throw new RangeError(`maxVolatilityRatio invalide : ${maxVolatilityRatio}`);
  }
  if (maxHoldBars !== undefined && (!Number.isInteger(maxHoldBars) || maxHoldBars < 1)) {
    throw new RangeError(`maxHoldBars invalide : ${maxHoldBars}`);
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
      ...(maxVolatilityRatio !== undefined ? { maxVolatilityRatio } : {}),
      ...(maxHoldBars !== undefined ? { maxHoldBars } : {}),
    },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const smaVal = sma(view, period);
      const stdVal = std(view, period);
      const price = view.close(0);
      const position = ctx.positions.get(symbol);
      const hasPosition = position !== undefined;
      const threshold = smaVal - entryK * stdVal;
      const trendOk = trendPeriod === undefined || price > sma(view, trendPeriod);
      const volumeOk =
        volumePeriod === undefined ||
        volumeMultiplier === undefined ||
        view.volume(0) >= volumeMultiplier * avgVolume(view, volumePeriod);
      const volRegimeOk = maxVolatilityRatio === undefined || stdVal / smaVal <= maxVolatilityRatio;

      if (!hasPosition && price < threshold && trendOk && volumeOk && volRegimeOk) {
        return [{
          kind: 'enter',
          symbol,
          reason: `prix=${price.toFixed(4)} < sma(${period})-${entryK}·std=${threshold.toFixed(4)}`,
        }];
      }
      if (position) {
        if (price >= smaVal) {
          return [{
            kind: 'exit',
            symbol,
            reason: `prix=${price.toFixed(4)} >= sma(${period})=${smaVal.toFixed(4)}`,
          }];
        }
        if (maxHoldBars !== undefined) {
          const barInterval = view.time(0) - view.time(1);
          const barsHeld = Math.round((ctx.now - position.entryTime) / barInterval);
          if (barsHeld >= maxHoldBars) {
            return [{
              kind: 'exit',
              symbol,
              reason: `stop de temps : ${barsHeld} barres détenues >= maxHoldBars=${maxHoldBars}`,
            }];
          }
        }
      }
      return [{ kind: 'hold' }];
    },
  };
}
