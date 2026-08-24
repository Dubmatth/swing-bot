# Phase 6 — Mean-reversion avec confirmation de volume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un filtre de volume optionnel et rétrocompatible à `createMeanReversion`, puis évaluer honnêtement s'il améliore le seul candidat de stratégie ayant montré un edge réel jusqu'ici.

**Architecture:** Extension du fichier existant `src/strategy/meanReversion.ts` (même pattern que l'ajout du filtre de tendance) + un script d'analyse non testé qui compare le résultat walk-forward avec et sans le filtre.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas de build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-phase6-volume-confirmed-mean-reversion-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- tsconfig strict : `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée.
- Commentaires et messages d'erreur en français.
- Rétrocompatibilité stricte : sans `volumePeriod`/`volumeMultiplier`, le comportement de `createMeanReversion` doit rester identique à avant cette phase — tous les tests existants de `test/meanReversion.test.ts` doivent continuer à passer sans modification de leur côté (seuls des tests nouveaux sont ajoutés).
- `volumePeriod` et `volumeMultiplier` doivent être fournis ensemble ou pas du tout — jamais l'un sans l'autre.
- La grille de la Task 2 reste volontairement étroite (voir la spec, section « Décisions actées ») — ne pas l'élargir sans repasser par une décision explicite, pour ne pas reproduire le piège de sur-optimisation déjà rencontré deux fois dans cette recherche.

---

## Task 1: Filtre de volume dans `createMeanReversion`

**Files:**
- Modify: `src/strategy/meanReversion.ts`
- Test: `test/meanReversion.test.ts`

**Interfaces:**
- Produces: `MeanReversionParams` gagne deux champs optionnels `volumePeriod?: number` et `volumeMultiplier?: number`. `createMeanReversion` reste `(params: MeanReversionParams) => Strategy`, signature inchangée.

- [ ] **Step 1: Lire le fichier actuel avant modification**

Le fichier actuel (`src/strategy/meanReversion.ts`) contient déjà `trendPeriod` (Phase de recherche de stratégie précédente). Vérifier qu'il correspond exactement à ce que ce plan suppose avant de continuer — s'il y a une divergence, l'implémentation doit s'adapter au fichier réel, pas à ce plan.

```ts
export interface MeanReversionParams {
  readonly symbol: string;
  readonly period: number;
  readonly entryK: number;
  readonly trendPeriod?: number;
}
// ...
export function createMeanReversion(params: MeanReversionParams): Strategy {
  const { symbol, period, entryK, trendPeriod } = params;
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Période invalide : ${period}`);
  }
  if (!(entryK > 0)) {
    throw new RangeError(`entryK invalide : ${entryK}`);
  }
  if (trendPeriod !== undefined && (!Number.isInteger(trendPeriod) || trendPeriod <= period)) {
    throw new RangeError(`trendPeriod invalide : ${trendPeriod} (doit être > period=${period})`);
  }

  const warmup = trendPeriod !== undefined ? Math.max(period, trendPeriod) : period;

  return {
    name: 'mean-reversion',
    warmup,
    params: { period, entryK, ...(trendPeriod !== undefined ? { trendPeriod } : {}) },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const smaVal = sma(view, period);
      const stdVal = std(view, period);
      const price = view.close(0);
      const hasPosition = ctx.positions.has(symbol);
      const threshold = smaVal - entryK * stdVal;
      const trendOk = trendPeriod === undefined || price > sma(view, trendPeriod);

      if (!hasPosition && price < threshold && trendOk) {
        return [{
          kind: 'enter',
          symbol,
          reason: `prix=${price.toFixed(4)} < sma(${period})-${entryK}·std=${threshold.toFixed(4)}`,
        }];
      }
      if (hasPosition && price >= smaVal) {
        return [{
          kind: 'exit',
          symbol,
          reason: `prix=${price.toFixed(4)} >= sma(${period})=${smaVal.toFixed(4)}`,
        }];
      }
      return [{ kind: 'hold' }];
    },
  };
}
```

- [ ] **Step 2: Écrire les tests du filtre de volume (échouent — le paramètre n'existe pas encore)**

Ajouter à `test/meanReversion.test.ts` (ne pas toucher aux tests existants) :

```ts
test('createMeanReversion : warmup inclut volumePeriod, params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 6, volumeMultiplier: 1.5 });
  assert.equal(s.warmup, 6);
  assert.deepEqual(s.params, { period: 4, entryK: 1, volumePeriod: 6, volumeMultiplier: 1.5 });
});

test('createMeanReversion : lève si volumePeriod est fourni sans volumeMultiplier', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 6 }),
    /volumePeriod.*volumeMultiplier|ensemble/,
  );
});

test('createMeanReversion : lève si volumeMultiplier est fourni sans volumePeriod', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumeMultiplier: 1.5 }),
    /volumePeriod.*volumeMultiplier|ensemble/,
  );
});

test('createMeanReversion : lève si volumePeriod est invalide', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 1, volumeMultiplier: 1.5 }),
    /volumePeriod/,
  );
});

test('createMeanReversion : lève si volumeMultiplier est invalide', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 4, volumeMultiplier: 0 }),
    /volumeMultiplier/,
  );
});

function barWithVolume(time: number, close: number, volume: number): ClosedBarLike {
  return { time, open: close, high: close, low: close, close, volume, trades: 1 };
}
```

Comme les autres tests du fichier construisent leurs séries via un
helper `seriesFrom(closes: number[])` qui fixe `volume: 1` pour chaque
barre (voir le fichier existant), les tests de volume ci-dessous ont
besoin d'un helper local capable de varier le volume par barre. Ajouter,
juste après le `seriesFrom` existant (ne pas le modifier) :

```ts
function seriesFromWithVolume(closes: number[], volumes: number[]): BarSeries {
  const c = emptyColumns();
  closes.forEach((close, i) => {
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(volumes[i] ?? 1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(SYMBOL, 240, c);
}

function ctxForWithVolume(closes: number[], volumes: number[], position?: Position): StrategyContext {
  const series = seriesFromWithVolume(closes, volumes);
  const view = new BarView(series, series.length - 1);
  const positions = new Map<string, Position>();
  if (position) positions.set(SYMBOL, position);
  return { views: new Map([[SYMBOL, view]]), positions, now: view.time(0) };
}

test("decide : le filtre de volume bloque une entrée sur volume ordinaire", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, volumePeriod: 4, volumeMultiplier: 2 });
  // Seuil d'entrée franchi (comme le test sans filtre), mais volume de la
  // barre courante égal à la moyenne — pas de confirmation de capitulation.
  const ctx = ctxForWithVolume([10, 10, 10, 10, 5], [1, 1, 1, 1, 1]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test("decide : le filtre de volume autorise une entrée sur volume élevé", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, volumePeriod: 4, volumeMultiplier: 2 });
  // Même repli de prix, mais la barre courante a un volume 5x la moyenne
  // des barres précédentes (1,1,1) -> confirmation de capitulation.
  const ctx = ctxForWithVolume([10, 10, 10, 10, 5], [1, 1, 1, 1, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : sans volumePeriod/volumeMultiplier, le volume est ignoré (comportement inchangé)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1 });
  const ctx = ctxForWithVolume([10, 10, 10, 10, 5], [1, 1, 1, 1, 0.01]); // volume très faible
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter'); // toujours une entrée : le volume n'est pas pris en compte
});
```

Retirer le bloc `barWithVolume`/`ClosedBarLike` du brouillon ci-dessus
avant de committer — il ne sert à rien, seuls `seriesFromWithVolume` et
`ctxForWithVolume` sont nécessaires. Vérifier que `BarSeries`, `Position`
et `StrategyContext` sont déjà importés en tête du fichier (c'est le cas
dans la version actuelle) ; sinon, compléter les imports.

- [ ] **Step 3: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/meanReversion.test.ts`
Expected: FAIL — `volumePeriod`/`volumeMultiplier` ne sont pas reconnus par `MeanReversionParams`.

- [ ] **Step 4: Implémenter le filtre de volume**

Dans `src/strategy/meanReversion.ts` :

1. Étendre `MeanReversionParams` :

```ts
  /**
   * Période de la moyenne de volume de confirmation, et multiplicateur du
   * volume moyen requis à l'entrée — capitulation réelle plutôt qu'un creux
   * sur volume ordinaire. Les deux doivent être fournis ensemble, ou pas du
   * tout (défaut : aucun filtre, comportement inchangé). N'affecte jamais
   * la sortie.
   */
  readonly volumePeriod?: number;
  readonly volumeMultiplier?: number;
```

2. Ajouter, à côté de `sma`/`std` :

```ts
function avgVolume(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.volume(ago));
  }
  return s.value;
}
```

3. Dans `createMeanReversion`, après la destructuration et les validations existantes :

```ts
  const { symbol, period, entryK, trendPeriod, volumePeriod, volumeMultiplier } = params;
  // ... validations period/entryK/trendPeriod inchangées ...
  if ((volumePeriod === undefined) !== (volumeMultiplier === undefined)) {
    throw new RangeError('volumePeriod et volumeMultiplier doivent être fournis ensemble');
  }
  if (volumePeriod !== undefined && (!Number.isInteger(volumePeriod) || volumePeriod < 2)) {
    throw new RangeError(`volumePeriod invalide : ${volumePeriod}`);
  }
  if (volumeMultiplier !== undefined && !(volumeMultiplier > 0)) {
    throw new RangeError(`volumeMultiplier invalide : ${volumeMultiplier}`);
  }

  const warmup = Math.max(period, trendPeriod ?? 0, volumePeriod ?? 0);
```

4. Mettre à jour `params` exposés et `decide()` :

```ts
    params: {
      period,
      entryK,
      ...(trendPeriod !== undefined ? { trendPeriod } : {}),
      ...(volumePeriod !== undefined ? { volumePeriod } : {}),
      ...(volumeMultiplier !== undefined ? { volumeMultiplier } : {}),
    },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const smaVal = sma(view, period);
      const stdVal = std(view, period);
      const price = view.close(0);
      const hasPosition = ctx.positions.has(symbol);
      const threshold = smaVal - entryK * stdVal;
      const trendOk = trendPeriod === undefined || price > sma(view, trendPeriod);
      const volumeOk =
        volumePeriod === undefined ||
        volumeMultiplier === undefined ||
        view.volume(0) >= volumeMultiplier * avgVolume(view, volumePeriod);

      if (!hasPosition && price < threshold && trendOk && volumeOk) {
        return [{
          kind: 'enter',
          symbol,
          reason: `prix=${price.toFixed(4)} < sma(${period})-${entryK}·std=${threshold.toFixed(4)}`,
        }];
      }
      if (hasPosition && price >= smaVal) {
        return [{
          kind: 'exit',
          symbol,
          reason: `prix=${price.toFixed(4)} >= sma(${period})=${smaVal.toFixed(4)}`,
        }];
      }
      return [{ kind: 'hold' }];
    },
