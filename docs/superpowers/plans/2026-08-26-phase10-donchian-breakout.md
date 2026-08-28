# Phase 10 — Breakout Donchian/Turtle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implémenter une stratégie mono-paire de breakout Donchian/Turtle (cassure du plus haut/plus bas sur une fenêtre glissante, mécanisme différent d'une moyenne mobile ou d'un classement relatif), puis évaluer honnêtement par walk-forward si ce mécanisme, indépendant des deux familles directionnelles déjà écartées (suivi de tendance, momentum cross-sectionnel), produit un edge sur les données réelles.

**Architecture:** Nouveau fichier `src/strategy/donchianBreakout.ts` exportant `createDonchianBreakout`, une stratégie mono-paire classique assemblée via `combineStrategies` existant (même pattern que `ma-crossover`/`mean-reversion`) — pas le pattern multi-paires dédié de la Phase 9. Un script d'analyse non testé (`scripts/tune-donchian-breakout.ts`) évalue une grille exploratoire de 3 combinaisons `(entryPeriod, exitPeriod)` par walk-forward sur les 20 paires réelles, calibrée directement en bougies 4h pour rester loin de la limite `TEST_BARS=180` (leçon de la revue finale Phase 9).

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas de build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-26-phase10-donchian-breakout-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- tsconfig strict : `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée.
- Commentaires et messages d'erreur en français.
- La stratégie doit rester pure : pas d'état mutable entre appels de `decide()`, pas d'I/O, pas de `Math.random` — contrat imposé par `src/strategy/types.ts`.
- Aucun look-ahead : le calcul du canal (`highestHigh`/`lowestLow`) ne lit jamais la barre courante — boucle `ago` de `1` à `period` inclus, jamais `ago=0`. Si le canal incluait la barre courante, `close(0) > highestHigh` serait structurellement impossible (`close(0) <= high(0)` toujours).
- Pas de `stopDistance` / sizing par risque en v1 — sizing fraction fixe existant (`sizeBuyOrder`), comme `ma-crossover`/`mean-reversion`.
- `entryPeriod`/`exitPeriod` : 2 degrés de liberté, aucune contrainte `exitPeriod < entryPeriod` imposée par le code (la grille testée respecte ce ratio par construction, pas par validation).
- Grille de la Task 2 calibrée directement en bougies 4h — **ne pas** convertir naïvement une référence journalière (`entryPeriod≈330` en bougies 4h dépasserait `TEST_BARS=180` et ferait échouer `runBacktest` immédiatement, `length < warmup+2`).
- Le script d'évaluation (Task 2) n'est pas testé automatiquement — même catégorie que `scripts/run-walkforward.ts` et les autres scripts `tune-*`.
- Cette phase explore une **nouvelle famille de stratégie** (grille exploratoire, sélection walk-forward réelle), pas un raffinement à 0 degré de liberté d'un candidat déjà validé.

---

## Task 1: Stratégie `createDonchianBreakout`

**Files:**
- Create: `src/strategy/donchianBreakout.ts`
- Test: `test/donchianBreakout.test.ts`

**Interfaces:**
- Consumes: `BarView`, `Intent`, `Strategy`, `StrategyContext`, `Position` (tous existants, `src/strategy/types.ts`, inchangés).
- Produces: `DonchianBreakoutParams { symbol: string; entryPeriod: number; exitPeriod: number }`, `createDonchianBreakout(params: DonchianBreakoutParams) => Strategy`. Consommé par Task 2 (via `combineStrategies`).

- [ ] **Step 1: Écrire le fichier de test complet (échoue — le module n'existe pas encore)**

Créer `test/donchianBreakout.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createDonchianBreakout } from '../src/strategy/donchianBreakout.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400; // 4h en secondes, comme test/maCrossover.test.ts

