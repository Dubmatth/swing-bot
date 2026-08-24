/**
 * Test d'intégration : statePersistence.ts + paperRunner.ts composés
 * ensemble, pour démontrer le critère de sortie de la Phase 5b — le runner
 * persiste son état et le reprend correctement après un redémarrage. Aucun
 * test existant ne composait les deux modules avant ce correctif (revue
 * finale de branche, correctif Important n°5).
 *
 * Scénario, dans l'ordre :
 *  1. Premier paperRunner (portefeuille neuf, source synthétique) : un fill
 *     d'achat a lieu.
 *  2. Sauvegarde du portefeuille via savePortfolioSnapshot dans un
 *     répertoire temporaire réel (mkdtemp).
 *  3. Rechargement du portefeuille via loadPortfolioSnapshot depuis ce même
 *     fichier — simule le redémarrage du processus.
 *  4. Second paperRunner (nouvelles sources/builders synthétiques, mais
 *     portefeuille RESTAURÉ).
 *  5. Une bougie déclenche une sortie sur la position restaurée : la vente
 *     doit porter sur la quantité exacte du fill d'achat d'avant le
 *     redémarrage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClosedBar, LiveBarSource } from '../src/live/liveBarSource.ts';
import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import { createPaperRunner } from '../src/live/paperRunner.ts';
import { createPortfolio } from '../src/backtest/portfolio.ts';
import type { Trade } from '../src/backtest/portfolio.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';
import { savePortfolioSnapshot, loadPortfolioSnapshot } from '../src/live/statePersistence.ts';

const SYMBOL_A = 'AEUR';
const STEP = 14_400;

function bar(symbol: string, i: number, close: number): ClosedBar {
  return { symbol, time: i * STEP, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

function createSyntheticSource(): LiveBarSource & { emit(bar: ClosedBar): void } {
  let callback: ((bar: ClosedBar) => void) | undefined;
  return {
    start(cb: (bar: ClosedBar) => void): void {
      callback = cb;
    },
    stop(): void {
      callback = undefined;
    },
    emit(b: ClosedBar): void {
      callback?.(b);
    },
  };
}

/** Stratégie de test déterministe : entre au-dessus du seuil, sort à/sous le seuil. */
function testStrategy(threshold: number): Strategy {
  return {
    name: 'test-strategy',
    warmup: 0,
    params: { threshold },
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents: Intent[] = [];
      for (const [symbol, view] of ctx.views) {
        const hasPosition = ctx.positions.has(symbol);
        const price = view.close(0);
        if (!hasPosition && price > threshold) {
          intents.push({ kind: 'enter', symbol, reason: `${price} > ${threshold}` });
        } else if (hasPosition && price <= threshold) {
          intents.push({ kind: 'exit', symbol, reason: `${price} <= ${threshold}` });
        }
      }
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}

test('Phase 5b — critère de sortie : le portefeuille persisté est repris correctement après un redémarrage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swing-bot-restart-test-'));
  try {
    const portfolioPath = join(dir, 'portfolio.json');
    const threshold = 50;

    // --- 1. Premier runner : fill d'achat ---
    const sourceA1 = createSyntheticSource();
    const builderA1 = createLiveSeriesBuilder(SYMBOL_A, 240);
    const portfolio1 = createPortfolio(1000);
    const fills1: Trade[] = [];

    const runner1 = createPaperRunner({
      strategy: testStrategy(threshold),
      sources: new Map([[SYMBOL_A, sourceA1]]),
      builders: new Map([[SYMBOL_A, builderA1]]),
      portfolio: portfolio1,
      options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
      onFill: (trade) => fills1.push(trade),
    });
    runner1.start();
    sourceA1.emit(bar(SYMBOL_A, 0, 60)); // 60 > 50 -> enter

    assert.equal(fills1.length, 1);
    assert.equal(fills1[0]?.side, 'buy');
    assert.equal(portfolio1.positions.size, 1);
    const boughtQuantity = portfolio1.positions.get(SYMBOL_A)?.quantity;
    assert.ok(boughtQuantity !== undefined && boughtQuantity > 0);
    runner1.stop();

    // --- 2. Sauvegarde du portefeuille ---
    await savePortfolioSnapshot(portfolioPath, portfolio1);

    // --- 3. Rechargement — simule le redémarrage du processus ---
    const restoredPortfolio = await loadPortfolioSnapshot(portfolioPath);
    assert.ok(restoredPortfolio);
    assert.equal(restoredPortfolio.positions.size, 1);
    assert.equal(restoredPortfolio.positions.get(SYMBOL_A)?.quantity, boughtQuantity);
    assert.equal(restoredPortfolio.trades.length, 0); // journal en mémoire reparti vide, attendu

    // --- 4. Second runner, nouvelles sources/builders, portefeuille restauré ---
    const sourceA2 = createSyntheticSource();
    const builderA2 = createLiveSeriesBuilder(SYMBOL_A, 240);
    const fills2: Trade[] = [];

    const runner2 = createPaperRunner({
      strategy: testStrategy(threshold),
      sources: new Map([[SYMBOL_A, sourceA2]]),
      builders: new Map([[SYMBOL_A, builderA2]]),
      portfolio: restoredPortfolio,
      options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
      onFill: (trade) => fills2.push(trade),
    });
    runner2.start();

    // --- 5. Bougie sous le seuil -> sortie sur la position restaurée ---
    sourceA2.emit(bar(SYMBOL_A, 0, 40)); // 40 <= 50 -> exit

    assert.equal(fills2.length, 1);
    assert.equal(fills2[0]?.side, 'sell');
    assert.equal(fills2[0]?.symbol, SYMBOL_A);
    // La quantité vendue doit être exactement celle du fill d'achat d'avant
    // le "redémarrage" — c'est le cœur du critère de sortie de la Phase 5b.
    assert.equal(fills2[0]?.quantity, boughtQuantity);
    assert.equal(restoredPortfolio.positions.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
