# Phase 9 — Momentum cross-sectionnel

Statut : approuvé (Approche A confirmée par l'utilisateur — « oui »,
2026-08-26 — après une session de recherche externe sur des sources quant
reconnues, voir « Contexte et objectif »).

## Contexte et objectif

Recherche interne à ce jour (voir README, section « Recherche de
stratégie ») : le suivi de tendance rapide (croisement de SMA sur bougies
4h) a montré une signature nette de sur-optimisation (rendement
hors-échantillon négatif). La réversion à la moyenne (`mean-reversion`,
bandes de Bollinger, `period≈70-80, entryK=4`) reste le seul candidat
avec un edge mesuré (+0,67 à +0,71 % par fenêtre de test), mais fragile et
dominé par les frais à haute fréquence — l'amélioration est venue de la
**réduction** de la fréquence de trading, pas d'un filtre d'entrée ou de
sortie supplémentaire (Phases 6-8, toutes neutres ou non concluantes).

Recherche externe (sites spécialisés — Quantpedia, QuantStart, Robot
Wealth — et littérature académique peer-reviewed) : le momentum est
l'anomalie la mieux documentée en finance, confirmée spécifiquement sur
crypto par Liu, Tsyvinski & Wu (*Common Risk Factors in Cryptocurrency*,
Journal of Finance 2022) — momentum et taille comptent parmi les trois
facteurs qui expliquent les rendements cross-sectionnels crypto. Le
momentum **cross-sectionnel** (classer un univers de paires par
performance relative, plutôt que suivre la tendance de chaque paire
isolément) est un mécanisme structurellement différent du croisement de
SMA déjà écarté : il ne prédit pas la direction d'une paire, il exploite
la dispersion de performance *entre* les paires d'un même univers — ce
que `src/config/universe.ts` anticipe déjà explicitement (« un univers
monofactoriel invalide le test cross-sectionnel »).

**Hypothèse** : classer les 20 paires de l'univers par rendement passé
sur une fenêtre de formation, détenir les `topN` meilleures, rebalancé à
fréquence hebdomadaire (donc peu de trades, comme la leçon retenue de
mean-reversion), produit un rendement hors-échantillon positif
indépendamment mesurable par le même harnais walk-forward que le reste du
projet. Si l'hypothèse est fausse, le résultat sera documenté aussi
honnêtement que les pistes précédentes qui ont échoué.

**Nature de cette phase** : contrairement aux Phases 6-8 (qui
re-testaient un filtre optionnel sur un candidat **déjà validé**, avec
des grilles étroites à 0 degré de liberté), la Phase 9 explore une
**nouvelle famille de stratégie** depuis zéro — comme l'a été le premier
passage sur le suivi de tendance et la réversion à la moyenne
(`scripts/run-walkforward.ts`, grilles plus larges avec sélection
walk-forward réelle). Le critère de sortie de cette phase n'est donc pas
« bat une référence déjà établie », mais : le mécanisme est implémenté,
testé unitairement, évalué par walk-forward sur une grille exploratoire
raisonnable, et le résultat (edge, neutre, ou sur-optimisation) est
documenté avec la même rigueur que les familles précédentes.