interface Bar {
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/**
 * Contrairement au helper à un seul symbole des tests existants
 * (open=high=low=close), cette stratégie lit high/low distincts de close
 * pour calculer le canal — nécessite un helper dédié avec OHLC indépendants.
 */
function seriesFromOHLC(bars: readonly Bar[]): BarSeries {
  const c = emptyColumns();
  bars.forEach((bar, i) => {
    c.time.push(i * STEP);
    c.open.push(bar.close);
    c.high.push(bar.high);
    c.low.push(bar.low);
    c.close.push(bar.close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(SYMBOL, 240, c);
}

function ctxFor(bars: readonly Bar[], position?: Position): StrategyContext {
  const series = seriesFromOHLC(bars);
  const view = new BarView(series, series.length - 1);
  const positions = new Map<string, Position>();
  if (position) positions.set(SYMBOL, position);
  return { views: new Map([[SYMBOL, view]]), positions, now: view.time(0) };
}

test('createDonchianBreakout : lève si entryPeriod est invalide (non entier)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 2.5, exitPeriod: 2 }),
    /entryPeriod/,
  );
});

test('createDonchianBreakout : lève si entryPeriod est invalide (< 1)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 0, exitPeriod: 2 }),
    /entryPeriod/,
  );
});

test('createDonchianBreakout : lève si exitPeriod est invalide (non entier)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 1.5 }),
    /exitPeriod/,
  );
});

test('createDonchianBreakout : lève si exitPeriod est invalide (< 1)', () => {
  assert.throws(
    () => createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 0 }),
    /exitPeriod/,
  );
});

test('createDonchianBreakout : warmup = max(entryPeriod, exitPeriod) quand exitPeriod plus grand, params exposés', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 5 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { entryPeriod: 3, exitPeriod: 5 });
});

test('createDonchianBreakout : warmup = max(entryPeriod, exitPeriod) quand entryPeriod plus grand', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 5, exitPeriod: 2 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { entryPeriod: 5, exitPeriod: 2 });
});

// Canal d'entrée (entryPeriod=3) sur les bougies précédentes (ago=1,2,3) :
// plus-haut = max(10.2, 10.5, 10.0) = 10.5.
const ENTRY_CHANNEL_BARS: Bar[] = [
  { high: 10.0, low: 9.0, close: 9.5 },
  { high: 10.5, low: 9.2, close: 10.0 },
  { high: 10.2, low: 9.5, close: 10.0 },
];

test("decide : cassure haussière (close > plus-haut du canal) sans position -> enter", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...ENTRY_CHANNEL_BARS, { high: 11.0, low: 10.5, close: 11.0 }];
  const intents = s.decide(ctxFor(bars));
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test("decide : pas d'entrée si close égal au plus-haut du canal (cassure non stricte)", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...ENTRY_CHANNEL_BARS, { high: 10.5, low: 10.0, close: 10.5 }];
  assert.equal(s.decide(ctxFor(bars))[0]?.kind, 'hold');
});

test("decide : pas d'entrée si close inférieur au plus-haut du canal", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...ENTRY_CHANNEL_BARS, { high: 9.0, low: 8.5, close: 9.0 }];
  assert.equal(s.decide(ctxFor(bars))[0]?.kind, 'hold');
});

test("decide : pas d'entrée si une position est déjà ouverte, même en cas de cassure haussière", () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  // Même cassure haussière que le premier test (close=11 > 10.5), mais une
  // position est déjà ouverte : pas de ré-entrée. Le plus-bas des 2
  // dernières bougies précédentes (ago=1,2 -> low=9.5, 9.2) vaut 9.2 ;
  // close=11 n'est pas < 9.2, donc pas de sortie non plus -> hold.
  const bars = [...ENTRY_CHANNEL_BARS, { high: 11.0, low: 10.5, close: 11.0 }];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  assert.equal(s.decide(ctxFor(bars, position))[0]?.kind, 'hold');
});

