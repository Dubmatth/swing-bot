/**
 * Événements du backtest, traités par runBacktest via une file event-driven.
 *
 * Discipline de file : tout événement qui MUTE le portefeuille est traité
 * avant tout événement déjà en attente qui LIT l'état du portefeuille —
 * d'où `order-filled` inséré en tête de file (`unshift`) plutôt qu'en fin
 * (`push`) dans runner.ts. Les autres événements (`bar-closed`,
 * `order-requested`, `order-rejected`) ne mutent jamais le portefeuille et
 * restent en FIFO simple (`push`). Un futur type d'événement qui mute le
 * portefeuille doit suivre la même règle — l'oublier réintroduit la classe
 * de bug déjà rencontrée en Phase 2 : deux achats concurrents sur la même
 * barre validés contre un état de portefeuille pas encore à jour.
 */
export type BacktestEvent =
  | {
      readonly kind: 'bar-closed';
      /** Index de barre dans la grille commune (pas un timestamp). */
      readonly t: number;
    }
  | { readonly kind: 'order-requested'; readonly symbol: string; readonly side: 'buy' | 'sell'; readonly reason: string }
  | {
      readonly kind: 'order-filled';
      readonly symbol: string;
      readonly side: 'buy' | 'sell';
      readonly quantity: number;
      readonly price: number;
      readonly fee: number;
      readonly time: number;
    }
  | {
      readonly kind: 'order-rejected';
      readonly symbol: string;
      readonly side: 'buy' | 'sell';
      readonly reason: string;
      readonly time: number;
    };
