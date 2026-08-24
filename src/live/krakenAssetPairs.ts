/**
 * Résout, pour chaque paire de l'univers, sa correspondance avec la
 * nomenclature Kraken WS v2 (wsname) et la clé utilisée par l'API REST
 * (/0/public/OHLC) — jamais codée en dur dans universe.ts, toujours
 * résolue dynamiquement contre /0/public/AssetPairs. Réutilise le même
 * garde-fou anti-délistage que validateUniverse (src/config/universe.ts),
 * pour un besoin différent (mapping, pas juste présence/absence).
 *
 * Forme de la réponse vérifiée contre la documentation officielle Kraken
 * (docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs,
 * août 2026) : `altname` (string, toujours présent) correspond au symbole
 * legacy utilisé dans universe.ts (ex. 'XBTEUR') ; `wsname` (string, mais
 * documenté comme optionnel — « if available ») a la forme 'BASE/QUOTE'
 * (ex. 'XBT/EUR'). Le garde-fou isAssetPairEntry ci-dessous traite déjà une
 * entrée sans wsname exploitable comme non exploitable (ignorée), ce qui
 * fait ensuite échouer explicitement sur le symbole manquant plus bas —
 * aucune adaptation du plan initial n'a été nécessaire.
 *
 * Correction (revue finale de branche, vérifiée contre l'API réelle) : le
 * `wsname` renvoyé par /0/public/AssetPairs est en réalité au format
 * WebSocket **v1** de Kraken, pas v2 — WS v2 rejette 'XBT/EUR' et 'XDG/EUR'
 * ("Currency pair not supported") mais accepte 'BTC/EUR' et 'DOGE/EUR'. La
 * table LEGACY_BASE_TO_WS_V2 ci-dessous traduit les codes d'actifs legacy
 * connus vers leur équivalent WS v2, appliquée uniquement à la partie base
 * (avant le '/') du wsname — la partie quote (ex. 'EUR') est inchangée.
 */

import type { PairSpec } from '../config/universe.ts';

export interface KrakenPairMapping {
  readonly symbol: string;
  readonly wsSymbol: string;
  readonly restSymbol: string;
}

/**
 * Codes d'actifs legacy (format wsname renvoyé par AssetPairs, en réalité WS
 * v1) vers leur équivalent WS v2. Liste non exhaustive : seuls les codes
 * legacy connus de l'univers actuel sont couverts ; un code absent de cette
 * table est conservé tel quel (pas de traduction nécessaire pour la grande
 * majorité des paires).
 */
const LEGACY_BASE_TO_WS_V2: Readonly<Record<string, string>> = {
  XBT: 'BTC',
  XDG: 'DOGE',
};

/** Traduit la partie base d'un wsname v1 ('BASE/QUOTE') vers son équivalent WS v2. */
function toWsV2Symbol(wsnameV1: string): string {
  const [base, quote] = wsnameV1.split('/');
  const translatedBase = LEGACY_BASE_TO_WS_V2[base] ?? base;
  return `${translatedBase}/${quote}`;
}

interface AssetPairEntry {
  readonly altname: string;
  readonly wsname: string;
}

function isAssetPairEntry(value: unknown): value is AssetPairEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.altname === 'string' && typeof entry.wsname === 'string';
}

/** Logique pure : mappe la réponse JSON déjà parsée sur l'univers fourni. */
export function parseAssetPairsResponse(
  universe: readonly PairSpec[],
  rawResult: Record<string, unknown>,
): readonly KrakenPairMapping[] {
  const byAltname = new Map<string, { key: string; wsname: string }>();
  for (const [key, value] of Object.entries(rawResult)) {
    if (!isAssetPairEntry(value)) continue;
    byAltname.set(value.altname, { key, wsname: value.wsname });
  }

  return universe.map((pair) => {
    const found = byAltname.get(pair.symbol);
    if (found === undefined) {
      throw new Error(`${pair.symbol} : absent de la réponse /0/public/AssetPairs (délisté ?)`);
    }
    if (!found.wsname.includes('/')) {
      throw new Error(`${pair.symbol} : wsname inattendu '${found.wsname}'`);
    }
    return { symbol: pair.symbol, wsSymbol: toWsV2Symbol(found.wsname), restSymbol: found.key };
  });
}

/** Câblage réseau — non testé automatiquement, comme krakenOhlcSource.ts. */
export async function fetchKrakenPairMappings(
  universe: readonly PairSpec[],
  restUrl = 'https://api.kraken.com/0/public/AssetPairs',
): Promise<readonly KrakenPairMapping[]> {
  const response = await fetch(restUrl);
  const body = (await response.json()) as { error?: readonly string[]; result?: Record<string, unknown> };
  if (body.error !== undefined && body.error.length > 0) {
    throw new Error(`AssetPairs : erreur API Kraken — ${body.error.join(', ')}`);
  }
  if (body.result === undefined) {
    throw new Error('AssetPairs : réponse sans champ result');
  }
  return parseAssetPairsResponse(universe, body.result);
}