test('decide : le canal exclut la barre courante (un extremum sur la barre courante ne compte pas)', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  // Même canal que le premier test (plus-haut=10.5 sur les 3 bougies
  // précédentes), mais la bougie courante a un plus-haut extrême (50.0).
  // Si le canal incluait ago=0, le plus-haut deviendrait 50.0 et
  // close=11.0 ne casserait pas (11 < 50) -> hold à tort. Avec l'exclusion
  // correcte de la barre courante, le canal reste 10.5 -> enter.
  const bars = [...ENTRY_CHANNEL_BARS, { high: 50.0, low: 10.6, close: 11.0 }];
  const intents = s.decide(ctxFor(bars));
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

// Canal de sortie (exitPeriod=2) sur les bougies précédentes (ago=1,2) :
// plus-bas = min(9.0, 8.5) = 8.5.
const EXIT_CHANNEL_BARS: Bar[] = [
  { high: 10.0, low: 9.0, close: 9.5 },
  { high: 10.0, low: 8.5, close: 9.0 },
];
const HELD_POSITION: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 9.5, entryTime: 0 };

test('decide : cassure baissière (close < plus-bas du canal) avec position -> exit', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...EXIT_CHANNEL_BARS, { high: 8.5, low: 7.5, close: 8.0 }];
  const intents = s.decide(ctxFor(bars, HELD_POSITION));
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test('decide : pas de sortie si close égal au plus-bas du canal (cassure non stricte)', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...EXIT_CHANNEL_BARS, { high: 9.0, low: 8.5, close: 8.5 }];
  assert.equal(s.decide(ctxFor(bars, HELD_POSITION))[0]?.kind, 'hold');
});

