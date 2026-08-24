# Phase 6 — Mean-reversion avec confirmation de volume

Statut : approuvé (décisions actées en session autonome le 2026-08-25,
pendant que l'utilisateur dormait — voir « Rulings » dans le ledger SDD
pour la trace de chaque décision prise en son absence).

## Contexte et objectif

La recherche de stratégie a déjà établi (voir README, section « Recherche
de stratégie ») que `mean-reversion` (bandes de Bollinger, `period≈70-80,
entryK=4`, univers complet, sans filtre de tendance) est le seul candidat
ayant montré un edge positif hors échantillon, validé à 0 degré de
liberté : +0,67 à +0,71 % par fenêtre de test, 65-68 % de trades gagnants,
facteur de profit ~2-2,7 — mais sur un échantillon encore modeste
(76-81 trades). Deux pistes d'amélioration ultérieures (filtre de
tendance, force relative cross-sectionnelle) n'ont rien apporté de mieux.

Cette phase teste une piste différente, motivée par un edge déjà réel
plutôt que par une nouvelle famille de signal partant de zéro : filtrer
les entrées de `mean-reversion` par le volume. L'intuition : un creux de
prix accompagné d'un volume anormalement élevé (capitulation réelle) a
plus de chances d'être suivi d'un vrai retour à la moyenne qu'un creux sur
volume ordinaire (bruit). Si cette intuition est fausse, on s'attend à ce
que le filtre ne change rien ou dégrade le résultat — un résultat négatif
ici est tout aussi informatif qu'un résultat positif, comme pour toutes
les pistes précédentes.

**Critère de sortie** : le filtre de volume est ajouté à
`createMeanReversion` comme paramètre optionnel (rétrocompatible — son
absence reproduit exactement le comportement actuel, aucune régression
sur le candidat déjà validé), testé unitairement, puis évalué par
walk-forward sur les 20 paires réelles avec une grille volontairement
étroite (peu de degrés de liberté ajoutés, pour ne pas retomber dans le
piège de sur-optimisation déjà démasqué deux fois dans cette recherche).
Le résultat — amélioration, neutralité, ou dégradation — est documenté
honnêtement dans le README, quel qu'il soit.

Hors périmètre :
- Toute nouvelle famille de signal (déjà exploré : suivi de tendance,
  force relative — voir README).
- Sélection de paires post-hoc (déjà explicitement écartée, biais de
  sélection rétroactive).
- Modification du critère de sortie existant (`price >= sma`) — seul le
  filtre d'entrée est concerné par cette phase.

## Décisions actées

| Question | Décision | Raison |
|---|---|---|
| Où vit le filtre ? | Paramètre optionnel supplémentaire sur `createMeanReversion` (`src/strategy/meanReversion.ts`), pas une nouvelle stratégie séparée | Même fichier, même pattern que l'ajout du filtre de tendance (`trendPeriod`) — DRY, cohérence, pas de duplication de la logique de signal déjà validée |
| Indicateur de volume | Moyenne mobile simple (`Sma`, déjà existante dans `indicators.ts`) appliquée à `view.volume(ago)` plutôt qu'à `view.close(ago)` | `Sma` est déjà générique sur n'importe quelle série numérique — aucun nouvel indicateur à écrire |
| Grille de test | Étroite et volontairement contrainte : `volumeMultiplier` ∈ {1.2, 1.5, 2.0} à `volumePeriod` fixe (20), combiné avec le `period`/`entryK` déjà validés (70-80 / 4), pas une recherche libre sur tous les paramètres à la fois | Chercher large a déjà produit deux faux positifs dans cette recherche (le pic isolé à period=80/entryK=4 avant validation, et le premier essai de force relative) — cette phase teste une hypothèse précise, pas une pêche au signal |
| Rétrocompatibilité | `volumePeriod`/`volumeMultiplier` optionnels, doivent être fournis ensemble ou pas du tout ; leur absence reproduit exactement le comportement actuel (aucune régression) | Le candidat déjà validé ne doit jamais changer de comportement par accident |

## Architecture

### `src/strategy/meanReversion.ts` (modifié)

```ts
export interface MeanReversionParams {
  readonly symbol: string;
  readonly period: number;
  readonly entryK: number;
  readonly trendPeriod?: number;
  /** Période de la moyenne de volume de confirmation. Fourni avec volumeMultiplier, ou pas du tout. */
  readonly volumePeriod?: number;
  /** Multiplicateur du volume moyen requis à l'entrée (confirmation de capitulation). */
  readonly volumeMultiplier?: number;
}
```

- Validation : si l'un de `volumePeriod`/`volumeMultiplier` est fourni sans
  l'autre, lève. `volumePeriod` entier ≥ 2 (contrainte de `Sma`/`RollingStd`
  existante), `volumeMultiplier > 0`.
- `warmup = max(period, trendPeriod ?? 0, volumePeriod ?? 0)`.
- Nouvelle fonction pure interne `avgVolume(view, period)`, même structure
  que `sma`/`std` déjà présentes dans le fichier (instancie `Sma`, boucle
  `ago` décroissant, renvoie `.value`).
- Condition d'entrée existante (`price < threshold && trendOk`) devient
  `price < threshold && trendOk && volumeOk`, où `volumeOk` vaut `true`
  si `volumePeriod`/`volumeMultiplier` ne sont pas fournis (comportement
  actuel inchangé), sinon `view.volume(0) >= volumeMultiplier * avgVolume(view, volumePeriod)`.
- La condition de sortie (`price >= sma`) n'est pas modifiée.

### Script d'évaluation (`scripts/tune-mean-reversion-volume.ts`, nouveau, non testé — même catégorie que les scripts d'analyse existants)

Lance `runWalkForward` sur les 20 paires réelles avec la grille étroite
décrite ci-dessus, imprime le rendement moyen in-sample/hors-échantillon
et le taux de fenêtres gagnantes, en comparaison directe avec le candidat
sans filtre de volume (déjà connu : +0,67 à +0,71 %).

## Fichiers touchés

```
src/strategy/meanReversion.ts        (modifié — paramètre optionnel ajouté)
test/meanReversion.test.ts           (modifié — nouveaux tests, existants inchangés)
scripts/tune-mean-reversion-volume.ts (nouveau, non testé — script d'analyse)
README.md                            (modifié — résultat consigné après l'évaluation)
```
