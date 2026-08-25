# Phase 8 — Mean-reversion avec stop de temps

Statut : approuvé (proposition faite par l'agent, confirmée par
l'utilisateur — « continue », 2026-08-25 — dans la continuité directe de
la recommandation « retravailler la sortie plutôt que l'entrée » déjà
faite avant la Phase 7).

## Contexte et objectif

Le seul candidat validé reste `mean-reversion` (bandes de Bollinger,
`period≈70-80, entryK=4`, univers complet, sans filtre de tendance, de
volume, ni de régime de volatilité) : +0,67 à +0,71 % par fenêtre de
test, 65-68 % de trades gagnants, sur 76-81 trades (voir README, section
« Recherche de stratégie »). Trois pistes précédentes ont toutes échoué
en filtrant l'**entrée** : filtre de tendance (Phase 5c), filtre de
volume (Phase 6), filtre de régime de volatilité (Phase 7). Cette phase
teste un axe différent, jamais touché jusqu'ici : la **sortie**. Le
critère de sortie actuel (`price >= sma`) est un seuil unique — la
stratégie reste en position indéfiniment tant que le prix n'est pas
revenu à la moyenne, sans limite de temps.

**Hypothèse** : un trade qui ne revient pas à la moyenne dans un délai
raisonnable a statistiquement moins de chances de le faire jamais (la
thèse du creux temporaire s'affaiblit avec le temps), et le capital
immobilisé dans une position stagnante a un coût d'opportunité (il ne
peut pas être alloué à un nouveau signal, sous le plafond
`maxConcurrentPositions=5`). Un stop de temps qui force la sortie après
`maxHoldBars` barres, si le retour à la moyenne n'a pas eu lieu avant,
devrait donc améliorer le rendement moyen — ou au moins ne pas le
dégrader, en libérant du capital plus tôt. Si l'hypothèse est fausse
(les trades qui prennent plus longtemps reviennent quand même, et sortir
tôt ne fait que réaliser une perte qui se serait résorbée), le stop de
temps dégradera le résultat — aussi informatif qu'un résultat positif,
comme pour toutes les pistes précédentes de cette recherche.

**Calibration de la grille sur les données réelles** (leçon de la Phase 7,
où la revue finale a reproché une grille calibrée sur la mauvaise
distribution) : durée de détention des 76-81 trades du candidat déjà
validé, mesurée directement sur un backtest complet (sans walk-forward,
juste pour calibrer la grille — pas pour évaluer le résultat) :

| | period=70, entryK=4 | period=80, entryK=4 |
|---|---|---|
| n trades | 81 | 76 |
| moyenne | 55,4 barres | 64,5 barres |
| p25 | 43 | 51 |
| p50 (médiane) | 55 | 63 |
| p75 | 68 | 84 |
| p90 | 90 | 98 |
| max | 124 | 133 |

**Critère de sortie (de la phase)** : le stop de temps est ajouté à
`createMeanReversion` comme paramètre optionnel, rétrocompatible (absence
= comportement actuel inchangé, aucune régression sur le candidat déjà
validé), testé unitairement, puis évalué par walk-forward sur les 20
paires réelles avec une grille étroite calibrée sur la distribution
ci-dessus. Le résultat — amélioration, neutralité, ou dégradation — est
documenté honnêtement dans le README, quel qu'il soit.

Hors périmètre :
- Toute nouvelle famille de signal (déjà exploré : suivi de tendance,
  force relative, filtre de volume, filtre de régime de volatilité — voir
  README).
- Sélection de paires post-hoc (déjà explicitement écartée, biais de
  sélection rétroactive).
- Combinaison avec les filtres d'entrée déjà testés (aucun n'est adopté ;
  les combiner ajouterait des degrés de liberté sans hypothèse motivée).
- Sortie partielle / échelonnée (sortir une fraction de la position) —
  changerait le modèle de sizing existant, hors périmètre de cette phase.
  Le stop de temps testé ici est un tout-ou-rien, comme la sortie
  actuelle.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Où vit le stop ? | Paramètre optionnel supplémentaire sur `createMeanReversion` (`src/strategy/meanReversion.ts`), pas une nouvelle stratégie séparée | Même pattern que les filtres précédents — DRY, cohérence |
