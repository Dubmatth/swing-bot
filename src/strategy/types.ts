/**
 * Contrat de stratégie.
 *
 * Deux invariants portés par le TYPE, pas par la discipline du développeur :
 *
 *  1. PURETÉ. Une stratégie ne fait pas d'I/O, ne lit pas l'horloge système,
 *     n'utilise pas Math.random. Même entrée → même sortie, toujours. C'est ce
 *     qui permet au backtester et au live-runner de consommer exactement le
 *     même module et garantit l'absence de dérive d'implémentation.
 *
 *  2. ABSENCE DE LOOK-AHEAD. La stratégie ne reçoit jamais la série complète,
 *     seulement une `BarView` bornée à la dernière barre CLOSE. Toute lecture
 *     au-delà lève une exception. C'est structurel : on ne peut pas oublier de
 *     ne pas tricher.
 *
 * Le look-ahead est la première cause d'échec de ce genre de projet, et il est
 * indétectable dans les résultats — un backtest contaminé est simplement
 * excellent. La seule parade fiable est de rendre la triche impossible.
 */

import type { BarSeries } from '../data/series.ts';

/** Vue en lecture seule, bornée à `t` inclus. */
export class BarView {
  readonly #s: BarSeries;
  /** Index de la dernière barre close et lisible. */
  readonly t: number;

  constructor(series: BarSeries, t: number) {
    this.#s = series;
    this.t = t;
  }

  get symbol(): string {
    return this.#s.symbol;
  }

  /** Nombre de barres lisibles. */
  get length(): number {
    return this.t + 1;
  }

  /**
   * Accès par décalage vers le passé : ago=0 est la barre close courante,
   * ago=1 la précédente. Un décalage négatif viserait le futur et lève.
   */
  private at(col: Float64Array, ago: number): number {
    if (!Number.isInteger(ago)) {
      throw new TypeError(`Décalage non entier : ${ago}`);
    }
    if (ago < 0) {
      throw new RangeError(
        `Look-ahead détecté sur ${this.#s.symbol} : décalage ${ago}. ` +
          `Une stratégie ne peut pas lire une barre future.`,
      );
    }
    const i = this.t - ago;
    if (i < 0) {
      throw new RangeError(
        `Historique insuffisant sur ${this.#s.symbol} : décalage ${ago} ` +
          `pour ${this.t + 1} barre(s) disponible(s). Déclarer un warmup suffisant.`,
      );
    }
    return col[i];
  }

  open(ago = 0): number {
    return this.at(this.#s.open, ago);
  }
  high(ago = 0): number {
    return this.at(this.#s.high, ago);
  }
  low(ago = 0): number {
    return this.at(this.#s.low, ago);
  }
  close(ago = 0): number {
    return this.at(this.#s.close, ago);
  }
  volume(ago = 0): number {
    return this.at(this.#s.volume, ago);
  }
  time(ago = 0): number {
    return this.at(this.#s.time, ago);
  }

  /** Vrai si la barre est un forward-fill (aucune transaction). */
  isSynthetic(ago = 0): boolean {
    if (ago < 0) throw new RangeError('Look-ahead détecté');
    const i = this.t - ago;
    if (i < 0) throw new RangeError('Historique insuffisant');
    return this.#s.synthetic[i] === 1;
  }
}

export type Side = 'long' | 'flat';

export interface Position {
  readonly symbol: string;
  readonly side: Side;
  /** Quantité en unités de l'actif de base. */
  readonly quantity: number;
  /** Prix de revient moyen en EUR. */
  readonly entryPrice: number;
  /** Timestamp d'entrée, en secondes epoch. */
  readonly entryTime: number;
}

export type Intent =
  | {
      readonly kind: 'enter';
      readonly symbol: string;
      readonly reason: string;
      /** Distance de stop en prix (pas en %), pour le sizing par risque du runner. Optionnel. */
      readonly stopDistance?: number;
    }
  | { readonly kind: 'exit'; readonly symbol: string; readonly reason: string }
  | { readonly kind: 'hold' };

/**
 * Contexte fourni à chaque pas. Contient uniquement de l'information
 * disponible à l'instant `t` — aucune donnée future, aucune donnée externe.
 */
export interface StrategyContext {
  /** Vues bornées, une par symbole de l'univers. Toutes alignées sur `t`. */
  readonly views: ReadonlyMap<string, BarView>;
  /** Positions ouvertes à cet instant. */
  readonly positions: ReadonlyMap<string, Position>;
  /** Timestamp de la barre close courante, en secondes epoch. */
  readonly now: number;
}

export interface Strategy {
  readonly name: string;
  /**
   * Nombre de barres d'historique requis avant que la stratégie n'émette un
   * signal. Le backtester saute ces barres ; sans ça, les premiers signaux
   * sont calculés sur des indicateurs non convergés et biaisent le résultat.
   */
  readonly warmup: number;
  /** Paramètres, exposés pour la traçabilité du walk-forward. */
  readonly params: Readonly<Record<string, number>>;
  /** Fonction pure. Ne doit rien muter, y compris ses propres champs. */
  decide(ctx: StrategyContext): readonly Intent[];
}

/**
 * Compte les degrés de liberté d'une stratégie.
 *
 * Rappel du plan (§4) : chaque paramètre ajusté améliore la performance sur
 * l'historique et la dégrade hors échantillon. Au-delà de trois, la
 * justification doit être économique — pas une amélioration du Sharpe.
 */
export function degreesOfFreedom(s: Strategy): number {
  return Object.keys(s.params).length;
}
