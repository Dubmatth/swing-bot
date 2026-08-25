# Phase 8 — Mean-reversion avec stop de temps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un stop de temps optionnel et rétrocompatible à `createMeanReversion` (sortie forcée si une position n'est pas revenue à la moyenne après N barres), puis évaluer honnêtement s'il améliore le seul candidat de stratégie ayant montré un edge réel jusqu'ici.

**Architecture:** Extension du fichier existant `src/strategy/meanReversion.ts` (même pattern que les filtres d'entrée déjà ajoutés, mais première modification touchant la condition de SORTIE) + un script d'analyse non testé qui compare le résultat walk-forward avec et sans le stop de temps, et instrumente dès le départ le comptage des sorties par stop de temps vs par retour à la moyenne (leçon de la Phase 7 : ne pas laisser la vérification reposer sur de l'instrumentation jetable non committée).

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas de build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-phase8-time-stop-mean-reversion-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- tsconfig strict : `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée.
- Commentaires et messages d'erreur en français.
- Rétrocompatibilité stricte : sans `maxHoldBars`, le comportement de `createMeanReversion` doit rester identique à avant cette phase — tous les tests existants de `test/meanReversion.test.ts` doivent continuer à passer sans modification de leur côté (seuls des tests nouveaux sont ajoutés).
- Le stop de temps ne nécessite aucune nouvelle fenêtre d'indicateur ni aucun nouveau champ sur `Position`/`StrategyContext` — il réutilise `position.entryTime`, `ctx.now`, et l'intervalle entre barres déduit de la vue (`view.time(0) - view.time(1)`).
- La sortie par retour à la moyenne (`price >= sma`) reste évaluée en premier et prioritaire : si les deux conditions sont vraies simultanément, la raison rapportée est celle du retour à la moyenne, pas celle du stop de temps.
- La grille de la Task 2 reste volontairement étroite et calibrée sur la distribution réelle de durée de détention des trades (voir la spec, table de percentiles) — ne pas l'élargir ni changer les seuils sans repasser par une décision explicite.
- Task 2 doit compter, dans le script committé lui-même (pas dans une instrumentation jetable), combien de sorties sont dues au stop de temps vs au retour à la moyenne, pour chaque réglage — leçon explicite de la Phase 7.

---

## Task 1: Stop de temps dans `createMeanReversion`

**Files:**
- Modify: `src/strategy/meanReversion.ts`
- Test: `test/meanReversion.test.ts`

**Interfaces:**
- Produces: `MeanReversionParams` gagne un champ optionnel supplémentaire `maxHoldBars?: number`. `createMeanReversion` reste `(params: MeanReversionParams) => Strategy`, signature inchangée.

- [ ] **Step 1: Lire le fichier actuel avant modification**

Le fichier actuel (`src/strategy/meanReversion.ts`) contient déjà `trendPeriod`, `volumePeriod`/`volumeMultiplier`, `maxVolatilityRatio` (phases de recherche précédentes). Vérifier qu'il correspond exactement à ce que ce plan suppose avant de continuer — s'il y a une divergence, l'implémentation doit s'adapter au fichier réel, pas à ce plan.

```ts
export interface MeanReversionParams {
  readonly symbol: string;
  readonly period: number;
  readonly entryK: number;
  readonly trendPeriod?: number;
  readonly volumePeriod?: number;
  readonly volumeMultiplier?: number;
  readonly maxVolatilityRatio?: number;
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
  const { symbol, period, entryK, trendPeriod, volumePeriod, volumeMultiplier, maxVolatilityRatio } = params;
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
  if (maxVolatilityRatio !== undefined && !(maxVolatilityRatio > 0)) {
    throw new RangeError(`maxVolatilityRatio invalide : ${maxVolatilityRatio}`);
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
  };
}
```

- [ ] **Step 2: Écrire les tests du stop de temps (échouent — le paramètre n'existe pas encore)**

Ajouter à `test/meanReversion.test.ts`, après les tests existants du filtre de régime de volatilité (ne pas toucher aux tests existants) :

```ts
test('createMeanReversion : lève si maxHoldBars est invalide (non entier)', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 2.5 }),
    /maxHoldBars/,
  );
});

test('createMeanReversion : lève si maxHoldBars est invalide (< 1)', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 0 }),
    /maxHoldBars/,
  );
});

test("createMeanReversion : maxHoldBars n'affecte pas warmup, params exposés", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 5 });
  assert.equal(s.warmup, 4);
  assert.deepEqual(s.params, { period: 4, entryK: 1, maxHoldBars: 5 });
});

