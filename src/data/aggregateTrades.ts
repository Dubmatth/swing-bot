/**
 * Agrège des transactions brutes ("Time & Sales" Kraken) en bougies OHLCVT,
 * dans le format déjà consommé par krakenCsv.ts.
 *
 * Une fenêtre sans transaction ne produit aucune bougie — pas de synthèse
 * artificielle ; le remplissage des trous reste la responsabilité de
 * gaps.ts, en aval, exactement comme pour le chargeur CSV existant.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { BarSeries, Interval, MutableColumns } from './series.ts';
import { emptyColumns, freezeSeries } from './series.ts';

export interface Trade {
  /** Timestamp de la transaction, en secondes epoch. */
  readonly time: number;
  readonly price: number;
  readonly volume: number;
}

interface Bucket {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

interface IntervalState {
  readonly interval: Interval;
  readonly step: number;
  readonly columns: MutableColumns;
  current: Bucket | undefined;
}

function bucketStart(time: number, stepSeconds: number): number {
  return Math.floor(time / stepSeconds) * stepSeconds;
}

function newBucket(start: number, trade: Trade): Bucket {
  return {
    start,
    open: trade.price,
    high: trade.price,
    low: trade.price,
    close: trade.price,
    volume: trade.volume,
    trades: 1,
  };
}

function updateBucket(bucket: Bucket, trade: Trade): void {
  bucket.high = Math.max(bucket.high, trade.price);
  bucket.low = Math.min(bucket.low, trade.price);
  bucket.close = trade.price;
  bucket.volume += trade.volume;
  bucket.trades += 1;
}

function pushBucket(cols: MutableColumns, bucket: Bucket): void {
  cols.time.push(bucket.start);
  cols.open.push(bucket.open);
  cols.high.push(bucket.high);
  cols.low.push(bucket.low);
  cols.close.push(bucket.close);
  cols.volume.push(bucket.volume);
  cols.trades.push(bucket.trades);
  cols.synthetic.push(0);
}

/**
 * Agrège un flux de transactions (attendu trié par temps croissant, comme
 * les exports Kraken) en bougies, pour un ou plusieurs intervalles à la
 * fois — un seul passage sur le flux suffit pour tous les intervalles
 * demandés, ce qui évite de relire un fichier de plusieurs Go une fois par
 * intervalle.
 */
export async function aggregateTrades(
  symbol: string,
  trades: Iterable<Trade> | AsyncIterable<Trade>,
  intervals: readonly Interval[],
): Promise<ReadonlyMap<Interval, BarSeries>> {
  if (intervals.length === 0) {
    throw new Error(`${symbol} : aucun intervalle demandé`);
  }
  if (new Set(intervals).size !== intervals.length) {
    throw new Error(`${symbol} : intervalles dupliqués dans ${intervals.join(',')}`);
  }

  const states: IntervalState[] = intervals.map((interval) => ({
    interval,
    step: interval * 60,
    columns: emptyColumns(),
    current: undefined,
  }));

  let lastTime: number | undefined;
  let count = 0;

  for await (const trade of trades) {
    if (lastTime !== undefined && trade.time < lastTime) {
      throw new Error(`${symbol} : transaction hors ordre, t=${trade.time} après ${lastTime}`);
    }
    lastTime = trade.time;
    count++;

    for (const state of states) {
      const bs = bucketStart(trade.time, state.step);
      if (state.current === undefined) {
        state.current = newBucket(bs, trade);
      } else if (bs === state.current.start) {
        updateBucket(state.current, trade);
      } else {
        pushBucket(state.columns, state.current);
        state.current = newBucket(bs, trade);
      }
    }
  }

  if (count === 0) {
    throw new Error(`${symbol} : aucune transaction à agréger`);
  }

  const result = new Map<Interval, BarSeries>();
  for (const state of states) {
    if (state.current !== undefined) {
      pushBucket(state.columns, state.current);
    }
    result.set(state.interval, freezeSeries(symbol, state.interval, state.columns));
  }
  return result;
}

/** Parseur strict d'une ligne "Time & Sales" Kraken : timestamp,price,volume. */
export function parseTradeLine(symbol: string, line: string, lineNo: number): Trade {
  const parts = line.split(',');
  if (parts.length !== 3) {
    throw new Error(`${symbol} ligne ${lineNo} : ${parts.length} champs, attendu 3`);
  }

  const time = Number(parts[0]);
  const price = Number(parts[1]);
  const volume = Number(parts[2]);

  if (!Number.isFinite(time) || time <= 0) {
    throw new Error(`${symbol} ligne ${lineNo} : timestamp invalide '${parts[0]}'`);
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`${symbol} ligne ${lineNo} : prix invalide '${parts[1]}'`);
  }
  if (!Number.isFinite(volume) || volume < 0) {
    throw new Error(`${symbol} ligne ${lineNo} : volume invalide '${parts[2]}'`);
  }

  return { time, price, volume };
}

/**
 * Lit un fichier "Time & Sales" en streaming — jamais chargé entièrement en
 * mémoire, les fichiers Kraken font plusieurs Go. Non testé automatiquement
 * (I/O réel sur disque), comme le câblage réseau de krakenOhlcSource.ts.
 */
export async function* readTradesFile(symbol: string, path: string): AsyncGenerator<Trade> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const rawLine of rl) {
    lineNo++;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    yield parseTradeLine(symbol, line, lineNo);
  }
}
