# Phase 9 — Momentum cross-sectionnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implémenter une nouvelle stratégie multi-paires dédiée qui classe l'univers de 20 paires par rendement de formation, détient les `topN` meilleures, rebalancée une fois par semaine — puis évaluer honnêtement par walk-forward si ce mécanisme, indépendant de mean-reversion, produit un edge sur les données réelles.

**Architecture:** Nouveau fichier `src/strategy/crossSectionalMomentum.ts` exportant `createCrossSectionalMomentum`, qui lit directement `ctx.views` (déjà multi-paires par construction) plutôt que d'être combiné mono-pair par mono-pair via `combineStrategies`. Un script d'analyse non testé (`scripts/tune-cross-sectional-momentum.ts`) évalue la grille exploratoire par walk-forward sur les 20 paires réelles, avec un appel `runWalkForward` séparé par valeur de `topN` (couplage avec `BacktestOptions.maxConcurrentPositions`, voir spec).

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas de build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-26-phase9-cross-sectional-momentum-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- tsconfig strict : `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée.
- Commentaires et messages d'erreur en français.
- La stratégie doit rester pure : pas d'état mutable entre appels de `decide()`, pas d'I/O, pas de `Math.random` — contrat imposé par `src/strategy/types.ts`.
- Aucun look-ahead : la détection de rebalancement et le calcul de rendement de formation ne lisent que `view.time(ago>=0)` et `view.close(ago>=0)`, jamais une barre future.
- `topN ∈ {3, 5, 7}` doit être couplé à `BacktestOptions.maxConcurrentPositions` dans le script d'évaluation (Task 2) — `sizeBuyOrder` (`src/backtest/runner.ts`) dimensionne chaque position en fraction de `equity/maxConcurrentPositions`, donc `topN < maxConcurrentPositions` sous-déploierait le capital.
- Le script d'évaluation (Task 2) n'est pas testé automatiquement — même catégorie que `scripts/run-walkforward.ts` et `scripts/tune-mean-reversion-*.ts`.
- Cette phase explore une **nouvelle famille de stratégie** (grille exploratoire, sélection walk-forward réelle sur plusieurs `lookbackPeriod`), pas un raffinement à 0 degré de liberté d'un candidat déjà validé — ne pas restreindre le `paramGrid` à un seul point comme dans les scripts `tune-mean-reversion-*`.

---

## Task 1: Stratégie `createCrossSectionalMomentum`

**Files:**
- Create: `src/strategy/crossSectionalMomentum.ts`
- Test: `test/crossSectionalMomentum.test.ts`

**Interfaces:**
- Consumes: `Intent`, `Strategy`, `StrategyContext`, `Position`, `BarView` (tous existants, `src/strategy/types.ts`, inchangés).
- Produces: `CrossSectionalMomentumParams { lookbackPeriod: number; topN: number }`, `createCrossSectionalMomentum(params: CrossSectionalMomentumParams) => Strategy`. Consommé par Task 2.

- [ ] **Step 1: Écrire le fichier de test complet (échoue — le module n'existe pas encore)**

Créer `test/crossSectionalMomentum.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createCrossSectionalMomentum } from '../src/strategy/crossSectionalMomentum.ts';

const STEP = 14_400; // 4h en secondes, comme test/meanReversion.test.ts
const SERIES_LENGTH = 43; // assez pour lookbackPeriod=5 et une barre de rebalancement à t=42

/**
 * Série plate à 100, sauf la dernière barre (index 42) fixée à `current`.
 * Avec lookbackPeriod=5, le rendement de formation lu à t=42 est
 * close(0)/close(5)-1 = current/closes[37]-1 = current/100-1.
 */
function flatCloses(current: number): number[] {
  const closes = new Array(SERIES_LENGTH).fill(100);
  closes[SERIES_LENGTH - 1] = current;
  return closes;
}

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
  t: number,
  positions: ReadonlyMap<string, Position> = new Map(),
): StrategyContext {
  const views = new Map<string, BarView>();
  for (const [symbol, closes] of Object.entries(closesBySymbol)) {
    views.set(symbol, new BarView(seriesFrom(symbol, closes), t));
  }
  return { views, positions, now: t * STEP };
}

