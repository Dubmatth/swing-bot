# Phase 4 — Validation walk-forward — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un framework de validation walk-forward (recherche de paramètres in-sample + mesure out-of-sample sur fenêtres glissantes) et démontrer qu'il révèle correctement l'overfitting plutôt que de le masquer.

**Architecture:** `totalReturn` (nouveau, minimal) calcule un rendement depuis une `equityCurve` existante. `runWalkForward` (nouveau, générique sur une `strategyFactory`) compose `sliceSeries` et `runBacktest` — déjà existants, inchangés — sur des fenêtres glissantes à taille fixe.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas d'étape de build), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-24-phase4-walk-forward-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Commentaires et messages d'erreur en français, cohérents avec le style existant.
- Aucun fichier existant n'est modifié — `runBacktest`, `sliceSeries`, `createMaCrossover`, `EquityPoint`, `BacktestOptions` sont consommés tels quels.
- Fenêtres glissantes à taille fixe (`trainBars`/`testBars` constants) : fold `i` = train `[i·testBars, i·testBars+trainBars)`, test `[i·testBars+trainBars, i·testBars+trainBars+testBars)`. Fenêtres de test bord à bord, sans chevauchement ; fenêtres d'entraînement se chevauchant normalement entre folds consécutifs (comportement standard du walk-forward glissant).
- Aucun garde-fou nouveau sur la compatibilité `warmup`/`trainBars` — l'erreur existante de `runBacktest` remonte telle quelle si un paramètre de la grille a un warmup trop long.
- `runWalkForward` lève une `Error`/`RangeError` explicite (jamais de dégradation silencieuse) si : la grille de paramètres est vide, `trainBars`/`testBars` ne sont pas des entiers positifs, ou aucun fold complet n'entre dans la série.
- Commande de test par fichier : `node --experimental-strip-types --test test/<fichier>.test.ts`. Commande globale : `npm test` (`npm run typecheck` pour la vérification de types).

---

## Task 1: Métriques et `runWalkForward`

**Files:**
- Create: `src/backtest/metrics.ts`
- Create: `src/backtest/walkForward.ts`
- Test: `test/metrics.test.ts`
- Test: `test/walkForward.test.ts`

**Interfaces:**
- Consumes : `EquityPoint`, `BacktestOptions`, `runBacktest` (`src/backtest/runner.ts`, existant, inchangé) ; `BarSeries`, `sliceSeries` (`src/data/series.ts`, existant, inchangé) ; `Strategy` (`src/strategy/types.ts`, existant, inchangé).
- Produces :
  - `function totalReturn(equityCurve: readonly EquityPoint[], initialCash: number): number`
  - `interface WalkForwardConfig<P> { readonly trainBars: number; readonly testBars: number; readonly paramGrid: readonly P[]; readonly strategyFactory: (params: P) => Strategy; readonly backtestOptions: BacktestOptions }`
  - `interface FoldResult<P> { readonly foldIndex: number; readonly selectedParams: P; readonly inSampleReturn: number; readonly outOfSampleReturn: number }`
  - `interface WalkForwardResult<P> { readonly folds: readonly FoldResult<P>[] }`
  - `function runWalkForward<P>(series: ReadonlyMap<string, BarSeries>, config: WalkForwardConfig<P>): WalkForwardResult<P>`

