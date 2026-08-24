# swing-bot — Phase 5a

Bot de trading swing sur Kraken. La couche de données (Phase 0), le moteur de
backtest event-driven avec frais/slippage (Phase 1), le backtest
multi-paires avec allocation de capital (Phase 2), le sizing par risque ATR
(Phase 3), la validation walk-forward (Phase 4) et le pipeline de données
live (Phase 5a) sont en place. Une première recherche de stratégie sur
données réelles (voir « Recherche de stratégie » ci-dessous) a produit un
candidat provisoire, pas encore une stratégie validée pour du capital réel.

## Démarrage

```bash
npm i -D typescript @types/node
npm run typecheck
npm test          # 137 tests
```

Node 22.6+ requis (type-stripping natif, pas de build step).

## Données

Les CSV OHLCVT ne sont pas versionnés (`data/` ignoré par git). Deux sources
possibles :
- L'archive « Downloadable historical OHLCVT data » du support Kraken, si
  elle contient déjà des bougies pré-agrégées `_240.csv`.
- L'archive « Time & Sales » (transactions brutes, `timestamp,price,volume`,
  un fichier par paire, ex. `XBTEUR.csv`) — c'est le format que Kraken fournit
  actuellement. La convertir en bougies avec :
  ```bash
  npm run convert-trades   # lit ~/Downloads/TimeAndSales_Combined, écrit data/kraken-ohlcvt/
  ```
  `scripts/convert-trades.ts` agrège les transactions en OHLCV (60/240/1440
  min) via `src/data/aggregateTrades.ts`, dans le format déjà attendu par
  `krakenCsv.ts` — aucun changement au chargeur.

L'endpoint REST `/0/public/OHLC` ne renvoie que 720 points : il sert à
l'amorçage temps réel, jamais à constituer l'historique.

```ts
const { series, reports, commonStart } = await loadUniverse(UNIVERSE_SYMBOLS, {
  dir: 'data/kraken-ohlcvt',
  interval: 240,
});
```

## Ce que le code garantit

| Invariant | Mécanisme | Test |
|---|---|---|
| Pas de look-ahead | `BarView` bornée à la barre close ; décalage négatif → exception | `BarView : lire une barre future lève` |
| Pas de swap crypto/crypto | `assertEurQuoted` au chargement de l'univers | `une paire crypto/crypto est rejetée` |
| Politique de trous unique | Module `gaps.ts` importé par backtest **et** live | `fillGaps : insère et marque` |
| Pas d'exécution sur barre fantôme | Marqueur `synthetic` par barre | `fillGaps : politique stricte` |
| Fichier corrompu détecté | Validation OHLC ligne à ligne | `un OHLC incohérent fait échouer` |
| Délistage détecté | `validateUniverse` contre `/0/public/AssetPairs` | `un symbole délisté fait échouer` |
| Alignement cross-sectionnel | `loadUniverse` réduit à l'intersection temporelle | — |
| Capital jamais dépassé | Plafond `maxConcurrentPositions` + budget `min(cash, équité/N)` | `Phase 2 — critère de sortie : le multi-paires ne dépasse jamais le capital disponible` |
| Plafond fraction fixe jamais dépassé, même avec sizing par risque | Budget par risque plafonné par `Math.min` contre le budget fraction fixe | `Phase 3 — critère de sortie : le sizing par risque normalise l'exposition entre paires de volatilité différente` |
| Le walk-forward révèle l'overfitting plutôt que de le masquer | Sélection des paramètres bornée à la fenêtre d'entraînement, mesure sur la fenêtre suivante non vue | `Phase 4 — critère de sortie : le walk-forward révèle l'overfitting plutôt que de le masquer` |
| Une coupure réseau ne fait jamais planter le pipeline live | Reconnexion avec backoff exponentiel, jamais de `throw` depuis les handlers WebSocket | `test/krakenOhlcSource.test.ts` |

## Structure

