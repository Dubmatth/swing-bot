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

/**
 * Contrat de cycle de vie (documenté pour la future Phase 5b, consommatrice
 * de cette interface) : `start()` ne doit être appelé qu'une seule fois par
 * instance — un second appel a un comportement non garanti selon
 * l'implémentation. `stop()` peut être appelé pour arrêter la source
 * (idempotent selon l'implémentation, voir KrakenOhlcSource).
 */
export interface LiveBarSource {
  /**
   * S'abonne et commence à émettre des barres closes, une par appel.
   * Le callback `onClosedBar` doit être synchrone : une exception qu'il lève
   * est interceptée par l'implémentation (voir KrakenOhlcSource), mais une
   * promesse rejetée par un callback async ne le serait pas.
   */
  start(onClosedBar: (bar: ClosedBar) => void): void;
  /** Ferme la connexion proprement. */
  stop(): void;
}
