/**
 * Combine plusieurs stratégies mono-pair en une seule stratégie
 * multi-paires.
 *
 * `ctx` est déjà multi-paires par construction depuis la Phase 0
 * (`ctx.views: ReadonlyMap<string, BarView>` couvre déjà toutes les paires
 * chargées par le runner) — ce combinateur ne fait qu'appeler chaque
 * sous-stratégie avec le même `ctx` et concaténer leurs intentions. Chaque
 * sous-stratégie reste testable isolément, comme en Phase 1.
 *
 * Sous plafond de positions concurrentes saturé (voir runner.ts), l'ordre
 * du tableau `strategies` devient la priorité de facto : la première
 * sous-stratégie à émettre une intention actionnable sur une barre donnée
 * est celle qui a une chance d'être exécutée si le plafond est atteint ce
 * jour-là.
 */

import type { Intent, Strategy, StrategyContext } from './types.ts';

export function combineStrategies(strategies: readonly Strategy[]): Strategy {
  if (strategies.length === 0) {
    throw new RangeError('combineStrategies : au moins une stratégie requise');
  }

  const warmup = Math.max(...strategies.map((s) => s.warmup));

  const params: Record<string, number> = {};
  strategies.forEach((s, i) => {
    for (const [key, value] of Object.entries(s.params)) {
      params[`${i}_${key}`] = value;
    }
  });

  return {
    name: `combined(${strategies.map((s) => s.name).join(',')})`,
    warmup,
    params,
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents: Intent[] = [];
      for (const s of strategies) {
        for (const intent of s.decide(ctx)) {
          if (intent.kind !== 'hold') {
            intents.push(intent);
          }
        }
      }
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}
