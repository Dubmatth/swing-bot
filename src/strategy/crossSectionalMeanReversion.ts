/**
 * Variante cross-sectionnelle de mean-reversion (Phase 6) : même signal
 * d'entrée/sortie par paire (price < sma-entryK·std / price >= sma), mais
 * lit tout l'univers à chaque decide() pour prioriser les entrées
 * simultanées par profondeur de survente (z-score décroissant) plutôt
 * que l'ordre arbitraire de combineStrategies. Aucun nouveau paramètre —
 * seule la priorité entre candidats simultanés change.
 *
 * sma()/std() sont dupliquées depuis meanReversion.ts plutôt qu'importées,
 * même convention que atrRiskCrossover.ts vis-à-vis de maCrossover.ts :
 * meanReversion.ts reste figé pour protéger le candidat déjà validé de
 * toute dérive d'implémentation accidentelle.
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';
import { RollingStd, Sma } from './indicators.ts';

export interface CrossSectionalMeanReversionParams {
  readonly period: number;
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

interface EnterCandidate {
  readonly symbol: string;
  readonly zScore: number;
  readonly price: number;
  readonly smaVal: number;
  readonly threshold: number;
}

export function createCrossSectionalMeanReversion(params: CrossSectionalMeanReversionParams): Strategy {
  const { period, entryK } = params;
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Période invalide : ${period}`);
  }
  if (!(entryK > 0)) {
    throw new RangeError(`entryK invalide : ${entryK}`);
  }

  return {
    name: 'cross-sectional-mean-reversion',
    warmup: period,
    params: { period, entryK },
    decide(ctx: StrategyContext): readonly Intent[] {
      const exitIntents: Intent[] = [];
      const candidates: EnterCandidate[] = [];

      for (const [symbol, view] of ctx.views) {
        const smaVal = sma(view, period);
        const stdVal = std(view, period);
        const price = view.close(0);
        const position = ctx.positions.get(symbol);

        if (position) {
          if (price >= smaVal) {
            exitIntents.push({
              kind: 'exit',
              symbol,
              reason: `prix=${price.toFixed(4)} >= sma(${period})=${smaVal.toFixed(4)}`,
            });
          }
          continue;
        }

        const threshold = smaVal - entryK * stdVal;
        if (price < threshold) {
          candidates.push({
            symbol,
            zScore: (smaVal - price) / stdVal,
            price,
            smaVal,
            threshold,
          });
        }
      }

      candidates.sort((a, b) => b.zScore - a.zScore);
      const enterIntents: Intent[] = candidates.map((c) => ({
        kind: 'enter',
        symbol: c.symbol,
        reason:
          `prix=${c.price.toFixed(4)} < sma(${period})-${entryK}·std=${c.threshold.toFixed(4)}, ` +
          `z-score=${c.zScore.toFixed(2)}`,
      }));

      const intents = [...exitIntents, ...enterIntents];
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}
