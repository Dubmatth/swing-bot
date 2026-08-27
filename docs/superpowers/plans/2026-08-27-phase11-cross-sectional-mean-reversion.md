# Phase 11 — Mean-reversion cross-sectionnelle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implémenter une variante cross-sectionnelle du candidat mean-reversion déjà validé (Phase 6) qui priorise les entrées simultanées par profondeur de survente (z-score décroissant) plutôt que l'ordre arbitraire de `combineStrategies`, puis comparer honnêtement les deux par walk-forward **et** par un diagnostic dédié de saturation du plafond de positions concurrentes.

**Architecture:** Nouveau fichier `src/strategy/crossSectionalMeanReversion.ts` exportant `createCrossSectionalMeanReversion`, une stratégie multi-paires dédiée (comme la Phase 9) qui lit `ctx.views` directement — même signal d'entrée/sortie que `meanReversion.ts` (dupliqué, pas importé, pour ne jamais risquer de faire dériver le candidat déjà validé), seule la priorité entre entrées simultanées change. Un script d'analyse non testé (`scripts/tune-cross-sectional-mean-reversion.ts`) compare référence et variante par walk-forward à 0 degré de liberté, plus un diagnostic de saturation committé.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas de build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-27-phase11-cross-sectional-mean-reversion-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- tsconfig strict : `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée.
- Commentaires et messages d'erreur en français.
- La stratégie doit rester pure : pas d'état mutable entre appels de `decide()`, pas d'I/O, pas de `Math.random` — contrat imposé par `src/strategy/types.ts`.
- Aucun nouveau paramètre par rapport au candidat déjà validé : seuls `period` et `entryK`, mêmes valeurs testées (`70`/`80` et `4`) — ce n'est pas une nouvelle famille, c'est un raffinement à 0 degré de liberté supplémentaire.
- `sma()`/`std()` sont dupliquées depuis `src/strategy/meanReversion.ts`, jamais importées — `meanReversion.ts` reste figé (même convention que `atrRiskCrossover.ts` vis-à-vis de `maCrossover.ts`).
- Le diagnostic de saturation du plafond (Task 2) doit être committé dans le script, pas une instrumentation jetable — leçon explicite des Phases 7-9.
- Le script d'évaluation (Task 2) n'est pas testé automatiquement — même catégorie que les autres scripts `tune-*`.

---

## Task 1: Stratégie `createCrossSectionalMeanReversion`

**Files:**
- Create: `src/strategy/crossSectionalMeanReversion.ts`
- Test: `test/crossSectionalMeanReversion.test.ts`

**Interfaces:**
- Consumes: `BarView`, `Intent`, `Strategy`, `StrategyContext`, `Position` (tous existants, `src/strategy/types.ts`, inchangés) ; `RollingStd`, `Sma` (existants, `src/strategy/indicators.ts`, inchangés).
- Produces: `CrossSectionalMeanReversionParams { period: number; entryK: number }`, `createCrossSectionalMeanReversion(params: CrossSectionalMeanReversionParams) => Strategy`. Consommé par Task 2.

- [ ] **Step 1: Écrire le fichier de test complet (échoue — le module n'existe pas encore)**

Créer `test/crossSectionalMeanReversion.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createCrossSectionalMeanReversion } from '../src/strategy/crossSectionalMeanReversion.ts';

const STEP = 14_400; // 4h en secondes, comme test/meanReversion.test.ts