```

Le reste du fichier (fonction `sma`, `std`, structure générale) reste
inchangé.

- [ ] **Step 5: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/meanReversion.test.ts`
Expected: PASS — tests existants (period/entryK/trendPeriod, inchangés)
**et** nouveaux tests de volume, tous verts.

- [ ] **Step 6: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 7: Commit**

```bash
git add src/strategy/meanReversion.ts test/meanReversion.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): filtre de volume optionnel pour mean-reversion

Ajoute volumePeriod/volumeMultiplier (optionnels, fournis ensemble ou
pas du tout, rétrocompatibles) : n'achète un creux que si le volume de
la bougie dépasse un multiple de sa moyenne récente — confirmation de
capitulation plutôt qu'un creux sur volume ordinaire. N'affecte jamais
la sortie. Comportement inchangé sans ces paramètres.
EOF
)"
```

---

## Task 2: Évaluation walk-forward et documentation du résultat

**Files:**
- Create: `scripts/tune-mean-reversion-volume.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createMeanReversion` (Task 1, avec `volumePeriod`/`volumeMultiplier`), `runWalkForward`, `loadUniverse`, `combineStrategies`, `DEFAULT_FEES` (tous existants, inchangés).

- [ ] **Step 1: Implémenter le script d'évaluation**

Créer `scripts/tune-mean-reversion-volume.ts` :

