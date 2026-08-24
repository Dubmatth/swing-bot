/**
 * Critère de sortie de la Phase 1 (voir README) : un croisement de
 * moyennes mobiles tourne de bout en bout à travers le moteur de backtest
 * et perd de l'argent après frais.
 *
 * Marché synthétique sans drift net (oscillation autour d'un niveau
 * constant) : le croisement de moyennes garde un léger edge brut (mesuré,
 * frictionless : +1,06 % sur ce jeu de paramètres) dû au retard structurel
 * du signal sur un sinus lisse — l'edge n'est pas nul, mais l'amplitude et
 * la longueur de cycle du marché sont calibrées pour qu'il reste plus petit
 * que le coût d'un aller-retour (frais + slippage, ~90 bps). La comparaison
 * frictionless vs avec frais prouve que c'est bien ce coût de transaction
 * qui fait basculer un edge brut faiblement positif en perte nette, pas un
 * marché simplement défavorable. L'assertion sur l'équité frictionless
 * ci-dessous garde cette propriété (edge petit) vérifiée mécaniquement.
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
  const series = oscillatingSeries(200, 100, 0.2, 20);
  const strategy = createMaCrossover({ symbol: SYMBOL, fast: 3, slow: 7 });
  const initialCash = 1000;

  const seriesMap = new Map([[SYMBOL, series]]);
  const withFees = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: 1,
    riskPerTradePct: 1,
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

  const frictionless = runBacktest(seriesMap, strategy, {
    initialCash,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
    maxConcurrentPositions: 1,
    riskPerTradePct: 1,
  });
  const finalEquityFrictionless =
    frictionless.portfolio.cash +
    (frictionless.portfolio.positions.get(SYMBOL)?.quantity ?? 0) * finalMarkPrice;

  assert.ok(
    finalEquityFrictionless > finalEquityWithFees,
    `attendu un résultat frictionless meilleur (${finalEquityFrictionless}) que celui avec frais (${finalEquityWithFees})`,
  );

  // Garde-fou : l'edge brut (sans frais) doit rester petit — c'est cette
  // propriété du marché synthétique qui permet aux frais de faire basculer
  // la stratégie en perte nette. Si ce marché est retuné au point que
  // l'edge frictionless devient large, ce test doit échouer plutôt que de
  // laisser le docstring ci-dessus redevenir silencieusement faux.
  assert.ok(
    Math.abs(finalEquityFrictionless - initialCash) < 0.05 * initialCash,
    `attendu un edge brut frictionless petit (proche de l'équité initiale ${initialCash}), obtenu ${finalEquityFrictionless}`,
  );
});
