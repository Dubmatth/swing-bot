/**
 * Stratégie de référence : croisement de deux moyennes mobiles simples.
 *
 * Sert à prouver que le moteur de backtest (file d'événements, exécution
 * simulée, frais, slippage) fonctionne de bout en bout — pas une stratégie
 * de production.
 *
 * `decide()` recalcule les deux moyennes à chaque appel depuis la fenêtre
 * `BarView` déjà disponible, sans état interne persistant : le contrat
 * `Strategy.decide` interdit toute mutation, y compris des propres champs
 * de la stratégie, ce qu'un indicateur incrémental mis à jour au fil des
 * appels violerait.
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';
import { Sma } from './indicators.ts';

export interface MaCrossoverParams {
  readonly symbol: string;
  readonly fast: number;
  readonly slow: number;
}

function sma(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

export function createMaCrossover(params: MaCrossoverParams): Strategy {
  const { symbol, fast, slow } = params;
  if (!Number.isInteger(fast) || fast < 1) {
    throw new RangeError(`Période fast invalide : ${fast}`);
  }
  if (!Number.isInteger(slow) || slow <= fast) {
    throw new RangeError(`Période slow invalide : ${slow} (doit être > fast=${fast})`);
  }

  return {
    name: 'ma-crossover',
    warmup: slow,
    params: { fast, slow },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const fastVal = sma(view, fast);
      const slowVal = sma(view, slow);
      const hasPosition = ctx.positions.has(symbol);

      if (!hasPosition && fastVal > slowVal) {
        return [{
          kind: 'enter',
          symbol,
          reason: `sma(${fast})=${fastVal.toFixed(4)} > sma(${slow})=${slowVal.toFixed(4)}`,
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
