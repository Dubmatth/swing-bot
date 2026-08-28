# Phase 11 — Mean-reversion cross-sectionnelle

Statut : approuvé (proposition faite par l'agent, confirmée par
l'utilisateur — « oui », 2026-08-27 — après l'échec de trois familles
directionnelles consécutives : suivi de tendance, momentum
cross-sectionnel (Phase 9), breakout Donchian (Phase 10). Seul
`mean-reversion` (Phase 6, `period≈70-80, entryK=4`) montre un edge réel,
bien que modeste).

## Contexte et objectif

Contrairement aux Phases 9 et 10 (découverte de nouvelles familles,
grilles exploratoires), cette phase est un **raffinement** du candidat
déjà validé — même discipline que les Phases 7 et 8 : isoler une seule
variable sur une base déjà établie, sans nouveau degré de liberté.

**Le mécanisme actuel** : `mean-reversion` (`src/strategy/meanReversion.ts`)
est assemblé mono-paire par mono-paire via `combineStrategies`, qui
traite les 20 paires **indépendamment**. Si plusieurs paires franchissent
le seuil d'entrée (`price < sma(period) - entryK·std(period)`) sur la même
bougie et que `maxConcurrentPositions=5` est déjà atteint, c'est l'ordre
arbitraire du tableau `UNIVERSE_SYMBOLS` — pas la force du signal — qui
décide laquelle obtient une place (voir `combineStrategies.ts` : « l'ordre
du tableau `strategies` devient la priorité de facto »).

