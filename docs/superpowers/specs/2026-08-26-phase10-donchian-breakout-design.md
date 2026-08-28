# Phase 10 — Breakout Donchian/Turtle

Statut : approuvé (proposition faite par l'agent, confirmée par
l'utilisateur — « oui », 2026-08-26 — après l'échec du momentum
cross-sectionnel en Phase 9, deuxième famille directionnelle à échouer
après le suivi de tendance par croisement de moyennes).

## Contexte et objectif

Deux familles reposant sur l'hypothèse « le prix continue dans sa
direction récente » ont maintenant échoué avec une signature de
sur-optimisation nette : le croisement de SMA (Phase 0, README) et le
momentum cross-sectionnel (Phase 9, in-sample +38 à +53 %, hors-échantillon
-1,4 à -1,9 %). Le breakout Donchian teste un **mécanisme de déclenchement
différent** au sein de la même famille directionnelle au sens large :
au lieu de comparer deux moyennes mobiles (état lissé, réagit avec retard)
ou de classer les paires entre elles (relatif, pas absolu), il compare le
prix courant à l'extremum (plus haut/plus bas) d'une fenêtre récente —
signal binaire, pas de lissage. C'est le système « Turtle » historique,
documenté indépendamment sur crypto (backtests BTC 2017-2023 positifs à
travers les cycles bull/bear, système 20/55 jours) par des sources
distinctes de celles déjà consultées pour le momentum.

**Hypothèse** : un signal de cassure de canal, structurellement différent
d'une moyenne mobile ou d'un classement relatif, peut capturer un edge que
les deux mécanismes précédents n'ont pas trouvé — ou peut échouer pour la
même raison structurelle qu'eux (sur-optimisation par sélection de
paramètres sur un marché où la persistance de tendance à cet horizon
n'est pas assez forte pour survivre aux frais). Les deux résultats sont
informatifs.

**Nature de cette phase** : comme la Phase 9, il s'agit de la découverte
d'une nouvelle famille de stratégie, pas du raffinement d'un candidat déjà
validé — grille exploratoire avec sélection walk-forward réelle, pas de
grille à 0 degré de liberté.

**Leçon explicitement appliquée (revue finale de Phase 9)** : la
référence académique/historique (20/55 **jours**) calibrée sur des
bougies journalières donnerait, convertie brute en bougies 4h de ce
projet, `entryPeriod≈330` — largement supérieur à `TEST_BARS=180`, ce qui
ferait échouer `runBacktest` immédiatement (`length < warmup+2`) et, à
une échelle moindre, reproduirait le piège déjà rencontré deux fois
(Phase 7 : seuil jamais atteint ; Phase 9 : fenêtre de test dominée par le
warmup). La grille de cette phase est donc calibrée directement en
bougies 4h, avec une marge confortable sous `TEST_BARS=180`, pas convertie
naïvement depuis une référence journalière.

Hors périmètre (cohérent avec la discipline « une variable à la fois »
déjà appliquée aux phases précédentes) :
- **Stop ATR / sizing par risque** : pas de `stopDistance` en v1, sizing
  fraction fixe comme `ma-crossover`/`mean-reversion`. `atr-risk-crossover`
  a déjà montré que l'ajout d'un stop ATR au suivi de tendance n'apportait
  pas d'amélioration démontrée — pas de raison de le tester en premier ici
  avant d'avoir une référence sans stop.
- **Canal symétrique unique** (`entryPeriod == exitPeriod`) : le système
  Turtle historique utilise délibérément deux fenêtres différentes
  (entrée large, sortie plus courte) pour réduire le va-et-vient ; c'est
  la configuration testée, pas une simplification à un seul paramètre.
- **Vente à découvert** : hors de portée, Kraken spot EUR uniquement.
- **Filtre de tendance long terme, de volume, ou de régime de
  volatilité** : déjà testés sur mean-reversion sans effet démontré
  (Phases 5c/6/7) — pas réintroduits ici sans une raison spécifique à ce
  nouveau signal.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Architecture | Stratégie **mono-paire classique** (`src/strategy/donchianBreakout.ts`), assemblée via `combineStrategies` existant — pas le pattern multi-paires dédié de la Phase 9 | Le breakout Donchian est évalué indépendamment par paire (pas de classement relatif entre paires) ; c'est exactement le pattern déjà utilisé par `ma-crossover`/`atr-risk-crossover`/`mean-reversion` |
