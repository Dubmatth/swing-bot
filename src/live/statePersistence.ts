/**
 * Persistance du portefeuille papier : snapshot JSON réécrit après chaque
 * fill, journal de trades JSONL append-only. Contrairement au réseau,
 * l'I/O sur disque local est déterministe — testée pour de vrai avec un
 * répertoire temporaire, pas laissée non testée par excès de prudence.
 */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Portfolio, Trade } from '../backtest/portfolio.ts';
import type { Position } from '../strategy/types.ts';

export interface PersistedPortfolio {
  readonly cash: number;
  readonly positions: readonly Position[];
}

export function serializePortfolio(p: Portfolio): PersistedPortfolio {
  return { cash: p.cash, positions: [...p.positions.values()] };
}

/**
 * Le journal de trades (JSONL) reste la trace d'audit complète sur disque ;
 * le `trades` en mémoire d'un portefeuille désérialisé repart vide — rien
 * dans la logique de décision ou d'exécution ne lit l'historique des
 * trades passés, seulement `cash`/`positions`.
 */
export function deserializePortfolio(data: PersistedPortfolio): Portfolio {
  const positions = new Map<string, Position>();
  for (const position of data.positions) {
    positions.set(position.symbol, position);
  }
  return { cash: data.cash, positions, trades: [] };
}

export async function savePortfolioSnapshot(path: string, p: Portfolio): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(serializePortfolio(p), null, 2), 'utf8');
}

export async function loadPortfolioSnapshot(path: string): Promise<Portfolio | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const data = JSON.parse(text) as PersistedPortfolio;
  return deserializePortfolio(data);
}

export async function appendTradeLog(path: string, trade: Trade): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(trade)}\n`, 'utf8');
}
