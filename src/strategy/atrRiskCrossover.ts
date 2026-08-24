/**
 * Stratégie de référence : croisement de deux moyennes mobiles simples,
 * avec sizing par risque basé sur l'ATR.
 *
 * Même logique de signal que maCrossover.ts (voir ce fichier pour le détail
 * du contrat de pureté — decide() recalcule tout à chaque appel, sans état
 * interne persistant) ; maCrossover.ts lui-même n'est pas modifié. Cette
 * variante calcule en plus une distance de stop (atrMultiplier × ATR)
 * transmise au runner via Intent.stopDistance, qui l'utilise pour
 * dimensionner la position par risque plutôt qu'en fraction fixe pure (voir
 * runner.ts). C'est la motivation d'origine du commentaire de la classe Atr
 * dans indicators.ts : normaliser l'exposition entre une paire peu volatile
 * et une paire trois fois plus volatile.
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';
import { Atr, Sma } from './indicators.ts';

export interface AtrRiskCrossoverParams {
  readonly symbol: string;
  readonly fast: number;
  readonly slow: number;
  readonly atrPeriod: number;
  readonly atrMultiplier: number;
}

function sma(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

function atr(view: BarView, period: number): number {
  const a = new Atr(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    a.update(view.high(ago), view.low(ago), view.close(ago));
  }
  return a.value;
}

export function createAtrRiskCrossover(params: AtrRiskCrossoverParams): Strategy {
  const { symbol, fast, slow, atrPeriod, atrMultiplier } = params;
  if (!Number.isInteger(fast) || fast < 1) {
    throw new RangeError(`Période fast invalide : ${fast}`);
  }
  if (!Number.isInteger(slow) || slow <= fast) {
    throw new RangeError(`Période slow invalide : ${slow} (doit être > fast=${fast})`);
  }
  if (!Number.isInteger(atrPeriod) || atrPeriod < 1) {
    throw new RangeError(`Période ATR invalide : ${atrPeriod}`);
  }
  if (!(atrMultiplier > 0)) {
    throw new RangeError(`atrMultiplier invalide : ${atrMultiplier}`);
  }

  const warmup = Math.max(slow, atrPeriod);

  return {
    name: 'atr-risk-crossover',
    warmup,
    params: { fast, slow, atrPeriod, atrMultiplier },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const fastVal = sma(view, fast);
      const slowVal = sma(view, slow);
      const hasPosition = ctx.positions.has(symbol);

      if (!hasPosition && fastVal > slowVal) {
        const atrVal = atr(view, atrPeriod);
        return [{
          kind: 'enter',
          symbol,
          reason: `sma(${fast})=${fastVal.toFixed(4)} > sma(${slow})=${slowVal.toFixed(4)}`,
          stopDistance: atrMultiplier * atrVal,
        }];
      }
      if (hasPosition && fastVal < slowVal) {
        return [{
          kind: 'exit',
          symbol,
          reason: `sma(${fast})=${fastVal.toFixed(4)} < sma(${slow})=${slowVal.toFixed(4)}`,
        }];
      }
      return [{ kind: 'hold' }];
    },
  };
}