Hors périmètre (approches délibérément écartées pour cette phase, voir
discussion avec l'utilisateur) :
- **Momentum absolu / dual momentum** (Approche C) : ne détenir que les
  paires à rendement positif, cash sinon. Adresse le risque documenté de
  « momentum crash », mais mélangerait deux décisions dans la même
  mesure. À tester en phase ultérieure si l'Approche A montre un edge.
- **Stop ATR / sizing par risque sur les entrées** (Approche B) : ajoute
  des degrés de liberté dès la baseline. Idem, phase ultérieure éventuelle.
- **Vente à découvert** : hors de portée — Kraken spot EUR uniquement,
  pas de perpetuals dans le pipeline actuel.
- **Sélection de secteur ou de sous-univers** : l'univers complet des 20
  paires est utilisé tel quel, comme pour toutes les phases précédentes.
- **Combinaison avec mean-reversion** : cette phase teste le momentum
  cross-sectionnel isolément. Une combinaison éventuelle (allocation de
  capital entre les deux familles) est hors périmètre.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Architecture | Nouvelle stratégie multi-paires dédiée (`src/strategy/crossSectionalMomentum.ts`), pas une extension de `combineStrategies` | Décision utilisateur explicite ; `ctx.views` donne déjà accès à tout l'univers à chaque `decide()` (voir `src/strategy/types.ts`), donc une stratégie cross-sectionnelle rentre nativement dans l'interface `Strategy` existante sans la modifier |
| Fréquence de rebalancement | Hebdomadaire, détectée par franchissement de frontière de semaine epoch (`Math.floor(t / 604800)`) entre la barre précédente et la barre courante | Décision utilisateur explicite. Doit rester une fonction **pure** de `ctx` (le contrat `Strategy` interdit tout état mutable, y compris un compteur de barres interne) — le franchissement de frontière epoch se déduit uniquement de `view.time(1)` et `ctx.now`, tous deux déjà disponibles |
| Référence temporelle pour la détection de frontière | N'importe quelle vue de `ctx.views` (toutes garanties alignées sur la même grille temporelle par les invariants existants de `runBacktest`/`runWalkForward`) | Pas besoin de choisir un symbole précis ; l'alignement cross-sectionnel est déjà un invariant du projet |
| Sizing | Fraction fixe existante (`sizeBuyOrder`, `src/backtest/runner.ts`), pas de `stopDistance` en v1 | Approche A — pas de degré de liberté supplémentaire à la baseline |
| Ordre des intents sur une barre de rebalancement | Toutes les sorties (`exit`) émises avant toutes les entrées (`enter`) | Vérifié dans `runner.ts` : un `order-filled` est traité immédiatement (`unshift`) avant le `order-requested` suivant de la même barre — émettre les sorties en premier libère des slots de `maxConcurrentPositions` que les entrées de la même barre peuvent alors utiliser |
| Ordre interne des entrées | Dans l'ordre du classement (meilleur rendement en premier) | Si `maxConcurrentPositions` contraint le nombre d'entrées effectivement remplies dans une barre, les paires au momentum le plus fort doivent avoir la priorité de fait (même mécanisme de priorité implicite que documenté dans `combineStrategies.ts`) |
| Filtre de signe (momentum absolu) | Absent en v1 (Approche A) : le `topN` est toujours détenu intégralement, même si son rendement de formation est négatif | Isoler une seule variable à la fois, comme pour mean-reversion (Phases 6-8) |
| Couplage `topN` / `maxConcurrentPositions` | Le script d'évaluation doit fixer `BacktestOptions.maxConcurrentPositions = topN` pour chaque valeur de `topN` testée | `sizeBuyOrder` calcule le budget par position comme `equity / maxConcurrentPositions` (fraction fixe) — si `topN < maxConcurrentPositions`, le capital serait sous-déployé (chaque position ne recevrait qu'une fraction dimensionnée pour un plus grand nombre de positions). `runWalkForward` ne permet qu'un seul `BacktestOptions` fixe pour tout un appel (pas par point de grille) → le script doit boucler sur les valeurs de `topN` **en dehors** du `paramGrid` walk-forward, avec un appel `runWalkForward` séparé par valeur de `topN` |
| Paramètres exposés | `lookbackPeriod` (nombre de barres), `topN` (nombre de paires détenues) — 2 degrés de liberté | Cohérent avec le plafond documenté par `degreesOfFreedom()` |
| Cas dégénéré : moins de symboles que `topN` | Détient tout l'univers disponible de `ctx.views`, sans erreur | Ne devrait jamais se produire avec l'univers réel (20 paires) mais doit rester un comportement défini, pas une exception, pour la robustesse des tests unitaires sur de petits univers synthétiques |
| Pas de churn inutile | Une paire déjà détenue et toujours dans le nouveau `topN` ne génère ni `exit` ni `enter` | Évite des frais d'aller-retour inutiles — c'est tout l'intérêt de comparer l'ensemble actuel détenu à l'ensemble cible plutôt que de tout liquider et tout racheter à chaque rebalancement |

## Architecture

### `src/strategy/crossSectionalMomentum.ts` (nouveau)

```ts
export interface CrossSectionalMomentumParams {
  readonly lookbackPeriod: number;
  readonly topN: number;
}

export function createCrossSectionalMomentum(params: CrossSectionalMomentumParams): Strategy
```

- Validation au constructeur : `lookbackPeriod` entier `>= 1`, `topN`
  entier `>= 1`.