**Hypothèse** : prioriser les entrées simultanées par profondeur de
survente (z-score `(sma-prix)/std` décroissant, plutôt que l'ordre
arbitraire de l'univers) devrait améliorer le rendement — ou au moins ne
pas le dégrader — en allouant le capital limité aux signaux les plus
forts plutôt qu'aux premiers dans une liste sans rapport avec la qualité
du signal.

**Risque explicitement anticipé (leçon des Phases 7-9)** : ce
réordonnancement ne peut avoir **aucun** effet mesurable si le plafond
`maxConcurrentPositions=5` n'est presque jamais atteint alors que
plusieurs paires sont éligibles simultanément — dans ce cas, l'ordre des
intentions ne change rien à ce qui s'exécute, et un résultat neutre serait
aussi peu concluant que `maxVolatilityRatio=0,09` (Phase 7) ou
`lookbackPeriod=168` (Phase 9). Cette phase inclut donc un **diagnostic
dédié**, committé (pas jetable), qui compte combien de rejets sont dus à
« plafond de positions concurrentes atteint » pour les deux variantes —
condition nécessaire pour interpréter honnêtement un résultat neutre ou
dégradé.

**Critère de sortie** : la stratégie cross-sectionnelle est implémentée,
testée unitairement, puis comparée au candidat déjà validé (même
`period`/`entryK`, **0 degré de liberté supplémentaire**) par walk-forward
**et** par un diagnostic de saturation du plafond. Le résultat — quel
qu'il soit — est documenté honnêtement dans le README.

Hors périmètre :
- **Nouveaux paramètres** : la stratégie cross-sectionnelle n'ajoute
  aucun paramètre — mêmes `period`/`entryK` que le candidat validé.
  Changer le seuil, ajouter un filtre, ou toucher la logique de sortie
  serait tester une variable différente, hors périmètre de cette phase.
- **Filtres déjà écartés** (tendance, volume, régime de volatilité, stop
  de temps) : aucun n'est réintroduit ici.
- **Rebalancement périodique** (à la Phase 9) : contrairement au momentum,
  le seuil `entryK=4` est déjà le facteur limitant la fréquence de trading
  (leçon de la Phase 6 : « les frais dominaient le résultat » aux réglages
  initiaux plus fréquents, corrigé en élargissant le seuil, pas en
  ajoutant une contrainte de calendrier). Une évaluation cross-sectionnelle
  continue (à chaque bougie) est cohérente avec ce mécanisme déjà validé —
  imposer un rebalancement hebdomadaire ici changerait la stratégie
  sous-jacente, pas seulement l'ordre de priorité.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Architecture | Nouvelle stratégie multi-paires dédiée (`src/strategy/crossSectionalMeanReversion.ts`), pas une extension de `combineStrategies` ni de `meanReversion.ts` | Le réordonnancement par z-score nécessite une vue simultanée de tout l'univers à chaque `decide()` — même raison architecturale que la Phase 9 (`ctx.views` donne déjà cet accès nativement) |
| Signal d'entrée | Identique au candidat validé : `price < sma(period) - entryK·std(period)`, par paire | Aucune nouvelle variable — seule la **priorité** entre candidats simultanés change, pas l'éligibilité |
| Signal de sortie | Identique au candidat validé : `price >= sma(period)`, par paire, indépendant du reste de l'univers | La sortie n'a pas de dimension relative — chaque position se gère individuellement, comme aujourd'hui |
| Ordre des intentions sur une bougie | Toutes les sorties (`exit`) avant toutes les entrées (`enter`) ; parmi les entrées, tri par z-score décroissant (le plus survendu en premier) | Sorties avant entrées : libère des places dans la même bougie (mécanisme vérifié dans `runner.ts` en Phase 9, toujours valide). Tri par z-score : c'est le cœur de l'hypothèse testée |
| Paramètres exposés | `period`, `entryK` — identiques au candidat validé, aucun ajout | 0 degré de liberté supplémentaire — comparaison directe, pas une nouvelle recherche de grille |
| Duplication de `sma()`/`std()` | Fonctions locales dupliquées depuis `meanReversion.ts`, pas importées | Même convention que `atrRiskCrossover.ts` (qui duplique délibérément la logique de `maCrossover.ts` — voir son commentaire d'en-tête) : `meanReversion.ts` reste figé pour protéger le candidat déjà validé de toute dérive d'implémentation accidentelle |
| Diagnostic de saturation du plafond | Backtest complet (hors walk-forward) sur la période commune entière, committé dans le script d'évaluation, comptant les rejets `« plafond de positions concurrentes atteint »` (`BacktestResult.rejectionReasons`) pour les deux variantes | Nécessaire pour interpréter honnêtement un résultat neutre — leçon explicite des Phases 7-9 (grilles/mécanismes qui ne se déclenchent jamais) |
| Grille d'évaluation | `period ∈ {70, 80}`, `entryK=4` fixe — les deux réglages déjà documentés comme candidats en Phase 6, chacun testé en 0-DoF (`paramGrid: [params]`) | Reproduit exactement la méthode des Phases 7/8 (comparer une variante à une référence déjà validée), pas une découverte de nouvelle famille |

## Architecture

### `src/strategy/crossSectionalMeanReversion.ts` (nouveau)

```ts
export interface CrossSectionalMeanReversionParams {
  readonly period: number;
  readonly entryK: number;
}

export function createCrossSectionalMeanReversion(params: CrossSectionalMeanReversionParams): Strategy
```

- Validation : `period` entier `>= 2` (message `Période invalide : ...`,
  même formulation que `meanReversion.ts`) ; `entryK > 0` (message `entryK
  invalide : ...`).
- `warmup = period`.
- `params` exposés : `{ period, entryK }`.
- `decide(ctx)` :
  1. Itère `[...ctx.views]` une seule fois (pas de `.get()` répété — leçon
     de code-quality de la Phase 9).
  2. Pour chaque `[symbol, view]` :
     - Si une position est déjà ouverte (`ctx.positions.get(symbol)`) :
       si `price >= smaVal`, ajoute un `exit` à la liste des sorties.
       Sinon (position ouverte, pas de sortie), rien — la paire est
       ignorée pour cette bougie, comme aujourd'hui.
     - Sinon (pas de position) : si `price < smaVal - entryK·stdVal`,
       calcule `zScore = (smaVal - price) / stdVal` et ajoute le candidat
       à la liste des entrées éligibles.
  3. Trie les candidats éligibles par `zScore` décroissant.
  4. Retourne `[...sorties, ...entrées triées]`, ou `[{ kind: 'hold' }]`
     si les deux listes sont vides.
- Le message (`reason`) de chaque `enter` inclut le `zScore` calculé, pour
  la traçabilité (permet de vérifier après coup que le tri a bien été
  appliqué dans le bon ordre).

### `test/crossSectionalMeanReversion.test.ts` (nouveau)

Nécessite un helper multi-symboles (comme
`test/crossSectionalMomentum.test.ts`, Phase 9) — plusieurs `BarSeries`
synthétiques partageant la même grille temporelle, assemblées en une
`ctx.views` à plusieurs entrées.

Cas à couvrir :
- Constructeur : lève si `period` invalide (non entier, `< 2`) ; lève si
  `entryK` invalide (`<= 0`) ; `warmup` égal à `period` ; `params`
  exposés.
- Une seule paire éligible, pas de position : `enter`.
- Aucune entrée si le prix n'est pas sous le seuil (pas de cassure).
- Pas de nouvelle entrée si une position est déjà ouverte sur cette
  paire, même si le prix reste sous le seuil.
- Sortie si `price >= sma`, avec position ouverte.
- Deux paires éligibles simultanément avec des profondeurs de survente
  différentes : les deux `enter` sont retournés, **dans l'ordre du
  z-score décroissant** (la plus survendue en premier) — test central de
  cette phase.
- Une sortie et une ou plusieurs entrées sur la même bougie : la sortie
  est retournée **avant** les entrées.
- Univers vide : `hold`, sans exception (même garde défensive que la
  Phase 9).

### `scripts/tune-cross-sectional-mean-reversion.ts` (nouveau, non testé — même catégorie que les scripts d'analyse existants)

Deux évaluations distinctes, committées dans le même script :

1. **Comparaison walk-forward** (référence `combineStrategies`-based vs
   variante cross-sectionnelle), pour `period ∈ {70, 80}`, `entryK=4` fixe,
   chacune en 0-DoF (`paramGrid: [params]`, même motif que
   `scripts/tune-mean-reversion-timestop.ts`). Imprime le rendement moyen
   hors-échantillon et le taux de fenêtres gagnantes pour les 4
   combinaisons (2 réglages × 2 stratégies).
2. **Diagnostic de saturation du plafond** : un `runBacktest` complet
   (pas de walk-forward — diagnostic, pas mesure) sur la période commune
   entière, pour les mêmes 4 combinaisons, imprimant `rejectedOrders`, le
   sous-compte de rejets dont la raison est exactement `'plafond de
   positions concurrentes atteint'`, et le nombre de trades réellement
   exécutés (`portfolio.trades.length`).

### `README.md` (modifié)

- Nouvelle puce dans « Recherche de stratégie (données réelles) »,
  documentant le résultat walk-forward **et** le diagnostic de saturation
  (le second conditionne l'interprétation honnête du premier — si le
  plafond n'est presque jamais atteint, un résultat neutre doit être
  qualifié de non concluant plutôt que d'échec du mécanisme, comme pour
  `maxVolatilityRatio=0,09` en Phase 7).
- Nouvelle ligne dans la section « Structure » pour
  `src/strategy/crossSectionalMeanReversion.ts` et
  `scripts/tune-cross-sectional-mean-reversion.ts`.

## Fichiers touchés

```
src/strategy/crossSectionalMeanReversion.ts       (nouveau)
test/crossSectionalMeanReversion.test.ts          (nouveau)
scripts/tune-cross-sectional-mean-reversion.ts    (nouveau, non testé — script d'analyse)
README.md                                         (modifié — résultat consigné après l'évaluation)
```