- [ ] **Step 1: Écrire les tests de `metrics.ts` (échouent — le module n'existe pas encore)**

Créer `test/metrics.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { totalReturn } from '../src/backtest/metrics.ts';
import type { EquityPoint } from '../src/backtest/runner.ts';

test('totalReturn : calcule le rendement entre le cash initial et la dernière équité', () => {
  const curve: EquityPoint[] = [
    { time: 0, equity: 1000 },
    { time: 1, equity: 1100 },
    { time: 2, equity: 1050 },
  ];
  assert.ok(Math.abs(totalReturn(curve, 1000) - 0.05) < 1e-9);
});

test('totalReturn : rendement négatif si perte', () => {
  const curve: EquityPoint[] = [{ time: 0, equity: 900 }];
  assert.ok(Math.abs(totalReturn(curve, 1000) - -0.1) < 1e-9);
});

test('totalReturn : lève si equityCurve est vide', () => {
  assert.throws(() => totalReturn([], 1000), /vide/);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/metrics.test.ts`
Expected: FAIL — `src/backtest/metrics.ts` n'existe pas.

- [ ] **Step 3: Implémenter `metrics.ts`**

Créer `src/backtest/metrics.ts` :

```ts
/**
 * Métriques de performance calculées depuis la courbe d'équité d'un
 * backtest. Rendement total pour l'instant — Sharpe/drawdown ajoutables
 * plus tard sans retoucher le reste, equityCurve les rend triviaux.
 */

import type { EquityPoint } from './runner.ts';

export function totalReturn(equityCurve: readonly EquityPoint[], initialCash: number): number {
  if (equityCurve.length === 0) {
    throw new Error('totalReturn : equityCurve vide');
  }
  const finalEquity = equityCurve[equityCurve.length - 1]!.equity;
  return (finalEquity - initialCash) / initialCash;
}
```

- [ ] **Step 4: Vérifier que les tests de `metrics.ts` passent**

Run: `node --experimental-strip-types --test test/metrics.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Écrire les tests de `walkForward.ts` (échouent — le module n'existe pas encore)**

Créer `test/walkForward.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import type { Strategy, StrategyContext } from '../src/strategy/types.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

function seriesFrom(closes: number[]): BarSeries {
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
  return freezeSeries(SYMBOL, 240, c);
}

interface Params {
  readonly mode: 'flat' | 'buyhold';
}

/** 'flat' ne trade jamais (rendement 0) ; 'buyhold' entre dès que possible et ne sort jamais. */
function strategyFactory(params: Params): Strategy {
  if (params.mode === 'flat') {
    return {
      name: 'flat',
      warmup: 1,
      params: {},
      decide: (_ctx: StrategyContext) => [{ kind: 'hold' }],
    };
  }
  return {
    name: 'buyhold',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      return ctx.positions.has(SYMBOL)
        ? [{ kind: 'hold' }]
        : [{ kind: 'enter', symbol: SYMBOL, reason: 'test' }];
    },
  };
}

const BACKTEST_OPTIONS = {
  initialCash: 1000,
  fees: DEFAULT_FEES,
  slippageBps: 10,
  maxConcurrentPositions: 1,
  riskPerTradePct: 1,
};

test('runWalkForward : sélectionne le meilleur rendement in-sample, mesure hors échantillon avec les mêmes paramètres', () => {
  const closes = [
    // train (bars 0-5) : hausse continue après l'entrée — buyhold doit gagner in-sample
    100, 100, 110, 130, 160, 200,
    // test (bars 6-11) : baisse continue après l'entrée — buyhold doit perdre hors échantillon
    200, 200, 180, 150, 110, 60,
  ];
  const series = new Map([[SYMBOL, seriesFrom(closes)]]);

  const result = runWalkForward(series, {
    trainBars: 6,
    testBars: 6,
    paramGrid: [{ mode: 'flat' }, { mode: 'buyhold' }],
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });

  assert.equal(result.folds.length, 1);
  const fold = result.folds[0]!;
  assert.equal(fold.foldIndex, 0);
  assert.equal(fold.selectedParams.mode, 'buyhold');
  assert.ok(fold.inSampleReturn > 0, `attendu un rendement in-sample positif, obtenu ${fold.inSampleReturn}`);
  assert.ok(
    fold.outOfSampleReturn < 0,
    `attendu un rendement hors échantillon négatif, obtenu ${fold.outOfSampleReturn}`,
  );
});

