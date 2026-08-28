/**
 * Breakout Donchian ("Turtle") : achète une cassure du plus haut sur
 * `entryPeriod` bougies, vend une cassure du plus bas sur `exitPeriod`
 * bougies (fenêtre de sortie plus courte que l'entrée, comme le système
 * Turtle historique — réduit le va-et-vient par rapport à un canal
 * symétrique).
 *
 * Mécanisme différent d'un croisement de moyennes mobiles
 * (`ma-crossover`) ou d'un classement relatif
 * (`cross-sectional-momentum`) : compare le prix courant à un extremum
 * récent, sans lissage ni classement entre paires.
 *
 * `decide()` recalcule tout à chaque appel depuis la `BarView` déjà
 * disponible, sans état interne persistant (voir le contrat de pureté de
 * `Strategy.decide`, src/strategy/types.ts).
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';

export interface DonchianBreakoutParams {
  readonly symbol: string;
  readonly entryPeriod: number;
  readonly exitPeriod: number;
}

/**
 * Plus haut des `period` bougies PRÉCÉDENTES (ago=1..period), en excluant
 * la bougie courante (ago=0) — sinon `close(0) > highestHigh` serait
 * structurellement impossible, puisque close(0) <= high(0) toujours.
 */
function highestHigh(view: BarView, period: number): number {
  let max = -Infinity;
  for (let ago = 1; ago <= period; ago++) {
    const h = view.high(ago);
    if (h > max) max = h;
  }
  return max;
}

/** Symétrique de highestHigh() pour le plus bas, même exclusion de ago=0. */
function lowestLow(view: BarView, period: number): number {
  let min = Infinity;
  for (let ago = 1; ago <= period; ago++) {
    const l = view.low(ago);
    if (l < min) min = l;
  }
  return min;
}

export function createDonchianBreakout(params: DonchianBreakoutParams): Strategy {
  const { symbol, entryPeriod, exitPeriod } = params;
  if (!Number.isInteger(entryPeriod) || entryPeriod < 1) {
    throw new RangeError(`entryPeriod invalide : ${entryPeriod}`);
  }
  if (!Number.isInteger(exitPeriod) || exitPeriod < 1) {
    throw new RangeError(`exitPeriod invalide : ${exitPeriod}`);
  }

  const warmup = Math.max(entryPeriod, exitPeriod);

  return {
    name: 'donchian-breakout',
    warmup,
    params: { entryPeriod, exitPeriod },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const hasPosition = ctx.positions.has(symbol);
      const price = view.close(0);

      if (!hasPosition) {
        const entryHigh = highestHigh(view, entryPeriod);
        if (price > entryHigh) {
          return [{
            kind: 'enter',
            symbol,
            reason: `cassure haussière : prix=${price.toFixed(4)} > plus-haut(${entryPeriod})=${entryHigh.toFixed(4)}`,
          }];
        }
      }
      if (hasPosition) {
        const exitLow = lowestLow(view, exitPeriod);
        if (price < exitLow) {
          return [{
            kind: 'exit',
            symbol,
            reason: `cassure baissière : prix=${price.toFixed(4)} < plus-bas(${exitPeriod})=${exitLow.toFixed(4)}`,
          }];
        }
      }
      return [{ kind: 'hold' }];
    },
  };
}