test('decide : pas de sortie si close supérieur au plus-bas du canal', () => {
  const s = createDonchianBreakout({ symbol: SYMBOL, entryPeriod: 3, exitPeriod: 2 });
  const bars = [...EXIT_CHANNEL_BARS, { high: 9.5, low: 9.0, close: 9.2 }];
  assert.equal(s.decide(ctxFor(bars, HELD_POSITION))[0]?.kind, 'hold');
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/donchianBreakout.test.ts`
Expected: FAIL — `src/strategy/donchianBreakout.ts` n'existe pas encore (erreur de résolution de module).

- [ ] **Step 3: Implémenter `createDonchianBreakout`**

Créer `src/strategy/donchianBreakout.ts` :

```ts
/**
 * Breakout Donchian ("Turtle") : achète une cassure du plus haut sur
 * `entryPeriod` bougies, vend une cassure du plus bas sur `exitPeriod`
 * bougies (fenêtre de sortie plus courte que l'entrée, comme le système
 * Turtle historique — réduit le va-et-vient par rapport à un canal
 * symétrique).
 *
 * Mécanisme différent d'un croisement de moyennes mobiles
 * (`ma-crossover`) ou d'un classement relatif
 * (`cross-sectional-momentum`) : compare le prix courant à un extremum
 * récent, sans lissage ni classement entre paires.
 *
 * `decide()` recalcule tout à chaque appel depuis la `BarView` déjà
 * disponible, sans état interne persistant (voir le contrat de pureté de
 * `Strategy.decide`, src/strategy/types.ts).
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';

export interface DonchianBreakoutParams {
  readonly symbol: string;
  readonly entryPeriod: number;
  readonly exitPeriod: number;
}

/**
 * Plus haut des `period` bougies PRÉCÉDENTES (ago=1..period), en excluant
 * la bougie courante (ago=0) — sinon `close(0) > highestHigh` serait
 * structurellement impossible, puisque close(0) <= high(0) toujours.
 */
function highestHigh(view: BarView, period: number): number {
  let max = -Infinity;
  for (let ago = 1; ago <= period; ago++) {
    const h = view.high(ago);
    if (h > max) max = h;
  }
  return max;
}

/** Symétrique de highestHigh() pour le plus bas, même exclusion de ago=0. */
function lowestLow(view: BarView, period: number): number {
  let min = Infinity;
  for (let ago = 1; ago <= period; ago++) {
    const l = view.low(ago);
    if (l < min) min = l;
  }
  return min;
}

export function createDonchianBreakout(params: DonchianBreakoutParams): Strategy {
  const { symbol, entryPeriod, exitPeriod } = params;
  if (!Number.isInteger(entryPeriod) || entryPeriod < 1) {
    throw new RangeError(`entryPeriod invalide : ${entryPeriod}`);
  }
  if (!Number.isInteger(exitPeriod) || exitPeriod < 1) {
    throw new RangeError(`exitPeriod invalide : ${exitPeriod}`);
  }

  const warmup = Math.max(entryPeriod, exitPeriod);

  return {
    name: 'donchian-breakout',
    warmup,
    params: { entryPeriod, exitPeriod },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const hasPosition = ctx.positions.has(symbol);
      const price = view.close(0);

      if (!hasPosition) {
        const entryHigh = highestHigh(view, entryPeriod);
        if (price > entryHigh) {
          return [{
            kind: 'enter',
            symbol,
            reason: `cassure haussière : prix=${price.toFixed(4)} > plus-haut(${entryPeriod})=${entryHigh.toFixed(4)}`,
          }];
        }
      }
      if (hasPosition) {
        const exitLow = lowestLow(view, exitPeriod);
        if (price < exitLow) {
          return [{
            kind: 'exit',
            symbol,
            reason: `cassure baissière : prix=${price.toFixed(4)} < plus-bas(${exitPeriod})=${exitLow.toFixed(4)}`,
          }];
        }
      }
      return [{ kind: 'hold' }];
    },
  };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/donchianBreakout.test.ts`
Expected: PASS — les 14 tests (4 validations + 2 warmup/params + 5 comportements d'entrée + 3 comportements de sortie) sont verts.

- [ ] **Step 5: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (nouveaux et existants)

- [ ] **Step 6: Commit**

```bash
git add src/strategy/donchianBreakout.ts test/donchianBreakout.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): breakout Donchian/Turtle

Nouvelle stratégie mono-paire : achète une cassure du plus haut sur
entryPeriod bougies, vend une cassure du plus bas sur exitPeriod
bougies (fenêtre de sortie plus courte, comme le système Turtle
historique). Mécanisme différent d'une moyenne mobile ou d'un
classement relatif — troisième famille testée après le suivi de
tendance et le momentum cross-sectionnel, tous deux écartés. Le canal
exclut toujours la barre courante (ago=1..period). Pas de stop ATR en
v1 (Approche minimale, discipline "une variable à la fois") — voir
docs/superpowers/specs/2026-08-26-phase10-donchian-breakout-design.md
EOF
)"
```

---

## Task 2: Évaluation walk-forward et documentation du résultat

**Files:**
- Create: `scripts/tune-donchian-breakout.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createDonchianBreakout` (Task 1), `combineStrategies`, `runWalkForward`, `loadUniverse`, `UNIVERSE_SYMBOLS`, `DEFAULT_FEES`, `BacktestOptions` (tous existants, inchangés).

- [ ] **Step 1: Implémenter le script d'évaluation**

Créer `scripts/tune-donchian-breakout.ts` :

```ts
/**
 * Évalue par walk-forward le breakout Donchian/Turtle (Phase 10) sur les 20
 * paires réelles de l'univers. Grille exploratoire (pas 0-DoF — découverte
 * d'une nouvelle famille, comme le premier passage sur le suivi de tendance
 * et la Phase 9), calibrée directement en bougies 4h avec une marge
 * confortable sous TEST_BARS=180 : convertir naïvement la référence
 * historique (20/55 JOURS) donnerait entryPeriod≈330 bougies 4h, largement
 * supérieur à TEST_BARS et ferait échouer runBacktest immédiatement
 * (length < warmup+2) — même piège que la dilution repérée en Phase 9.
 *
 * Usage : node --experimental-strip-types scripts/tune-donchian-breakout.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createDonchianBreakout } from '../src/strategy/donchianBreakout.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface DonchianParams {
  readonly entryPeriod: number;
  readonly exitPeriod: number;
}

// Paires alignées (ratio ~3:1, convention Turtle historique) plutôt qu'un
// produit cartésien complet — voir la spec pour la justification.
const PARAM_GRID: DonchianParams[] = [
  { entryPeriod: 30, exitPeriod: 10 },
  { entryPeriod: 60, exitPeriod: 20 },
  { entryPeriod: 120, exitPeriod: 40 },
];

const BACKTEST_OPTIONS: BacktestOptions = {
  initialCash: 10000,
  fees: DEFAULT_FEES,
  slippageBps: 5,
  maxConcurrentPositions: 5,
  riskPerTradePct: 0.01,
};

const TRAIN_BARS = 1095;
const TEST_BARS = 180;

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

  const start = Date.now();
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: PARAM_GRID,
    strategyFactory: (p) =>
      combineStrategies(UNIVERSE_SYMBOLS.map((symbol) => createDonchianBreakout({ symbol, ...p }))),
    backtestOptions: BACKTEST_OPTIONS,
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

  console.log(`\n=== donchian-breakout ===`);
  console.log(`${PARAM_GRID.length} jeux de paramètres, ${n} folds, ${elapsed}s`);
  console.log(`Moyenne in-sample        : ${(meanIn * 100).toFixed(2)}%`);
  console.log(`Moyenne hors échantillon : ${(meanOut * 100).toFixed(2)}%`);
  console.log(`Folds positifs hors échantillon : ${winFolds}/${n}`);
  console.log(`Meilleur/pire fold hors échantillon : ${(best * 100).toFixed(2)}% / ${(worst * 100).toFixed(2)}%`);
  for (const fold of result.folds) {
    console.log(
      `  fold ${fold.foldIndex} : entryPeriod=${fold.selectedParams.entryPeriod} ` +
        `exitPeriod=${fold.selectedParams.exitPeriod} ` +
        `in=${(fold.inSampleReturn * 100).toFixed(2)}% out=${(fold.outOfSampleReturn * 100).toFixed(2)}%`,
    );
  }
}

await main();
```

- [ ] **Step 2: Lancer l'évaluation**

Run: `node --experimental-strip-types scripts/tune-donchian-breakout.ts`
Expected: le script s'exécute sans erreur et imprime le rendement moyen
in-sample et hors-échantillon, le nombre de fenêtres gagnantes, le
meilleur/pire fold, et le détail par fold (quel `entryPeriod`/`exitPeriod`
a été sélectionné et son rendement).

- [ ] **Step 3: Documenter le résultat dans le README, quel qu'il soit**

Dans la section « Recherche de stratégie (données réelles) » du
`README.md`, ajouter une puce après la dernière puce existante (momentum
cross-sectionnel, Phase 9) :

- Si au moins une combinaison `(entryPeriod, exitPeriod)` sélectionnée par
  walk-forward produit un rendement hors-échantillon moyen clairement
  positif, avec un écart in-sample/hors-échantillon raisonnable (pas de
  signature de sur-optimisation comme les deux familles précédentes) :
  documenter ce résultat comme un nouveau candidat potentiel, avec les
  chiffres exacts (rendement moyen, fenêtres gagnantes, quelle combinaison
  a été sélectionnée le plus souvent par fold).
- Sinon (neutre, négatif, ou signature de sur-optimisation nette) :
  documenter honnêtement l'échec de cette troisième famille directionnelle,
  avec les chiffres exacts obtenus, dans le même esprit que les constats
  déjà faits sur le suivi de tendance et le momentum cross-sectionnel.
- Dans les deux cas, vérifier explicitement (comme la leçon de la revue
  finale de la Phase 9 l'impose) qu'aucune combinaison sélectionnée ne
  laisse trop peu de barres de décision dans une fenêtre de test de 180
  bougies (`180 - max(entryPeriod, exitPeriod) - 1` doit rester très
  supérieur à quelques barres) — avec la grille de cette phase
  (`entryPeriod` max = 120), cela laisse au moins 59 barres de décision par
  fenêtre de test, largement suffisant ; le mentionner explicitement dans
  le README plutôt que de le supposer silencieusement.

Dans tous les cas, le texte doit rapporter les chiffres réels imprimés par
le script committé — jamais une estimation.

Ajouter aussi une ligne dans la liste « Structure » (section `##
Structure`), juste après la ligne
`scripts/tune-cross-sectional-momentum.ts` existante :

```
scripts/tune-donchian-breakout.ts Évalue le breakout Donchian/Turtle par walk-forward (grille calibrée en bougies 4h, 3 combinaisons entryPeriod/exitPeriod alignées)
```

Et une ligne dans la liste des modules de `src/strategy/` (section `##
Structure`), juste après la ligne `src/strategy/crossSectionalMomentum.ts`
existante :

```
src/strategy/donchianBreakout.ts Breakout Donchian/Turtle : cassure du plus haut (entrée) ou du plus bas (sortie) sur une fenêtre glissante, canal exclut toujours la barre courante
```

- [ ] **Step 4: Vérifier que rien n'est cassé**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (ce script n'a pas de test dédié — pas
plus que les autres scripts d'analyse du projet)

- [ ] **Step 5: Commit**

```bash
git add scripts/tune-donchian-breakout.ts README.md
git commit -m "$(cat <<'EOF'
feat(scripts): évalue le breakout Donchian par walk-forward

Grille exploratoire (3 combinaisons entryPeriod/exitPeriod alignées,
ratio ~3:1, calibrées en bougies 4h avec marge sous TEST_BARS=180).
Résultat consigné honnêtement dans le README, qu'il soit positif,
neutre, ou négatif.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — §Architecture (`donchianBreakout.ts` nouveau,
stratégie mono-paire via `combineStrategies`, script d'évaluation à un
seul appel `runWalkForward`) → Task 1 et Task 2 respectivement ;
§Décisions actées (canal excluant la barre courante, warmup =
max(entryPeriod, exitPeriod), pas de stop ATR, grille calibrée en bougies
4h avec marge) → toutes reprises explicitement dans le code de Task 1 et
les commentaires de Task 2.

**Décomposition** — 2 tâches : Task 1 (code de production, testé) avant
Task 2 (évaluation, dépend du code de Task 1). Ordre respecte la
dépendance, comme les Phases 6-9.

**Cohérence des types** — `DonchianBreakoutParams { symbol: string;
entryPeriod: number; exitPeriod: number }` (Task 1) utilisé identiquement
dans Task 2 (`createDonchianBreakout({ symbol, ...p })` avec `p:
DonchianParams { entryPeriod: number; exitPeriod: number }` — les deux
champs numériques correspondent champ à champ). `Strategy`/
`StrategyContext`/`Intent`/`Position`/`BarView` importés dans le test
(Task 1) correspondent aux types déjà exportés de `src/strategy/types.ts`,
inchangés. `combineStrategies` (Task 2) consomme `readonly Strategy[]`,
correspondance avec le tableau produit par
`UNIVERSE_SYMBOLS.map((symbol) => createDonchianBreakout({ symbol, ...p }))`
vérifiée. `fold.selectedParams.entryPeriod`/`.exitPeriod` (Task 2) : `P =
DonchianParams` inféré depuis `paramGrid: DonchianParams[]` et
`strategyFactory: (p: DonchianParams) => Strategy` — pas de cast
nécessaire.

**Aucun placeholder** — chaque step contient le code complet (stratégie,
14 tests, script d'évaluation). Task 2 Step 3 ne prescrit pas un résultat
à l'avance, il prescrit la procédure de documentation honnête dans les
deux cas, plus une vérification explicite anti-dilution héritée de la
Phase 9 — ce n'est pas un placeholder, c'est la nature même d'une
évaluation dont le résultat n'est pas encore connu au moment d'écrire le
plan (même formulation que les Phases 8/9, déjà validées par le projet).
