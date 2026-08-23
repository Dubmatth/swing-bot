/**
 * Indicateurs incrémentaux.
 *
 * Chaque `update()` est en O(1). Recalculer une fenêtre de 200 périodes à
 * chaque barre coûte O(n·p) sur l'ensemble d'un backtest ; sur 2 400 backtests
 * × 20 paires, la différence n'est plus mesurée en millisecondes.
 *
 * Ces objets sont MUTABLES et donc réservés au calcul interne d'une stratégie.
 * La stratégie elle-même reste pure vis-à-vis de son contexte : elle
 * reconstruit ses indicateurs à chaque backtest depuis la même graine de
 * données, ce qui préserve le déterminisme.
 */

export interface Indicator {
  /** Renvoie la valeur courante, ou NaN tant que non convergé. */
  update(x: number): number;
  readonly ready: boolean;
  readonly value: number;
}

/** Moyenne mobile exponentielle. Convergence considérée acquise à `period`. */
export class Ema implements Indicator {
  private readonly k: number;
  private acc = 0;
  private n = 0;

  readonly period: number;

  constructor(period: number) {
    this.period = period;
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`Période EMA invalide : ${period}`);
    }
    this.k = 2 / (period + 1);
  }

  update(x: number): number {
    this.n++;
    // Amorçage en moyenne simple : évite le biais de départ d'une EMA
    // initialisée sur la première valeur.
    if (this.n <= this.period) {
      this.acc += (x - this.acc) / this.n;
    } else {
      this.acc += this.k * (x - this.acc);
    }
    return this.value;
  }

  get ready(): boolean {
    return this.n >= this.period;
  }

  get value(): number {
    return this.ready ? this.acc : NaN;
  }
}

/** Moyenne mobile simple sur tampon circulaire. */
export class Sma implements Indicator {
  private readonly buf: Float64Array;
  private sum = 0;
  private i = 0;
  private n = 0;

  readonly period: number;

  constructor(period: number) {
    this.period = period;
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`Période SMA invalide : ${period}`);
    }
    this.buf = new Float64Array(period);
  }

  update(x: number): number {
    if (this.n >= this.period) {
      this.sum -= this.buf[this.i];
    } else {
      this.n++;
    }
    this.buf[this.i] = x;
    this.sum += x;
    this.i = (this.i + 1) % this.period;
    return this.value;
  }

  get ready(): boolean {
    return this.n >= this.period;
  }

  get value(): number {
    return this.ready ? this.sum / this.period : NaN;
  }
}

/**
 * Average True Range de Wilder. Base du dimensionnement de position :
 * risquer 1 % du capital sur une distance de N×ATR normalise l'exposition
 * entre BTC/EUR et une altcoin trois fois plus volatile, ce qu'un stop en
 * pourcentage fixe ne fait pas.
 */
export class Atr {
  private prevClose = NaN;
  private acc = 0;
  private n = 0;

  readonly period: number;

  constructor(period: number) {
    this.period = period;
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`Période ATR invalide : ${period}`);
    }
  }

  update(high: number, low: number, close: number): number {
    const tr = Number.isNaN(this.prevClose)
      ? high - low
      : Math.max(
          high - low,
          Math.abs(high - this.prevClose),
          Math.abs(low - this.prevClose),
        );
    this.prevClose = close;
    this.n++;
    if (this.n <= this.period) {
      this.acc += (tr - this.acc) / this.n;
    } else {
      this.acc = (this.acc * (this.period - 1) + tr) / this.period;
    }
    return this.value;
  }

  get ready(): boolean {
    return this.n >= this.period;
  }

  get value(): number {
    return this.ready ? this.acc : NaN;
  }
}

/** Écart-type glissant (population), via somme des carrés. */
export class RollingStd implements Indicator {
  private readonly buf: Float64Array;
  private sum = 0;
  private sumSq = 0;
  private i = 0;
  private n = 0;

  readonly period: number;

  constructor(period: number) {
    this.period = period;
    if (!Number.isInteger(period) || period < 2) {
      throw new RangeError(`Période invalide : ${period}`);
    }
    this.buf = new Float64Array(period);
  }

  update(x: number): number {
    if (this.n >= this.period) {
      const old = this.buf[this.i];
      this.sum -= old;
      this.sumSq -= old * old;
    } else {
      this.n++;
    }
    this.buf[this.i] = x;
    this.sum += x;
    this.sumSq += x * x;
    this.i = (this.i + 1) % this.period;
    return this.value;
  }

  get ready(): boolean {
    return this.n >= this.period;
  }

  get value(): number {
    if (!this.ready) return NaN;
    const mean = this.sum / this.period;
    // max(0, …) neutralise les variances négatives dues à l'accumulation
    // d'erreurs en virgule flottante sur de longues séries.
    return Math.sqrt(Math.max(0, this.sumSq / this.period - mean * mean));
  }
}