function seriesFrom(symbol: string, closes: number[]): BarSeries {
  const c = emptyColumns();
  closes.forEach((close, i) => {
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(symbol, 240, c);
}

function multiCtx(
  closesBySymbol: Readonly<Record<string, number[]>>,
  positions: ReadonlyMap<string, Position> = new Map(),
): StrategyContext {
  const views = new Map<string, BarView>();
  let now = 0;
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    const view = new BarView(seriesFrom(symbol, closes), closes.length - 1);
    views.set(symbol, view);
    now = view.time(0);
  }
  return { views, positions, now };
}

test('createCrossSectionalMeanReversion : lève si period est invalide (non entier)', () => {
  assert.throws(
    () => createCrossSectionalMeanReversion({ period: 2.5, entryK: 1 }),
    /Période/,
  );
});

test('createCrossSectionalMeanReversion : lève si period est invalide (< 2)', () => {
  assert.throws(
    () => createCrossSectionalMeanReversion({ period: 1, entryK: 1 }),
    /Période/,
  );
});

test('createCrossSectionalMeanReversion : lève si entryK est invalide (<= 0)', () => {
  assert.throws(
    () => createCrossSectionalMeanReversion({ period: 4, entryK: 0 }),
    /entryK/,
  );
});

test('createCrossSectionalMeanReversion : warmup vaut period, params exposés', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  assert.equal(s.warmup, 4);
  assert.deepEqual(s.params, { period: 4, entryK: 1 });
});

test('decide : univers vide -> hold, sans exception', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx: StrategyContext = { views: new Map(), positions: new Map(), now: 0 };
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

// Fenêtre plate : sma=10, std=0, threshold=10 -> price=10 n'est jamais < threshold (strict).
const FLAT_CLOSES = [10, 10, 10, 10, 10];

test("decide : aucune entrée si le prix n'est pas sous le seuil, pas de position -> hold", () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx = multiCtx({ SYMFLAT: FLAT_CLOSES });
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : sortie si price >= sma, avec position ouverte', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const position: Position = { symbol: 'SYMFLAT', side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = multiCtx({ SYMFLAT: FLAT_CLOSES }, new Map([['SYMFLAT', position]]));
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

// SYMA : fenêtre [10,9,8,6] (period=4, ago=0..3) -> sma=8.25, écart-type≈1.479,
// seuil≈6.771, prix=6 < seuil -> éligible, z-score=(8.25-6)/1.479≈1.521.
const SYMA_CLOSES = [10, 10, 9, 8, 6];
// SYMB : fenêtre [10,10,9,3] -> sma=8, écart-type≈2.915, seuil≈5.085,
// prix=3 < seuil -> éligible, z-score=(8-3)/2.915≈1.715 — PLUS survendu que SYMA.
const SYMB_CLOSES = [10, 10, 10, 9, 3];

test('decide : une seule paire éligible, pas de position -> enter', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx = multiCtx({ SYMA: SYMA_CLOSES });
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : pas de nouvelle entrée si une position est déjà ouverte, même sous le seuil', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const position: Position = { symbol: 'SYMA', side: 'long', quantity: 1, entryPrice: 6, entryTime: 0 };
  const ctx = multiCtx({ SYMA: SYMA_CLOSES }, new Map([['SYMA', position]]));
  const intents = s.decide(ctx);
  // price=6 < sma=8.25 : pas de sortie (price < sma) ; position déjà ouverte : pas
  // d'entrée -> hold.
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : deux paires éligibles, entrées triées par z-score décroissant (la plus survendue en premier)', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const ctx = multiCtx({ SYMA: SYMA_CLOSES, SYMB: SYMB_CLOSES });
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'enter');
  assert.equal(intents[0]?.kind === 'enter' && intents[0].symbol, 'SYMB');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMA');
});

