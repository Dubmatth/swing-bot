/**
 * Construit une BarSeries croissante à partir de barres closes reçues au
 * fil de l'eau. Réutilise MutableColumns/freezeSeries (src/data/series.ts,
 * inchangés) — l'invariant de timestamps strictement croissants est
 * revalidé gratuitement par freezeSeries à chaque appel de current().
 */

import type { BarSeries, Interval, MutableColumns } from '../data/series.ts';
import { emptyColumns, freezeSeries } from '../data/series.ts';
import type { ClosedBar } from './liveBarSource.ts';

export interface LiveSeriesBuilder {
  append(bar: ClosedBar): void;
  current(): BarSeries;
}

export function createLiveSeriesBuilder(symbol: string, interval: Interval): LiveSeriesBuilder {
  const columns: MutableColumns = emptyColumns();

  return {
    append(bar: ClosedBar): void {
      if (bar.symbol !== symbol) {
        throw new Error(`createLiveSeriesBuilder(${symbol}) : barre reçue pour ${bar.symbol}`);
      }
      columns.time.push(bar.time);
      columns.open.push(bar.open);
      columns.high.push(bar.high);
      columns.low.push(bar.low);
      columns.close.push(bar.close);
      columns.volume.push(bar.volume);
      columns.trades.push(bar.trades);
      columns.synthetic.push(0);
    },
    current(): BarSeries {
      if (columns.time.length === 0) {
        throw new Error(`createLiveSeriesBuilder(${symbol}) : aucune barre ajoutée`);
      }
      return freezeSeries(symbol, interval, columns);
    },
  };
}
