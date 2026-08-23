/**
 * Politique de comblement des trous.
 *
 * Les CSV OHLCVT de Kraken ne contiennent que les intervalles où des
 * transactions ont eu lieu. Une bougie absente signifie « zéro trade », pas
 * « donnée perdue ».
 *
 * Ce module est LE point de vérité unique. Le backtester et le live-runner
 * l'importent tous les deux. Une divergence ici est invisible et invalide
 * silencieusement l'intégralité du backtest — c'est la raison d'être de ce
 * fichier séparé plutôt que d'un booléen passé au chargeur.
 */

import type { MutableColumns } from './series.ts';

export type GapPolicy = 'forward-fill' | 'strict';

export const DEFAULT_GAP_POLICY: GapPolicy = 'forward-fill';

export interface GapReport {
  readonly symbol: string;
  /** Nombre de barres synthétiques insérées. */
  readonly filled: number;
  /** Plus longue série consécutive de barres manquantes. */
  readonly longestRun: number;
  /** Bornes du plus long trou, en secondes epoch. */
  readonly longestRunAt: readonly [number, number] | null;
  readonly totalBars: number;
}

/**
 * Insère les barres manquantes sur une grille régulière.
 *
 * Une barre synthétique reprend le close précédent pour open/high/low/close,
 * avec volume et trades à zéro, et `synthetic = 1`. Elle représente
 * fidèlement la réalité : le marché n'a pas bougé parce que personne n'a
 * traité. Ce qu'elle ne représente pas, c'est un prix auquel on aurait pu
 * s'exécuter — d'où le marqueur, que le moteur d'exécution doit respecter.
 */
export function fillGaps(
  symbol: string,
  sorted: MutableColumns,
  intervalMinutes: number,
  policy: GapPolicy = DEFAULT_GAP_POLICY,
): { columns: MutableColumns; report: GapReport } {
  const step = intervalMinutes * 60;
  const n = sorted.time.length;

  if (n === 0) {
    return {
      columns: sorted,
      report: {
        symbol,
        filled: 0,
        longestRun: 0,
        longestRunAt: null,
        totalBars: 0,
      },
    };
  }

  const out: MutableColumns = {
    time: [],
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    trades: [],
    synthetic: [],
  };

  let filled = 0;
  let longestRun = 0;
  let longestRunAt: [number, number] | null = null;

  const push = (i: number): void => {
    out.time.push(sorted.time[i]);
    out.open.push(sorted.open[i]);
    out.high.push(sorted.high[i]);
    out.low.push(sorted.low[i]);
    out.close.push(sorted.close[i]);
    out.volume.push(sorted.volume[i]);
    out.trades.push(sorted.trades[i]);
    out.synthetic.push(0);
  };

  push(0);

  for (let i = 1; i < n; i++) {
    const prevT = sorted.time[i - 1];
    const curT = sorted.time[i];
    const missing = Math.round((curT - prevT) / step) - 1;

    if (missing > 0) {
      if (policy === 'strict') {
        throw new Error(
          `Trou de ${missing} barre(s) sur ${symbol} entre ` +
            `${new Date(prevT * 1000).toISOString()} et ` +
            `${new Date(curT * 1000).toISOString()} (politique 'strict')`,
        );
      }
      if (missing > longestRun) {
        longestRun = missing;
        longestRunAt = [prevT + step, curT - step];
      }
      const lastClose = sorted.close[i - 1];
      for (let k = 1; k <= missing; k++) {
        out.time.push(prevT + k * step);
        out.open.push(lastClose);
        out.high.push(lastClose);
        out.low.push(lastClose);
        out.close.push(lastClose);
        out.volume.push(0);
        out.trades.push(0);
        out.synthetic.push(1);
        filled++;
      }
    }
    push(i);
  }

  return {
    columns: out,
    report: {
      symbol,
      filled,
      longestRun,
      longestRunAt,
      totalBars: out.time.length,
    },
  };
}

/**
 * Un trou long signale un problème réel : délistage temporaire, incident
 * d'exchange, ou paire trop illiquide pour l'univers. Combler 200 barres
 * consécutives par forward-fill produit une ligne plate parfaite qu'une
 * stratégie de momentum interprétera comme une absence de volatilité —
 * et sur laquelle elle prendra des décisions.
 */
export function assertGapsAcceptable(
  report: GapReport,
  maxRun = 12,
  maxFilledRatio = 0.02,
): void {
  if (report.longestRun > maxRun) {
    const at = report.longestRunAt
      ? ` autour de ${new Date(report.longestRunAt[0] * 1000).toISOString()}`
      : '';
    throw new Error(
      `${report.symbol} : trou de ${report.longestRun} barres${at} ` +
        `(max toléré ${maxRun}). Vérifier la paire ou l'exclure de l'univers.`,
    );
  }
  const ratio = report.totalBars > 0 ? report.filled / report.totalBars : 0;
  if (ratio > maxFilledRatio) {
    throw new Error(
      `${report.symbol} : ${(ratio * 100).toFixed(1)} % de barres synthétiques ` +
        `(max toléré ${(maxFilledRatio * 100).toFixed(1)} %). Paire trop illiquide.`,
    );
  }
}
