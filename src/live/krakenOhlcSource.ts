/**
 * Client WebSocket Kraken (canal OHLC, WS v2). La logique de détection de
 * clôture de bougie (processOhlcMessage) et de validation des trames
 * (isValidOhlcEntry) sont des fonctions pures, testées exhaustivement sans
 * réseau. Le câblage autour (connexion, abonnement,
 * parsing JSON, reconnexion) n'est PAS testé par npm test — vérifié
 * manuellement en le faisant tourner, seule pièce du projet dans ce cas.
 *
 * Kraken WS v2 n'a pas de flag « bougie fermée » : la bougie en cours se
 * met à jour en place (même interval_begin) jusqu'à ce qu'un nouvel
 * interval_begin apparaisse pour ce symbole — c'est ce changement qui
 * signe la clôture de la précédente.
 */

import type { Interval } from '../data/series.ts';
import type { ClosedBar, LiveBarSource } from './liveBarSource.ts';

export interface KrakenOhlcSourceConfig {
  /** Symbole au format Kraken WS v2 (ex. 'BTC/EUR'). */
  readonly wsSymbol: string;
  /** Symbole interne du projet (ex. 'XBTEUR'), utilisé dans ClosedBar.symbol. */
  readonly symbol: string;
  readonly interval: Interval;
  readonly wsUrl?: string;
}

export interface OhlcMessage {
  readonly symbol: string;
  /** interval_begin déjà converti en secondes epoch. */
  readonly intervalBegin: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number;
}

interface TrackedBar {
  readonly intervalBegin: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number;
}

/**
 * Logique pure de détection de clôture — testable sans réseau. Maintient
 * un état par symbole (dernière bougie en cours) et renvoie la barre
 * précédente comme close dès qu'un nouvel interval_begin apparaît pour ce
 * symbole. Ne mute que `tracked`, aucune I/O.
 */
export function processOhlcMessage(
  tracked: Map<string, TrackedBar>,
  msg: OhlcMessage,
): ClosedBar | null {
  const current = tracked.get(msg.symbol);

  if (current === undefined || msg.intervalBegin === current.intervalBegin) {
    tracked.set(msg.symbol, {
      intervalBegin: msg.intervalBegin,
      open: msg.open,
      high: msg.high,
      low: msg.low,
      close: msg.close,
      volume: msg.volume,
      trades: msg.trades,
    });
    return null;
  }

  if (msg.intervalBegin < current.intervalBegin) {
    return null; // rejeu / doublon après reconnexion
  }

  const closed: ClosedBar = {
    symbol: msg.symbol,
    time: current.intervalBegin,
    open: current.open,
    high: current.high,
    low: current.low,
    close: current.close,
    volume: current.volume,
    trades: current.trades,
  };
  tracked.set(msg.symbol, {
    intervalBegin: msg.intervalBegin,
    open: msg.open,
    high: msg.high,
    low: msg.low,
    close: msg.close,
    volume: msg.volume,
    trades: msg.trades,
  });
  return closed;
}

const DEFAULT_WS_URL = 'wss://ws.kraken.com/v2';
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function parseIntervalBeginToEpochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Valide une entrée OHLC brute reçue du réseau, une fois les types primitifs
 * déjà vérifiés — fonction pure, testable sans réseau. `intervalBegin` doit
 * être une date valide déjà convertie en secondes epoch (un interval_begin
 * syntaxiquement une string mais représentant une date invalide donne NaN
 * via parseIntervalBeginToEpochSeconds, ce qui déjoue silencieusement les
 * comparaisons de processOhlcMessage — voir revue de branche). Les garde-fous
 * de cohérence OHLC reprennent le style de src/data/krakenCsv.ts, adaptés au
 * contexte réseau : une trame invalide est ignorée, jamais levée.
 */
export function isValidOhlcEntry(
  intervalBegin: number,
  open: number,
  high: number,
  low: number,
  close: number,
): boolean {
  if (!Number.isFinite(intervalBegin) || intervalBegin <= 0) return false;
  if (high < low || open > high || open < low || close > high || close < low) return false;
  if (open <= 0 || low <= 0) return false;
  return true;
}

export function createKrakenOhlcSource(config: KrakenOhlcSourceConfig): LiveBarSource {
  const tracked = new Map<string, TrackedBar>();
  let ws: WebSocket | undefined;
  let stopped = false;
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  let onClosedBar: ((bar: ClosedBar) => void) | undefined;

  function connect(): void {
    if (stopped) return;
    const url = config.wsUrl ?? DEFAULT_WS_URL;
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          method: 'subscribe',
          params: {
            channel: 'ohlc',
            symbol: [config.wsSymbol],
            interval: config.interval,
            snapshot: true,
          },
        }),
      );
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // message non-JSON (heartbeat, etc.) — ignoré
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { channel?: unknown }).channel !== 'ohlc' ||
        !('data' in parsed)
      ) {
        return;
      }
      const data = (parsed as { data: unknown }).data;
      if (!Array.isArray(data)) return;

      for (const entry of data) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (
          typeof e.interval_begin !== 'string' ||
          typeof e.open !== 'number' ||
          typeof e.high !== 'number' ||
          typeof e.low !== 'number' ||
          typeof e.close !== 'number' ||
          typeof e.volume !== 'number' ||
          typeof e.trades !== 'number'
        ) {
          continue;
        }

        const intervalBegin = parseIntervalBeginToEpochSeconds(e.interval_begin);
        if (!isValidOhlcEntry(intervalBegin, e.open, e.high, e.low, e.close)) {
          console.error(
            `KrakenOhlcSource(${config.symbol}) : trame OHLC invalide, ignorée`,
          );
          continue;
        }

        const message: OhlcMessage = {
          symbol: config.symbol,
          intervalBegin,
          open: e.open,
          high: e.high,
          low: e.low,
          close: e.close,
          volume: e.volume,
          trades: e.trades,
        };
        // Le backoff de reconnexion n'est réinitialisé qu'ici, pas dans le
        // handler `open` : un serveur qui accepte la connexion puis la ferme
        // aussitôt (rate limiting, abonnement rejeté) ne doit pas repartir à
        // 1s indéfiniment. Recevoir un message OHLC exploitable est la seule
        // preuve que l'abonnement fonctionne réellement.
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
        const closed = processOhlcMessage(tracked, message);
        if (closed && onClosedBar) {
          try {
            onClosedBar(closed);
          } catch (err) {
            console.error(
              `KrakenOhlcSource(${config.symbol}) : erreur dans le callback onClosedBar`,
              err,
            );
          }
        }
      }
    });

    socket.addEventListener('close', () => {
      if (stopped) return;
      console.error(
        `KrakenOhlcSource(${config.symbol}) : connexion fermée, reconnexion dans ${reconnectDelay}ms`,
      );
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    });

    socket.addEventListener('error', (event: Event) => {
      console.error(`KrakenOhlcSource(${config.symbol}) : erreur WebSocket`, event);
    });
  }

  return {
    start(callback: (bar: ClosedBar) => void): void {
      onClosedBar = callback;
      connect();
    },
    stop(): void {
      stopped = true;
      ws?.close();
    },
  };
}