test('runWalkForward : découpe la série en folds glissants successifs', () => {
  const closes = Array.from({ length: 24 }, () => 100);
  const series = new Map([[SYMBOL, seriesFrom(closes)]]);

  const result = runWalkForward(series, {
    trainBars: 6,
    testBars: 6,
    paramGrid: [{ mode: 'flat' as const }],
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });

  assert.equal(result.folds.length, 3);
  assert.deepEqual(result.folds.map((f) => f.foldIndex), [0, 1, 2]);
});

test('runWalkForward : lève si la grille de paramètres est vide', () => {
  const series = new Map([[SYMBOL, seriesFrom(Array.from({ length: 12 }, () => 100))]]);
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 6,
        testBars: 6,
        paramGrid: [],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /au moins un jeu de paramètres/,
  );
});

test('runWalkForward : lève si trainBars ou testBars est invalide', () => {
  const series = new Map([[SYMBOL, seriesFrom(Array.from({ length: 12 }, () => 100))]]);
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 0,
        testBars: 6,
        paramGrid: [{ mode: 'flat' as const }],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /trainBars/,
  );
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 6,
        testBars: -1,
        paramGrid: [{ mode: 'flat' as const }],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /testBars/,
  );
});

test('runWalkForward : lève si la série est trop courte pour un seul fold', () => {
  const series = new Map([[SYMBOL, seriesFrom(Array.from({ length: 8 }, () => 100))]]);
  assert.throws(
    () =>
      runWalkForward(series, {
        trainBars: 6,
        testBars: 6,
        paramGrid: [{ mode: 'flat' as const }],
        strategyFactory,
        backtestOptions: BACKTEST_OPTIONS,
      }),
    /insuffisant/,
  );
});
```

- [ ] **Step 6: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/walkForward.test.ts`
Expected: FAIL — `src/backtest/walkForward.ts` n'existe pas.

- [ ] **Step 7: Implémenter `walkForward.ts`**

Créer `src/backtest/walkForward.ts` :

