/**
 * Construit une BarSeries croissante à partir de barres closes reçues au
 * fil de l'eau. Réutilise MutableColumns/freezeSeries (src/data/series.ts,
 * inchangés).
 *
 * Une bougie dont le timestamp n'est pas strictement supérieur à la
 * dernière déjà ajoutée est silencieusement ignorée plutôt qu'ajoutée —
 * observé en conditions réelles : l'amorçage REST (krakenRestSeed.ts) et
 * le snapshot WebSocket initial (krakenOhlcSource.ts) peuvent tous les
 * deux se référer à la même bougie « en cours » selon l'instant exact de
 * chacun des deux appels, produisant un doublon au premier message WS qui
 * fait ensuite réellement avancer l'intervalle. Même philosophie que le
 * « rejeu/doublon, ignoré » déjà en place dans processOhlcMessage — ce
 * n'est pas une anomalie à faire remonter, juste deux sources qui se
 * recoupent. Avaler ce cas ici, à l'ajout, évite de corrompre `columns`
 * de façon permanente (l'ancien comportement laissait passer la bougie
 * invalide, qui ne provoquait un échec qu'au prochain current() — et pour
 * toujours après, puisque rien ne retire jamais la ligne fautive).
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
      const lastTime = columns.time[columns.time.length - 1];
      if (lastTime !== undefined && bar.time <= lastTime) {
        console.error(
          `createLiveSeriesBuilder(${symbol}) : bougie ignorée (rejeu/doublon), ` +
            `timestamp ${bar.time} <= dernier connu ${lastTime}`,
        );
        return;
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