| Mesure du temps détenu | `(ctx.now - position.entryTime) / (view.time(0) - view.time(1))`, arrondi — pas de nouveau champ sur `Position`/`StrategyContext`, réutilise l'intervalle de barre déduit de la vue elle-même | `Position.entryTime` et `ctx.now` existent déjà (`src/strategy/types.ts`) ; l'intervalle entre deux barres consécutives de la vue donne la durée d'une barre sans introduire de constante magique ni de nouveau champ d'API |
| Nombre de paramètres ajoutés | Un seul : `maxHoldBars` | `period`+`entryK`+`maxHoldBars` = 3 degrés de liberté si adopté, au plafond documenté (`degreesOfFreedom()`, `src/strategy/types.ts`) sans le dépasser |
| Grille de test | Étroite, calibrée sur la vraie distribution de durée de détention (table ci-dessus) plutôt que devinée : `maxHoldBars ∈ {75, 90, 110}` — couvre le p75 (period=70) jusqu'à juste sous le max observé, identique aux deux périodes (pas de calibration séparée par période, pour ne pas ajouter un degré de liberté caché) | Même méthode que la Phase 7 aurait dû utiliser dès le départ — calibrer sur la distribution effectivement pertinente (ici, la durée de détention réelle des trades du candidat déjà validé) plutôt que deviner |
| Interaction avec la sortie existante | Le stop de temps est une condition de sortie **supplémentaire**, en OU avec la condition existante (`price >= sma`) — la première des deux qui se déclenche l'emporte, jamais les deux en même temps | La sortie par retour à la moyenne reste la sortie "normale" ; le stop de temps est un filet de sécurité pour les positions qui ne reviennent pas, pas un remplacement |
| Rétrocompatibilité | `maxHoldBars` optionnel ; son absence reproduit exactement le comportement actuel (aucune régression) | Le candidat déjà validé ne doit jamais changer de comportement par accident |

## Architecture

### `src/strategy/meanReversion.ts` (modifié)

```ts
export interface MeanReversionParams {
  readonly symbol: string;
  readonly period: number;
  readonly entryK: number;
  readonly trendPeriod?: number;
  readonly volumePeriod?: number;
  readonly volumeMultiplier?: number;
  readonly maxVolatilityRatio?: number;
  /**
   * Nombre maximal de barres qu'une position peut rester ouverte avant
   * une sortie forcée, si le retour à la moyenne (price >= sma) ne s'est
   * pas encore produit. Sans lui (défaut), aucune limite — comportement
   * actuel inchangé. N'affecte jamais l'entrée.
   */
  readonly maxHoldBars?: number;
}
```

- Validation : `maxHoldBars` entier `>= 1` s'il est fourni (contrainte
  minimale : une position ne peut pas être forcée à sortir avant même
  d'avoir tenu une barre).
- `warmup` n'est pas affecté (le stop de temps ne nécessite aucune
  fenêtre d'indicateur — seulement `ctx.now`, `position.entryTime`, et
  l'intervalle déduit de la vue, tous déjà disponibles à chaque appel).
- Condition de sortie existante (`hasPosition && price >= smaVal`)
  devient `hasPosition && (price >= smaVal || timeStopOk)`, où
  `timeStopOk` vaut `false` si `maxHoldBars` n'est pas fourni
  (comportement actuel inchangé), sinon
  `barsHeld >= maxHoldBars` avec `barsHeld = Math.round((ctx.now - position.entryTime) / (view.time(0) - view.time(1)))`.
  Le message (`reason`) de l'intent `exit` doit distinguer les deux cas
  (retour à la moyenne vs stop de temps), pour la traçabilité.
- La condition d'entrée n'est pas modifiée.

### Script d'évaluation (`scripts/tune-mean-reversion-timestop.ts`, nouveau, non testé — même catégorie que les scripts d'analyse existants)

Lance `runWalkForward` sur les 20 paires réelles avec la grille étroite
décrite ci-dessus (6 combinaisons : `period ∈ {70,80} × maxHoldBars ∈
{75, 90, 110}`) plus les 2 références sans stop de temps (`period=70/80,
entryK=4`), imprime le rendement moyen hors-échantillon et le taux de
fenêtres gagnantes pour chaque combinaison, en comparaison directe avec
les références. Même structure que
`scripts/tune-mean-reversion-volatility.ts`. Suivant la leçon de la
Phase 7 (revue finale exigeant des chiffres reproductibles depuis le
dépôt, pas d'instrumentation jetable) : le script imprime aussi, pour
chaque réglage de `maxHoldBars`, combien de trades ont réellement été
coupés par le stop de temps (plutôt que par le retour à la moyenne) dans
les fenêtres de test walk-forward — nécessaire pour interpréter
honnêtement un résultat neutre ou dégradé (est-ce que le stop se
déclenche effectivement, ou est-il structurellement hors d'atteinte
comme `maxVolatilityRatio=0,09` en Phase 7 ?).

## Fichiers touchés

```
src/strategy/meanReversion.ts            (modifié — paramètre optionnel ajouté)
test/meanReversion.test.ts               (modifié — nouveaux tests, existants inchangés)
scripts/tune-mean-reversion-timestop.ts  (nouveau, non testé — script d'analyse)
README.md                                (modifié — résultat consigné après l'évaluation)
```
