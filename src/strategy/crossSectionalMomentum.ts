/**
 * Momentum cross-sectionnel : classe l'univers de paires par rendement de
 * formation, détient les `topN` meilleures, rebalancé une fois par semaine.
 *
 * Contrairement aux stratégies mono-pair assemblées via `combineStrategies`,
 * celle-ci lit tout `ctx.views` directement à chaque appel — le classement
 * n'a de sens que relativement à l'univers complet, pas paire par paire.
 *
 * Détection du rebalancement hebdomadaire : purement fonction de `ctx`
 * (franchissement de frontière de semaine epoch entre la barre précédente
 * et la barre courante), sans aucun état mutable — le contrat `Strategy`
 * (src/strategy/types.ts) interdit à une stratégie de retenir un compteur
 * de barres entre deux appels de `decide()`.
 */

import type { Intent, Strategy, StrategyContext } from './types.ts';

export interface CrossSectionalMomentumParams {
  readonly lookbackPeriod: number;
  readonly topN: number;
}

const WEEK_SECONDS = 7 * 24 * 3600;

// epoch 0 (1970-01-01T00:00:00Z) était un jeudi : les frontières de semaine
// détectées ici (changement de valeur de weekOf) tombent donc toutes un
// jeudi 00:00 UTC, pas un lundi comme on pourrait le supposer par défaut.
function weekOf(time: number): number {
  return Math.floor(time / WEEK_SECONDS);
}

export function createCrossSectionalMomentum(params: CrossSectionalMomentumParams): Strategy {
  const { lookbackPeriod, topN } = params;
  if (!Number.isInteger(lookbackPeriod) || lookbackPeriod < 1) {
    throw new RangeError(`lookbackPeriod invalide : ${lookbackPeriod}`);
  }
  if (!Number.isInteger(topN) || topN < 1) {
    throw new RangeError(`topN invalide : ${topN}`);
  }

  return {
    name: 'cross-sectional-momentum',
    warmup: lookbackPeriod,
    params: { lookbackPeriod, topN },
    decide(ctx: StrategyContext): readonly Intent[] {
      const entries = [...ctx.views];
      if (entries.length === 0) return [{ kind: 'hold' }];

      const [, firstView] = entries[0];
      const isRebalanceBar = weekOf(ctx.now) !== weekOf(firstView.time(1));
      if (!isRebalanceBar) return [{ kind: 'hold' }];

      const ranked = entries
        .map(([symbol, view]) => {
          const formationReturn = view.close(0) / view.close(lookbackPeriod) - 1;
          return { symbol, formationReturn };
        })
        .sort((a, b) => b.formationReturn - a.formationReturn);

      const target = ranked.slice(0, topN);
      const targetSymbols = new Set(target.map((r) => r.symbol));
      const currentlyHeld = entries.filter(([symbol]) => ctx.positions.has(symbol)).map(([symbol]) => symbol);

      const intents: Intent[] = [];
      for (const symbol of currentlyHeld) {
        if (!targetSymbols.has(symbol)) {
          intents.push({
            kind: 'exit',
            symbol,
            reason: `momentum cross-sectionnel : ${symbol} sort du top ${topN}`,
          });
        }
      }
      target.forEach((r, i) => {
        if (!ctx.positions.has(r.symbol)) {
          intents.push({
            kind: 'enter',
            symbol: r.symbol,
            reason:
              `momentum cross-sectionnel : rang ${i + 1}/${topN}, ` +
              `rendement(${lookbackPeriod})=${(r.formationReturn * 100).toFixed(2)}%`,
          });
        }
      });

      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}