test('decide : le stop de temps force une sortie après maxHoldBars barres sans retour à la moyenne', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 5 });
  // closes[4..7]=[10,10,10,9] -> sma=9.75, prix=9 < sma : pas de sortie par
  // retour à la moyenne. Position ouverte à l'index 0 (barre 0), barre
  // courante = index 7 -> 7 barres détenues >= maxHoldBars=5.
  const closes = [10, 10, 10, 10, 10, 10, 10, 9];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test("decide : pas de sortie forcée tant que maxHoldBars n'est pas atteint", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 10 });
  // Même série (7 barres détenues), mais maxHoldBars=10 > 7 : pas encore atteint.
  const closes = [10, 10, 10, 10, 10, 10, 10, 9];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : sans maxHoldBars, aucune sortie forcée par le temps (comportement inchangé)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  // Même série que les deux tests précédents (7 barres détenues), mais pas
  // de maxHoldBars : la position resterait ouverte indéfiniment.
  const closes = [10, 10, 10, 10, 10, 10, 10, 9];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : le retour à la moyenne reste prioritaire sur le stop de temps', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 5 });
  // Retour à la moyenne (prix=10 >= sma=10) ET maxHoldBars atteint (7 >= 5)
  // simultanément : la sortie doit se déclencher (peu importe la raison
  // exacte rapportée), pas rester bloquée.
  const closes = [10, 10, 10, 10, 10, 10, 10, 10];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});
```

- [ ] **Step 3: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/meanReversion.test.ts`
Expected: FAIL — `maxHoldBars` n'est pas reconnu par `MeanReversionParams`.

- [ ] **Step 4: Implémenter le stop de temps**

Dans `src/strategy/meanReversion.ts` :

1. Étendre `MeanReversionParams`, après `maxVolatilityRatio` :

```ts
  /**
   * Nombre maximal de barres qu'une position peut rester ouverte avant une
   * sortie forcée, si le retour à la moyenne (price >= sma) ne s'est pas
   * encore produit. Sans lui (défaut), aucune limite — comportement actuel
   * inchangé. N'affecte jamais l'entrée. La sortie par retour à la moyenne
   * reste prioritaire si les deux conditions sont vraies en même temps.
   */
  readonly maxHoldBars?: number;
```

2. Dans `createMeanReversion`, destructurer `maxHoldBars` et ajouter sa validation après celle de `maxVolatilityRatio` :

```ts
  const { symbol, period, entryK, trendPeriod, volumePeriod, volumeMultiplier, maxVolatilityRatio, maxHoldBars } = params;
  // ... validations period/entryK/trendPeriod/volumePeriod/volumeMultiplier/maxVolatilityRatio inchangées ...
  if (maxHoldBars !== undefined && (!Number.isInteger(maxHoldBars) || maxHoldBars < 1)) {
    throw new RangeError(`maxHoldBars invalide : ${maxHoldBars}`);
  }
```

Ne pas toucher au calcul de `warmup` — `maxHoldBars` ne requiert aucune fenêtre supplémentaire.

3. Mettre à jour `params` exposés et `decide()`. La condition de sortie doit maintenant récupérer l'objet `Position` complet (pas seulement `ctx.positions.has(symbol)`), pour accéder à `entryTime` :

```ts
    params: {
      period,
      entryK,
      ...(trendPeriod !== undefined ? { trendPeriod } : {}),
      ...(volumePeriod !== undefined ? { volumePeriod } : {}),
      ...(volumeMultiplier !== undefined ? { volumeMultiplier } : {}),
      ...(maxVolatilityRatio !== undefined ? { maxVolatilityRatio } : {}),
      ...(maxHoldBars !== undefined ? { maxHoldBars } : {}),
    },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const smaVal = sma(view, period);
      const stdVal = std(view, period);
      const price = view.close(0);
      const position = ctx.positions.get(symbol);
      const hasPosition = position !== undefined;
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
      if (position) {
        if (price >= smaVal) {
          return [{
            kind: 'exit',
            symbol,
            reason: `prix=${price.toFixed(4)} >= sma(${period})=${smaVal.toFixed(4)}`,
          }];
        }
        if (maxHoldBars !== undefined) {
          const barInterval = view.time(0) - view.time(1);
          const barsHeld = Math.round((ctx.now - position.entryTime) / barInterval);
          if (barsHeld >= maxHoldBars) {
            return [{
              kind: 'exit',
              symbol,
              reason: `stop de temps : ${barsHeld} barres détenues >= maxHoldBars=${maxHoldBars}`,
            }];
          }
        }
      }
      return [{ kind: 'hold' }];
    },
```

Le reste du fichier (fonctions `sma`, `std`, `avgVolume`, structure générale) reste inchangé.