```ts
/**
 * Évalue si le filtre de volume (Task 1) améliore le candidat déjà
 * validé (period=70-80, entryK=4, sans filtre de tendance). Grille
 * volontairement étroite — voir la spec, section « Décisions actées ».
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion-volume.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Params {
  readonly period: number;
  readonly entryK: number;
  readonly volumePeriod?: number;
  readonly volumeMultiplier?: number;
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

function strategyFactory(params: Params) {
  return combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...params })),
  );
}

function runSingle(
  series: Awaited<ReturnType<typeof loadUniverse>>['series'],
  label: string,
  params: Params,
): void {
  const result = runWalkForward(series, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    paramGrid: [params], // 0 degré de liberté — un seul réglage fixe
    strategyFactory,
    backtestOptions: BACKTEST_OPTIONS,
  });
  const n = result.folds.length;
  const meanOut = result.folds.reduce((s, f) => s + f.outOfSampleReturn, 0) / n;
  const win = result.folds.filter((f) => f.outOfSampleReturn > 0).length;
  console.log(`${label.padEnd(45)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}`);
}

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('Référence (sans filtre de volume) :');
  runSingle(series, 'period=70, entryK=4', { period: 70, entryK: 4 });
  runSingle(series, 'period=80, entryK=4', { period: 80, entryK: 4 });

  console.log('\nAvec filtre de volume (volumePeriod=20) :');
  for (const period of [70, 80]) {
    for (const volumeMultiplier of [1.2, 1.5, 2.0]) {
      runSingle(
        series,
        `period=${period}, entryK=4, volumeMultiplier=${volumeMultiplier}`,
        { period, entryK: 4, volumePeriod: 20, volumeMultiplier },
      );
    }
  }
}

await main();
```

