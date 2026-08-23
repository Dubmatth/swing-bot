/**
 * Chargeur des CSV OHLCVT téléchargeables de Kraken.
 *
 * Source : le ZIP « Downloadable historical OHLCVT data » du support Kraken,
 * qui couvre tout l'historique de chaque paire. L'endpoint REST /0/public/OHLC
 * ne renvoie que 720 points et ne sert qu'à l'amorçage temps réel.
 *
 * Format attendu (sans en-tête) :
 *   timestamp,open,high,low,close,volume,trades
 * Nom de fichier : <SYMBOL>_<INTERVAL>.csv  (ex. XBTEUR_240.csv)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BarSeries, Interval, MutableColumns } from './series.ts';
import { emptyColumns, freezeSeries } from './series.ts';
import type { GapPolicy, GapReport } from './gaps.ts';
import { DEFAULT_GAP_POLICY, assertGapsAcceptable, fillGaps } from './gaps.ts';

export interface LoadOptions {
  readonly dir: string;
  readonly interval: Interval;
  readonly gapPolicy?: GapPolicy;
  /** Bornes optionnelles, en secondes epoch. */
  readonly from?: number;
  readonly to?: number;
  /** Applique les garde-fous de qualité (§ assertGapsAcceptable). */
  readonly enforceQuality?: boolean;
}

export interface LoadResult {
  readonly series: BarSeries;
  readonly report: GapReport;
}

/** Parseur strict : toute ligne malformée fait échouer le chargement. */
export function parseKrakenCsv(
  symbol: string,
  text: string,
  from?: number,
  to?: number,
): MutableColumns {
  const cols = emptyColumns();
  let lineNo = 0;

  for (const rawLine of text.split('\n')) {
    lineNo++;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const parts = line.split(',');
    if (parts.length < 6) {
      throw new Error(
        `${symbol} ligne ${lineNo} : ${parts.length} champs, attendu >= 6`,
      );
    }

    const t = Number(parts[0]);
    if (!Number.isFinite(t) || t <= 0) {
      throw new Error(`${symbol} ligne ${lineNo} : timestamp invalide '${parts[0]}'`);
    }
    if (from !== undefined && t < from) continue;
    if (to !== undefined && t >= to) continue;

    const o = Number(parts[1]);
    const h = Number(parts[2]);
    const l = Number(parts[3]);
    const c = Number(parts[4]);
    const v = Number(parts[5]);
    const n = parts.length > 6 ? Number(parts[6]) : 0;

    if (![o, h, l, c, v, n].every(Number.isFinite)) {
      throw new Error(`${symbol} ligne ${lineNo} : champ numérique invalide`);
    }
    // Un OHLC incohérent signale un fichier corrompu ou mal aligné. Mieux
    // vaut échouer maintenant qu'obtenir un backtest subtilement faux.
    if (h < l || o > h || o < l || c > h || c < l) {
      throw new Error(
        `${symbol} ligne ${lineNo} : OHLC incohérent (o=${o} h=${h} l=${l} c=${c})`,
      );
    }
    if (o <= 0 || l <= 0) {
      throw new Error(`${symbol} ligne ${lineNo} : prix nul ou négatif`);
    }

    cols.time.push(t);
    cols.open.push(o);
    cols.high.push(h);
    cols.low.push(l);
    cols.close.push(c);
    cols.volume.push(v);
    cols.trades.push(n);
    cols.synthetic.push(0);
  }

  return cols;
}

export async function loadPair(
  symbol: string,
  opts: LoadOptions,
): Promise<LoadResult> {
  const path = join(opts.dir, `${symbol}_${opts.interval}.csv`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `CSV introuvable : ${path}. Télécharger l'archive OHLCVT depuis le ` +
        `support Kraken et extraire les fichiers _${opts.interval}.csv.`,
    );
  }

  const parsed = parseKrakenCsv(symbol, text, opts.from, opts.to);
  if (parsed.time.length === 0) {
    throw new Error(`${symbol} : aucune barre dans la fenêtre demandée`);
  }

  const { columns, report } = fillGaps(
    symbol,
    parsed,
    opts.interval,
    opts.gapPolicy ?? DEFAULT_GAP_POLICY,
  );

  if (opts.enforceQuality !== false) {
    assertGapsAcceptable(report);
  }

  return { series: freezeSeries(symbol, opts.interval, columns), report };
}

/**
 * Charge l'univers complet et aligne toutes les paires sur une grille
 * temporelle commune.
 *
 * L'alignement n'est pas cosmétique : le test cross-sectionnel exige que la
 * barre d'index t désigne le même instant sur les 20 paires. Sans ça, une
 * stratégie qui compare des actifs entre eux compare des moments différents.
 * On retient l'intersection — la date de début est celle de la paire la plus
 * récemment listée.
 */
export async function loadUniverse(
  symbols: readonly string[],
  opts: LoadOptions,
): Promise<{
  readonly series: ReadonlyMap<string, BarSeries>;
  readonly reports: readonly GapReport[];
  readonly commonStart: number;
  readonly commonEnd: number;
}> {
  const loaded = await Promise.all(
    symbols.map(async (s) => [s, await loadPair(s, opts)] as const),
  );

  const commonStart = Math.max(...loaded.map(([, r]) => r.series.time[0]));
  const commonEnd = Math.min(
    ...loaded.map(([, r]) => r.series.time[r.series.length - 1]),
  );

  if (commonStart >= commonEnd) {
    throw new Error(
      `Aucune fenêtre commune aux ${symbols.length} paires. ` +
        `Retirer les listings les plus récents de l'univers.`,
    );
  }

  const step = opts.interval * 60;
  const expected = Math.round((commonEnd - commonStart) / step) + 1;

  const series = new Map<string, BarSeries>();
  for (const [sym, r] of loaded) {
    const start = Math.round((commonStart - r.series.time[0]) / step);
    const end = start + expected;
    series.set(sym, sliceAligned(r.series, start, end, sym));
  }

  return {
    series,
    reports: loaded.map(([, r]) => r.report),
    commonStart,
    commonEnd,
  };
}

function sliceAligned(
  s: BarSeries,
  from: number,
  to: number,
  symbol: string,
): BarSeries {
  if (from < 0 || to > s.length) {
    throw new Error(
      `${symbol} : alignement hors bornes [${from}, ${to}) sur ${s.length} barres. ` +
        `Grille temporelle incohérente — vérifier la politique de trous.`,
    );
  }
  return {
    ...s,
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
