/**
 * Comptabilité du backtest. Seul endroit du système où la mutation est
 * légitime — le contrat `Strategy.decide` (src/strategy/types.ts) interdit
 * toute mutation, y compris interne à la stratégie.
 */

import type { Position } from '../strategy/types.ts';
import type { Fill } from './execution.ts';

export interface Trade {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly price: number;
  readonly fee: number;
  /** Timestamp d'exécution, en secondes epoch (pas un index de barre). */
  readonly time: number;
}

export interface Portfolio {
  cash: number;
  readonly positions: Map<string, Position>;
  readonly trades: Trade[];
}

export function createPortfolio(initialCash: number): Portfolio {
  if (!(initialCash > 0)) {
    throw new RangeError(`Cash initial invalide : ${initialCash}`);
  }
  return { cash: initialCash, positions: new Map(), trades: [] };
}

export function applyBuyFill(p: Portfolio, symbol: string, fill: Fill, time: number): void {
  if (p.positions.has(symbol)) {
    throw new Error(`Position déjà ouverte sur ${symbol}, achat refusé`);
  }
  const cost = fill.quantity * fill.price + fill.fee;
  if (!(cost <= p.cash + 1e-6)) {
    throw new Error(
      `Fill d'achat dépasse le cash disponible sur ${symbol} : coût ${cost}, cash ${p.cash}`,
    );
  }
  p.cash -= cost;
  p.positions.set(symbol, {
    symbol,
    side: 'long',
    quantity: fill.quantity,
    entryPrice: fill.price,
    entryTime: time,
  });
  p.trades.push({
    symbol,
    side: 'buy',
    quantity: fill.quantity,
    price: fill.price,
    fee: fill.fee,
    time,
  });
}

export function applySellFill(p: Portfolio, symbol: string, fill: Fill, time: number): void {
  if (!p.positions.has(symbol)) {
    throw new Error(`Aucune position ouverte sur ${symbol}, vente refusée`);
  }
  p.cash += fill.quantity * fill.price - fill.fee;
  p.positions.delete(symbol);
  p.trades.push({
    symbol,
    side: 'sell',
    quantity: fill.quantity,
    price: fill.price,
    fee: fill.fee,
    time,
  });
}

/**
 * Équité totale marquée au marché : cash + valeur de marché de chaque
 * position ouverte. Lève si un prix de marque manque pour une position
 * ouverte — ne devrait jamais arriver étant donné l'alignement temporel
 * imposé par le runner sur toutes les séries.
 */
export function portfolioEquity(p: Portfolio, markPrices: ReadonlyMap<string, number>): number {
  let equity = p.cash;
  for (const position of p.positions.values()) {
    const markPrice = markPrices.get(position.symbol);
    if (markPrice === undefined) {
      throw new Error(`Prix de marque manquant pour la position ouverte sur ${position.symbol}`);
    }
    equity += position.quantity * markPrice;
  }
  return equity;
}