// t=42*STEP=604800 -> semaine 1 ; t=41*STEP=590400 -> semaine 0 : rebalancement.
// t=41 vs t=40 (576000) -> semaine 0 les deux : pas de rebalancement.
const FOUR_SYMBOL_UNIVERSE = {
  SYMA: flatCloses(130), // rendement(5) = +30 % -> rang 1
  SYMB: flatCloses(120), // rendement(5) = +20 % -> rang 2
  SYMC: flatCloses(110), // rendement(5) = +10 % -> rang 3
  SYMD: flatCloses(90), // rendement(5) = -10 % -> rang 4
};

test('createCrossSectionalMomentum : lève si lookbackPeriod est invalide (non entier)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 2.5, topN: 2 }),
    /lookbackPeriod/,
  );
});

test('createCrossSectionalMomentum : lève si lookbackPeriod est invalide (< 1)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 0, topN: 2 }),
    /lookbackPeriod/,
  );
});

test('createCrossSectionalMomentum : lève si topN est invalide (non entier)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 1.5 }),
    /topN/,
  );
});

test('createCrossSectionalMomentum : lève si topN est invalide (< 1)', () => {
  assert.throws(
    () => createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 0 }),
    /topN/,
  );
});

test('createCrossSectionalMomentum : warmup vaut lookbackPeriod, params exposés', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { lookbackPeriod: 5, topN: 2 });
});

test('decide : hors barre de rebalancement, hold même si le classement changerait la composition', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  // SYMC détenu alors qu'il ne serait pas dans le top 2 si on rebalançait —
  // ne doit rien changer tant qu'on n'est pas sur une barre de rebalancement.
  const position: Position = { symbol: 'SYMC', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 };
  const positions = new Map([['SYMC', position]]);
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 41, positions);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : sur une barre de rebalancement, sélectionne le top N dans l\'ordre du classement', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  // Aucune position détenue -> deux entrées, SYMA (+30%) avant SYMB (+20%).
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 42);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'enter');
  assert.equal(intents[0]?.kind === 'enter' && intents[0].symbol, 'SYMA');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMB');
});

