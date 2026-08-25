# Phase 7 — Mean-reversion avec filtre de régime de volatilité Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un filtre de régime de volatilité optionnel et rétrocompatible à `createMeanReversion`, puis évaluer honnêtement s'il améliore le seul candidat de stratégie ayant montré un edge réel jusqu'ici.

**Architecture:** Extension du fichier existant `src/strategy/meanReversion.ts` (même pattern que l'ajout des filtres de tendance/volume) + un script d'analyse non testé qui compare le résultat walk-forward avec et sans le filtre.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas de build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-phase7-volatility-regime-mean-reversion-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- tsconfig strict : `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée.
- Commentaires et messages d'erreur en français.
- Rétrocompatibilité stricte : sans `maxVolatilityRatio`, le comportement de `createMeanReversion` doit rester identique à avant cette phase — tous les tests existants de `test/meanReversion.test.ts` doivent continuer à passer sans modification de leur côté (seuls des tests nouveaux sont ajoutés).
- Le filtre réutilise `smaVal`/`stdVal` déjà calculés dans `decide()` pour le seuil d'entrée — pas de nouvelle fenêtre, pas de nouveau paramètre de période.
- La grille de la Task 2 reste volontairement étroite et calibrée sur la distribution réelle des données (voir la spec, section « Décisions actées ») — ne pas l'élargir ni changer les seuils sans repasser par une décision explicite.

---

## Task 1: Filtre de régime de volatilité dans `createMeanReversion`

**Files:**
- Modify: `src/strategy/meanReversion.ts`
- Test: `test/meanReversion.test.ts`

**Interfaces:**
- Produces: `MeanReversionParams` gagne un champ optionnel supplémentaire `maxVolatilityRatio?: number`. `createMeanReversion` reste `(params: MeanReversionParams) => Strategy`, signature inchangée.

- [ ] **Step 1: Lire le fichier actuel avant modification**

Le fichier actuel (`src/strategy/meanReversion.ts`) contient déjà `trendPeriod`, `volumePeriod`, `volumeMultiplier` (phases de recherche précédentes). Vérifier qu'il correspond exactement à ce que ce plan suppose avant de continuer — s'il y a une divergence, l'implémentation doit s'adapter au fichier réel, pas à ce plan.

```ts
export interface MeanReversionParams {
  readonly symbol: string;
  readonly period: number;
  readonly entryK: number;
  readonly trendPeriod?: number;
  readonly volumePeriod?: number;
  readonly volumeMultiplier?: number;
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

function avgVolume(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.volume(ago));
  }
  return s.value;
}

export function createMeanReversion(params: MeanReversionParams): Strategy {
  const { symbol, period, entryK, trendPeriod, volumePeriod, volumeMultiplier } = params;
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`Période invalide : ${period}`);
  }
  if (!(entryK > 0)) {
    throw new RangeError(`entryK invalide : ${entryK}`);
  }
  if (trendPeriod !== undefined && (!Number.isInteger(trendPeriod) || trendPeriod <= period)) {
    throw new RangeError(`trendPeriod invalide : ${trendPeriod} (doit être > period=${period})`);
  }
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

  return {
    name: 'mean-reversion',
    warmup,
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
  };
}
```

- [ ] **Step 2: Écrire les tests du filtre de régime de volatilité (échouent — le paramètre n'existe pas encore)**

Ajouter à `test/meanReversion.test.ts`, après les tests existants du filtre de volume (ne pas toucher aux tests existants, y compris `seriesFromWithVolume`/`ctxForWithVolume` déjà présents dans le fichier) :

```ts
test('createMeanReversion : lève si maxVolatilityRatio est invalide', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 0 }),
    /maxVolatilityRatio/,
  );
});

test('createMeanReversion : maxVolatilityRatio n\'affecte pas warmup, params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 0.05 });
  assert.equal(s.warmup, 4);
  assert.deepEqual(s.params, { period: 4, entryK: 1, maxVolatilityRatio: 0.05 });
});

test('decide : le filtre de régime de volatilité bloque une entrée en régime trop volatil', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 0.05 });
  // closes 10,10,10,10 -> sma=10, std=0 (ratio=0, filtre neutre à ce point) ;
  // une chute nette à 5 franchit le seuil d'entrée MAIS fait aussi bondir le
  // ratio std/sma (les 5 dernières closes incluent maintenant le 5) bien
  // au-dessus de 0.05 — le filtre doit bloquer.
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : le filtre de régime de volatilité autorise une entrée en régime calme', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 100 });
  // Même repli que le test précédent, mais un seuil de ratio si large qu'il
  // n'exclut jamais rien -> comportement identique au cas sans filtre.
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : sans maxVolatilityRatio, le régime de volatilité est ignoré (comportement inchangé)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});
```

- [ ] **Step 3: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/meanReversion.test.ts`
Expected: FAIL — `maxVolatilityRatio` n'est pas reconnu par `MeanReversionParams`.

