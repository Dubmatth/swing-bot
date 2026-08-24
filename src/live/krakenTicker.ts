/**
 * Récupère le dernier prix négocié pour un ensemble de paires via l'API
 * REST publique Kraken (/0/public/Ticker) — utilisé par le tableau de
 * bord pour afficher la valeur actuelle des positions ouvertes. Même
 * schéma que krakenRestSeed.ts : logique de parsing pure testée, câblage
 * réseau non testé.
 */

import type { KrakenPairMapping } from './krakenAssetPairs.ts';

export interface KrakenTickerConfig {
  /** Paires pour lesquelles récupérer un prix (mapping déjà résolu). */
  readonly mappings: readonly KrakenPairMapping[];
  readonly restUrl?: string;
}

/**
 * Logique pure : mappe la réponse JSON déjà parsée sur le mapping fourni.
 * Une entrée absente, malformée, ou dont le prix n'est pas fini/positif
 * est ignorée plutôt que de faire échouer tout l'appel — un prix
 * manquant pour une paire ne doit jamais empêcher d'afficher les autres.
 */
export function parseTickerResponse(
  mappings: readonly KrakenPairMapping[],
  rawResult: Record<string, unknown>,
): ReadonlyMap<string, number> {
  const symbolByRestSymbol = new Map(mappings.map((m) => [m.restSymbol, m.symbol]));
  const prices = new Map<string, number>();

  for (const [key, value] of Object.entries(rawResult)) {
    const symbol = symbolByRestSymbol.get(key);
    if (symbol === undefined) continue;
    if (typeof value !== 'object' || value === null) continue;

    const c = (value as Record<string, unknown>).c;
    if (!Array.isArray(c) || typeof c[0] !== 'string') continue;

    const price = Number(c[0]);
    if (!Number.isFinite(price) || price <= 0) continue;

    prices.set(symbol, price);
  }

  return prices;
}

/** Câblage réseau — non testé automatiquement, comme krakenRestSeed.ts. */
export async function fetchTickerPrices(
  config: KrakenTickerConfig,
): Promise<ReadonlyMap<string, number>> {
  if (config.mappings.length === 0) return new Map();

  const url = new URL(config.restUrl ?? 'https://api.kraken.com/0/public/Ticker');
  url.searchParams.set('pair', config.mappings.map((m) => m.restSymbol).join(','));

  const response = await fetch(url);
  const body = (await response.json()) as { error?: readonly string[]; result?: Record<string, unknown> };
  if (body.error !== undefined && body.error.length > 0) {
    throw new Error(`Ticker : erreur API Kraken — ${body.error.join(', ')}`);
  }
  if (body.result === undefined) {
    throw new Error('Ticker : réponse sans champ result');
  }

  return parseTickerResponse(config.mappings, body.result);
}
