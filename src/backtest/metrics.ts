/**
 * Métriques de performance calculées depuis la courbe d'équité d'un
 * backtest. Rendement total pour l'instant — Sharpe/drawdown ajoutables
 * plus tard sans retoucher le reste, equityCurve les rend triviaux.
 */

import type { EquityPoint } from './runner.ts';

export function totalReturn(equityCurve: readonly EquityPoint[], initialCash: number): number {
  if (!(initialCash > 0)) {
    throw new RangeError(`totalReturn : initialCash invalide : ${initialCash}`);
  }
  if (equityCurve.length === 0) {
    throw new Error('totalReturn : equityCurve vide');
  }
  const finalEquity = equityCurve[equityCurve.length - 1]!.equity;
  return (finalEquity - initialCash) / initialCash;
}
