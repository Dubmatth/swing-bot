/**
 * Affiche un résumé de l'état du runner de trading papier depuis les
 * fichiers déjà persistés (data/live-state/) — lecture seule, aucun accès
 * réseau, aucune modification d'état.
 *
 * Usage : node --experimental-strip-types scripts/status.ts
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPortfolioSnapshot } from '../src/live/statePersistence.ts';
import type { Trade } from '../src/backtest/portfolio.ts';

const STATE_DIR = join(process.cwd(), 'data', 'live-state');
const PORTFOLIO_PATH = join(STATE_DIR, 'portfolio.json');
const TRADES_PATH = join(STATE_DIR, 'trades.jsonl');
const RECENT_TRADES_COUNT = 10;

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

async function loadTradeLog(): Promise<readonly Trade[]> {
  let text: string;
  try {
    text = await readFile(TRADES_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Trade);
}

async function main(): Promise<void> {
  const portfolio = await loadPortfolioSnapshot(PORTFOLIO_PATH);

  if (!portfolio) {
    console.log("Aucun état persisté trouvé — le runner n'a encore effectué aucun trade.");
    console.log(`(recherché dans ${PORTFOLIO_PATH})`);
    return;
  }

  console.log('=== Portefeuille papier ===');
  console.log(`Cash disponible   : ${portfolio.cash.toFixed(2)} €`);
  console.log(`Positions ouvertes: ${portfolio.positions.size}`);

  if (portfolio.positions.size > 0) {
    console.log();
    for (const position of portfolio.positions.values()) {
      const valeurEntree = position.quantity * position.entryPrice;
      console.log(
        `  ${position.symbol.padEnd(10)} qty=${position.quantity.toFixed(6).padStart(14)} ` +
          `prix d'entrée=${position.entryPrice.toFixed(4).padStart(10)} ` +
          `valeur(entrée)=${valeurEntree.toFixed(2).padStart(10)} € ` +
          `depuis ${formatDate(position.entryTime)}`,
      );
    }
  }

  const trades = await loadTradeLog();
  console.log();
  console.log(`=== Journal des trades (${trades.length} au total) ===`);

  if (trades.length === 0) {
    console.log('Aucun trade effectué pour le moment.');
  } else {
    const recent = trades.slice(-RECENT_TRADES_COUNT);
    console.log(`Les ${recent.length} plus récent(s) :`);
    for (const trade of recent) {
      console.log(
        `  ${formatDate(trade.time)}  ${trade.side.padEnd(4)} ${trade.symbol.padEnd(10)} ` +
          `qty=${trade.quantity.toFixed(6).padStart(14)} prix=${trade.price.toFixed(4).padStart(10)} ` +
          `frais=${trade.fee.toFixed(4)} €`,
      );
    }
    const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);
    console.log();
    console.log(`Frais cumulés (tous trades) : ${totalFees.toFixed(2)} €`);
  }

  console.log();
  console.log(
    "Note : la valeur des positions ouvertes est indiquée au prix d'entrée, " +
      'pas au prix de marché actuel — ce script ne se connecte à aucun réseau.',
  );
}

await main();