```ts
/**
 * Validation walk-forward : sélectionne les meilleurs paramètres d'une
 * grille sur une fenêtre d'entraînement, puis mesure leur performance sur
 * la fenêtre suivante non vue (hors échantillon). Répété sur des fenêtres
 * glissantes à taille fixe qui couvrent la série de bout en bout, fenêtres
 * de test bord à bord sans chevauchement.
 *
 * Générique sur une strategyFactory : n'importe quelle stratégie
 * paramétrable peut être testée, ce module ne connaît aucune stratégie
 * précise.
 */

import type { BarSeries } from '../data/series.ts';
import { sliceSeries } from '../data/series.ts';
import type { Strategy } from '../strategy/types.ts';
import type { BacktestOptions } from './runner.ts';
import { runBacktest } from './runner.ts';
import { totalReturn } from './metrics.ts';

export interface WalkForwardConfig<P> {
  readonly trainBars: number;
  readonly testBars: number;
  readonly paramGrid: readonly P[];
  readonly strategyFactory: (params: P) => Strategy;
  readonly backtestOptions: BacktestOptions;
}

export interface FoldResult<P> {
  readonly foldIndex: number;
  readonly selectedParams: P;
  readonly inSampleReturn: number;
  readonly outOfSampleReturn: number;
}

export interface WalkForwardResult<P> {
  readonly folds: readonly FoldResult<P>[];
}

function sliceMap(
  series: ReadonlyMap<string, BarSeries>,
  from: number,
  to: number,
): Map<string, BarSeries> {
  const sliced = new Map<string, BarSeries>();
  for (const [symbol, s] of series) {
    sliced.set(symbol, sliceSeries(s, from, to));
  }
  return sliced;
}

export function runWalkForward<P>(
  series: ReadonlyMap<string, BarSeries>,
  config: WalkForwardConfig<P>,
): WalkForwardResult<P> {
  if (config.paramGrid.length === 0) {
    throw new RangeError('runWalkForward : au moins un jeu de paramètres requis');
  }
  if (!Number.isInteger(config.trainBars) || config.trainBars < 1) {
    throw new RangeError(`trainBars invalide : ${config.trainBars}`);
  }
  if (!Number.isInteger(config.testBars) || config.testBars < 1) {
    throw new RangeError(`testBars invalide : ${config.testBars}`);
  }

  const length = [...series.values()][0]?.length;
  if (length === undefined) {
    throw new Error('runWalkForward : au moins une série requise');
  }

  const folds: FoldResult<P>[] = [];
  for (let foldIndex = 0; ; foldIndex++) {
    const trainFrom = foldIndex * config.testBars;
    const trainTo = trainFrom + config.trainBars;
    const testFrom = trainTo;
    const testTo = testFrom + config.testBars;
    if (testTo > length) break;

    const trainSeries = sliceMap(series, trainFrom, trainTo);
    let bestParams = config.paramGrid[0]!;
    let bestReturn = -Infinity;
    for (const params of config.paramGrid) {
      const strategy = config.strategyFactory(params);
      const trainResult = runBacktest(trainSeries, strategy, config.backtestOptions);
      const inSampleReturn = totalReturn(trainResult.equityCurve, config.backtestOptions.initialCash);
      if (inSampleReturn > bestReturn) {
        bestReturn = inSampleReturn;
        bestParams = params;
      }
    }

    const testSeries = sliceMap(series, testFrom, testTo);
    const testStrategy = config.strategyFactory(bestParams);
    const testResult = runBacktest(testSeries, testStrategy, config.backtestOptions);
    const outOfSampleReturn = totalReturn(testResult.equityCurve, config.backtestOptions.initialCash);

    folds.push({
      foldIndex,
      selectedParams: bestParams,
      inSampleReturn: bestReturn,
      outOfSampleReturn,
    });
  }

  if (folds.length === 0) {
    throw new Error(
      `${length} barre(s), insuffisant pour au moins un fold ` +
        `(trainBars=${config.trainBars} + testBars=${config.testBars})`,
    );
  }

  return { folds };
}
```

- [ ] **Step 8: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/walkForward.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 9: Suite complète et typecheck**

Run: `npm test`
Expected: tous les tests passent

Run: `npm run typecheck`
Expected: aucune erreur

- [ ] **Step 10: Commit**

```bash
git add src/backtest/metrics.ts src/backtest/walkForward.ts test/metrics.test.ts test/walkForward.test.ts
git commit -m "$(cat <<'EOF'
feat(backtest): totalReturn + runWalkForward

runWalkForward compose sliceSeries et runBacktest (inchangés) sur des
fenêtres glissantes à taille fixe : sélectionne les paramètres au
meilleur rendement in-sample, mesure les MÊMES paramètres sur la
fenêtre suivante non vue. Générique sur une strategyFactory — aucune
stratégie précise n'est câblée dans ce module.
EOF
)"
```

---

## Task 2: Test du critère de sortie de la Phase 4