```
src/config/universe.ts    20 paires EUR + garde-fous
src/data/series.ts        Colonnes Float64Array, slice, recherche binaire
src/data/gaps.ts          Politique de trous (point de vérité unique)
src/data/krakenCsv.ts     Parseur strict + chargement d'univers aligné (bougies OHLCVT)
src/data/aggregateTrades.ts Agrège des transactions brutes ("Time & Sales") en bougies OHLCVT
src/strategy/types.ts     BarView, Strategy, Intent
src/strategy/indicators.ts EMA, SMA, ATR, RollingStd — O(1) par barre
src/strategy/maCrossover.ts Stratégie de référence : croisement de deux SMA
src/strategy/atrRiskCrossover.ts Croisement de deux SMA + stopDistance = atrMultiplier × ATR
src/strategy/meanReversion.ts Réversion à la moyenne (bandes de Bollinger) + filtre de tendance optionnel
src/strategy/combineStrategies.ts Assemble plusieurs stratégies mono-pair en une stratégie multi-paires
src/backtest/events.ts    Événements typés de la file (bar-closed → order-*)
src/backtest/execution.ts Exécution simulée : frais, slippage, quantité/prix de fill
src/backtest/portfolio.ts Portefeuille — cash, positions, journal de trades, équité (portfolioEquity)
src/backtest/runner.ts    Runner event-driven multi-paires : rejoue les séries barre par barre, alloue le capital sous plafond de positions
src/backtest/metrics.ts   Métriques de performance depuis la courbe d'équité (rendement total)
src/backtest/walkForward.ts Validation walk-forward : recherche de grille sur fenêtre d'entraînement, mesure hors échantillon sur la fenêtre suivante
src/live/liveBarSource.ts Interface LiveBarSource + ClosedBar (injectable, testable sans réseau)
src/live/liveSeriesBuilder.ts Construit une BarSeries croissante à partir de barres closes reçues au fil de l'eau
src/live/krakenOhlcSource.ts Client WebSocket Kraken (canal OHLC v2) : détection de clôture pure + câblage réseau
scripts/convert-trades.ts Convertit les CSV "Time & Sales" en bougies OHLCVT (voir « Données »)
scripts/run-walkforward.ts Compare plusieurs stratégies par walk-forward sur les 20 paires réelles
scripts/tune-mean-reversion.ts Explore la sensibilité de mean-reversion à la fréquence de trading
scripts/map-mean-reversion.ts Cartographie period/entryK sur la période complète (0 sélection walk-forward)
```

## Recherche de stratégie (données réelles)

Une fois le pipeline de données réelles débloqué (20 paires, juin 2022 →
décembre 2025, `scripts/convert-trades.ts` + `scripts/run-walkforward.ts`),
plusieurs familles de stratégies ont été testées par walk-forward sur cet
univers. Résumé honnête, dans l'ordre où elles ont été essayées :

- **Suivi de tendance** (`ma-crossover`, `atr-risk-crossover`, grilles
  élargies à 54+ combinaisons) : signature de sur-optimisation nette dans
  les deux cas — rendement in-sample moyen +23 à +31 %, rendement hors
  échantillon moyen **négatif** (-3 à -4 %). Aucun edge démontré après frais.
- **Réversion à la moyenne** (`mean-reversion`, bandes de Bollinger) :
  aux réglages initiaux, quasi neutre hors échantillon (-0,01 %) mais avec
  un écart in-sample/hors-échantillon bien plus faible que le suivi de
  tendance — signe de moins de sur-ajustement, pas encore un edge.
  Diagnostic : 2321 trades/3,5 ans, 6150 € de frais sur 10000 € initiaux —
  les frais dominaient le résultat.
- **Réduction de la fréquence de trading** (seuil d'entrée plus large,
  moins de trades) : la zone `period≈70-80, entryK=4` (sans filtre de
  tendance) est le meilleur candidat trouvé — validé avec **0 degré de
  liberté** (un seul réglage fixe, aucune sélection walk-forward possible) :
  rendement hors échantillon moyen +0,67 à +0,71 % par fenêtre de test
  (~1 mois), 65-68 % de trades gagnants, facteur de profit ~2-2,7 sur
  76-81 trades complets. Chercher plus loin dans cette direction
  (`period` > 100 ou `entryK` > 4,5) redégrade le résultat par manque
  d'échantillon (3-13 trades actifs sur 37 fenêtres) — signe de sur-ajustement,
  pas d'amélioration réelle.
