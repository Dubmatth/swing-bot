# swing-bot — Phase 5b

Bot de trading swing sur Kraken. La couche de données (Phase 0), le moteur de
backtest event-driven avec frais/slippage (Phase 1), le backtest
multi-paires avec allocation de capital (Phase 2), le sizing par risque ATR
(Phase 3), la validation walk-forward (Phase 4), le pipeline de données live
(Phase 5a) et le runner de trading papier (Phase 5b) sont en place. Une
première recherche de stratégie sur données réelles (voir « Recherche de
stratégie » ci-dessous) a produit un candidat provisoire, pas encore une
stratégie validée pour du capital réel.

## Démarrage

```bash
npm i -D typescript @types/node
npm run typecheck
npm test          # 171 tests
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
src/strategy/meanReversion.ts Réversion à la moyenne (bandes de Bollinger) + filtre de tendance optionnel + filtre de volume optionnel
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
src/live/krakenAssetPairs.ts Résout wsname/altname contre /0/public/AssetPairs, traduit le wsname (WS v1) en symbole WS v2
src/live/krakenRestSeed.ts Amorce liveSeriesBuilder via /0/public/OHLC (bougies déjà closes uniquement, filtrées sur result.last)
src/live/statePersistence.ts Persistance du portefeuille (snapshot JSON, écriture atomique) et journal de trades JSONL append-only
src/live/paperRunner.ts Boucle de décision réactive du runner papier : fill immédiat au prix de la bougie qui vient de clôturer
scripts/run-paper.ts Point d'entrée du runner de trading papier (npm run run-paper)
scripts/convert-trades.ts Convertit les CSV "Time & Sales" en bougies OHLCVT (voir « Données »)
scripts/run-walkforward.ts Compare plusieurs stratégies par walk-forward sur les 20 paires réelles
scripts/tune-mean-reversion.ts Explore la sensibilité de mean-reversion à la fréquence de trading
scripts/tune-mean-reversion-volume.ts Évalue si un filtre de volume améliore mean-reversion (grille étroite, 0 degré de liberté)
scripts/tune-mean-reversion-volatility.ts Évalue si un filtre de régime de volatilité améliore mean-reversion (grille étroite calibrée sur les données, 0 degré de liberté)
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
- **Filtre de volume** (n'acheter un creux que si le volume de la bougie
  dépasse sa moyenne récente × un multiplicateur — `volumePeriod`/
  `volumeMultiplier` sur `mean-reversion`) : testé par walk-forward avec
  **0 degré de liberté** (grille fixe de 6 réglages, aucune sélection),
  `volumePeriod=20` contre les deux références `period=70/80, entryK=4`.
  Référence sans filtre : period=70 → +0,67 % (12/37 fenêtres gagnantes),
  period=80 → +0,71 % (13/37). Avec filtre : period=70 → +0,68 % (12/37) à
  `volumeMultiplier=1.2`, puis **dégradation** à +0,66 % (11/37) et
  +0,52 % (11/37) pour 1,5 et 2,0 ; period=80 → **strictement identique**
  (+0,71 %, 13/37) aux trois multiplicateurs testés (1,2 / 1,5 / 2,0) : à 1,2 et 1,5 le filtre ne bloque aucun signal d'entrée ; à 2,0 il en bloque 3, mais exactement les 3 que le runner rejetait déjà faute de slot libre (`maxConcurrentPositions=5`) ou de capital — la séquence de trades exécutés (45) est inchangée. Ce non-effet dépend donc du régime d'allocation, pas seulement du signal : à revérifier si `maxConcurrentPositions`/`riskPerTradePct` changent.
  Aucun réglage ne dépasse clairement la référence — au mieux neutre, au
  pire dégradé. Le filtre de volume **n'apporte rien de plus** sur cette
  période : non retenu, le candidat sans filtre de volume reste la
  référence.
- **Filtre de régime de volatilité** (bloquer une entrée quand
  std(period)/sma(period) dépasse un seuil — `maxVolatilityRatio` sur
  `mean-reversion`) : testé par walk-forward avec **0 degré de liberté**
  (grille fixe de 6 réglages, aucune sélection), `maxVolatilityRatio` ∈
  {0,06 ; 0,075 ; 0,09} contre les deux références `period=70/80,
  entryK=4`. Référence sans filtre : period=70 → +0,67 % (12/37 fenêtres
  gagnantes), period=80 → +0,71 % (13/37). Avec filtre, à
  `maxVolatilityRatio=0,09` le résultat est **bit-identique** à la
  référence pour les deux périodes (vérifié fold par fold en pleine
  précision, pas seulement à 2 décimales) — instrumentation dédiée à
  l'appui : sur les 37 fenêtres de test, aucune des ~57-58 tentatives
  d'entrée réelles (`!hasPosition && prix < seuil`) n'atteint un
  coefficient de variation > 0,09 ; le filtre ne se déclenche donc
  jamais dans ces fenêtres. Contrairement au filtre de volume en Phase 6
  (où le non-effet venait de `maxConcurrentPositions`/capital masquant
  des entrées réellement bloquées), c'est ici un vrai non-déclenchement
  du filtre lui-même, pas un plafond qui masque son effet. Aux seuils
  plus serrés, le filtre se déclenche réellement (1 entrée bloquée sur
  ~57-58 à `0,075`, 4 à 5 à `0,06`) et **dégrade** le résultat :
  period=70 → +0,57 % (12/37) à 0,075 puis +0,50 % (11/37) à 0,06 ;
  period=80 → +0,63 % (13/37) à 0,075 puis +0,52 % (13/37) à 0,06. Les
  quelques entrées bloquées à ces seuils sont donc en moyenne plus
  rentables que le reste, pas moins : le filtre écarte le signal le plus
  fort au lieu d'un faux signal. Aucun réglage ne dépasse la référence.
  Le filtre de régime de volatilité **n'apporte rien de plus** sur cette
  période : non retenu, le candidat sans filtre de régime de volatilité
  reste la référence.
- **Force relative / momentum cross-sectionnel** (classer les 20 paires
  par performance récente, détenir seulement les meilleures) : famille de
  signal explorée en spike (jetable, jamais formalisée en code de
  production). Sans hystérésis, rendement négatif in-sample **et** hors
  échantillon (pas un cas de sur-ajustement, juste l'absence d'edge). Avec
  hystérésis (entrée top-3, sortie seulement après le top-10, pour réduire
  le churn), quasi neutre hors échantillon (-0,28 %) mais avec un écart
  in/hors-échantillon plus marqué que mean-reversion. Ni pire ni meilleur
  que le candidat déjà trouvé — non retenue, non creusée davantage.

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

Phase 5b est terminée : runner de trading papier (`src/live/paperRunner.ts`),
amorçage REST (`krakenRestSeed.ts`) et résolution des mappings de paires
(`krakenAssetPairs.ts`, avec traduction du `wsname` WS v1 vers WS v2), et
persistance par snapshot JSON + journal JSONL (`statePersistence.ts`). Le
runner réutilise `sizeBuyOrder` (`src/backtest/runner.ts`) comme unique
source de vérité pour le sizing — jamais dupliqué, pour que le
sizing/fills papier ne puissent pas diverger de ceux déjà validés par
walk-forward — avec des fills immédiats au prix de la bougie qui vient de
clôturer, plutôt qu'à la bougie suivante comme en backtest (la contrainte
anti-look-ahead n'a pas de sens sur un flux déjà temps réel). Critère de
sortie démontré par `test/paperRunnerRestart.test.ts` : le portefeuille
persisté est repris correctement après un redémarrage simulé (nouveau
runner, nouvelles sources, portefeuille restauré depuis le disque).

Hors périmètre, reporté à une phase ultérieure (voir les specs Phase 1,
Phase 2, Phase 3, Phase 4, Phase 5a et Phase 5b, section « Hors périmètre ») :
- Stop-loss réellement exécuté : `stopDistance` sert uniquement au calcul
  de la taille de position, aucun ordre stop n'est simulé — une position
  n'est encore fermée que par un `Intent` `'exit'` émis par la stratégie.
- Slippage dépendant de la volatilité (ATR), plutôt que le bps fixe actuel
  (`src/backtest/execution.ts`).
- Ordres limites / distinction maker vs taker à l'exécution.
- Envoi d'ordres réels à Kraken : la Phase 5b reste strictement du trading
  papier, aucun chemin vers un ordre réel n'existe dans `paperRunner.ts`.
- Rattrapage des barres manquées pendant une coupure WebSocket au-delà de
  l'amorçage REST au démarrage : une coupure prolongée en cours de
  fonctionnement laisse un trou dans la série, non comblé automatiquement.
- Monitoring / alerting du runner en production (santé du process, retard
  de fills, échecs de persistance récurrents) : seuls des `console.error`
  ponctuels existent aujourd'hui.
- Métriques Sharpe / drawdown : `metrics.ts` n'expose pour l'instant que le
  rendement total, conçu pour être étendu sans retoucher le reste.
- Fenêtre ancrée/croissante (anchored/expanding window) : `runWalkForward`
  n'implémente que des fenêtres glissantes à taille fixe.
- Fenêtre de test « à froid » : `runWalkForward` ne fait pas précéder la
  fenêtre de test d'un historique de warmup pris dans la fenêtre
  d'entraînement — la mesure hors échantillon perd donc jusqu'à
  `strategy.warmup` barres effectives, un effet plus sensible avec un
  warmup grand relativement à `testBars`.