- [ ] **Step 5: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/meanReversion.test.ts`
Expected: PASS — tests existants (period/entryK/trendPeriod/volume/régime de volatilité, inchangés) **et** nouveaux tests de stop de temps, tous verts.

- [ ] **Step 6: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 7: Commit**

```bash
git add src/strategy/meanReversion.ts test/meanReversion.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): stop de temps optionnel pour mean-reversion

Ajoute maxHoldBars (optionnel, rétrocompatible) : force la sortie
d'une position après ce nombre de barres si le retour à la moyenne ne
s'est pas encore produit — première modification touchant la SORTIE
plutôt que l'entrée. La sortie par retour à la moyenne reste
prioritaire si les deux conditions sont vraies simultanément.
Comportement inchangé sans ce paramètre.
EOF
)"
```

---

## Task 2: Évaluation walk-forward et documentation du résultat

**Files:**
- Create: `scripts/tune-mean-reversion-timestop.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createMeanReversion` (Task 1, avec `maxHoldBars`), `runWalkForward`, `loadUniverse`, `combineStrategies`, `DEFAULT_FEES` (tous existants, inchangés).

- [ ] **Step 1: Implémenter le script d'évaluation avec comptage des sorties intégré**

Créer `scripts/tune-mean-reversion-timestop.ts` :

```ts
/**
 * Évalue si le stop de temps (Task 1) améliore le candidat déjà validé
 * (period=70-80, entryK=4, sans filtre d'entrée). Grille volontairement
 * étroite, calibrée sur la distribution réelle de durée de détention des
 * trades — voir la spec, section « Décisions actées ».
 *
 * Compte, pour chaque réglage, combien de sorties sont dues au stop de
 * temps vs au retour à la moyenne (nécessaire pour interpréter
 * honnêtement un résultat neutre ou dégradé — leçon de la Phase 7, où la
 * revue finale a reproché une vérification reposant sur de
 * l'instrumentation jetable non committée).
 *
 * Usage : node --experimental-strip-types scripts/tune-mean-reversion-timestop.ts
 */

import { loadUniverse } from '../src/data/krakenCsv.ts';
import { UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { runWalkForward } from '../src/backtest/walkForward.ts';
import type { BacktestOptions } from '../src/backtest/runner.ts';
import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

interface Params {
  readonly period: number;
  readonly entryK: number;
  readonly maxHoldBars?: number;
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

// Compteur module-level des sorties, vidé avant chaque run instrumenté.
let exitCounts = { timeStop: 0, meanReversion: 0 };

function withExitCounting(strategy: Strategy): Strategy {
  return {
    ...strategy,
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents = strategy.decide(ctx);
      for (const intent of intents) {
        if (intent.kind === 'exit') {
          if (intent.reason.startsWith('stop de temps')) {
            exitCounts.timeStop++;
          } else {
            exitCounts.meanReversion++;
          }
        }
      }
      return intents;
    },
  };
}

function strategyFactory(params: Params) {
  return combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => withExitCounting(createMeanReversion({ symbol, ...params }))),
  );
}

function runSingle(
  series: Awaited<ReturnType<typeof loadUniverse>>['series'],
  label: string,
  params: Params,
): void {
  exitCounts = { timeStop: 0, meanReversion: 0 };
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
  const counts =
    params.maxHoldBars !== undefined
      ? `  sorties: retour-moyenne=${exitCounts.meanReversion} stop-de-temps=${exitCounts.timeStop}`
      : '';
  console.log(`${label.padEnd(45)} moyenne=${(meanOut * 100).toFixed(2)}%  gagnants=${win}/${n}${counts}`);
}

async function main(): Promise<void> {
  const { series } = await loadUniverse(UNIVERSE_SYMBOLS, {
    dir: 'data/kraken-ohlcvt',
    interval: 240,
    from: Math.floor(Date.parse('2019-01-01') / 1000),
  });

  console.log('Référence (sans stop de temps) :');
  runSingle(series, 'period=70, entryK=4', { period: 70, entryK: 4 });
  runSingle(series, 'period=80, entryK=4', { period: 80, entryK: 4 });

  console.log('\nAvec stop de temps :');
  for (const period of [70, 80]) {
    for (const maxHoldBars of [75, 90, 110]) {
      runSingle(
        series,
        `period=${period}, entryK=4, maxHoldBars=${maxHoldBars}`,
        { period, entryK: 4, maxHoldBars },
      );
    }
  }
}