| Calcul du canal | Fonctions locales `highestHigh(view, period)` / `lowestLow(view, period)`, boucle `for (let ago = 1; ago <= period; ago++)` — **exclut la barre courante** (`ago` commence à 1, pas 0) | Si le canal incluait la barre courante, `close(0) > highestHigh` serait structurellement impossible (`close(0) <= high(0)` toujours) — la cassure ne pourrait jamais se déclencher. Pas besoin d'une nouvelle classe dans `indicators.ts` : ce calcul n'est pas incrémental de façon triviale (max/min glissant) et le reste du projet recalcule déjà ses indicateurs à neuf à chaque appel de `decide()` (voir le commentaire d'en-tête de `indicators.ts`) — une simple boucle locale suit la convention existante (`sma()`/`atr()` dans `atrRiskCrossover.ts`) |
| Signal d'entrée | `!hasPosition && close(0) > highestHigh(view, entryPeriod)` | Cassure haussière du canal des `entryPeriod` dernières bougies |
| Signal de sortie | `hasPosition && close(0) < lowestLow(view, exitPeriod)` | Cassure baissière du canal des `exitPeriod` dernières bougies — fenêtre plus courte que l'entrée dans la grille testée (voir ci-dessous), conformément au système Turtle historique |
| `warmup` | `Math.max(entryPeriod, exitPeriod)` | Garantit que `view.high(period)`/`view.low(period)` sont toujours lisibles (même convention légèrement conservative que `mean-reversion`, qui fixe `warmup = period` plutôt que `period - 1`) |
| Sizing | Fraction fixe existante (`sizeBuyOrder`), pas de `stopDistance` en v1 | Discipline « une variable à la fois » |
| Paramètres exposés | `entryPeriod`, `exitPeriod` — 2 degrés de liberté | Cohérent avec `ma-crossover` (`fast`/`slow`) et `mean-reversion` (`period`/`entryK`) |
| Validation | `entryPeriod`/`exitPeriod` entiers `>= 1` chacun ; **pas** de contrainte `exitPeriod < entryPeriod` imposée par le code | La grille testée respecte ce ratio par construction (voir ci-dessous), mais l'imposer dans le constructeur ajouterait une règle non demandée par la spec fonctionnelle — cohérent avec YAGNI |
| Calibration de la grille | Bougies 4h directement (pas de conversion depuis une référence journalière) : paires alignées `(entryPeriod, exitPeriod)` ∈ `{(30,10), (60,20), (120,40)}` — ratio ~3:1, 3 points au lieu d'un produit cartésien 3×3 | Marge confortable sous `TEST_BARS=180` (au pire `entryPeriod=120` → `180-120-1=59` barres de décision par fenêtre de test, très supérieur au cas dégénéré à 11 barres de la Phase 9) ; ratio motivé par la convention Turtle plutôt qu'un produit cartésien non justifié qui multiplierait les combinaisons sans hypothèse supplémentaire |

## Architecture

### `src/strategy/donchianBreakout.ts` (nouveau)

```ts
export interface DonchianBreakoutParams {
  readonly symbol: string;
  readonly entryPeriod: number;
  readonly exitPeriod: number;
}

export function createDonchianBreakout(params: DonchianBreakoutParams): Strategy
```

- Validation : `entryPeriod`/`exitPeriod` entiers `>= 1`.
- `warmup = Math.max(entryPeriod, exitPeriod)`.
- `params` exposés : `{ entryPeriod, exitPeriod }`.
- `decide(ctx)` :
  1. `view = ctx.views.get(symbol)` ; si absent, `hold`.
  2. `hasPosition = ctx.positions.has(symbol)`.
  3. Si `!hasPosition` : `entryHigh = highestHigh(view, entryPeriod)` ; si
     `view.close(0) > entryHigh`, `enter` (raison : valeur de cassure +
     `entryHigh`).
  4. Si `hasPosition` : `exitLow = lowestLow(view, exitPeriod)` ; si
     `view.close(0) < exitLow`, `exit` (raison : valeur de cassure +
     `exitLow`).
  5. Sinon `hold`.
- `highestHigh`/`lowestLow` : fonctions locales non exportées, boucle
  `ago` de `1` à `period` inclus (jamais `ago=0`).

### `test/donchianBreakout.test.ts` (nouveau)

Le helper `seriesFrom` à un seul symbole des tests existants
(`test/maCrossover.test.ts`) construit des bougies où `open=high=low=close`
— insuffisant ici puisque le canal dépend de `high`/`low` distincts de
`close`. Nouveau helper local à ce fichier de test, `seriesFromOHLC(bars:
{ high: number; low: number; close: number }[])`, construisant une
`BarSeries` avec des colonnes `high`/`low`/`close` indépendantes
(`open` égal à `close` par simplicité, non lu par cette stratégie).

Cas à couvrir :
- Constructeur : lève si `entryPeriod` invalide (non entier, `< 1`) ; lève
  si `exitPeriod` invalide (non entier, `< 1`) ; `warmup` égal au maximum
  des deux ; `params` exposés.
- Entrée : cassure haussière (`close(0)` strictement supérieur au plus
  haut des `entryPeriod` bougies précédentes) sans position → `enter`.
- Pas d'entrée si `close(0)` égal ou inférieur au plus haut du canal (pas
  de cassure, ou cassure non stricte).