- [ ] **Step 4: Implémenter le filtre de régime de volatilité**

Dans `src/strategy/meanReversion.ts` :

1. Étendre `MeanReversionParams`, après `volumeMultiplier` :

```ts
  /**
   * Seuil de coefficient de variation (std(period)/sma(period)) au-delà
   * duquel aucune entrée n'est autorisée — filtre de régime de forte
   * volatilité. Sans lui (défaut), aucun filtre. N'affecte jamais la
   * sortie. Réutilise smaVal/stdVal déjà calculés pour le seuil d'entrée :
   * pas de nouvelle fenêtre, pas de nouveau paramètre de période.
   */
  readonly maxVolatilityRatio?: number;
```

2. Dans `createMeanReversion`, destructurer `maxVolatilityRatio` et ajouter sa validation après celle de `volumeMultiplier` :

```ts
  const { symbol, period, entryK, trendPeriod, volumePeriod, volumeMultiplier, maxVolatilityRatio } = params;
  // ... validations period/entryK/trendPeriod/volumePeriod/volumeMultiplier inchangées ...
  if (maxVolatilityRatio !== undefined && !(maxVolatilityRatio > 0)) {
    throw new RangeError(`maxVolatilityRatio invalide : ${maxVolatilityRatio}`);
  }
```

Ne pas toucher au calcul de `warmup` — `maxVolatilityRatio` ne requiert aucune fenêtre supplémentaire.

3. Mettre à jour `params` exposés et `decide()` :

```ts
    params: {
      period,
      entryK,
      ...(trendPeriod !== undefined ? { trendPeriod } : {}),
      ...(volumePeriod !== undefined ? { volumePeriod } : {}),
      ...(volumeMultiplier !== undefined ? { volumeMultiplier } : {}),
      ...(maxVolatilityRatio !== undefined ? { maxVolatilityRatio } : {}),
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
      const volRegimeOk = maxVolatilityRatio === undefined || stdVal / smaVal <= maxVolatilityRatio;

      if (!hasPosition && price < threshold && trendOk && volumeOk && volRegimeOk) {
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

Le reste du fichier (fonctions `sma`, `std`, `avgVolume`, structure générale) reste inchangé.

- [ ] **Step 5: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/meanReversion.test.ts`
Expected: PASS — tests existants (period/entryK/trendPeriod/volume, inchangés) **et** nouveaux tests de régime de volatilité, tous verts.

- [ ] **Step 6: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 7: Commit**

```bash
git add src/strategy/meanReversion.ts test/meanReversion.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): filtre de régime de volatilité optionnel pour mean-reversion

Ajoute maxVolatilityRatio (optionnel, rétrocompatible) : n'achète un
creux que si le coefficient de variation std(period)/sma(period) reste
sous ce seuil — évite d'entrer en régime de forte volatilité/tendance
où la réversion à la moyenne échoue plus souvent. Réutilise smaVal/
stdVal déjà calculés pour le seuil d'entrée, aucune nouvelle fenêtre.
N'affecte jamais la sortie. Comportement inchangé sans ce paramètre.
EOF
)"
```

---

## Task 2: Évaluation walk-forward et documentation du résultat

**Files:**
- Create: `scripts/tune-mean-reversion-volatility.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createMeanReversion` (Task 1, avec `maxVolatilityRatio`), `runWalkForward`, `loadUniverse`, `combineStrategies`, `DEFAULT_FEES` (tous existants, inchangés).

- [ ] **Step 1: Implémenter le script d'évaluation**

Créer `scripts/tune-mean-reversion-volatility.ts` :

```ts
/**
 * Évalue si le filtre de régime de volatilité (Task 1) améliore le
 * candidat déjà validé (period=70-80, entryK=4, sans filtre de
 * tendance/volume). Grille volontairement étroite, calibrée sur la
 * distribution réelle du coefficient de variation std/sma — voir la
 * spec, section « Décisions actées ».
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion-volatility.ts
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
  readonly maxVolatilityRatio?: number;
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
  console.log(`${label.padEnd(55)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}`);
}

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('Référence (sans filtre de régime de volatilité) :');
  runSingle(series, 'period=70, entryK=4', { period: 70, entryK: 4 });
  runSingle(series, 'period=80, entryK=4', { period: 80, entryK: 4 });

  console.log('\nAvec filtre de régime de volatilité :');
  for (const period of [70, 80]) {
    for (const maxVolatilityRatio of [0.06, 0.075, 0.09]) {
      runSingle(
        series,
        `period=${period}, entryK=4, maxVolatilityRatio=${maxVolatilityRatio}`,
        { period, entryK: 4, maxVolatilityRatio },
      );
    }
  }
}

await main();
```