await main();
```

Note : `withExitCounting` compte TOUTES les sorties émises par `decide()` au
fil de la simulation walk-forward (train + test de chaque fold), pas
seulement celles réellement exécutées par le runner (un `exit` émis peut
en théorie être rejeté — improbable pour une sortie mais garder cette
nuance en tête si les comptes semblent incohérents avec le nombre de
trades du portefeuille). C'est suffisant pour répondre à la question de
cette phase : le stop de temps se déclenche-t-il seulement, et à quelle
fréquence relative par rapport au retour à la moyenne.

- [ ] **Step 2: Lancer l'évaluation**

Run: `node --experimental-strip-types scripts/tune-mean-reversion-timestop.ts`
Expected : le script s'exécute sans erreur et imprime une ligne par
réglage (2 références + 6 variantes avec stop de temps), chaque ligne
avec stop de temps incluant le compte de sorties par catégorie.

- [ ] **Step 3: Documenter le résultat dans le README, quel qu'il soit**

Dans la section « Recherche de stratégie (données réelles) » du
`README.md`, ajouter une puce après celle sur le filtre de régime de
volatilité (avant la ligne « **Statut** ») :

- Si un réglage avec stop de temps dépasse clairement (pas
  marginalement) la référence sans stop sur le rendement hors échantillon
  moyen ET garde un nombre de fenêtres gagnantes comparable ou meilleur :
  documenter ce réglage comme le nouveau candidat, et mettre à jour la
  puce « **Statut** » en conséquence (nouveaux paramètres, nouvelle plage
  de rendement).
- Sinon (neutre ou pire) : documenter honnêtement que le stop de temps
  n'apporte rien de plus sur cette période, avec les chiffres exacts
  obtenus (y compris les comptes de sorties par catégorie, pour montrer
  si le stop se déclenche effectivement ou est structurellement hors
  d'atteinte), et laisser le « **Statut** » inchangé.

Dans les deux cas, le texte doit rapporter les chiffres réels imprimés
par le script committé — jamais une estimation. Si le nombre de sorties
par stop de temps est très faible par rapport au nombre total de trades,
le mentionner explicitement (comme pour `maxVolatilityRatio=0,09` en
Phase 7) plutôt que de laisser un lecteur croire que le mécanisme a été
testé à pleine puissance.

Ajouter aussi une ligne dans la liste « Structure » (section `##
Structure`), juste après la ligne
`scripts/tune-mean-reversion-volatility.ts` existante :

```
scripts/tune-mean-reversion-timestop.ts Évalue si un stop de temps améliore mean-reversion (grille calibrée sur la durée de détention réelle, compte les sorties par catégorie, 0 degré de liberté)
```

- [ ] **Step 4: Vérifier que rien n'est cassé**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (ce script n'a pas de test dédié — pas
plus que les autres scripts d'analyse du projet)

- [ ] **Step 5: Commit**

```bash
git add scripts/tune-mean-reversion-timestop.ts README.md
git commit -m "$(cat <<'EOF'
feat(scripts): évalue le stop de temps par walk-forward

Grille étroite (0 degré de liberté par point) calibrée sur la
distribution réelle de durée de détention des trades du candidat déjà
validé, comparant period=70/80 × entryK=4 avec et sans stop de temps.
Compte les sorties par catégorie (retour à la moyenne vs stop de
temps) directement dans le script committé. Résultat consigné
honnêtement dans le README, qu'il soit positif, neutre, ou négatif.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — §Architecture (`meanReversion.ts` modifié,
script d'évaluation avec comptage intégré) → Task 1 et Task 2
respectivement ; §Décisions actées (grille calibrée sur la durée de
détention réelle, un seul paramètre ajouté, priorité de la sortie par
retour à la moyenne, rétrocompatibilité) → contraintes globales et
Task 1 Step 4 / Task 2 Step 1.

**Décomposition** — 2 tâches : Task 1 (code de production, testé) avant
Task 2 (évaluation, dépend du code de Task 1). Ordre respecte la
dépendance.

**Cohérence des types** — `MeanReversionParams` (Task 1, `maxHoldBars?:
number`) et son usage dans `scripts/tune-mean-reversion-timestop.ts`
(Task 2, `Params.maxHoldBars?: number`, `{ symbol, ...params }`) vérifiés
champ à champ. `Strategy`/`StrategyContext`/`Intent` importés dans le
script pour `withExitCounting` correspondent aux types exportés de
`src/strategy/types.ts` (déjà existants, inchangés).

**Aucun placeholder** — chaque step contient le code complet, y compris
l'instrumentation de comptage (pas laissée à l'appréciation de
l'implémenteur cette fois, contrairement à la Phase 7 où elle avait été
ajoutée après coup en fix round). Task 2 Step 3 ne prescrit pas un
résultat à l'avance, il prescrit la procédure de documentation honnête
dans les deux cas — ce n'est pas un placeholder, c'est la nature même
d'une évaluation dont le résultat n'est pas encore connu au moment
d'écrire le plan.