**Files:**
- Create: `test/phase4.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes : `runWalkForward` (`src/backtest/walkForward.ts`, Task 1) ; `createMaCrossover`, `MaCrossoverParams` (`src/strategy/maCrossover.ts`, existant, inchangé) ; `DEFAULT_FEES` (`src/backtest/execution.ts`, existant, inchangé).
- Produces : rien (fichier de test terminal, pas de nouveau module source)

- [ ] **Step 1: Écrire le test**

Créer `test/phase4.test.ts` :

```ts
/**
 * Critère de sortie de la Phase 4 (voir README) : le walk-forward révèle
 * l'overfitting plutôt que de le masquer.
 *
 * Marché synthétique sans structure réelle (bruit pseudo-aléatoire
 * déterministe — un générateur congruentiel linéaire à graine fixe, pas
 * de vraie randomisation, pour rester reproductible) et une grille de
 * paramètres riche (48 combinaisons fast/slow pour createMaCrossover).
 * Sur des données sans edge réel, la combinaison sélectionnée par
 * recherche in-sample capture nécessairement du bruit plutôt qu'un
 * signal — c'est le biais de sélection multiple (« choisir le meilleur
 * parmi 48 » gonfle artificiellement la performance mesurée sur les
 * données mêmes qui ont servi à choisir). Le walk-forward doit exposer ce
 * biais : le rendement moyen in-sample doit être significativement
 * meilleur que le rendement moyen hors échantillon des mêmes paramètres.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';
import type { MaCrossoverParams } from '../src/strategy/maCrossover.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

/** Générateur congruentiel linéaire — déterministe, pas Math.random. */
function lcgNoiseSeries(bars: number, seed: number, base: number, stepScale: number): BarSeries {
  const c = emptyColumns();
  let state = seed;
  let price = base;
  for (let i = 0; i < bars; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const u = state / 0x7fffffff; // [0, 1)
    price += (u - 0.5) * 2 * stepScale;
    c.time.push(i * STEP);
    c.open.push(price);
    c.high.push(price);
    c.low.push(price);
    c.close.push(price);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(SYMBOL, 240, c);
}

function buildParamGrid(): MaCrossoverParams[] {
  const grid: MaCrossoverParams[] = [];
  for (const fast of [2, 3, 4, 5, 6, 8, 10, 12]) {
    for (const slowOffset of [2, 4, 6, 10, 15, 20]) {
      grid.push({ symbol: SYMBOL, fast, slow: fast + slowOffset });
    }
  }
  return grid;
}

test("Phase 4 — critère de sortie : le walk-forward révèle l'overfitting plutôt que de le masquer", () => {
  const series = new Map([[SYMBOL, lcgNoiseSeries(200, 42, 100, 1.5)]]);
  const paramGrid = buildParamGrid();

  const result = runWalkForward(series, {
    trainBars: 60,
    testBars: 20,
    paramGrid,
    strategyFactory: (params: MaCrossoverParams) => createMaCrossover(params),
    backtestOptions: {
      initialCash: 1000,
      fees: DEFAULT_FEES,
      slippageBps: 5,
      maxConcurrentPositions: 1,
      riskPerTradePct: 1,
    },
  });

  assert.ok(
    result.folds.length >= 3,
    `attendu au moins 3 folds pour une moyenne significative, obtenu ${result.folds.length}`,
  );

  const meanInSample =
    result.folds.reduce((sum, f) => sum + f.inSampleReturn, 0) / result.folds.length;
  const meanOutOfSample =
    result.folds.reduce((sum, f) => sum + f.outOfSampleReturn, 0) / result.folds.length;

  assert.ok(
    meanInSample > meanOutOfSample,
    `attendu in-sample (${meanInSample}) > hors échantillon (${meanOutOfSample}) — ` +
      `signature attendue de l'overfitting sur données sans edge réel`,
  );
});
```

- [ ] **Step 2: Lancer le test**

Run: `node --experimental-strip-types --test test/phase4.test.ts`

Ce test repose sur un effet statistique (biais de sélection multiple sur
48 combinaisons de paramètres testées sur du bruit) plutôt que sur une
arithmétique exacte — comme le test du critère de sortie de la Phase 1,
il n'est pas garanti de passer du premier coup avec les constantes de
départ. Si l'assertion `meanInSample > meanOutOfSample` échoue :
- Vérifier d'abord que ce n'est pas une régression réelle dans
  `runWalkForward` (Task 1) — relire `test/walkForward.test.ts`, doit
  toujours passer.
- Si `runWalkForward` fonctionne correctement, ajuster la richesse du
  bruit (`stepScale`) ou la taille de la grille (`buildParamGrid`) plutôt
  que d'affaiblir l'assertion — l'effet doit être robuste avec une grille
  suffisamment riche (48 combinaisons est un point de départ raisonnable,
  pas une valeur garantie).
- Le nombre de folds (`trainBars=60, testBars=20` sur 200 barres → 7
  folds attendus) peut aussi être augmenté pour stabiliser la moyenne.

Expected une fois calibré : PASS (1 test)

- [ ] **Step 3: Suite complète et typecheck**

Run: `npm test`
Expected : tous les tests passent (Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4)

Run: `npm run typecheck`
Expected : aucune erreur

- [ ] **Step 4: Mettre à jour `README.md`**

- Mettre à jour le titre/intro pour refléter que la Phase 4 est terminée
  (rester concis, dans le style existant).
- Mettre à jour le nombre de tests dans la section Démarrage avec le
  total réel obtenu à l'étape 3 (lire la ligne `# tests N` dans la sortie
  de `npm test`, ne pas deviner le nombre).