test('decide : sur une barre de rebalancement, sort les positions hors du nouveau top N avant les nouvelles entrées', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  // SYMB (rang 2, reste dans le top 2) et SYMD (rang 4, en sort) sont
  // détenus. Attendu : exit SYMD, puis enter SYMA. SYMB ne génère ni exit
  // ni enter (déjà détenu, reste dans le top 2 : pas de churn inutile).
  const positions = new Map<string, Position>([
    ['SYMB', { symbol: 'SYMB', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
    ['SYMD', { symbol: 'SYMD', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
  ]);
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 42, positions);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'exit');
  assert.equal(intents[0]?.kind === 'exit' && intents[0].symbol, 'SYMD');
  assert.equal(intents[1]?.kind, 'enter');
  assert.equal(intents[1]?.kind === 'enter' && intents[1].symbol, 'SYMA');
});

test('decide : une position déjà détenue et toujours dans le top N ne génère ni exit ni enter', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 2 });
  const positions = new Map<string, Position>([
    ['SYMA', { symbol: 'SYMA', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
    ['SYMB', { symbol: 'SYMB', side: 'long', quantity: 1, entryPrice: 100, entryTime: 0 }],
  ]);
  const ctx = multiCtx(FOUR_SYMBOL_UNIVERSE, 42, positions);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('decide : univers plus petit que topN détient tout ce qui est disponible, sans exception', () => {
  const s = createCrossSectionalMomentum({ lookbackPeriod: 5, topN: 5 });
  const twoSymbolUniverse = { SYMA: flatCloses(130), SYMB: flatCloses(120) };
  const ctx = multiCtx(twoSymbolUniverse, 42);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 2);
  assert.equal(intents.every((i) => i.kind === 'enter'), true);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/crossSectionalMomentum.test.ts`
Expected: FAIL — `src/strategy/crossSectionalMomentum.ts` n'existe pas encore (erreur de résolution de module).

- [ ] **Step 3: Implémenter `createCrossSectionalMomentum`**

Créer `src/strategy/crossSectionalMomentum.ts` :

```ts
/**
 * Momentum cross-sectionnel : classe l'univers de paires par rendement de
 * formation, détient les `topN` meilleures, rebalancé une fois par semaine.
 *
 * Contrairement aux stratégies mono-pair assemblées via `combineStrategies`,
 * celle-ci lit tout `ctx.views` directement à chaque appel — le classement
 * n'a de sens que relativement à l'univers complet, pas paire par paire.
 *
 * Détection du rebalancement hebdomadaire : purement fonction de `ctx`
 * (franchissement de frontière de semaine epoch entre la barre précédente
 * et la barre courante), sans aucun état mutable — le contrat `Strategy`
 * (src/strategy/types.ts) interdit à une stratégie de retenir un compteur
 * de barres entre deux appels de `decide()`.
 */

import type { Intent, Strategy, StrategyContext } from './types.ts';

export interface CrossSectionalMomentumParams {
  readonly lookbackPeriod: number;
  readonly topN: number;
}

const WEEK_SECONDS = 7 * 24 * 3600;

function weekOf(time: number): number {
  return Math.floor(time / WEEK_SECONDS);
}

export function createCrossSectionalMomentum(params: CrossSectionalMomentumParams): Strategy {
  const { lookbackPeriod, topN } = params;
  if (!Number.isInteger(lookbackPeriod) || lookbackPeriod < 1) {
    throw new RangeError(`lookbackPeriod invalide : ${lookbackPeriod}`);
  }
  if (!Number.isInteger(topN) || topN < 1) {
    throw new RangeError(`topN invalide : ${topN}`);
  }

  return {
    name: 'cross-sectional-momentum',
    warmup: lookbackPeriod,
    params: { lookbackPeriod, topN },
    decide(ctx: StrategyContext): readonly Intent[] {
      const symbols = [...ctx.views.keys()];
      if (symbols.length === 0) return [{ kind: 'hold' }];

      const firstView = ctx.views.get(symbols[0]!)!;
      const isRebalanceBar = weekOf(ctx.now) !== weekOf(firstView.time(1));
      if (!isRebalanceBar) return [{ kind: 'hold' }];

      const ranked = symbols
        .map((symbol) => {
          const view = ctx.views.get(symbol)!;
          const formationReturn = view.close(0) / view.close(lookbackPeriod) - 1;
          return { symbol, formationReturn };
        })
        .sort((a, b) => b.formationReturn - a.formationReturn);

      const target = ranked.slice(0, topN);
      const targetSymbols = new Set(target.map((r) => r.symbol));
      const currentlyHeld = symbols.filter((s) => ctx.positions.has(s));

      const intents: Intent[] = [];
      for (const symbol of currentlyHeld) {
        if (!targetSymbols.has(symbol)) {
          intents.push({
            kind: 'exit',
            symbol,
            reason: `momentum cross-sectionnel : ${symbol} sort du top ${topN}`,
          });
        }
      }
      target.forEach((r, i) => {
        if (!ctx.positions.has(r.symbol)) {
          intents.push({
            kind: 'enter',
            symbol: r.symbol,
            reason:
              `momentum cross-sectionnel : rang ${i + 1}/${topN}, ` +
              `rendement(${lookbackPeriod})=${(r.formationReturn * 100).toFixed(2)}%`,
          });
        }
      });

      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/crossSectionalMomentum.test.ts`
Expected: PASS — les 11 tests (4 validations + warmup/params + 6 comportements de `decide`) sont verts.

- [ ] **Step 5: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (nouveaux et existants)

- [ ] **Step 6: Commit**

```bash
git add src/strategy/crossSectionalMomentum.ts test/crossSectionalMomentum.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): momentum cross-sectionnel

Nouvelle stratégie multi-paires dédiée : classe l'univers par
rendement de formation (lookbackPeriod), détient les topN meilleures,
rebalancement hebdomadaire détecté purement depuis ctx (franchissement
de frontière de semaine epoch, sans état mutable). Sorties émises
avant les entrées sur une barre de rebalancement, pour libérer des
slots de maxConcurrentPositions dans la même barre. Pas de filtre de
signe ni de stop ATR (Approche A de la spec) — voir
docs/superpowers/specs/2026-08-26-phase9-cross-sectional-momentum-design.md
EOF
)"
```

---

## Task 2: Évaluation walk-forward et documentation du résultat

**Files:**
- Create: `scripts/tune-cross-sectional-momentum.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createCrossSectionalMomentum` (Task 1), `runWalkForward`, `loadUniverse`, `UNIVERSE_SYMBOLS`, `DEFAULT_FEES`, `BacktestOptions` (tous existants, inchangés).

- [ ] **Step 1: Implémenter le script d'évaluation**

Créer `scripts/tune-cross-sectional-momentum.ts` :

```ts
/**
 * Évalue par walk-forward le momentum cross-sectionnel (Phase 9) sur les 20
 * paires réelles de l'univers. Contrairement aux scripts de réglage fin de
 * mean-reversion (Phases 6-8, qui re-testent un filtre optionnel sur un
 * candidat déjà validé avec une grille à 0 degré de liberté), cette phase
 * explore une nouvelle famille de stratégie depuis zéro — grille
 * exploratoire avec sélection walk-forward réelle, comme le premier passage
 * sur le suivi de tendance (voir run-walkforward.ts).
 *
 * `topN` est en dehors du paramGrid walk-forward : il doit être couplé à
 * `BacktestOptions.maxConcurrentPositions` (sizeBuyOrder dimensionne chaque
 * position en fraction de equity/maxConcurrentPositions — si topN <
 * maxConcurrentPositions, le capital serait sous-déployé). runWalkForward
 * n'accepte qu'un seul BacktestOptions fixe par appel, donc un appel séparé
 * est nécessaire par valeur de topN.
 *
 * Usage : node --experimental-strip-types scripts/tune-cross-sectional-momentum.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createCrossSectionalMomentum } from '../src/strategy/crossSectionalMomentum.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { BarSeries } from '../src/data/series.ts';

interface LookbackParams {
  readonly lookbackPeriod: number;
}

const TOP_N_VALUES = [3, 5, 7];
const LOOKBACK_PERIODS = [42, 84, 168]; // ~7j, 14j, 28j à 6 bougies 4h/jour

const TRAIN_BARS = 1095;
const TEST_BARS = 180;

function runForTopN(series: ReadonlyMap<string, BarSeries>, topN: number): void {
  const backtestOptions: BacktestOptions = {
    initialCash: 10000,
    fees: DEFAULT_FEES,
    slippageBps: 5,
    maxConcurrentPositions: topN,
    riskPerTradePct: 0.01,
  };

  const paramGrid: LookbackParams[] = LOOKBACK_PERIODS.map((lookbackPeriod) => ({ lookbackPeriod }));

  const start = Date.now();
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid,
    strategyFactory: (p) => createCrossSectionalMomentum({ lookbackPeriod: p.lookbackPeriod, topN }),
    backtestOptions,
  });

  let sumIn = 0;
  let sumOut = 0;
  let winFolds = 0;
  let best = -Infinity;
  let worst = Infinity;
  for (const fold of result.folds) {
    sumIn += fold.inSampleReturn;
    sumOut += fold.outOfSampleReturn;
    if (fold.outOfSampleReturn > 0) winFolds++;
    best = Math.max(best, fold.outOfSampleReturn);
    worst = Math.min(worst, fold.outOfSampleReturn);
  }
  const n = result.folds.length;
  const meanIn = sumIn / n;
  const meanOut = sumOut / n;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n=== momentum cross-sectionnel, topN=${topN} ===`);
  console.log(`${paramGrid.length} lookbackPeriod testés, ${n} folds, ${elapsed}s`);
  console.log(`Moyenne in-sample        : ${(meanIn * 100).toFixed(2)}%`);
  console.log(`Moyenne hors échantillon : ${(meanOut * 100).toFixed(2)}%`);
  console.log(`Folds positifs hors échantillon : ${winFolds}/${n}`);
  console.log(`Meilleur/pire fold hors échantillon : ${(best * 100).toFixed(2)}% / ${(worst * 100).toFixed(2)}%`);
  for (const fold of result.folds) {
    console.log(
      `  fold ${fold.foldIndex} : lookbackPeriod=${fold.selectedParams.lookbackPeriod} ` +
        `in=${(fold.inSampleReturn * 100).toFixed(2)}% out=${(fold.outOfSampleReturn * 100).toFixed(2)}%`,
    );
  }
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

  for (const topN of TOP_N_VALUES) {
    runForTopN(series, topN);
  }
}

await main();
```

- [ ] **Step 2: Lancer l'évaluation**

Run: `node --experimental-strip-types scripts/tune-cross-sectional-momentum.ts`
Expected: le script s'exécute sans erreur et imprime, pour chacune des 3
valeurs de `topN`, le rendement moyen in-sample et hors-échantillon, le
nombre de fenêtres gagnantes, le meilleur/pire fold, et le détail par fold
(quel `lookbackPeriod` a été sélectionné et son rendement).

- [ ] **Step 3: Documenter le résultat dans le README, quel qu'il soit**

Dans la section « Recherche de stratégie (données réelles) » du
`README.md`, ajouter une puce après la dernière puce existante (stop de
temps, Phase 8) :

- Si au moins une combinaison `(topN, lookbackPeriod sélectionné)` produit
  un rendement hors-échantillon moyen clairement positif, avec un écart
  in-sample/hors-échantillon raisonnable (pas de signature de
  sur-optimisation comme le suivi de tendance en ouverture de cette
  section) : documenter ce résultat comme un nouveau candidat potentiel,
  avec les chiffres exacts (rendement moyen, fenêtres gagnantes, quel
  `lookbackPeriod` a été sélectionné le plus souvent par fold).
- Sinon (neutre, négatif, ou signature de sur-optimisation nette entre
  in-sample et hors-échantillon) : documenter honnêtement l'échec de cette
  famille, avec les chiffres exacts obtenus pour les 3 valeurs de `topN`,
  dans le même esprit que le constat déjà fait sur le suivi de tendance.

Dans les deux cas, le texte doit rapporter les chiffres réels imprimés par
le script committé — jamais une estimation.

Ajouter aussi une ligne dans la liste « Structure » (section `##
Structure`), juste après la ligne
`scripts/tune-mean-reversion-timestop.ts` existante :

```
scripts/tune-cross-sectional-momentum.ts Évalue le momentum cross-sectionnel par walk-forward (topN couplé à maxConcurrentPositions, grille exploratoire lookbackPeriod)
```

Et une ligne dans la liste des modules de `src/strategy/` (section `##
Structure`), juste après la ligne `src/strategy/combineStrategies.ts`
existante :

```
src/strategy/crossSectionalMomentum.ts Momentum cross-sectionnel : classe l'univers par rendement de formation, détient le top N, rebalancement hebdomadaire
```

- [ ] **Step 4: Vérifier que rien n'est cassé**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (ce script n'a pas de test dédié — pas
plus que les autres scripts d'analyse du projet)

- [ ] **Step 5: Commit**

```bash
git add scripts/tune-cross-sectional-momentum.ts README.md
git commit -m "$(cat <<'EOF'
feat(scripts): évalue le momentum cross-sectionnel par walk-forward

Grille exploratoire (topN ∈ {3,5,7} × lookbackPeriod ∈ {42,84,168}),
un appel runWalkForward séparé par topN (couplé à
maxConcurrentPositions pour un déploiement de capital cohérent).
Résultat consigné honnêtement dans le README, qu'il soit positif,
neutre, ou négatif.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — §Architecture (`crossSectionalMomentum.ts`
nouveau, script d'évaluation avec appels séparés par `topN`) → Task 1 et
Task 2 respectivement ; §Décisions actées (rebalancement hebdo pur,
ordre exits-avant-enters, ordre interne par classement, pas de filtre de
signe, couplage `topN`/`maxConcurrentPositions`, cas dégénéré univers
plus petit que `topN`, pas de churn) → toutes reprises explicitement dans
le code de Task 1 et les tests associés.

**Décomposition** — 2 tâches : Task 1 (code de production, testé) avant
Task 2 (évaluation, dépend du code de Task 1). Ordre respecte la
dépendance, comme les phases précédentes (6, 7, 8).

**Cohérence des types** — `CrossSectionalMomentumParams { lookbackPeriod:
number; topN: number }` (Task 1) utilisé identiquement dans Task 2
(`createCrossSectionalMomentum({ lookbackPeriod: p.lookbackPeriod, topN
})`). `Strategy`/`StrategyContext`/`Intent`/`Position`/`BarView` importés
dans le test (Task 1) et dans le script (Task 2, indirectement via
`runWalkForward`/`BacktestOptions`) correspondent aux types déjà exportés
de `src/strategy/types.ts` et `src/backtest/runner.ts`, inchangés.
`WalkForwardConfig<P>`/`FoldResult<P>` (déjà existants,
`src/backtest/walkForward.ts`) : `P = LookbackParams` inféré depuis
`paramGrid: LookbackParams[]` et `strategyFactory: (p: LookbackParams) =>
Strategy` — pas de cast nécessaire sur `fold.selectedParams.lookbackPeriod`.

**Aucun placeholder** — chaque step contient le code complet (stratégie,
11 tests, script d'évaluation). Task 2 Step 3 ne prescrit pas un résultat
à l'avance, il prescrit la procédure de documentation honnête dans les
deux cas — ce n'est pas un placeholder, c'est la nature même d'une
évaluation dont le résultat n'est pas encore connu au moment d'écrire le
plan (même formulation que Phase 8 Step 3, déjà validée par le projet).
