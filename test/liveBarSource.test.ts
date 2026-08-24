/**
 * Vérifie que LiveBarSource et LiveSeriesBuilder fonctionnent ensemble une
 * fois branchés — le seul lien entre les deux dans le code de production est
 * une annotation de type (createKrakenOhlcSource retourne un LiveBarSource),
 * rien ne les fait jamais tourner ensemble ailleurs. Ce test comble ce trou
 * en implémentant une source synthétique injectable qui rejoue une séquence
 * de barres prédéfinie, exactement comme prévu par la spec d'origine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ClosedBar, LiveBarSource } from '../src/live/liveBarSource.ts';
import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';

const SYMBOL = 'TESTEUR';

function bar(time: number, close: number): ClosedBar {
  return { symbol: SYMBOL, time, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

/**
 * Source synthétique implémentant LiveBarSource : rejoue de façon
 * synchrone une séquence de ClosedBar prédéfinie quand start() est appelé.
 */
function createSyntheticBarSource(sequence: readonly ClosedBar[]): LiveBarSource & { stopped: boolean } {
  const source = {
    stopped: false,
    start(onClosedBar: (bar: ClosedBar) => void): void {
      for (const b of sequence) {
        onClosedBar(b);
      }
    },
    stop(): void {
      source.stopped = true;
    },
  };
  return source;
}

test('LiveBarSource + LiveSeriesBuilder : une séquence de barres rejouée produit une BarSeries correcte', () => {
  const sequence = [bar(1000, 100), bar(15400, 110), bar(29800, 120), bar(44200, 130)];
  const source = createSyntheticBarSource(sequence);
  const builder = createLiveSeriesBuilder(SYMBOL, 240);

  source.start((b) => builder.append(b));

  const series = builder.current();
  assert.equal(series.length, sequence.length);
  assert.deepEqual(Array.from(series.time), [1000, 15400, 29800, 44200]);
  assert.deepEqual(Array.from(series.close), [100, 110, 120, 130]);
  assert.equal(series.symbol, SYMBOL);
  assert.equal(series.interval, 240);
});

test('LiveBarSource : stop() peut être appelé sans erreur (contrat minimal de l’interface)', () => {
  const source = createSyntheticBarSource([bar(1000, 100)]);
  assert.doesNotThrow(() => source.stop());
  assert.equal(source.stopped, true);
});
