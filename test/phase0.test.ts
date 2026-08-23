/**
 * Tests de Phase 0. Chacun couvre un invariant dont la violation produirait
 * un backtest silencieusement faux plutôt qu'une erreur visible.
 *
 * Exécution : node --experimental-strip-types --test test/phase0.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { UNIVERSE, assertEurQuoted, validateUniverse } from '../src/config/universe.ts';
import { freezeSeries, emptyColumns, indexAtOrAfter } from '../src/data/series.ts';
import { fillGaps, assertGapsAcceptable } from '../src/data/gaps.ts';
import { parseKrakenCsv } from '../src/data/krakenCsv.ts';
import { BarView } from '../src/strategy/types.ts';
import { Ema, Sma, Atr, RollingStd } from '../src/strategy/indicators.ts';

const H = 3600;

function seriesFrom(times: number[], closes: number[], synthetic?: number[]) {
  const c = emptyColumns();
  times.forEach((t, i) => {
    c.time.push(t);
    c.open.push(closes[i]);
    c.high.push(closes[i]);
    c.low.push(closes[i]);
    c.close.push(closes[i]);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(synthetic ? synthetic[i] : 0);
  });
  return freezeSeries('TESTEUR', 60, c);
}

// ---------------------------------------------------------------------------
// Contrainte fiscale : paires EUR uniquement
// ---------------------------------------------------------------------------

test('univers : les 20 paires sont cotées en EUR', () => {
  assert.equal(UNIVERSE.length, 20);
  assert.doesNotThrow(() => assertEurQuoted(UNIVERSE));
});

test('univers : une paire crypto/crypto est rejetée', () => {
  assert.throws(
    () => assertEurQuoted([{ symbol: 'ETHXBT', label: 'ETH/BTC', sector: 'defi' }]),
    /fiscale/,
  );
});

test('univers : un symbole délisté fait échouer le démarrage', () => {
  const tradable = new Set(UNIVERSE.map((p) => p.symbol));
  tradable.delete('FILEUR');
  assert.throws(() => validateUniverse(UNIVERSE, tradable), /FIL\/EUR/);
});

// ---------------------------------------------------------------------------
// Anti-look-ahead
// ---------------------------------------------------------------------------

test('BarView : lire une barre future lève', () => {
  const s = seriesFrom([0, H, 2 * H], [10, 11, 12]);
  const v = new BarView(s, 1);
  assert.equal(v.close(0), 11);
  assert.equal(v.close(1), 10);
  assert.throws(() => v.close(-1), /Look-ahead/);
});

test('BarView : historique insuffisant lève au lieu de renvoyer undefined', () => {
  const s = seriesFrom([0, H, 2 * H], [10, 11, 12]);
  const v = new BarView(s, 0);
  assert.equal(v.length, 1);
  assert.throws(() => v.close(1), /Historique insuffisant/);
});

test('BarView : la barre finale n_est pas visible avant sa clôture', () => {
  const s = seriesFrom([0, H, 2 * H], [10, 11, 999]);
  const v = new BarView(s, 1);
  // 999 existe dans la série mais reste inatteignable — c'est tout l'enjeu.
  for (let ago = 0; ago < v.length; ago++) {
    assert.notEqual(v.close(ago), 999);
  }
});

// ---------------------------------------------------------------------------
// Trous
// ---------------------------------------------------------------------------

test('fillGaps : insère les barres manquantes et les marque', () => {
  const c = emptyColumns();
  for (const [t, p] of [[0, 100] as const, [3 * H, 130] as const]) {
    c.time.push(t);
    c.open.push(p);
    c.high.push(p);
    c.low.push(p);
    c.close.push(p);
    c.volume.push(5);
    c.trades.push(2);
    c.synthetic.push(0);
  }
  const { columns, report } = fillGaps('TESTEUR', c, 60);
  assert.equal(columns.time.length, 4);
  assert.equal(report.filled, 2);
  assert.deepEqual(columns.synthetic, [0, 1, 1, 0]);
  // Forward-fill du close précédent, volume nul.
  assert.equal(columns.close[1], 100);
  assert.equal(columns.volume[1], 0);
});

test('fillGaps : politique stricte échoue au lieu de combler', () => {
  const c = emptyColumns();
  for (const [t, p] of [[0, 100] as const, [3 * H, 130] as const]) {
    c.time.push(t);
    c.open.push(p);
    c.high.push(p);
    c.low.push(p);
    c.close.push(p);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  assert.throws(() => fillGaps('TESTEUR', c, 60, 'strict'), /Trou de 2/);
});

test('assertGapsAcceptable : un trou long est refusé', () => {
  assert.throws(
    () =>
      assertGapsAcceptable({
        symbol: 'ILLIQEUR',
        filled: 50,
        longestRun: 40,
        longestRunAt: [0, 40 * H],
        totalBars: 1000,
      }),
    /trou de 40 barres/,
  );
});

test('assertGapsAcceptable : trop de barres synthétiques est refusé', () => {
  assert.throws(
    () =>
      assertGapsAcceptable({
        symbol: 'ILLIQEUR',
        filled: 100,
        longestRun: 2,
        longestRunAt: [0, H],
        totalBars: 1000,
      }),
    /trop illiquide/,
  );
});

// ---------------------------------------------------------------------------
// Parseur CSV
// ---------------------------------------------------------------------------

test('parseKrakenCsv : parse le format OHLCVT', () => {
  const csv = '1700000000,37000.0,37500.0,36800.0,37200.0,150.5,320\n' +
    '1700003600,37200.0,37800.0,37100.0,37600.0,98.2,210\n';
  const c = parseKrakenCsv('XBTEUR', csv);
  assert.equal(c.time.length, 2);
  assert.equal(c.close[1], 37600);
  assert.equal(c.trades[0], 320);
});

test('parseKrakenCsv : un OHLC incohérent fait échouer le chargement', () => {
  // high < low : fichier corrompu ou colonnes décalées.
  const csv = '1700000000,37000.0,36000.0,36800.0,37200.0,150.5,320\n';
  assert.throws(() => parseKrakenCsv('XBTEUR', csv), /incohérent/);
});

test('parseKrakenCsv : filtre par fenêtre temporelle', () => {
  const csv = '1000,1,1,1,1,1,1\n2000,2,2,2,2,1,1\n3000,3,3,3,3,1,1\n';
  const c = parseKrakenCsv('XBTEUR', csv, 2000, 3000);
  assert.deepEqual(c.time, [2000]);
});

// ---------------------------------------------------------------------------
// Séries
// ---------------------------------------------------------------------------

test('freezeSeries : refuse des timestamps non croissants', () => {
  const c = emptyColumns();
  for (const t of [0, 2 * H, H]) {
    c.time.push(t);
    c.open.push(1);
    c.high.push(1);
    c.low.push(1);
    c.close.push(1);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  assert.throws(() => freezeSeries('TESTEUR', 60, c), /non strictement croissants/);
});

test('indexAtOrAfter : recherche binaire correcte', () => {
  const s = seriesFrom([0, H, 2 * H, 3 * H], [1, 2, 3, 4]);
  assert.equal(indexAtOrAfter(s, 0), 0);
  assert.equal(indexAtOrAfter(s, H + 1), 2);
  assert.equal(indexAtOrAfter(s, 99 * H), 4);
});

// ---------------------------------------------------------------------------
// Indicateurs
// ---------------------------------------------------------------------------

test('Sma : valeur exacte et NaN avant convergence', () => {
  const sma = new Sma(3);
  assert.ok(Number.isNaN(sma.update(1)));
  assert.ok(Number.isNaN(sma.update(2)));
  assert.equal(sma.update(3), 2);
  assert.equal(sma.update(6), (2 + 3 + 6) / 3);
});

test('Sma : le tampon circulaire reste exact sur longue série', () => {
  const sma = new Sma(50);
  const naive: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const x = Math.sin(i / 7) * 100 + 500;
    naive.push(x);
    sma.update(x);
  }
  const expected = naive.slice(-50).reduce((a, b) => a + b, 0) / 50;
  assert.ok(Math.abs(sma.value - expected) < 1e-9);
});

test('Ema : converge vers une constante', () => {
  const ema = new Ema(10);
  for (let i = 0; i < 500; i++) ema.update(42);
  assert.ok(Math.abs(ema.value - 42) < 1e-9);
});

test('Atr : sur barres régulières, vaut la hauteur de barre', () => {
  const atr = new Atr(14);
  for (let i = 0; i < 200; i++) atr.update(102, 98, 100);
  assert.ok(Math.abs(atr.value - 4) < 1e-6);
});

test('RollingStd : reste stable numériquement sur grandes valeurs', () => {
  const std = new RollingStd(20);
  for (let i = 0; i < 10000; i++) std.update(1e6 + (i % 2));
  assert.ok(std.value >= 0);
  assert.ok(Math.abs(std.value - 0.5) < 1e-3);
});

test('indicateurs : périodes invalides rejetées', () => {
  assert.throws(() => new Sma(0), RangeError);
  assert.throws(() => new Ema(1.5), RangeError);
  assert.throws(() => new RollingStd(1), RangeError);
});
