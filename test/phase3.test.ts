/**
 * Critère de sortie de la Phase 3 (voir README) : le sizing par risque ATR
 * normalise l'exposition entre paires de volatilité différente, sans
 * jamais dépasser le plafond fraction fixe déjà prouvé par
 * test/phase2.test.ts.
 *
 * Deux paires synthétiques, même niveau de prix et mêmes croisements
 * garantis simultanés (même construction que test/phase2.test.ts), mais
 * amplitude de bougie différente : LOWVOL a un ATR petit, HIGHVOL un ATR
 * grand. Pour un risque égal (riskPerTradePct fixe), un stopDistance plus
 * petit sur LOWVOL implique une quantité plus grande — exactement la
 * motivation d'origine du commentaire de la classe Atr dans
 * src/strategy/indicators.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createAtrRiskCrossover } from '../src/strategy/atrRiskCrossover.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const STEP = 14_400;

/**
 * Bougies dont le corps oscille avec une amplitude donnée (signal de
 * croisement, identique sur les deux paires), mais dont le high/low
 * s'écarte du corps d'un facteur `volatility` — c'est ce qui fait varier
 * l'ATR entre les deux paires sans changer le signal de croisement.
 */
function volatileSeries(
  symbol: string,
  bars: number,
  base: number,
  amplitude: number,
  cycleLen: number,
  volatility: number,
): BarSeries {
  const c = emptyColumns();
  for (let i = 0; i < bars; i++) {
    const close = base + amplitude * Math.sin((2 * Math.PI * i) / cycleLen);
    const spread = volatility;
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close + spread);
    c.low.push(close - spread);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(symbol, 240, c);
}

test("Phase 3 — critère de sortie : le sizing par risque normalise l'exposition entre paires de volatilité différente", () => {
  const lowVolSeries = volatileSeries('LOWVOL', 200, 100, 2, 20, 2);
  const highVolSeries = volatileSeries('HIGHVOL', 200, 100, 2, 20, 10);
  const series = new Map([
    ['LOWVOL', lowVolSeries],
    ['HIGHVOL', highVolSeries],
  ]);

  const params = { fast: 3, slow: 7, atrPeriod: 5, atrMultiplier: 2 };
  const strategy = combineStrategies([
    createAtrRiskCrossover({ symbol: 'LOWVOL', ...params }),
    createAtrRiskCrossover({ symbol: 'HIGHVOL', ...params }),
  ]);

  const maxConcurrentPositions = 5; // large : le plafond de concurrence n'est pas le facteur limitant ici
  const result = runBacktest(series, strategy, {
    initialCash: 1000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions,
    riskPerTradePct: 0.01,
  });

  const lowVolTrade = result.portfolio.trades.find((t) => t.symbol === 'LOWVOL' && t.side === 'buy');
  const highVolTrade = result.portfolio.trades.find((t) => t.symbol === 'HIGHVOL' && t.side === 'buy');
  assert.ok(lowVolTrade, 'attendu un achat sur LOWVOL');
  assert.ok(highVolTrade, 'attendu un achat sur HIGHVOL');

  const lowVolNotional = lowVolTrade!.quantity * lowVolTrade!.price;
  const highVolNotional = highVolTrade!.quantity * highVolTrade!.price;
  assert.ok(
    lowVolNotional > highVolNotional,
    `attendu un notional plus grand sur LOWVOL (${lowVolNotional}) que sur HIGHVOL (${highVolNotional})`,
  );

  // Aucun des deux trades ne dépasse jamais le plafond fraction fixe —
  // l'invariant de la Phase 2 reste garanti même avec le sizing par risque.
  const fixedFractionCap = 1000 / maxConcurrentPositions;
  assert.ok(
    lowVolNotional <= fixedFractionCap + 1e-6,
    `LOWVOL (${lowVolNotional}) dépasse le plafond fraction fixe (${fixedFractionCap})`,
  );
  assert.ok(
    highVolNotional <= fixedFractionCap + 1e-6,
    `HIGHVOL (${highVolNotional}) dépasse le plafond fraction fixe (${fixedFractionCap})`,
  );
});