test('decide : une sortie et des entrées sur la même bougie -> la sortie est retournée en premier', () => {
  const s = createCrossSectionalMeanReversion({ period: 4, entryK: 1 });
  const position: Position = { symbol: 'SYMFLAT', side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = multiCtx(
    { SYMFLAT: FLAT_CLOSES, SYMA: SYMA_CLOSES, SYMB: SYMB_CLOSES },
    new Map([['SYMFLAT', position]]),
  );
  const intents = s.decide(ctx);
  assert.equal(intents.length, 3);
  assert.equal(intents[0]?.kind, 'exit');
  assert.equal(intents[0]?.kind === 'exit' && intents[0].symbol, 'SYMFLAT');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMB');
  assert.equal(intents[2]?.kind, 'enter');
  assert.equal(intents[2]?.kind === 'enter' && intents[2].symbol, 'SYMA');
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/crossSectionalMeanReversion.test.ts`
Expected: FAIL — `src/strategy/crossSectionalMeanReversion.ts` n'existe pas encore (erreur de résolution de module).

- [ ] **Step 3: Implémenter `createCrossSectionalMeanReversion`**

Créer `src/strategy/crossSectionalMeanReversion.ts` :

```ts
/**
 * Variante cross-sectionnelle de mean-reversion (Phase 6) : même signal
 * d'entrée/sortie par paire (price < sma-entryK·std / price >= sma), mais
 * lit tout l'univers à chaque decide() pour prioriser les entrées
 * simultanées par profondeur de survente (z-score décroissant) plutôt
 * que l'ordre arbitraire de combineStrategies. Aucun nouveau paramètre —
 * seule la priorité entre candidats simultanés change.
 *
 * sma()/std() sont dupliquées depuis meanReversion.ts plutôt qu'importées,
 * même convention que atrRiskCrossover.ts vis-à-vis de maCrossover.ts :
 * meanReversion.ts reste figé pour protéger le candidat déjà validé de
 * toute dérive d'implémentation accidentelle.
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';
import { RollingStd, Sma } from './indicators.ts';

export interface CrossSectionalMeanReversionParams {
  readonly period: number;
  readonly entryK: number;
}

function sma(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

function std(view: BarView, period: number): number {
  const s = new RollingStd(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

interface EnterCandidate {
  readonly symbol: string;
  readonly zScore: number;
  readonly price: number;
  readonly smaVal: number;
  readonly threshold: number;
}

export function createCrossSectionalMeanReversion(params: CrossSectionalMeanReversionParams): Strategy {
  const { period, entryK } = params;
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Période invalide : ${period}`);
  }
  if (!(entryK > 0)) {
    throw new RangeError(`entryK invalide : ${entryK}`);
  }

  return {
    name: 'cross-sectional-mean-reversion',
    warmup: period,
    params: { period, entryK },
    decide(ctx: StrategyContext): readonly Intent[] {
      const exitIntents: Intent[] = [];
      const candidates: EnterCandidate[] = [];

      for (const [symbol, view] of ctx.views) {
        const smaVal = sma(view, period);
        const stdVal = std(view, period);
        const price = view.close(0);
        const position = ctx.positions.get(symbol);

        if (position) {
          if (price >= smaVal) {
            exitIntents.push({
              kind: 'exit',
              symbol,
              reason: `prix=${price.toFixed(4)} >= sma(${period})=${smaVal.toFixed(4)}`,
            });
          }
          continue;
        }

        const threshold = smaVal - entryK * stdVal;
        if (price < threshold) {
          candidates.push({
            symbol,
            zScore: (smaVal - price) / stdVal,
            price,
            smaVal,
            threshold,
          });
        }
      }

      candidates.sort((a, b) => b.zScore - a.zScore);
      const enterIntents: Intent[] = candidates.map((c) => ({
        kind: 'enter',
        symbol: c.symbol,
        reason:
          `prix=${c.price.toFixed(4)} < sma(${period})-${entryK}·std=${c.threshold.toFixed(4)}, ` +
          `z-score=${c.zScore.toFixed(2)}`,
      }));

      const intents = [...exitIntents, ...enterIntents];
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/crossSectionalMeanReversion.test.ts`
Expected: PASS — les 11 tests (3 validations + warmup/params + 7 comportements de `decide`) sont verts.

- [ ] **Step 5: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (nouveaux et existants)

- [ ] **Step 6: Commit**

```bash
git add src/strategy/crossSectionalMeanReversion.ts test/crossSectionalMeanReversion.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): mean-reversion cross-sectionnelle

Nouvelle stratégie multi-paires dédiée : même signal d'entrée/sortie
que le candidat mean-reversion déjà validé (period/entryK, aucun
nouveau paramètre), mais priorise les entrées simultanées par
profondeur de survente (z-score décroissant) plutôt que l'ordre
arbitraire de combineStrategies. Sorties émises avant les entrées,
comme la Phase 9. sma()/std() dupliquées depuis meanReversion.ts pour
ne jamais faire dériver le candidat déjà validé — voir
docs/superpowers/specs/2026-08-27-phase11-cross-sectional-mean-reversion-design.md
EOF
)"
```

---

## Task 2: Évaluation walk-forward, diagnostic de saturation, et documentation du résultat

**Files:**
- Create: `scripts/tune-cross-sectional-mean-reversion.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createCrossSectionalMeanReversion` (Task 1), `createMeanReversion`, `combineStrategies`, `runWalkForward`, `runBacktest`, `loadUniverse`, `UNIVERSE_SYMBOLS`, `DEFAULT_FEES`, `BacktestOptions`, `Strategy` (tous existants, inchangés).

- [ ] **Step 1: Implémenter le script d'évaluation**

Créer `scripts/tune-cross-sectional-mean-reversion.ts` :

```ts
/**
 * Compare, par walk-forward ET par diagnostic de saturation du plafond,
 * le candidat mean-reversion déjà validé (Phase 6, combineStrategies,
 * ordre arbitraire de l'univers en cas de plafond atteint) à sa variante
 * cross-sectionnelle (priorité aux paires les plus survendues). Même
 * period/entryK des deux côtés, 0 degré de liberté ajouté — ce n'est pas
 * une nouvelle famille, c'est un raffinement du candidat déjà validé,
 * comme les Phases 7/8.
 *
 * Leçon des Phases 7-9 : avant d'interpréter un résultat neutre ou
 * dégradé, vérifier que le mécanisme testé a eu l'occasion de jouer. Le
 * réordonnancement par z-score ne peut avoir d'effet que si le plafond
 * maxConcurrentPositions est effectivement atteint alors que plusieurs
 * paires sont éligibles simultanément — le diagnostic ci-dessous
 * (backtest complet, hors walk-forward) compte combien de rejets sont dus
 * à « plafond de positions concurrentes atteint » pour les deux variantes.
 *
 * Usage : node --experimental-strip-types scripts/tune-cross-sectional-mean-reversion.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { createCrossSectionalMeanReversion } from '../src/strategy/crossSectionalMeanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import type { BarSeries } from '../src/data/series.ts';
import type { Strategy } from '../src/strategy/types.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Params {
  readonly period: number;
  readonly entryK: number;
}

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

const TRAIN_BARS = 1095;
const TEST_BARS = 180;
const PERIODS = [70, 80];
const ENTRY_K = 4;

function referenceStrategy(p: Params): Strategy {
  return combineStrategies(UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...p })));
}

function crossSectionalStrategy(p: Params): Strategy {
  return createCrossSectionalMeanReversion(p);
}

function runWalkForwardSingle(
  series: ReadonlyMap<string, BarSeries>,
  label: string,
  strategyFactory: (p: Params) => Strategy,
  params: Params,
): void {
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: [params], // 0 degré de liberté
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });
  const n = result.folds.length;
  const meanOut = result.folds.reduce((s, f) => s + f.outOfSampleReturn, 0) / n;
  const win = result.folds.filter((f) => f.outOfSampleReturn > 0).length;
  console.log(`${label.padEnd(55)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}`);
}

function countCapRejections(rejectionReasons: readonly string[]): number {
  return rejectionReasons.filter((r) => r === 'plafond de positions concurrentes atteint').length;
}

function runCapacityDiagnostic(
  series: ReadonlyMap<string, BarSeries>,
  label: string,
  strategy: Strategy,
): void {
  const result = runBacktest(series, strategy, BACKTEST_OPTIONS);
  const capRejections = countCapRejections(result.rejectionReasons);
  console.log(
    `${label.padEnd(55)} rejets totaux=${result.rejectedOrders}  ` +
      `dont plafond atteint=${capRejections}  trades exécutés=${result.portfolio.trades.length}`,
  );
}

async function main(): Promise<void> {
  console.log(`Chargement de ${UNIVERSE_SYMBOLS.length} paires (interval=240)...`);
  const { series, commonStart, commonEnd } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });
  console.log(
    `Fenêtre commune : ${new Date(commonStart * 1000).toISOString()} -> ` +
      `${new Date(commonEnd * 1000).toISOString()} (${series.get(UNIVERSE_SYMBOLS[0]!)!.length} bougies)`,
  );

  console.log('\n=== Walk-forward : référence (combineStrategies) vs cross-sectionnelle ===');
  for (const period of PERIODS) {
    const params: Params = { period, entryK: ENTRY_K };
    runWalkForwardSingle(series, `référence period=${period}, entryK=${ENTRY_K}`, referenceStrategy, params);
    runWalkForwardSingle(
      series,
      `cross-sectionnelle period=${period}, entryK=${ENTRY_K}`,
      crossSectionalStrategy,
      params,
    );
  }

  console.log('\n=== Diagnostic de saturation du plafond (backtest complet, hors walk-forward) ===');
  for (const period of PERIODS) {
    const params: Params = { period, entryK: ENTRY_K };
    runCapacityDiagnostic(series, `référence period=${period}, entryK=${ENTRY_K}`, referenceStrategy(params));
    runCapacityDiagnostic(
      series,
      `cross-sectionnelle period=${period}, entryK=${ENTRY_K}`,
      crossSectionalStrategy(params),
    );
  }
}

await main();
```

- [ ] **Step 2: Lancer l'évaluation**

Run: `node --experimental-strip-types scripts/tune-cross-sectional-mean-reversion.ts`
Expected: le script s'exécute sans erreur et imprime, pour `period=70` et
`period=80` : le rendement moyen hors-échantillon et le taux de fenêtres
gagnantes des deux variantes (walk-forward), puis les rejets totaux, les
rejets pour cause de plafond, et le nombre de trades exécutés des deux
variantes (diagnostic).

- [ ] **Step 3: Documenter le résultat dans le README, quel qu'il soit**

Dans la section « Recherche de stratégie (données réelles) » du
`README.md`, ajouter une puce après la dernière puce existante :

- **D'abord**, rapporter le diagnostic de saturation (les deux variantes,
  les deux `period`) : si le nombre de rejets pour cause de plafond est
  proche de zéro pour la référence (le mécanisme n'a presque jamais eu
  l'occasion de jouer), le dire explicitement — un résultat neutre sur le
  rendement walk-forward doit alors être qualifié de **non concluant**,
  pas d'échec du mécanisme (même discipline que `maxVolatilityRatio=0,09`
  en Phase 7 et `lookbackPeriod=168` en Phase 9).
- **Ensuite**, rapporter le résultat walk-forward avec les chiffres réels :
  si la variante cross-sectionnelle bat clairement (pas marginalement) la
  référence sur au moins un des deux réglages, ET que le diagnostic
  confirme que le plafond était effectivement saturé pour une fraction
  significative des tentatives d'entrée : documenter ce réglage comme une
  amélioration retenue, mettre à jour la puce « **Statut** ».
  Sinon (neutre, dégradé, ou mécanisme non concluant faute de saturation) :
  documenter honnêtement, avec les chiffres exacts des deux diagnostics
  (walk-forward et saturation), et laisser le « **Statut** » inchangé.

Dans tous les cas, le texte doit rapporter les chiffres réels imprimés
par le script committé — jamais une estimation.

Ajouter aussi une ligne dans la liste « Structure » (section `##
Structure`), juste après la ligne
`scripts/tune-donchian-breakout.ts` existante (ou, si la Phase 10 n'est
pas encore mergée dans cette branche, après la dernière ligne `scripts/`
existante) :

```
scripts/tune-cross-sectional-mean-reversion.ts Compare mean-reversion (référence combineStrategies) à sa variante cross-sectionnelle par walk-forward et par diagnostic de saturation du plafond de positions
```

Et une ligne dans la liste des modules de `src/strategy/` (section `##
Structure`), juste après la ligne `src/strategy/meanReversion.ts`
existante :

```
src/strategy/crossSectionalMeanReversion.ts Variante cross-sectionnelle de mean-reversion : priorise les entrées simultanées par profondeur de survente (z-score), même signal que meanReversion.ts
```

- [ ] **Step 4: Vérifier que rien n'est cassé**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (ce script n'a pas de test dédié — pas
plus que les autres scripts d'analyse du projet)

- [ ] **Step 5: Commit**

```bash
git add scripts/tune-cross-sectional-mean-reversion.ts README.md
git commit -m "$(cat <<'EOF'
feat(scripts): évalue mean-reversion cross-sectionnelle par walk-forward

Compare la variante cross-sectionnelle à la référence déjà validée
(period=70/80, entryK=4, 0 degré de liberté ajouté), plus un
diagnostic committé de saturation du plafond de positions concurrentes
(leçon des Phases 7-9 : vérifier que le mécanisme testé a l'occasion
de jouer avant d'interpréter un résultat neutre). Résultat consigné
honnêtement dans le README, qu'il soit positif, neutre, ou non
concluant.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — §Architecture (`crossSectionalMeanReversion.ts`
nouveau, script d'évaluation à deux diagnostics distincts) → Task 1 et
Task 2 respectivement ; §Décisions actées (signal identique au candidat
validé, sorties avant entrées, tri par z-score, sma/std dupliquées, 0 DoF
ajouté, diagnostic de saturation committé) → toutes reprises explicitement
dans le code de Task 1 et le script de Task 2.

**Décomposition** — 2 tâches : Task 1 (code de production, testé) avant
Task 2 (évaluation, dépend du code de Task 1). Ordre respecte la
dépendance, comme les Phases 6-10.

**Cohérence des types** — `CrossSectionalMeanReversionParams { period:
number; entryK: number }` (Task 1) utilisé identiquement dans Task 2
(`crossSectionalStrategy(p: Params)` avec `Params { period: number;
entryK: number }` — champs identiques). `Strategy`/`StrategyContext`/
`Intent`/`Position`/`BarView` importés dans le test (Task 1) correspondent
aux types déjà exportés de `src/strategy/types.ts`, inchangés.
`BacktestResult` (via `runBacktest`, Task 2) : `rejectedOrders: number`,
`rejectionReasons: readonly string[]`, `portfolio.trades: Trade[]` — tous
trois vérifiés champ à champ contre `src/backtest/runner.ts` et
`src/backtest/portfolio.ts` (lus avant d'écrire ce plan). `FoldResult<P>`
(`foldIndex`, `selectedParams`, `inSampleReturn`, `outOfSampleReturn`)
utilisé dans `runWalkForwardSingle` correspond à
`src/backtest/walkForward.ts`, inchangé.

**Aucun placeholder** — chaque step contient le code complet (stratégie,
11 tests, script d'évaluation à deux diagnostics). Task 2 Step 3 ne
prescrit pas un résultat à l'avance, il prescrit la procédure de
documentation honnête (y compris la distinction neutre-vs-non-concluant
selon le diagnostic de saturation) — ce n'est pas un placeholder, c'est la
nature même d'une évaluation dont le résultat n'est pas encore connu au
moment d'écrire le plan (même formulation que les Phases 8/9/10, déjà
validées par le projet).