- **Filtre de tendance** (n'acheter un creux que si le prix reste au-dessus
  d'une moyenne longue) : incompatible avec ce signal sur cette période —
  un filtre court/moyen (100-200 bougies) élimine tous les trades, un filtre
  très long (600+ bougies) n'en laisse que 16, trop peu pour conclure.
- **Sélection de paires post-hoc** (retirer les 7 paires nettes négatives
  sur 20) : délibérément **non retenue**. Avec 1 à 9 trades par paire,
  distinguer une "mauvaise" paire d'une paire malchanceuse sur cette
  période précise n'est pas possible sans tomber dans le biais de
  sélection rétroactive que `universe.ts` met explicitement en garde
  contre.

**Statut** : `mean-reversion` (`period=70-80, entryK=4`, univers complet,
sans filtre de tendance) est un candidat **provisoire**, pas une stratégie
validée pour du capital réel — l'échantillon (76-81 trades sur 3,5 ans)
reste modeste. Il sert de référence pour la Phase 5b, remplaçable dès
qu'une meilleure stratégie est trouvée.

## Suite

Phase 1 est terminée : boucle event-driven, modèle de frais (0,25 % maker /
0,40 % taker), slippage, exécution simulée sur une seule paire (BTC/EUR).
Critère de sortie démontré par `test/phase1.test.ts` : un croisement de
moyennes mobiles tourne de bout en bout et **perd de l'argent** après frais.

Phase 2 est terminée : backtest multi-paires, `combineStrategies` pour
assembler des stratégies mono-pair, allocation de capital sous
`maxConcurrentPositions`. Critère de sortie démontré par
`test/phase2.test.ts` : le multi-paires ne dépasse jamais le capital
disponible — un dépassement du plafond de positions concurrentes est refusé
proprement plutôt que d'engager plus de capital que disponible.

Phase 3 est terminée : sizing par risque, `createAtrRiskCrossover` calcule
un `stopDistance` à partir de l'ATR, le runner en déduit un budget par
risque qui resserre (jamais n'élargit) le budget fraction fixe hérité de la
Phase 2. Critère de sortie démontré par `test/phase3.test.ts` : le sizing
par risque normalise l'exposition entre paires de volatilité différente,
sans jamais dépasser le plafond fraction fixe.

Phase 4 est terminée : `totalReturn` (`src/backtest/metrics.ts`) et
`runWalkForward` (`src/backtest/walkForward.ts`), validation walk-forward
générique par recherche de grille sur fenêtres glissantes entraînement/test.
Critère de sortie démontré par `test/phase4.test.ts` : sur un marché
synthétique sans edge réel, le rendement moyen in-sample sélectionné par
recherche sur une grille de 48 combinaisons dépasse le rendement moyen hors
échantillon des mêmes paramètres — le walk-forward révèle l'overfitting
plutôt que de le masquer.

Phase 5a est terminée : pipeline de données live (`src/live/`).
`KrakenOhlcSource` détecte la clôture des bougies WebSocket via une fonction
pure entièrement testée (`processOhlcMessage`), `liveSeriesBuilder`
construit une `BarSeries` croissante au fil de l'eau en réutilisant
`freezeSeries` sans le dupliquer. Critère de sortie démontré par
`test/liveBarSource.test.ts`, `test/krakenOhlcSource.test.ts` et
`test/liveSeriesBuilder.test.ts` : détection de clôture et construction de
série couvertes par des tests déterministes exhaustifs, sans jamais tester
`KrakenOhlcSource` contre un vrai serveur. Aucune logique de
décision/exécution/portefeuille — mono-pair, pas de rattrapage de coupure,
pas de persistance : voir Phase 5b.

Hors périmètre, reporté à une phase ultérieure (voir les specs Phase 1,
Phase 2, Phase 3, Phase 4 et Phase 5a, section « Hors périmètre ») :
- Stop-loss réellement exécuté : `stopDistance` sert uniquement au calcul
  de la taille de position, aucun ordre stop n'est simulé — une position
  n'est encore fermée que par un `Intent` `'exit'` émis par la stratégie.
- Slippage dépendant de la volatilité (ATR), plutôt que le bps fixe actuel
  (`src/backtest/execution.ts`).
- Ordres limites / distinction maker vs taker à l'exécution.
- Live-runner de trading papier (boucle de décision consommant le pipeline
  live, persistance du portefeuille) : Phase 5b, pas encore construite.
- Rattrapage des barres manquées pendant une coupure WebSocket, multi-paires
  et persistance de la série côté live : voir la spec Phase 5a.
- Métriques Sharpe / drawdown : `metrics.ts` n'expose pour l'instant que le
  rendement total, conçu pour être étendu sans retoucher le reste.
- Fenêtre ancrée/croissante (anchored/expanding window) : `runWalkForward`
  n'implémente que des fenêtres glissantes à taille fixe.
- Fenêtre de test « à froid » : `runWalkForward` ne fait pas précéder la
  fenêtre de test d'un historique de warmup pris dans la fenêtre
  d'entraînement — la mesure hors échantillon perd donc jusqu'à
  `strategy.warmup` barres effectives, un effet plus sensible avec un
  warmup grand relativement à `testBars`.
