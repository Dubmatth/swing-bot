/**
 * Interface d'une source de barres closes en temps réel. Séparée de
 * l'implémentation réelle (KrakenOhlcSource) pour rester testable sans
 * réseau — voir krakenOhlcSource.ts et son extraction de logique pure.
 */

export interface ClosedBar {
  readonly symbol: string;
  /** Timestamp d'ouverture de la barre (interval_begin), en secondes epoch. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number;
}

export interface LiveBarSource {
  /** S'abonne et commence à émettre des barres closes, une par appel. */
  start(onClosedBar: (bar: ClosedBar) => void): void;
  /** Ferme la connexion proprement. */
  stop(): void;
}
