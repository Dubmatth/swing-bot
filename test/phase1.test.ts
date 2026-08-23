/**
 * Critère de sortie de la Phase 1 (voir README) : un croisement de
 * moyennes mobiles tourne de bout en bout à travers le moteur de backtest
 * et perd de l'argent après frais.
 *
 * Marché synthétique sans drift net (oscillation autour d'un niveau
 * constant) : le gain brut cumulé sur un cycle complet est proche de zéro
 * quel que soit le nombre d'allers-retours, alors que chaque aller-retour
 * coûte des frais + slippage. La comparaison frictionless vs avec frais
 * prouve que c'est bien le coût de transaction qui creuse la perte, pas un
 * marché simplement défavorable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400; // barres de 240 minutes, en secondes

function oscillatingSeries(bars: number, base: number, amplitude: number, cycleLen: number): BarSeries {
  const c = emptyColumns();
  for (let i = 0; i < bars; i++) {
    const close = base + amplitude * Math.sin((2 * Math.PI * i) / cycleLen);
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(SYMBOL, 240, c);
}

test("Phase 1 — critère de sortie : un croisement de moyennes mobiles perd de l'argent après frais", () => {
  const series = oscillatingSeries(100, 100, 2, 10);
  const strategy = createMaCrossover({ symbol: SYMBOL, fast: 3, slow: 7 });
  const initialCash = 1000;

  const withFees = runBacktest(series, strategy, {
    initialCash,
    fees: DEFAULT_FEES,
    slippageBps: 5,
  });

  assert.ok(
    withFees.portfolio.trades.length > 1,
    `attendu plusieurs trades, obtenu ${withFees.portfolio.trades.length}`,
  );

  const finalMarkPrice = series.close[series.length - 1]!;
  const finalEquityWithFees =
    withFees.portfolio.cash +
    (withFees.portfolio.positions.get(SYMBOL)?.quantity ?? 0) * finalMarkPrice;

  assert.ok(
    finalEquityWithFees < initialCash,
    `attendu une perte nette après frais, équité finale ${finalEquityWithFees} vs cash initial ${initialCash}`,
  );

  const frictionless = runBacktest(series, strategy, {
    initialCash,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
  });
  const finalEquityFrictionless =
    frictionless.portfolio.cash +
    (frictionless.portfolio.positions.get(SYMBOL)?.quantity ?? 0) * finalMarkPrice;

  assert.ok(
    finalEquityFrictionless > finalEquityWithFees,
    `attendu un résultat frictionless meilleur (${finalEquityFrictionless}) que celui avec frais (${finalEquityWithFees})`,
  );
});