- `warmup = lookbackPeriod`.
- `params` exposés : `{ lookbackPeriod, topN }`.
- `decide(ctx)` :
  1. `symbols = [...ctx.views.keys()]`. Si vide, `hold`.
  2. Détection de rebalancement : prendre n'importe quelle vue de
     `ctx.views` (la première par itération), calculer
     `Math.floor(ctx.now / 604800) !== Math.floor(view.time(1) / 604800)`.
     Si faux, retourner `[{ kind: 'hold' }]` immédiatement — aucun calcul
     de classement hors barre de rebalancement.
  3. Pour chaque symbole, rendement de formation :
     `view.close(0) / view.close(lookbackPeriod) - 1`.
  4. Trier les symboles par rendement décroissant (tri stable — en cas
     d'égalité exacte, l'ordre d'origine de `symbols`, donc de
     `ctx.views`, est préservé — comportement garanti par `Array.sort`
     depuis ES2019, pas besoin de départage explicite), prendre les
     `topN` premiers (ou tous si moins de `topN` symboles disponibles) →
     `targetSet`, dans l'ordre du classement.
  5. `currentlyHeld = symbols.filter(s => ctx.positions.has(s))` (restreint
     à l'univers de cette stratégie, pas à toutes les positions du
     portefeuille — cohérent avec le fait que la stratégie ne gère que ce
     qu'elle voit dans `ctx.views`).
  6. `toExit = currentlyHeld` non présents dans `targetSet`.
  7. `toEnter = targetSet` (dans l'ordre du classement) non présents dans
     `currentlyHeld`.
  8. Retourner `[...toExit.map(exit), ...toEnter.map(enter)]`, ou
     `[{ kind: 'hold' }]` si les deux listes sont vides.
- `reason` de chaque intent : inclure le rendement de formation et le rang
  (traçabilité, même esprit que les autres stratégies du projet).

### `test/crossSectionalMomentum.test.ts` (nouveau)

Nécessite un helper multi-symboles (les tests existants de
`meanReversion.test.ts` n'ont qu'un seul symbole) : construire plusieurs
`BarSeries` synthétiques partageant la même grille temporelle, plusieurs
`BarView` à la même barre `t`, assembler `ctx.views` comme une Map à
plusieurs entrées.

Cas à couvrir :
- Constructeur : lève si `lookbackPeriod` invalide (non entier, `< 1`) ;
  lève si `topN` invalide (non entier, `< 1`) ; `warmup` égal à
  `lookbackPeriod` ; `params` exposés.
- Hors barre de rebalancement : `hold`, même si le classement calculé
  changerait la composition (vérifie que le calcul de classement n'est
  même pas atteint / n'a pas d'effet en dehors du rebalancement).
- Sur barre de rebalancement, univers de 4-5 symboles synthétiques avec
  des rendements de formation clairement différenciés : sélectionne
  exactement les `topN` meilleurs, émet `exit` pour une position détenue
  qui sort du classement, émet `enter` pour une nouvelle entrée qui y
  rentre, dans l'ordre exits-puis-enters.
- Pas de churn : une position détenue qui reste dans le nouveau `topN` ne
  génère ni `exit` ni `enter`.
- Cas dégénéré : univers plus petit que `topN` → détient tout l'univers
  disponible, pas d'exception.
- Ordre interne des entrées : sur un rebalancement avec plusieurs
  nouvelles entrées, l'ordre du tableau retourné respecte le classement
  (meilleur rendement en premier).

### `scripts/tune-cross-sectional-momentum.ts` (nouveau, non testé — même catégorie que les scripts d'analyse existants)

- Charge les 20 paires réelles, même motif que
  `scripts/run-walkforward.ts` (`loadUniverse`, `from: 2019-01-01`,
  `interval: 240`).
- Grille exploratoire (pas 0-DoF — découverte d'une nouvelle famille, voir
  « Contexte et objectif ») :
  - `topN ∈ {3, 5, 7}` (boucle **externe**, en dehors de `runWalkForward`,
    car couplé à `BacktestOptions.maxConcurrentPositions` — voir table de
    décisions).
  - `lookbackPeriod ∈ {42, 84, 168}` bougies 4h (≈ 7, 14, 28 jours) —
    grille interne, passée comme `paramGrid` à `runWalkForward`.
- Pour chaque `topN`, un appel `runWalkForward` séparé avec
  `BacktestOptions.maxConcurrentPositions = topN`, `TRAIN_BARS = 1095`,
  `TEST_BARS = 180` (cohérent avec le reste du projet).
- `strategyFactory: (params: { lookbackPeriod: number }) => createCrossSectionalMomentum({ lookbackPeriod: params.lookbackPeriod, topN })`
  — pas de `combineStrategies` : la stratégie est nativement multi-paires.
- Imprime, pour chaque combinaison `(topN, lookbackPeriod)` : rendement
  in-sample moyen, rendement hors-échantillon moyen, nombre de fenêtres
  gagnantes, meilleur/pire fold — même format que
  `scripts/run-walkforward.ts` (`runCandidate`).

### `README.md` (modifié)

- Nouvelle puce dans « Recherche de stratégie (données réelles) »,
  documentant le résultat obtenu (edge, neutre, ou sur-optimisation) avec
  les chiffres réels imprimés par le script — jamais une estimation,
  comme pour toutes les phases précédentes.
- Nouvelles lignes dans la section « Structure » pour
  `src/strategy/crossSectionalMomentum.ts` et
  `scripts/tune-cross-sectional-momentum.ts`.

## Fichiers touchés

```
src/strategy/crossSectionalMomentum.ts       (nouveau)
test/crossSectionalMomentum.test.ts          (nouveau)
scripts/tune-cross-sectional-momentum.ts     (nouveau, non testé — script d'analyse)
README.md                                    (modifié — résultat consigné après l'évaluation)
```
