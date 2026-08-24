# swing-bot — Phase 3

Bot de trading swing sur Kraken. La couche de données (Phase 0), le moteur de
backtest event-driven avec frais/slippage (Phase 1), le backtest
multi-paires avec allocation de capital (Phase 2) et le sizing par risque
ATR (Phase 3) sont en place, avec une stratégie de référence (croisement de
moyennes mobiles) qui prouve que la mécanique tourne de bout en bout et est
honnête sur les coûts de transaction.

## Démarrage

```bash
npm i -D typescript @types/node
npm run typecheck
npm test          # 81 tests
```

Node 22.6+ requis (type-stripping natif, pas de build step).

## Données

Les CSV OHLCVT ne sont pas versionnés. Télécharger l'archive complète depuis
le support Kraken (« Downloadable historical OHLCVT data »), extraire les
fichiers `_240.csv` des 20 symboles de `src/config/universe.ts` dans `data/`.

L'endpoint REST `/0/public/OHLC` ne renvoie que 720 points : il sert à
l'amorçage temps réel, jamais à constituer l'historique.

```ts
const { series, reports, commonStart } = await loadUniverse(UNIVERSE_SYMBOLS, {
  dir: 'data',
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

## Structure

```
src/config/universe.ts    20 paires EUR + garde-fous
src/data/series.ts        Colonnes Float64Array, slice, recherche binaire
src/data/gaps.ts          Politique de trous (point de vérité unique)
src/data/krakenCsv.ts     Parseur strict + chargement d'univers aligné
src/strategy/types.ts     BarView, Strategy, Intent
src/strategy/indicators.ts EMA, SMA, ATR, RollingStd — O(1) par barre
src/strategy/maCrossover.ts Stratégie de référence : croisement de deux SMA
src/strategy/atrRiskCrossover.ts Croisement de deux SMA + stopDistance = atrMultiplier × ATR
src/strategy/combineStrategies.ts Assemble plusieurs stratégies mono-pair en une stratégie multi-paires
src/backtest/events.ts    Événements typés de la file (bar-closed → order-*)
src/backtest/execution.ts Exécution simulée : frais, slippage, quantité/prix de fill
src/backtest/portfolio.ts Portefeuille — cash, positions, journal de trades, équité (portfolioEquity)
src/backtest/runner.ts    Runner event-driven multi-paires : rejoue les séries barre par barre, alloue le capital sous plafond de positions
```

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

Hors périmètre, reporté à une phase ultérieure (voir les specs Phase 1,
Phase 2 et Phase 3, section « Hors périmètre ») :
- Stop-loss réellement exécuté : `stopDistance` sert uniquement au calcul
  de la taille de position, aucun ordre stop n'est simulé — une position
  n'est encore fermée que par un `Intent` `'exit'` émis par la stratégie.
- Slippage dépendant de la volatilité (ATR), plutôt que le bps fixe actuel
  (`src/backtest/execution.ts`).
- Ordres limites / distinction maker vs taker à l'exécution.
- Live-runner (le module est conçu pour être réutilisable par lui, mais ne
  l'implémente pas encore).
- Backtest sur l'univers réel des 20 paires (les tests utilisent des séries
  synthétiques).