- [ ] **Step 2: Lancer l'évaluation**

Run: `node --experimental-strip-types scripts/tune-mean-reversion-volume.ts`
Expected : le script s'exécute sans erreur et imprime une ligne par
réglage (référence + 6 variantes avec filtre de volume).

- [ ] **Step 3: Documenter le résultat dans le README, quel qu'il soit**

Dans la section « Recherche de stratégie (données réelles) » du
`README.md`, ajouter une puce après celle sur la sélection de paires
post-hoc (avant la ligne « **Statut** ») :

- Si un réglage avec filtre de volume dépasse clairement (pas
  marginalement) la référence sans filtre sur le rendement hors
  échantillon moyen ET garde un nombre de fenêtres gagnantes comparable
  ou meilleur : documenter ce réglage comme le nouveau candidat, et
  mettre à jour la puce « **Statut** » en conséquence (nouveaux
  paramètres, nouvelle plage de rendement).
- Sinon (neutre ou pire) : documenter honnêtement que le filtre de volume
  n'apporte rien de plus sur cette période, avec les chiffres exacts
  obtenus, et laisser le « **Statut** » inchangé (le candidat sans filtre
  de volume reste la référence).

Dans les deux cas, le texte doit rapporter les chiffres réels obtenus à
l'exécution du script — jamais une estimation ou une extrapolation.

- [ ] **Step 4: Vérifier que rien n'est cassé**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (ce script n'a pas de test dédié — pas
plus que les autres scripts d'analyse du projet)

- [ ] **Step 5: Commit**

```bash
git add scripts/tune-mean-reversion-volume.ts README.md
git commit -m "$(cat <<'EOF'
feat(scripts): évalue le filtre de volume par walk-forward

Grille étroite (0 degré de liberté par point, comme les évaluations
précédentes de cette recherche) comparant period=70/80 × entryK=4 avec
et sans confirmation de volume. Résultat consigné honnêtement dans le
README, qu'il soit positif, neutre, ou négatif.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — §Architecture (`meanReversion.ts` modifié,
script d'évaluation) → Task 1 et Task 2 respectivement ; §Décisions
actées (grille étroite, rétrocompatibilité) → contraintes globales et
Task 2 Step 1 (grille fixée dans le code, pas laissée à l'appréciation de
l'implémenteur).

**Décomposition** — 2 tâches : Task 1 (code de production, testé) avant
Task 2 (évaluation, dépend du code de Task 1). Ordre respecte la
dépendance.

**Cohérence des types** — `MeanReversionParams` (Task 1) et son usage dans
`scripts/tune-mean-reversion-volume.ts` (Task 2, `{ symbol, ...params }`
où `params: Params` a exactement les champs optionnels ajoutés en Task 1)
vérifiés champ à champ.

**Aucun placeholder** — chaque step contient le code complet ; Task 2
Step 3 ne prescrit pas un résultat à l'avance (positif ou négatif), il
prescrit la procédure de documentation honnête dans les deux cas — ce
n'est pas un placeholder, c'est la nature même d'une évaluation dont le
résultat n'est pas encore connu au moment d'écrire le plan.
