/**
 * Univers de trading — 20 paires EUR sur Kraken.
 *
 * Critères de sélection, par ordre de priorité :
 *  1. Profondeur d'historique. Pour du swing, la significativité statistique
 *     prime sur le volume instantané. Une paire listée en 2024 n'apporte rien.
 *  2. Liquidité EUR. L'EUR représente ~27 % du volume du top 20 de Kraken.
 *  3. Diversité de facteurs. L1, oracle/infra, DeFi, paiement, meme —
 *     un univers monofactoriel invalide le test cross-sectionnel : si toutes
 *     les paires bougent ensemble, 20 paires ne valent qu'un seul échantillon.
 *
 * Exclusions délibérées :
 *  - Privacy coins (XMR, ZEC) : retirées de la plupart des CASP européens.
 *  - Stablecoins : pas de mouvement à capturer.
 *  - Actifs ayant changé de ticker (MATIC → POL) : l'historique CSV est
 *    scindé entre deux symboles, source silencieuse de trous.
 *  - Listings récents et memecoins hors DOGE : historique insuffisant.
 *
 * IMPORTANT : cette liste est une intention, pas une vérité. Elle doit être
 * validée au chargement contre /0/public/AssetPairs (voir validateUniverse).
 * Les listings changent ; un symbole mort doit faire échouer le démarrage,
 * pas produire un backtest sur 19 paires sans que personne ne le remarque.
 */

export type Sector =
  | 'store-of-value'
  | 'smart-contract'
  | 'payment'
  | 'infrastructure'
  | 'defi'
  | 'meme';

export interface PairSpec {
  /** Symbole Kraken (nomenclature REST/CSV). */
  readonly symbol: string;
  /** Libellé lisible. */
  readonly label: string;
  readonly sector: Sector;
}

export const UNIVERSE: readonly PairSpec[] = [
  { symbol: 'XBTEUR', label: 'BTC/EUR', sector: 'store-of-value' },
  { symbol: 'ETHEUR', label: 'ETH/EUR', sector: 'smart-contract' },
  { symbol: 'XRPEUR', label: 'XRP/EUR', sector: 'payment' },
  { symbol: 'SOLEUR', label: 'SOL/EUR', sector: 'smart-contract' },
  { symbol: 'ADAEUR', label: 'ADA/EUR', sector: 'smart-contract' },
  { symbol: 'DOTEUR', label: 'DOT/EUR', sector: 'infrastructure' },
  { symbol: 'LINKEUR', label: 'LINK/EUR', sector: 'infrastructure' },
  { symbol: 'LTCEUR', label: 'LTC/EUR', sector: 'payment' },
  { symbol: 'BCHEUR', label: 'BCH/EUR', sector: 'payment' },
  { symbol: 'XLMEUR', label: 'XLM/EUR', sector: 'payment' },
  { symbol: 'AVAXEUR', label: 'AVAX/EUR', sector: 'smart-contract' },
  { symbol: 'ATOMEUR', label: 'ATOM/EUR', sector: 'infrastructure' },
  { symbol: 'ALGOEUR', label: 'ALGO/EUR', sector: 'smart-contract' },
  { symbol: 'XDGEUR', label: 'DOGE/EUR', sector: 'meme' },
  { symbol: 'ETCEUR', label: 'ETC/EUR', sector: 'smart-contract' },
  { symbol: 'FILEUR', label: 'FIL/EUR', sector: 'infrastructure' },
  { symbol: 'UNIEUR', label: 'UNI/EUR', sector: 'defi' },
  { symbol: 'AAVEEUR', label: 'AAVE/EUR', sector: 'defi' },
  { symbol: 'TRXEUR', label: 'TRX/EUR', sector: 'smart-contract' },
  { symbol: 'NEAREUR', label: 'NEAR/EUR', sector: 'smart-contract' },
] as const;

/**
 * Garde-fou fiscal (voir §2.3 du plan) : toute paire doit être cotée en EUR.
 * Un swap crypto/crypto est un fait générateur d'imposition sans flux fiat
 * pour payer l'impôt correspondant. Cette règle est structurelle, pas
 * configurable.
 */
export function assertEurQuoted(universe: readonly PairSpec[]): void {
  const offenders = universe.filter((p) => !p.symbol.endsWith('EUR'));
  if (offenders.length > 0) {
    throw new Error(
      `Paires non cotées en EUR interdites (contrainte fiscale) : ` +
        offenders.map((p) => p.symbol).join(', '),
    );
  }
}

/**
 * Valide l'univers contre la liste des paires réellement négociables.
 * À appeler au démarrage avec le résultat de /0/public/AssetPairs.
 * Échoue bruyamment : un symbole délisté doit arrêter le processus.
 */
export function validateUniverse(
  universe: readonly PairSpec[],
  tradableSymbols: ReadonlySet<string>,
): void {
  assertEurQuoted(universe);
  const missing = universe.filter((p) => !tradableSymbols.has(p.symbol));
  if (missing.length > 0) {
    throw new Error(
      `Paires absentes de Kraken (délistées ou mal orthographiées) : ` +
        missing.map((p) => `${p.label} (${p.symbol})`).join(', '),
    );
  }
}

export const UNIVERSE_SYMBOLS: readonly string[] = UNIVERSE.map((p) => p.symbol);
