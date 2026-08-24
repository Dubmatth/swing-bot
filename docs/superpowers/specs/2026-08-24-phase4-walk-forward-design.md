# Phase 4 — Validation walk-forward

Statut : approuvé (décisions actées en conversation le 2026-08-24).

## Objectif et critère de sortie

Ajouter un framework de validation walk-forward : pour une grille de
paramètres et une stratégie donnée, sélectionner les meilleurs paramètres
sur une fenêtre d'entraînement puis mesurer leur performance sur la fenêtre
suivante, non vue (hors échantillon), en répétant l'opération sur plusieurs
fenêtres glissantes. Démontrer que le mécanisme révèle correctement
l'overfitting plutôt que de le masquer : sur des données sans structure
réelle et une grille de paramètres riche, la performance moyenne
in-sample doit être significativement meilleure que la performance moyenne
out-of-sample.

C'est la garantie anti-overfitting déjà anticipée depuis la Phase 0
(`degreesOfFreedom` dans `src/strategy/types.ts`, `sliceSeries` dans
`src/data/series.ts` explicitement commenté « utilisé par le walk-forward »)
mais jamais câblée à un mécanisme réel jusqu'ici.

Hors périmètre (reporté) :
- Métriques au-delà du rendement total (Sharpe, max drawdown) — `equityCurve`
  les rend triviales à ajouter plus tard, pas un besoin de cette phase.
- Fenêtre d'entraînement ancrée/croissante — glissante à taille fixe
  uniquement (voir Décisions actées).
- Dégradation silencieuse de la grille de paramètres quand un `warmup` ne
  tient pas dans `trainBars` — l'erreur existante de `runBacktest` remonte
  telle quelle.
- Backtest sur l'univers réel des 20 paires (toujours hors périmètre,
  bloqué sur l'obtention des CSV Kraken).
- Fenêtre de test « à froid » (pas de préfixe de warmup pris dans la
  fenêtre d'entraînement) — la mesure hors échantillon perd jusqu'à
  `strategy.warmup` barres effectives par fold. Vérifié comme
  n'invalidant pas le critère de sortie de cette phase (robuste à la
  normalisation par horizon et à des fenêtres symétriques), mais une
  vraie limitation pour un usage futur sur des données réelles à warmup
  plus grand.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Portée | Walk-forward complet (recherche de paramètres + validation hors échantillon), pas juste un découpage en fenêtres | Sans recherche de paramètres, ce ne serait qu'un backtest tranché — aucune valeur anti-overfitting nouvelle |
| Schéma de fenêtres | Glissante, taille fixe (`trainBars`/`testBars` constants, fenêtres de test non chevauchantes) | Comparaison équitable entre folds ; correspond au commentaire déjà présent dans `series.ts` |
| Métrique de sélection et de reporting | Rendement total uniquement (`(équité finale − cash initial) / cash initial`) | YAGNI — Sharpe/drawdown ajoutables plus tard sans retoucher le reste |
| Généricité | `runWalkForward` générique sur une `strategyFactory: P => Strategy`, pas câblé sur une stratégie précise | N'importe quelle stratégie paramétrable peut être testée |

## Architecture

### 1. Métriques (`src/backtest/metrics.ts`, nouveau)

```ts
export function totalReturn(equityCurve: readonly EquityPoint[], initialCash: number): number
```

`(equityCurve[equityCurve.length - 1].equity - initialCash) / initialCash`.
Lève si `equityCurve` est vide (ne devrait jamais arriver étant donné les
bornes de boucle de `runBacktest`, mais défensif).

### 2. `runWalkForward` (`src/backtest/walkForward.ts`, nouveau)

```ts
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

export function runWalkForward<P>(
  series: ReadonlyMap<string, BarSeries>,
  config: WalkForwardConfig<P>,
): WalkForwardResult<P>
```

- Lève si `paramGrid.length === 0` ou `trainBars`/`testBars` non entiers
  positifs — même philosophie « échec bruyant » que le reste du projet.
- Nombre de folds dérivé de la longueur commune des séries : fold `i`
  couvre train `[i·testBars, i·testBars + trainBars)`, test
  `[i·testBars + trainBars, i·testBars + trainBars + testBars)`. S'arrête
  dès que la fenêtre de test dépasserait la série (dernier fold partiel
  exclu, pas de fenêtre tronquée silencieuse).
- Par fold :
  1. Découpe chaque symbole de `series` via `sliceSeries` (existant,
     inchangé) sur la fenêtre train.
  2. Pour chaque `params` de `paramGrid` : `runBacktest` sur la série
     d'entraînement avec `strategyFactory(params)`, calcule `totalReturn`.
     Retient les `params` au meilleur rendement in-sample.
  3. Découpe chaque symbole sur la fenêtre test.
  4. `runBacktest` sur la série de test avec `strategyFactory(selectedParams)`
     (les MÊMES paramètres, jamais re-sélectionnés), calcule `totalReturn`
     → `outOfSampleReturn`.
- Aucun garde-fou nouveau sur la compatibilité `warmup`/`trainBars` : si une
  combinaison de la grille a un warmup trop long, l'erreur existante de
  `runBacktest` (« insuffisant pour un warmup... ») remonte telle quelle et
  interrompt `runWalkForward` — c'est à l'appelant de choisir une grille et
  un `trainBars` cohérents.

### 3. Test du critère de sortie (`test/phase4.test.ts`, nouveau)

Contrairement aux phases précédentes (qui prouvaient qu'un mécanisme
fonctionne), celle-ci doit prouver que **le walk-forward révèle
correctement l'overfitting** plutôt que de le masquer.

- Série synthétique sans structure réelle : bruit pseudo-aléatoire
  déterministe (générateur congruentiel linéaire simple, graine fixe — pas
  de vraie randomisation, pour rester reproductible d'un run à l'autre).
- Grille de paramètres riche (plusieurs dizaines de combinaisons fast/slow
  pour `createMaCrossover`, degrés de liberté volontairement élevés).
- `runWalkForward` sur plusieurs folds.
- Assertion : la moyenne des `inSampleReturn` sur tous les folds est
  significativement supérieure à la moyenne des `outOfSampleReturn` — la
  signature classique de l'overfitting sur des données sans edge réel.

## Fichiers touchés

```
src/backtest/metrics.ts       (nouveau)
src/backtest/walkForward.ts   (nouveau)
test/metrics.test.ts          (nouveau)
test/walkForward.test.ts      (nouveau)
test/phase4.test.ts           (nouveau)
```

Aucun fichier existant n'est modifié — `runBacktest`, `sliceSeries`,
`createMaCrossover` sont consommés tels quels.
