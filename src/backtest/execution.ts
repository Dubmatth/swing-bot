/**
 * Exécution simulée : frais Kraken + slippage constant.
 *
 * Seul `takerBps` est appliqué dans cette phase — tous les ordres sont au
 * marché (prochaine ouverture). `makerBps` est porté par le type dès
 * maintenant pour que le futur live-runner à ordres limites n'ait pas à
 * changer la forme de `FeeSchedule`.
 */

export interface FeeSchedule {
  readonly makerBps: number;
  readonly takerBps: number;
}

export const DEFAULT_FEES: FeeSchedule = { makerBps: 25, takerBps: 40 };

export interface ExecutionOptions {
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface Fill {
  readonly price: number;
  readonly quantity: number;
  readonly fee: number;
}

function slippagePrice(side: 'buy' | 'sell', referencePrice: number, slippageBps: number): number {
  const adj = slippageBps / 10_000;
  return side === 'buy' ? referencePrice * (1 + adj) : referencePrice * (1 - adj);
}

/**
 * Achat : engage tout le cash disponible. La quantité et le fee sont
 * résolus ensemble — pas l'inverse — pour que
 * `quantity * price + fee === cash` par construction. Calculer d'abord
 * `quantity = cash / price` puis ajouter le fee par-dessus dépenserait plus
 * que le cash disponible.
 */
export function simulateBuy(cash: number, referencePrice: number, opts: ExecutionOptions): Fill {
  if (!(cash > 0)) {
    throw new RangeError(`Cash insuffisant pour acheter : ${cash}`);
  }
  if (!(referencePrice > 0)) {
    throw new RangeError(`Prix de référence invalide : ${referencePrice}`);
  }
  const price = slippagePrice('buy', referencePrice, opts.slippageBps);
  const takerRate = opts.fees.takerBps / 10_000;
  const quantity = cash / (price * (1 + takerRate));
  const fee = quantity * price * takerRate;
  return { price, quantity, fee };
}

/** Vente : solde une quantité déjà détenue. */
export function simulateSell(quantity: number, referencePrice: number, opts: ExecutionOptions): Fill {
  if (!(quantity > 0)) {
    throw new RangeError(`Quantité invalide pour vendre : ${quantity}`);
  }
  if (!(referencePrice > 0)) {
    throw new RangeError(`Prix de référence invalide : ${referencePrice}`);
  }
  const price = slippagePrice('sell', referencePrice, opts.slippageBps);
  const fee = quantity * price * (opts.fees.takerBps / 10_000);
  return { price, quantity, fee };
}
