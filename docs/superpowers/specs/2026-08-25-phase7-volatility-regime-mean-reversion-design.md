# Phase 7 — Mean-reversion avec filtre de régime de volatilité

Statut : approuvé (utilisateur : « Phase complet », 2026-08-25, après avoir
choisi cette piste parmi deux propositions).

## Contexte et objectif

Le seul candidat validé reste `mean-reversion` (bandes de Bollinger,
`period≈70-80, entryK=4`, univers complet, sans filtre de tendance ni de
volume) : +0,67 à +0,71 % par fenêtre de test, 65-68 % de trades gagnants,
sur 76-81 trades (voir README, section « Recherche de stratégie »). Trois
pistes d'amélioration précédentes n'ont rien apporté : filtre de tendance
(Phase 5c), filtre de volume (Phase 6), force relative cross-sectionnelle
(spike). Les deux filtres précédents portaient sur l'entrée elle-même
(direction du prix, confirmation de volume) ; cette phase teste un axe
différent : filtrer *quand* trader plutôt que *quel* signal trader.

**Hypothèse** : la réversion à la moyenne échoue surtout en régime de
forte volatilité / tendance marquée (le prix continue de s'écarter au lieu
de revenir — « attraper un couteau qui tombe » à l'échelle du régime, pas
seulement du creux individuel). En période de volatilité normale, un creux
qui franchit le seuil a plus de chances d'être un vrai retour à la
moyenne. Si l'hypothèse est fausse, on s'attend à ce que le filtre ne
change rien ou dégrade le résultat — aussi informatif qu'un résultat
positif, comme pour toutes les pistes précédentes de cette recherche.

**Critère de sortie** : le filtre est ajouté à `createMeanReversion` comme
paramètre optionnel unique, rétrocompatible (absence = comportement actuel
inchangé, aucune régression sur le candidat déjà validé), testé
unitairement, puis évalué par walk-forward sur les 20 paires réelles avec
une grille étroite calibrée sur la distribution réelle des données (pas
de valeurs arbitraires). Le résultat — amélioration, neutralité, ou
dégradation — est documenté honnêtement dans le README, quel qu'il soit.

Hors périmètre :
- Toute nouvelle famille de signal (déjà exploré : suivi de tendance,
  force relative, filtre de volume — voir README).
- Sélection de paires post-hoc (déjà explicitement écartée, biais de
  sélection rétroactive).
- Modification du critère de sortie existant (`price >= sma`) — seul le
  filtre d'entrée est concerné par cette phase.
- Combinaison avec les filtres de tendance ou de volume déjà testés (ni
  l'un ni l'autre n'est adopté ; les combiner ajouterait des degrés de
  liberté sans hypothèse motivée pour justifier cette combinaison
  spécifique).

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Où vit le filtre ? | Paramètre optionnel supplémentaire sur `createMeanReversion` (`src/strategy/meanReversion.ts`), pas une nouvelle stratégie séparée | Même pattern que `trendPeriod`/`volumePeriod` — DRY, cohérence, pas de duplication de la logique de signal déjà validée |
| Indicateur de volatilité | Réutilisation directe de `sma`/`std` déjà calculés pour les bandes de Bollinger à `period` (coefficient de variation `stdVal/smaVal`) — pas de nouvelle fenêtre | Le filtre de volume avait besoin d'une fenêtre de volume dédiée (rien d'existant ne la calculait) ; ici la mesure de volatilité est déjà calculée pour le seuil d'entrée lui-même, la réutiliser évite un degré de liberté supplémentaire (une deuxième période) |
| Nombre de paramètres ajoutés | Un seul : `maxVolatilityRatio` | `period`+`entryK`+`maxVolatilityRatio` = 3 degrés de liberté si adopté, au plafond documenté (`degreesOfFreedom()`, `src/strategy/types.ts`) sans le dépasser |
| Grille de test | Étroite, calibrée sur la vraie distribution des données plutôt que devinée : `maxVolatilityRatio ∈ {0.06, 0.075, 0.09}` (≈ percentiles 75/85/90 du ratio `std(period)/sma(period)` mesurés sur les 20 paires réelles, 4h, depuis 2019 — médiane empirique ≈0,042-0,045, p75≈0,062, p90≈0,088-0,094), combiné avec le `period`/`entryK` déjà validés (70-80 / 4), grille identique aux deux périodes (pas de calibration séparée par période, pour ne pas ajouter un degré de liberté caché) | Chercher large ou deviner des seuils a produit un pic isolé (avant validation) et deux pistes stériles dans cette recherche ; calibrer sur la distribution réelle rend le choix des seuils falsifiable et traçable plutôt qu'arbitraire |
| Rétrocompatibilité | `maxVolatilityRatio` optionnel ; son absence reproduit exactement le comportement actuel (aucune régression) | Le candidat déjà validé ne doit jamais changer de comportement par accident |

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
  /**
   * Seuil de coefficient de variation (std(period)/sma(period)) au-delà
   * duquel aucune entrée n'est autorisée — filtre de régime de forte
   * volatilité. Sans lui (défaut), aucun filtre. N'affecte jamais la
   * sortie.
   */
  readonly maxVolatilityRatio?: number;
}
```

- Validation : `maxVolatilityRatio` doit être `> 0` s'il est fourni (même
  contrainte que `volumeMultiplier`).
- `warmup` n'est pas affecté (le filtre réutilise `stdVal`/`smaVal` déjà
  calculés à `period`, aucune fenêtre supplémentaire).
- Condition d'entrée existante (`price < threshold && trendOk && volumeOk`)
  devient `price < threshold && trendOk && volumeOk && volRegimeOk`, où
  `volRegimeOk` vaut `true` si `maxVolatilityRatio` n'est pas fourni
  (comportement actuel inchangé), sinon
  `stdVal / smaVal <= maxVolatilityRatio` (`stdVal`/`smaVal` déjà calculés
  en tête de `decide()`, pas de recalcul).
- La condition de sortie (`price >= sma`) n'est pas modifiée.

### Script d'évaluation (`scripts/tune-mean-reversion-volatility.ts`, nouveau, non testé — même catégorie que les scripts d'analyse existants)

Lance `runWalkForward` sur les 20 paires réelles avec la grille étroite
décrite ci-dessus (6 combinaisons : `period ∈ {70,80} × maxVolatilityRatio
∈ {0.06, 0.075, 0.09}`) plus les 2 références sans filtre (`period=70/80,
entryK=4`), imprime le rendement moyen hors-échantillon et le taux de
fenêtres gagnantes pour chaque combinaison, en comparaison directe avec
les références. Même structure que
`scripts/tune-mean-reversion-volume.ts`.

## Fichiers touchés

```
src/strategy/meanReversion.ts             (modifié — paramètre optionnel ajouté)
test/meanReversion.test.ts                (modifié — nouveaux tests, existants inchangés)
scripts/tune-mean-reversion-volatility.ts (nouveau, non testé — script d'analyse)
README.md                                 (modifié — résultat consigné après l'évaluation)
```
