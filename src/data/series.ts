/**
 * Représentation colonnaire des barres OHLCVT.
 *
 * Pourquoi pas un `Bar[]` d'objets : à 2 400 backtests (12 fenêtres
 * walk-forward × 200 combinaisons de paramètres) sur 20 paires, un tableau
 * d'objets impose une déréférence de pointeur par accès et une pression GC
 * permanente. Les colonnes typées tiennent en cache et se partagent entre
 * worker_threads via SharedArrayBuffer sans copie — les données de marché
 * sont en lecture seule, c'est le cas d'usage idéal.
 */

export type Interval = 60 | 240 | 1440;

export interface BarSeries {
  readonly symbol: string;
  readonly interval: Interval;
  /** Timestamps d'ouverture, en secondes epoch. Strictement croissants. */
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  readonly trades: Float64Array;
  /**
   * Marqueur par barre : 1 si la barre provient d'un forward-fill (aucune
   * transaction sur l'intervalle), 0 si elle est réelle.
   *
   * Ce champ n'est pas cosmétique. Une stratégie ne doit jamais entrer en
   * position sur une barre synthétique : le prix affiché n'a pas été négocié,
   * et supposer qu'on aurait pu s'y exécuter est une forme discrète de
   * look-ahead. Le backtester s'en sert pour refuser l'exécution.
   */
  readonly synthetic: Uint8Array;
  readonly length: number;
}

export interface MutableColumns {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  trades: number[];
  synthetic: number[];
}

export function emptyColumns(): MutableColumns {
  return {
    time: [],
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    trades: [],
    synthetic: [],
  };
}

/** Fige des colonnes mutables en séries typées. Vérifie les invariants. */
export function freezeSeries(
  symbol: string,
  interval: Interval,
  c: MutableColumns,
): BarSeries {
  const n = c.time.length;
  for (const [name, col] of Object.entries(c)) {
    if (col.length !== n) {
      throw new Error(
        `Colonne '${name}' de longueur ${col.length}, attendu ${n} (${symbol})`,
      );
    }
  }
  for (let i = 1; i < n; i++) {
    if (c.time[i] <= c.time[i - 1]) {
      throw new Error(
        `Timestamps non strictement croissants en ${i} sur ${symbol} : ` +
          `${c.time[i - 1]} puis ${c.time[i]}`,
      );
    }
  }
  return {
    symbol,
    interval,
    time: Float64Array.from(c.time),
    open: Float64Array.from(c.open),
    high: Float64Array.from(c.high),
    low: Float64Array.from(c.low),
    close: Float64Array.from(c.close),
    volume: Float64Array.from(c.volume),
    trades: Float64Array.from(c.trades),
    synthetic: Uint8Array.from(c.synthetic),
    length: n,
  };
}

/** Extrait une tranche [from, to) — utilisé par le walk-forward. */
export function sliceSeries(s: BarSeries, from: number, to: number): BarSeries {
  if (from < 0 || to > s.length || from > to) {
    throw new RangeError(`Tranche [${from}, ${to}) hors bornes (0..${s.length})`);
  }
  return {
    symbol: s.symbol,
    interval: s.interval,
    time: s.time.subarray(from, to),
    open: s.open.subarray(from, to),
    high: s.high.subarray(from, to),
    low: s.low.subarray(from, to),
    close: s.close.subarray(from, to),
    volume: s.volume.subarray(from, to),
    trades: s.trades.subarray(from, to),
    synthetic: s.synthetic.subarray(from, to),
    length: to - from,
  };
}

/** Index de la première barre dont le timestamp est >= t (recherche binaire). */
export function indexAtOrAfter(s: BarSeries, t: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (s.time[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
