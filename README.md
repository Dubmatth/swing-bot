# swing-bot — Phase 0

Fondations du bot de trading swing sur Kraken. Aucune stratégie, aucune
exécution : uniquement la couche de données, le contrat de stratégie et les
invariants qui empêchent un backtest d'être silencieusement faux.

## Démarrage

```bash
npm i -D typescript @types/node
npm run typecheck
npm test          # 21 tests
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

## Structure

```
src/config/universe.ts    20 paires EUR + garde-fous
src/data/series.ts        Colonnes Float64Array, slice, recherche binaire
src/data/gaps.ts          Politique de trous (point de vérité unique)
src/data/krakenCsv.ts     Parseur strict + chargement d'univers aligné
src/strategy/types.ts     BarView, Strategy, Intent
src/strategy/indicators.ts EMA, SMA, ATR, RollingStd — O(1) par barre
```

## Suite

Phase 1 : boucle event-driven, modèle de frais (0,25 % maker / 0,40 % taker),
slippage, exécution simulée. Critère de sortie : un croisement de moyennes
mobiles tourne de bout en bout et **perd de l'argent** après frais.
