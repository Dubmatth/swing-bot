/**
 * Convertit les fichiers "Time & Sales" Kraken (transactions brutes,
 * timestamp,price,volume) en bougies OHLCVT, dans le format attendu par
 * src/data/krakenCsv.ts.
 *
 * Usage :
 *   node --experimental-strip-types scripts/convert-trades.ts [dossierEntrée] [dossierSortie]
 *
 * Par défaut : ~/Downloads/TimeAndSales_Combined -> ./data/kraken-ohlcvt
 * Un fichier d'entrée par symbole (ex. XBTEUR.csv), sans en-tête.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { BarSeries, Interval } from '../src/data/series.ts';
import { aggregateTrades, readTradesFile } from '../src/data/aggregateTrades.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';

const INTERVALS: readonly Interval[] = [60, 240, 1440];

const inputDir = process.argv[2] ?? join(homedir(), 'Downloads', 'TimeAndSales_Combined');
const outputDir = process.argv[3] ?? join(process.cwd(), 'data', 'kraken-ohlcvt');

function toCsv(series: BarSeries): string {
  const lines: string[] = [];
  for (let i = 0; i < series.length; i++) {
    lines.push(
      `${series.time[i]},${series.open[i]},${series.high[i]},${series.low[i]},` +
        `${series.close[i]},${series.volume[i]},${series.trades[i]}`,
    );
  }
  return lines.join('\n') + '\n';
}

async function convertPair(symbol: string): Promise<void> {
  const inputPath = join(inputDir, `${symbol}.csv`);
  const start = Date.now();
  console.log(`[${symbol}] lecture de ${inputPath}...`);

  const trades = readTradesFile(symbol, inputPath);
  const series = await aggregateTrades(symbol, trades, INTERVALS);

  for (const interval of INTERVALS) {
    const bars = series.get(interval);
    if (bars === undefined) continue;
    const outputPath = join(outputDir, `${symbol}_${interval}.csv`);
    await writeFile(outputPath, toCsv(bars), 'utf8');
    console.log(`[${symbol}] ${bars.length} bougies (interval=${interval}) -> ${outputPath}`);
  }

  console.log(`[${symbol}] terminé en ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
  console.log(`Conversion de ${UNIVERSE_SYMBOLS.length} paires : ${inputDir} -> ${outputDir}`);
  for (const symbol of UNIVERSE_SYMBOLS) {
    await convertPair(symbol);
  }
  console.log('Terminé.');
}

await main();