- Ajouter au bloc Structure : `src/backtest/metrics.ts` et
  `src/backtest/walkForward.ts` (une ligne de description chacun, dans le
  style des entrées existantes).
- Ajouter une ligne au tableau « Ce que le code garantit » pour
  l'invariant de la Phase 4, citant `test/phase4.test.ts` par son nom
  littéral, dans le même format que les lignes Phase 2/Phase 3.
- Mettre à jour la section Suite : marquer la Phase 4 terminée, lier au
  test `test/phase4.test.ts`, et mettre à jour la liste « Hors
  périmètre, reporté » (garder les points encore non traités : slippage
  par ATR, ordres limites, live-runner, stop-loss réellement exécuté,
  backtest sur l'univers réel des 20 paires ; ajouter Sharpe/drawdown et
  fenêtre ancrée/croissante comme nouveaux points hors périmètre issus de
  la spec Phase 4).

- [ ] **Step 5: Commit**

```bash
git add test/phase4.test.ts README.md
git commit -m "$(cat <<'EOF'
test(phase4): critère de sortie — le walk-forward révèle l'overfitting

Bruit pseudo-aléatoire déterministe (LCG, graine fixe) + grille de 48
combinaisons fast/slow pour createMaCrossover : le rendement moyen
in-sample dépasse le rendement moyen hors échantillon sur les mêmes
paramètres — la signature attendue du biais de sélection multiple sur
des données sans edge réel. README mis à jour pour la Phase 4.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — chaque section de
`docs/superpowers/specs/2026-08-24-phase4-walk-forward-design.md` est
couverte : §1 métriques + §2 `runWalkForward` → Task 1 ; §3 test du
critère de sortie → Task 2.

**Décomposition plus légère que les phases précédentes** — 2 tâches au
lieu de 3-4, `metrics.ts` (une seule fonction, aucune surface de test
indépendante significative au-delà d'être consommée par `walkForward.ts`)
regroupé dans la même tâche que `walkForward.ts` plutôt qu'isolé — moins
de cycles de revue pour un chantier plus petit que les phases précédentes.

**Cohérence des types** — vérifié que `WalkForwardConfig<P>`/
`FoldResult<P>`/`WalkForwardResult<P>` (Task 1) sont utilisés
identiquement en Task 2 (`strategyFactory: MaCrossoverParams => Strategy`,
`paramGrid: MaCrossoverParams[]`) ; `totalReturn` (Task 1) a la signature
`(readonly EquityPoint[], number) => number` utilisée identiquement dans
`walkForward.ts`.

**Aucun placeholder** — chaque step contient le code complet à écrire.
Le seul point de vérification manuelle (Task 2, Step 2) porte sur un
effet statistique déjà justifié théoriquement (biais de sélection
multiple), avec une piste de diagnostic explicite distinguant une
régression réelle d'un besoin de recalibrage, comme pour le test
équivalent de la Phase 1.
