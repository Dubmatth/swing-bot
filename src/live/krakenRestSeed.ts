/**
 * Amorce liveSeriesBuilder avec les dernières bougies connues via l'API
 * REST Kraken (/0/public/OHLC, jusqu'à 720 points) au démarrage du runner
 * papier — le dump historique déjà téléchargé a plusieurs mois de retard,
 * inutilisable pour amorcer un flux temps réel sans discontinuité.
 */

import type { Interval } from '../data/series.ts';
import type { ClosedBar } from './liveBarSource.ts';

export interface KrakenRestSeedConfig {
  readonly restSymbol: string;
  readonly symbol: string;
  readonly interval: Interval;
  /** Nombre de bougies conservées (les plus récentes), <= 720. */
  readonly count: number;
  readonly restUrl?: string;
}

/** Logique pure : mappe les lignes brutes déjà parsées (JSON) en ClosedBar[]. */
export function parseRestOhlcResponse(
  symbol: string,
  rawRows: readonly unknown[],
): readonly ClosedBar[] {
  return rawRows.map((row, i) => {
    if (!Array.isArray(row) || row.length < 8) {
      throw new Error(`${symbol} ligne REST ${i} : forme inattendue`);
    }
    const time = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[6]);
    const trades = Number(row[7]);
    if (![time, open, high, low, close, volume, trades].every(Number.isFinite)) {
      throw new Error(`${symbol} ligne REST ${i} : champ numérique invalide`);
    }
    if (
      time <= 0 || open <= 0 || low <= 0 ||
      high < low || open > high || open < low || close > high || close < low
    ) {
      throw new Error(`${symbol} ligne REST ${i} : OHLC incohérent`);
    }
    return { symbol, time, open, high, low, close, volume, trades };
  });
}

/** Câblage réseau — non testé automatiquement, comme krakenOhlcSource.ts. */
export async function fetchSeedBars(config: KrakenRestSeedConfig): Promise<readonly ClosedBar[]> {
  const url = new URL(config.restUrl ?? 'https://api.kraken.com/0/public/OHLC');
  url.searchParams.set('pair', config.restSymbol);
  url.searchParams.set('interval', String(config.interval));

  const response = await fetch(url);
  const body = (await response.json()) as { error?: readonly string[]; result?: Record<string, unknown> };
  if (body.error !== undefined && body.error.length > 0) {
    throw new Error(`${config.symbol} : erreur API Kraken OHLC — ${body.error.join(', ')}`);
  }
  if (body.result === undefined) {
    throw new Error(`${config.symbol} : réponse OHLC sans champ result`);
  }
  const rowsKey = Object.keys(body.result).find((k) => k !== 'last');
  if (rowsKey === undefined) {
    throw new Error(`${config.symbol} : réponse OHLC sans clé de bougies reconnue`);
  }
  const rows = body.result[rowsKey];
  if (!Array.isArray(rows)) {
    throw new Error(`${config.symbol} : bougies OHLC de forme inattendue`);
  }
  const bars = parseRestOhlcResponse(config.symbol, rows);
  return bars.slice(-config.count);
}