- [ ] **Step 2: Lancer l'évaluation**

Run: `node --experimental-strip-types scripts/tune-mean-reversion-volatility.ts`
Expected : le script s'exécute sans erreur et imprime une ligne par
réglage (2 références + 6 variantes avec filtre de régime de volatilité).

- [ ] **Step 3: Documenter le résultat dans le README, quel qu'il soit**

Dans la section « Recherche de stratégie (données réelles) » du
`README.md`, ajouter une puce après celle sur le filtre de volume (avant
la ligne « **Statut** ») :

- Si un réglage avec filtre de régime de volatilité dépasse clairement
  (pas marginalement) la référence sans filtre sur le rendement hors
  échantillon moyen ET garde un nombre de fenêtres gagnantes comparable ou
  meilleur : documenter ce réglage comme le nouveau candidat, et mettre à
  jour la puce « **Statut** » en conséquence (nouveaux paramètres,
  nouvelle plage de rendement).
- Sinon (neutre ou pire) : documenter honnêtement que le filtre de régime
  de volatilité n'apporte rien de plus sur cette période, avec les
  chiffres exacts obtenus, et laisser le « **Statut** » inchangé (le
  candidat sans filtre de régime de volatilité reste la référence).

Dans les deux cas, le texte doit rapporter les chiffres réels obtenus à
l'exécution du script — jamais une estimation ou une extrapolation. Si un
réglage bloque des entrées mais que le résultat final (trades exécutés,
rendement) reste identique à la référence, vérifier la cause exacte
(plafond `maxConcurrentPositions` ou capital insuffisant, comme constaté
pour le filtre de volume en Phase 6) avant d'écrire une explication
causale — ne pas se contenter d'observer « aucun changement » sans en
avoir vérifié la raison si le filtre bloque effectivement des signaux.

Ajouter aussi une ligne dans la liste « Structure » (section `##
Structure`), juste après la ligne `scripts/tune-mean-reversion-volume.ts`
existante :

```
scripts/tune-mean-reversion-volatility.ts Évalue si un filtre de régime de volatilité améliore mean-reversion (grille étroite calibrée sur les données, 0 degré de liberté)
```

- [ ] **Step 4: Vérifier que rien n'est cassé**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (ce script n'a pas de test dédié — pas
plus que les autres scripts d'analyse du projet)

- [ ] **Step 5: Commit**

```bash
git add scripts/tune-mean-reversion-volatility.ts README.md
git commit -m "$(cat <<'EOF'
feat(scripts): évalue le filtre de régime de volatilité par walk-forward

Grille étroite (0 degré de liberté par point) calibrée sur la
distribution réelle du coefficient de variation std/sma des 20 paires,
comparant period=70/80 × entryK=4 avec et sans filtre de régime de
volatilité. Résultat consigné honnêtement dans le README, qu'il soit
positif, neutre, ou négatif.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — §Architecture (`meanReversion.ts` modifié,
script d'évaluation) → Task 1 et Task 2 respectivement ; §Décisions
actées (grille calibrée sur les données réelles, un seul paramètre ajouté,
rétrocompatibilité) → contraintes globales et Task 2 Step 1 (grille et
seuils fixés dans le code avec leur justification empirique, pas laissés
à l'appréciation de l'implémenteur).

**Décomposition** — 2 tâches : Task 1 (code de production, testé) avant
Task 2 (évaluation, dépend du code de Task 1). Ordre respecte la
dépendance.

**Cohérence des types** — `MeanReversionParams` (Task 1) et son usage dans
`scripts/tune-mean-reversion-volatility.ts` (Task 2, `{ symbol, ...params
}` où `params: Params` a exactement le champ optionnel ajouté en Task 1)
vérifiés champ à champ.

**Aucun placeholder** — chaque step contient le code complet ; Task 2
Step 3 ne prescrit pas un résultat à l'avance (positif ou négatif), il
prescrit la procédure de documentation honnête dans les deux cas, y
compris l'exigence (tirée de la leçon de la Phase 6) de vérifier la cause
exacte d'un non-effet apparent avant de l'expliquer — ce n'est pas un
placeholder, c'est la nature même d'une évaluation dont le résultat n'est
pas encore connu au moment d'écrire le plan.
