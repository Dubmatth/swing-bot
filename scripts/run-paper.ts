/**
 * Point d'entrée du runner de trading papier. Assemble le mapping de
 * paires (REST AssetPairs), l'amorçage (REST OHLC), le pipeline live
 * (Phase 5a) et la persistance, puis démarre le runner papier. Trading
 * papier uniquement — aucun ordre réel n'est jamais envoyé à Kraken.
 *
 * Usage : node --experimental-strip-types scripts/run-paper.ts
 */

import { join } from 'node:path';
import type { Interval } from '../src/data/series.ts';
import { UNIVERSE, UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { fetchKrakenPairMappings } from '../src/live/krakenAssetPairs.ts';
import { fetchSeedBars } from '../src/live/krakenRestSeed.ts';
import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import type { LiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import { createKrakenOhlcSource } from '../src/live/krakenOhlcSource.ts';
import type { LiveBarSource } from '../src/live/liveBarSource.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { createPortfolio } from '../src/backtest/portfolio.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import { createPaperRunner } from '../src/live/paperRunner.ts';
import {
  loadPortfolioSnapshot,
  savePortfolioSnapshot,
  appendTradeLog,
} from '../src/live/statePersistence.ts';

const INTERVAL: Interval = 240;
// Candidat provisoire trouvé en recherche de stratégie (voir README) —
// remplaçable sans changer l'architecture du runner.
const STRATEGY_PARAMS = { period: 80, entryK: 4 };

const STATE_DIR = join(process.cwd(), 'data', 'live-state');
const PORTFOLIO_PATH = join(STATE_DIR, 'portfolio.json');
const TRADES_PATH = join(STATE_DIR, 'trades.jsonl');

/**
 * Délai maximal accordé aux écritures de persistance en cours pour se
 * terminer avant de forcer l'arrêt du processus sur SIGINT/SIGTERM — sans
 * ça, un fill qui vient juste d'avoir lieu pourrait ne jamais être
 * persisté lors d'un arrêt propre.
 */
const SHUTDOWN_PERSISTENCE_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  console.log(`Résolution des mappings de paires (${UNIVERSE.length} paires)...`);
  const mappings = await fetchKrakenPairMappings(UNIVERSE);

  const strategy = combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...STRATEGY_PARAMS })),
  );

  const sources = new Map<string, LiveBarSource>();
  const builders = new Map<string, LiveSeriesBuilder>();

  for (const mapping of mappings) {
    console.log(`[${mapping.symbol}] amorçage (REST OHLC)...`);
    const seedBars = await fetchSeedBars({
      restSymbol: mapping.restSymbol,
      symbol: mapping.symbol,
      interval: INTERVAL,
      // Marge de sécurité d'une bougie contre les cas limites de frontière
      // d'intervalle (filtrage sur `result.last`, voir krakenRestSeed.ts).
      count: strategy.warmup + 1,
    });
    const builder = createLiveSeriesBuilder(mapping.symbol, INTERVAL);
    for (const bar of seedBars) {
      builder.append(bar);
    }
    builders.set(mapping.symbol, builder);
    sources.set(
      mapping.symbol,
      createKrakenOhlcSource({
        wsSymbol: mapping.wsSymbol,
        symbol: mapping.symbol,
        interval: INTERVAL,
      }),
    );
    console.log(`[${mapping.symbol}] amorcé avec ${seedBars.length} bougies.`);
  }

  console.log("Chargement de l'état persisté...");
  const portfolio = (await loadPortfolioSnapshot(PORTFOLIO_PATH)) ?? createPortfolio(10000);

  // Écritures de persistance en cours, suivies pour que shutdown() puisse les
  // attendre (avec timeout) avant de terminer le processus — voir plus bas.
  const pendingPersistence = new Set<Promise<void>>();
  function trackPersistence(promise: Promise<void>): void {
    pendingPersistence.add(promise);
    void promise.finally(() => pendingPersistence.delete(promise));
  }

  const runner = createPaperRunner({
    strategy,
    sources,
    builders,
    portfolio,
    options: {
      maxConcurrentPositions: 5,
      riskPerTradePct: 0.01,
      fees: DEFAULT_FEES,
      slippageBps: 5,
    },
    onFill: (trade, p) => {
      console.log(`[fill] ${trade.side} ${trade.symbol} qty=${trade.quantity} prix=${trade.price}`);
      // Écritures « fire-and-forget » : suffisant vu la fréquence de trading
      // très faible de la stratégie candidate (quelques trades par mois sur
      // 20 paires). Le journal JSONL reste la trace d'audit qui ne perd
      // jamais un trade même si le snapshot accuse un léger retard. Chaque
      // écriture est cependant suivie (trackPersistence) et dotée d'un
      // .catch : un incident I/O récupérable (disque plein, permission
      // refusée) ne doit jamais faire planter tout le processus — le
      // rejet d'une promesse non gérée termine le processus par défaut
      // depuis Node 15, ce qui tuerait toutes les connexions WebSocket
      // ouvertes pour une seule écriture manquée.
      trackPersistence(
        savePortfolioSnapshot(PORTFOLIO_PATH, p).catch((err: unknown) => {
          console.error('Échec de la sauvegarde du snapshot de portefeuille :', err);
        }),
      );
      trackPersistence(
        appendTradeLog(TRADES_PATH, trade).catch((err: unknown) => {
          console.error(`Échec de l'écriture du journal de trades (${trade.symbol}) :`, err);
        }),
      );
    },
  });

  console.log('Démarrage du runner papier...');
  runner.start();

  const shutdown = (): void => {
    console.log('Arrêt en cours...');
    runner.stop();
    // Laisse les écritures de persistance déclenchées par un fill tout juste
    // survenu se terminer avant de quitter — sans ça, un SIGINT/SIGTERM
    // propre pourrait sortir avant l'écriture du snapshot et perdre
    // silencieusement la toute dernière mise à jour. Timeout de secours au
    // cas où une écriture reste bloquée (ex. disque hors service) : un arrêt
    // propre ne doit jamais devenir un arrêt qui ne se termine jamais.
    const pending = Promise.all(pendingPersistence);
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_PERSISTENCE_TIMEOUT_MS);
    });
    void Promise.race([pending, timeout]).then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