- Pas d'entrée si une position est déjà ouverte, même en cas de cassure.
- Sortie : cassure baissière (`close(0)` strictement inférieur au plus bas
  des `exitPeriod` bougies précédentes) avec position ouverte → `exit`.
- Pas de sortie si `close(0)` égal ou supérieur au plus bas du canal.
- Pas de sortie sans position ouverte (comportement `hold`, même en cas de
  cassure baissière).
- La barre courante n'est jamais incluse dans le calcul du canal (test
  explicite : un extremum sur la barre courante seule, plus large que tout
  l'historique précédent, ne doit pas empêcher une cassure basée
  uniquement sur l'historique).

### `scripts/tune-donchian-breakout.ts` (nouveau, non testé — même catégorie que les scripts d'analyse existants)

- Charge les 20 paires réelles, même motif que
  `scripts/run-walkforward.ts`/`scripts/tune-cross-sectional-momentum.ts`
  (`loadUniverse`, `from: 2019-01-01`, `interval: 240`).
- `strategyFactory: (p: { entryPeriod: number; exitPeriod: number }) => combineStrategies(UNIVERSE_SYMBOLS.map((symbol) => createDonchianBreakout({ symbol, ...p })))`
  — même motif que les candidats mono-paire de `run-walkforward.ts`.
- `paramGrid` : les 3 paires alignées `{(30,10), (60,20), (120,40)}` —
  **un seul appel `runWalkForward`** (contrairement à la Phase 9, il n'y a
  pas de couplage `topN`/`maxConcurrentPositions` ici : `maxConcurrentPositions=5`
  fixe comme dans tous les scripts précédents).
- `TRAIN_BARS = 1095`, `TEST_BARS = 180` (cohérent avec le reste du
  projet).
- Imprime, comme `run-walkforward.ts` (`runCandidate`) : rendement moyen
  in-sample, rendement moyen hors-échantillon, nombre de fenêtres
  gagnantes, meilleur/pire fold, et — leçon de la Phase 9 — le
  `entryPeriod`/`exitPeriod` réellement sélectionné par fold, pour pouvoir
  vérifier honnêtement qu'aucun réglage ne consomme une fraction excessive
  de `TEST_BARS` (aucun ne devrait ici, la grille étant calibrée avec
  marge, mais la traçabilité par fold reste la discipline établie).

### `README.md` (modifié)

- Nouvelle puce dans « Recherche de stratégie (données réelles) »,
  documentant le résultat obtenu (edge, neutre, ou sur-optimisation) avec
  les chiffres réels imprimés par le script — jamais une estimation.
- Nouvelles lignes dans la section « Structure » pour
  `src/strategy/donchianBreakout.ts` et `scripts/tune-donchian-breakout.ts`.

## Fichiers touchés

```
src/strategy/donchianBreakout.ts       (nouveau)
test/donchianBreakout.test.ts          (nouveau)
scripts/tune-donchian-breakout.ts      (nouveau, non testé — script d'analyse)
README.md                              (modifié — résultat consigné après l'évaluation)
```
