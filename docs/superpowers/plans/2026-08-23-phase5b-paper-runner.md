# Phase 5b — Runner de trading papier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brancher une boucle de décision réelle sur le pipeline de données live (Phase 5a) : décisions et fills papier sur les 20 paires, portefeuille persistant qui survit à un redémarrage, jamais d'ordre réel.

**Architecture:** Extraction du sizing partagé backtest/live (`sizeBuyOrder`), deux petits modules REST non testés (mapping de paires + amorçage), un module de persistance disque testé, une boucle de décision réactive (`paperRunner`) qui réutilise telle quelle la logique d'exécution/portefeuille existante, et un point d'entrée qui assemble le tout.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas de build), `fetch` natif de Node (aucune dépendance runtime ajoutée), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-23-phase5b-paper-runner-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- tsconfig strict : `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée — `fetch` natif de Node (stable depuis Node 18), pas de bibliothèque HTTP.
- Commentaires et messages d'erreur en français, cohérents avec le style existant.
- Trading papier uniquement — aucun ordre n'est jamais envoyé à un exchange réel dans cette phase. Ce n'est pas qu'une convention de style : aucun code de ce plan ne doit contenir de chemin qui enverrait un ordre réel.
- Le sizing et l'exécution du runner papier ne doivent jamais diverger de ceux du backtest : `sizeBuyOrder` (Task 1) est la seule source de vérité pour le calcul de budget d'achat, utilisée par `runBacktest` **et** `paperRunner`.
- Une anomalie réseau ou une donnée invalide ne doit jamais faire planter le runner papier — cohérent avec la Phase 5a. Dans `paperRunner.ts`, une intention inexploitable (position déjà ouverte, plafond atteint, budget insuffisant, symbole inconnu) est silencieusement ignorée, jamais une exception.
- `krakenAssetPairs.ts` et `krakenRestSeed.ts` : le câblage réseau (`fetch`) n'est jamais exercé par `npm test` — seule la logique de parsing pure (`parseAssetPairsResponse`, `parseRestOhlcResponse`) l'est. Même principe que `krakenOhlcSource.ts` en Phase 5a.
- `statePersistence.ts` fait exception à la règle ci-dessus : l'I/O sur disque local est déterministe (contrairement au réseau), donc testée pour de vrai avec un répertoire temporaire — ne pas la laisser non testée par excès de prudence.
- Commande de test par fichier : `node --experimental-strip-types --test test/<fichier>.test.ts`. Commande globale : `npm test` (`npm run typecheck` pour la vérification de types).

---

## Task 1: Extraction de `sizeBuyOrder` (sizing partagé backtest/live)

**Files:**
- Modify: `src/backtest/runner.ts`
- Test: `test/runner.test.ts` (ajouts, tests existants inchangés et doivent continuer à passer)

**Interfaces:**
- Produces: `SizeBuyOrderInput { cash, equity, maxConcurrentPositions, riskPerTradePct, referencePrice, stopDistance? }`, `SizeBuyOrderResult = { ok: true, budget: number } | { ok: false, reason: string }`, `function sizeBuyOrder(input: SizeBuyOrderInput): SizeBuyOrderResult` — exportés depuis `src/backtest/runner.ts`, consommés par la Task 4.

- [ ] **Step 1: Lire le code actuel à extraire**

Dans `src/backtest/runner.ts`, la branche `order-requested`/`buy` calcule le budget ainsi (à extraire, ne pas encore modifier) :

```ts
            budget = Math.min(portfolio.cash, equitySnapshot / opts.maxConcurrentPositions);
            if (event.stopDistance !== undefined) {
              if (!Number.isFinite(event.stopDistance) || !(event.stopDistance > 0)) {
                queue.push({
                  kind: 'order-rejected',
                  symbol: event.symbol,
                  side: 'buy',
                  reason: 'stopDistance invalide',
                  time: fillTime,
                });
                break;
              }
              const riskBudget =
                ((equitySnapshot * opts.riskPerTradePct) / event.stopDistance) * referencePrice;
              budget = Math.min(budget, riskBudget);
            }
            if (!(budget > 0)) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: 'budget alloué insuffisant',
                time: fillTime,
              });
              break;
            }
```

- [ ] **Step 2: Écrire les tests unitaires de `sizeBuyOrder` (échouent — la fonction n'existe pas encore)**

Ajouter à la fin de `test/runner.test.ts` :

```ts
test('sizeBuyOrder : budget = min(cash, équité/N) sans stopDistance', () => {
  const result = sizeBuyOrder({
    cash: 1000,
    equity: 2000,
    maxConcurrentPositions: 4,
    riskPerTradePct: 0.01,
    referencePrice: 100,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok && Math.abs(result.budget - 500) < 1e-9); // 2000/4 = 500 < cash=1000
});

test('sizeBuyOrder : le budget de risque resserre le plafond fraction fixe', () => {
  const result = sizeBuyOrder({
    cash: 1000,
    equity: 1000,
    maxConcurrentPositions: 1,
    riskPerTradePct: 0.01,
    referencePrice: 100,
    stopDistance: 2, // riskBudget = (1000*0.01/2)*100 = 500 < plafond fraction fixe (1000)
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok && Math.abs(result.budget - 500) < 1e-9);
});

test('sizeBuyOrder : le plafond fraction fixe gagne quand le budget de risque serait plus grand', () => {
  const result = sizeBuyOrder({
    cash: 1000,
    equity: 1000,
    maxConcurrentPositions: 1,
    riskPerTradePct: 0.5,
    referencePrice: 100,
    stopDistance: 0.01, // riskBudget énorme
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok && Math.abs(result.budget - 1000) < 1e-9);
});

test('sizeBuyOrder : stopDistance invalide est rejeté avec la raison exacte', () => {
  const result = sizeBuyOrder({
    cash: 1000, equity: 1000, maxConcurrentPositions: 1, riskPerTradePct: 0.01,
    referencePrice: 100, stopDistance: -5,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'stopDistance invalide');
});

test('sizeBuyOrder : stopDistance infini est rejeté', () => {
  const result = sizeBuyOrder({
    cash: 1000, equity: 1000, maxConcurrentPositions: 1, riskPerTradePct: 0.01,
    referencePrice: 100, stopDistance: Infinity,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'stopDistance invalide');
});

test('sizeBuyOrder : budget nul ou négatif est rejeté avec la raison exacte', () => {
  const result = sizeBuyOrder({
    cash: 0, equity: 0, maxConcurrentPositions: 1, riskPerTradePct: 0.01,
    referencePrice: 100,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'budget alloué insuffisant');
});
```

Ajouter `sizeBuyOrder` à l'import existant de `'../src/backtest/runner.ts'` en tête du fichier.

- [ ] **Step 3: Vérifier que les nouveaux tests échouent**

Run: `node --experimental-strip-types --test test/runner.test.ts`
Expected: FAIL — `sizeBuyOrder` n'est pas exporté.

- [ ] **Step 4: Ajouter `sizeBuyOrder` à `src/backtest/runner.ts`**

Ajouter, avant `export function runBacktest`, ces deux exports :

```ts
export interface SizeBuyOrderInput {
  readonly cash: number;
  readonly equity: number;
  readonly maxConcurrentPositions: number;
  readonly riskPerTradePct: number;
  readonly referencePrice: number;
  readonly stopDistance?: number;
}

export type SizeBuyOrderResult =
  | { readonly ok: true; readonly budget: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Calcule le budget alloué à un achat : plafond fraction fixe
 * (cash/N positions), resserré (jamais élargi) par un budget de risque si
 * stopDistance est fourni. Partagé entre runBacktest et le runner papier
 * (paperRunner.ts) pour qu'ils ne puissent jamais diverger sur le sizing.
 */
export function sizeBuyOrder(input: SizeBuyOrderInput): SizeBuyOrderResult {
  if (
    input.stopDistance !== undefined &&
    (!Number.isFinite(input.stopDistance) || !(input.stopDistance > 0))
  ) {
    return { ok: false, reason: 'stopDistance invalide' };
  }

  let budget = Math.min(input.cash, input.equity / input.maxConcurrentPositions);
  if (input.stopDistance !== undefined) {
    const riskBudget =
      ((input.equity * input.riskPerTradePct) / input.stopDistance) * input.referencePrice;
    budget = Math.min(budget, riskBudget);
  }

  if (!(budget > 0)) {
    return { ok: false, reason: 'budget alloué insuffisant' };
  }
  return { ok: true, budget };
}
```

- [ ] **Step 5: Remplacer le calcul inline par un appel à `sizeBuyOrder`**

Dans la branche `order-requested`/`buy` de `runBacktest`, remplacer exactement le bloc cité au Step 1 par :

```ts
            const sized = sizeBuyOrder({
              cash: portfolio.cash,
              equity: equitySnapshot,
              maxConcurrentPositions: opts.maxConcurrentPositions,
              riskPerTradePct: opts.riskPerTradePct,
              referencePrice,
              ...(event.stopDistance !== undefined ? { stopDistance: event.stopDistance } : {}),
            });
            if (!sized.ok) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'buy',
                reason: sized.reason,
                time: fillTime,
              });
              break;
            }
            budget = sized.budget;
```

Le reste de `runBacktest` (déclaration de `let budget = 0;`, utilisation de `budget` dans `simulateBuy(budget, referencePrice, execOpts)` plus bas) reste inchangé.

- [ ] **Step 6: Lancer toute la suite `runner.test.ts` — non-régression**

Run: `node --experimental-strip-types --test test/runner.test.ts`
Expected: PASS — tous les tests existants (sizing fraction fixe, sizing par risque, stopDistance invalide/infini, rejets de plafond) **et** les nouveaux tests de `sizeBuyOrder` passent, avec les mêmes chaînes de raison de rejet qu'avant l'extraction.

- [ ] **Step 7: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent (137 + les nouveaux tests `sizeBuyOrder`)

- [ ] **Step 8: Commit**

```bash
git add src/backtest/runner.ts test/runner.test.ts
git commit -m "$(cat <<'EOF'
refactor(backtest): extrait sizeBuyOrder pour le partager avec le live

Le calcul de budget d'achat (fraction fixe + resserrement par risque)
vivait uniquement inline dans runBacktest. Extrait en fonction pure
réutilisable pour que le futur runner papier ne puisse jamais diverger
du sizing déjà validé par le backtest. Comportement de runBacktest
inchangé — mêmes raisons de rejet, mêmes tests existants verts.
EOF
)"
```

---

## Task 2: Mapping de paires et amorçage REST (`krakenAssetPairs.ts`, `krakenRestSeed.ts`)

**Files:**
- Create: `src/live/krakenAssetPairs.ts`
- Create: `src/live/krakenRestSeed.ts`
- Test: `test/krakenAssetPairs.test.ts`
- Test: `test/krakenRestSeed.test.ts`

**Interfaces:**
- Consumes: `PairSpec` (`src/config/universe.ts`, existant, inchangé) ; `ClosedBar`, `Interval` (`src/live/liveBarSource.ts` / `src/data/series.ts`, existants, inchangés).
- Produces:
  - `interface KrakenPairMapping { symbol: string; wsSymbol: string; restSymbol: string }`
  - `function parseAssetPairsResponse(universe: readonly PairSpec[], rawResult: Record<string, unknown>): readonly KrakenPairMapping[]`
  - `function fetchKrakenPairMappings(universe: readonly PairSpec[], restUrl?: string): Promise<readonly KrakenPairMapping[]>`
  - `interface KrakenRestSeedConfig { restSymbol: string; symbol: string; interval: Interval; count: number; restUrl?: string }`
  - `function parseRestOhlcResponse(symbol: string, rawRows: readonly unknown[]): readonly ClosedBar[]`
  - `function fetchSeedBars(config: KrakenRestSeedConfig): Promise<readonly ClosedBar[]>`

**Point à vérifier avant d'écrire le code (pas supposé ici sans confirmation)** : ce plan suppose que `/0/public/AssetPairs` renvoie, par entrée, un champ `altname` (correspondant au `symbol` legacy de `universe.ts`, ex. `'XBTEUR'`) et un champ `wsname` au format `'BASE/QUOTE'` (ex. `'XBT/EUR'`) — forme historique connue de l'API Kraken. Avant d'écrire `parseAssetPairsResponse`, vérifier cette forme contre la documentation Kraken actuelle (ou un appel réel à `https://api.kraken.com/0/public/AssetPairs`). Si la forme a changé, adapter le code ci-dessous en conséquence et noter l'écart dans le rapport de tâche.

- [ ] **Step 1: Écrire les tests de `krakenAssetPairs.ts` (échouent — le module n'existe pas encore)**

Créer `test/krakenAssetPairs.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAssetPairsResponse } from '../src/live/krakenAssetPairs.ts';
import type { PairSpec } from '../src/config/universe.ts';

const UNIVERSE: readonly PairSpec[] = [
  { symbol: 'XBTEUR', label: 'BTC/EUR', sector: 'store-of-value' },
  { symbol: 'ETHEUR', label: 'ETH/EUR', sector: 'smart-contract' },
];

test('parseAssetPairsResponse : résout le mapping pour chaque paire de l\'univers', () => {
  const raw = {
    XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR' },
    XETHZEUR: { altname: 'ETHEUR', wsname: 'ETH/EUR' },
    XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD' }, // paire hors univers, ignorée
  };
  const mappings = parseAssetPairsResponse(UNIVERSE, raw);
  assert.equal(mappings.length, 2);
  assert.deepEqual(mappings[0], { symbol: 'XBTEUR', wsSymbol: 'XBT/EUR', restSymbol: 'XXBTZEUR' });
  assert.deepEqual(mappings[1], { symbol: 'ETHEUR', wsSymbol: 'ETH/EUR', restSymbol: 'XETHZEUR' });
});

test('parseAssetPairsResponse : lève si une paire de l\'univers est absente de la réponse', () => {
  const raw = { XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR' } }; // ETHEUR manquant
  assert.throws(() => parseAssetPairsResponse(UNIVERSE, raw), /ETHEUR/);
});

test('parseAssetPairsResponse : lève si wsname n\'a pas la forme BASE/QUOTE attendue', () => {
  const raw = {
    XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBTEUR' }, // pas de '/'
    XETHZEUR: { altname: 'ETHEUR', wsname: 'ETH/EUR' },
  };
  assert.throws(() => parseAssetPairsResponse(UNIVERSE, raw), /wsname/);
});

test('parseAssetPairsResponse : ignore silencieusement une entrée sans altname/wsname exploitable', () => {
  const raw = {
    XXBTZEUR: { altname: 'XBTEUR', wsname: 'XBT/EUR' },
    XETHZEUR: { altname: 'ETHEUR', wsname: 'ETH/EUR' },
    BROKEN: { foo: 'bar' },
  };
  const mappings = parseAssetPairsResponse(UNIVERSE, raw);
  assert.equal(mappings.length, 2);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/krakenAssetPairs.test.ts`
Expected: FAIL — `src/live/krakenAssetPairs.ts` n'existe pas.

- [ ] **Step 3: Implémenter `krakenAssetPairs.ts`**

```ts
/**
 * Résout, pour chaque paire de l'univers, sa correspondance avec la
 * nomenclature Kraken WS v2 (wsname) et la clé utilisée par l'API REST
 * (/0/public/OHLC) — jamais codée en dur dans universe.ts, toujours
 * résolue dynamiquement contre /0/public/AssetPairs. Réutilise le même
 * garde-fou anti-délistage que validateUniverse (src/config/universe.ts),
 * pour un besoin différent (mapping, pas juste présence/absence).
 */

import type { PairSpec } from '../config/universe.ts';

export interface KrakenPairMapping {
  readonly symbol: string;
  readonly wsSymbol: string;
  readonly restSymbol: string;
}

interface AssetPairEntry {
  readonly altname: string;
  readonly wsname: string;
}

function isAssetPairEntry(value: unknown): value is AssetPairEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.altname === 'string' && typeof entry.wsname === 'string';
}

/** Logique pure : mappe la réponse JSON déjà parsée sur l'univers fourni. */
export function parseAssetPairsResponse(
  universe: readonly PairSpec[],
  rawResult: Record<string, unknown>,
): readonly KrakenPairMapping[] {
  const byAltname = new Map<string, { key: string; wsname: string }>();
  for (const [key, value] of Object.entries(rawResult)) {
    if (!isAssetPairEntry(value)) continue;
    byAltname.set(value.altname, { key, wsname: value.wsname });
  }

  return universe.map((pair) => {
    const found = byAltname.get(pair.symbol);
    if (found === undefined) {
      throw new Error(`${pair.symbol} : absent de la réponse /0/public/AssetPairs (délisté ?)`);
    }
    if (!found.wsname.includes('/')) {
      throw new Error(`${pair.symbol} : wsname inattendu '${found.wsname}'`);
    }
    return { symbol: pair.symbol, wsSymbol: found.wsname, restSymbol: found.key };
  });
}

/** Câblage réseau — non testé automatiquement, comme krakenOhlcSource.ts. */
export async function fetchKrakenPairMappings(
  universe: readonly PairSpec[],
  restUrl = 'https://api.kraken.com/0/public/AssetPairs',
): Promise<readonly KrakenPairMapping[]> {
  const response = await fetch(restUrl);
  const body = (await response.json()) as { error?: readonly string[]; result?: Record<string, unknown> };
  if (body.error !== undefined && body.error.length > 0) {
    throw new Error(`AssetPairs : erreur API Kraken — ${body.error.join(', ')}`);
  }
  if (body.result === undefined) {
    throw new Error('AssetPairs : réponse sans champ result');
  }
  return parseAssetPairsResponse(universe, body.result);
}
```

- [ ] **Step 4: Vérifier que les tests de `krakenAssetPairs.ts` passent**

Run: `node --experimental-strip-types --test test/krakenAssetPairs.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: aucune erreur. **Point de vérification** : si TypeScript ne reconnaît pas les types globaux `fetch`/`Response` ("Cannot find name 'fetch'"), c'est le même type de question déjà résolue en Phase 5a pour `WebSocket` — `@types/node` les expose ambiantement via son propre `web-globals/fetch.d.ts` dès que `"types": ["node"]` est présent (déjà le cas dans `tsconfig.json`), donc ça devrait fonctionner sans modification. Si ce n'est pas le cas, documenter précisément ce qui a été trouvé dans le rapport de tâche — ne pas ajouter `"dom"` à `lib`.

- [ ] **Step 6: Écrire les tests de `krakenRestSeed.ts` (échouent — le module n'existe pas encore)**

Créer `test/krakenRestSeed.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRestOhlcResponse } from '../src/live/krakenRestSeed.ts';

const SYMBOL = 'XBTEUR';

test('parseRestOhlcResponse : parse des lignes valides en ClosedBar', () => {
  const rows = [
    [1700000000, '50000.0', '50100.0', '49900.0', '50050.0', '50025.0', '1.5', 42],
    [1700014400, '50050.0', '50200.0', '50000.0', '50150.0', '50075.0', '2.0', 30],
  ];
  const bars = parseRestOhlcResponse(SYMBOL, rows);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], {
    symbol: SYMBOL, time: 1700000000, open: 50000, high: 50100, low: 49900,
    close: 50050, volume: 1.5, trades: 42,
  });
});

test('parseRestOhlcResponse : lève si une ligne n\'a pas la forme attendue', () => {
  assert.throws(() => parseRestOhlcResponse(SYMBOL, [[1700000000, '1']]), /forme inattendue/);
});

test('parseRestOhlcResponse : lève sur un champ numérique invalide', () => {
  const rows = [[1700000000, 'abc', '50100.0', '49900.0', '50050.0', '50025.0', '1.5', 42]];
  assert.throws(() => parseRestOhlcResponse(SYMBOL, rows), /invalide/);
});

test('parseRestOhlcResponse : lève sur un OHLC incohérent', () => {
  const rows = [[1700000000, '50000.0', '100.0', '49900.0', '50050.0', '50025.0', '1.5', 42]]; // high < open
  assert.throws(() => parseRestOhlcResponse(SYMBOL, rows), /incohérent/);
});
```

- [ ] **Step 7: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/krakenRestSeed.test.ts`
Expected: FAIL — `src/live/krakenRestSeed.ts` n'existe pas.

- [ ] **Step 8: Implémenter `krakenRestSeed.ts`**

```ts
/**
 * Amorce liveSeriesBuilder avec les dernières bougies connues via l'API
 * REST Kraken (/0/public/OHLC, jusqu'à 720 points) au démarrage du runner
 * papier — le dump historique déjà téléchargé a plusieurs mois de retard,
 * inutilisable pour amorcer un flux temps réel sans discontinuité.
 */

import type { Interval } from '../data/series.ts';
import type { ClosedBar } from './liveBarSource.ts';

export interface KrakenRestSeedConfig {
  readonly restSymbol: string;
  readonly symbol: string;
  readonly interval: Interval;
  /** Nombre de bougies conservées (les plus récentes), <= 720. */
  readonly count: number;
  readonly restUrl?: string;
}

/** Logique pure : mappe les lignes brutes déjà parsées (JSON) en ClosedBar[]. */
export function parseRestOhlcResponse(
  symbol: string,
  rawRows: readonly unknown[],
): readonly ClosedBar[] {
  return rawRows.map((row, i) => {
    if (!Array.isArray(row) || row.length < 8) {
      throw new Error(`${symbol} ligne REST ${i} : forme inattendue`);
    }
    const time = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[6]);
    const trades = Number(row[7]);
    if (![time, open, high, low, close, volume, trades].every(Number.isFinite)) {
      throw new Error(`${symbol} ligne REST ${i} : champ numérique invalide`);
    }
    if (
      time <= 0 || open <= 0 || low <= 0 ||
      high < low || open > high || open < low || close > high || close < low
    ) {
      throw new Error(`${symbol} ligne REST ${i} : OHLC incohérent`);
    }
    return { symbol, time, open, high, low, close, volume, trades };
  });
}

/** Câblage réseau — non testé automatiquement, comme krakenOhlcSource.ts. */
export async function fetchSeedBars(config: KrakenRestSeedConfig): Promise<readonly ClosedBar[]> {
  const url = new URL(config.restUrl ?? 'https://api.kraken.com/0/public/OHLC');
  url.searchParams.set('pair', config.restSymbol);
  url.searchParams.set('interval', String(config.interval));

  const response = await fetch(url);
  const body = (await response.json()) as { error?: readonly string[]; result?: Record<string, unknown> };
  if (body.error !== undefined && body.error.length > 0) {
    throw new Error(`${config.symbol} : erreur API Kraken OHLC — ${body.error.join(', ')}`);
  }
  if (body.result === undefined) {
    throw new Error(`${config.symbol} : réponse OHLC sans champ result`);
  }
  const rowsKey = Object.keys(body.result).find((k) => k !== 'last');
  if (rowsKey === undefined) {
    throw new Error(`${config.symbol} : réponse OHLC sans clé de bougies reconnue`);
  }
  const rows = body.result[rowsKey];
  if (!Array.isArray(rows)) {
    throw new Error(`${config.symbol} : bougies OHLC de forme inattendue`);
  }
  const bars = parseRestOhlcResponse(config.symbol, rows);
  return bars.slice(-config.count);
}
```

- [ ] **Step 9: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/krakenRestSeed.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 10: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 11: Commit**

```bash
git add src/live/krakenAssetPairs.ts src/live/krakenRestSeed.ts test/krakenAssetPairs.test.ts test/krakenRestSeed.test.ts
git commit -m "$(cat <<'EOF'
feat(live): mapping de paires et amorçage REST Kraken

krakenAssetPairs résout wsSymbol/restSymbol dynamiquement via
/0/public/AssetPairs plutôt qu'un codage en dur dans universe.ts.
krakenRestSeed récupère les dernières bougies via /0/public/OHLC pour
amorcer liveSeriesBuilder sans discontinuité au démarrage du runner
papier. Logique de parsing pure testée exhaustivement ; câblage réseau
non testé automatiquement, comme krakenOhlcSource.ts.
EOF
)"
```

---

## Task 3: Persistance (`statePersistence.ts`)

**Files:**
- Create: `src/live/statePersistence.ts`
- Test: `test/statePersistence.test.ts`

**Interfaces:**
- Consumes: `Portfolio`, `Trade` (`src/backtest/portfolio.ts`, existant, inchangé) ; `Position` (`src/strategy/types.ts`, existant, inchangé).
- Produces:
  - `interface PersistedPortfolio { cash: number; positions: readonly Position[] }`
  - `function serializePortfolio(p: Portfolio): PersistedPortfolio`
  - `function deserializePortfolio(data: PersistedPortfolio): Portfolio`
  - `function savePortfolioSnapshot(path: string, p: Portfolio): Promise<void>`
  - `function loadPortfolioSnapshot(path: string): Promise<Portfolio | undefined>`
  - `function appendTradeLog(path: string, trade: Trade): Promise<void>`

- [ ] **Step 1: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/statePersistence.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  serializePortfolio,
  deserializePortfolio,
  savePortfolioSnapshot,
  loadPortfolioSnapshot,
  appendTradeLog,
} from '../src/live/statePersistence.ts';
import { createPortfolio, applyBuyFill } from '../src/backtest/portfolio.ts';
import type { Trade } from '../src/backtest/portfolio.ts';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'swing-bot-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('serializePortfolio/deserializePortfolio : aller-retour préserve cash et positions', () => {
  const p = createPortfolio(1000);
  applyBuyFill(p, 'XBTEUR', { price: 100, quantity: 2, fee: 1 }, 1000);
  const restored = deserializePortfolio(serializePortfolio(p));
  assert.equal(restored.cash, p.cash);
  assert.equal(restored.positions.size, 1);
  assert.deepEqual(restored.positions.get('XBTEUR'), p.positions.get('XBTEUR'));
});

test('savePortfolioSnapshot/loadPortfolioSnapshot : aller-retour sur disque réel', async () => {
  await withTempDir(async (dir) => {
    const p = createPortfolio(1000);
    applyBuyFill(p, 'ETHEUR', { price: 50, quantity: 4, fee: 0.5 }, 2000);
    const path = join(dir, 'nested', 'portfolio.json');

    await savePortfolioSnapshot(path, p);
    const loaded = await loadPortfolioSnapshot(path);

    assert.ok(loaded);
    assert.equal(loaded.cash, p.cash);
    assert.deepEqual(loaded.positions.get('ETHEUR'), p.positions.get('ETHEUR'));
  });
});

test('loadPortfolioSnapshot : renvoie undefined si le fichier n\'existe pas', async () => {
  await withTempDir(async (dir) => {
    const loaded = await loadPortfolioSnapshot(join(dir, 'absent.json'));
    assert.equal(loaded, undefined);
  });
});

test('appendTradeLog : chaque appel ajoute une ligne JSON, sans écraser les précédentes', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'trades.jsonl');
    const t1: Trade = { symbol: 'XBTEUR', side: 'buy', quantity: 1, price: 100, fee: 1, time: 1000 };
    const t2: Trade = { symbol: 'XBTEUR', side: 'sell', quantity: 1, price: 110, fee: 1, time: 2000 };

    await appendTradeLog(path, t1);
    await appendTradeLog(path, t2);

    const text = await readFile(path, 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), t1);
    assert.deepEqual(JSON.parse(lines[1]!), t2);
  });
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/statePersistence.test.ts`
Expected: FAIL — `src/live/statePersistence.ts` n'existe pas.

- [ ] **Step 3: Implémenter `statePersistence.ts`**

```ts
/**
 * Persistance du portefeuille papier : snapshot JSON réécrit après chaque
 * fill, journal de trades JSONL append-only. Contrairement au réseau,
 * l'I/O sur disque local est déterministe — testée pour de vrai avec un
 * répertoire temporaire, pas laissée non testée par excès de prudence.
 */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Portfolio, Trade } from '../backtest/portfolio.ts';
import type { Position } from '../strategy/types.ts';

export interface PersistedPortfolio {
  readonly cash: number;
  readonly positions: readonly Position[];
}

export function serializePortfolio(p: Portfolio): PersistedPortfolio {
  return { cash: p.cash, positions: [...p.positions.values()] };
}

/**
 * Le journal de trades (JSONL) reste la trace d'audit complète sur disque ;
 * le `trades` en mémoire d'un portefeuille désérialisé repart vide — rien
 * dans la logique de décision ou d'exécution ne lit l'historique des
 * trades passés, seulement `cash`/`positions`.
 */
export function deserializePortfolio(data: PersistedPortfolio): Portfolio {
  const positions = new Map<string, Position>();
  for (const position of data.positions) {
    positions.set(position.symbol, position);
  }
  return { cash: data.cash, positions, trades: [] };
}

export async function savePortfolioSnapshot(path: string, p: Portfolio): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(serializePortfolio(p), null, 2), 'utf8');
}

export async function loadPortfolioSnapshot(path: string): Promise<Portfolio | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const data = JSON.parse(text) as PersistedPortfolio;
  return deserializePortfolio(data);
}

export async function appendTradeLog(path: string, trade: Trade): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(trade)}\n`, 'utf8');
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/statePersistence.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 6: Commit**

```bash
git add src/live/statePersistence.ts test/statePersistence.test.ts
git commit -m "$(cat <<'EOF'
feat(live): persistance du portefeuille papier sur disque

Snapshot JSON réécrit après chaque fill + journal de trades JSONL
append-only, sous data/live-state/ (déjà ignoré par git). Testé avec un
répertoire temporaire réel — l'I/O disque est déterministe,
contrairement au réseau, donc pas laissée non testée.
EOF
)"
```

---

## Task 4: Boucle de décision (`paperRunner.ts`)

**Files:**
- Create: `src/live/paperRunner.ts`
- Test: `test/paperRunner.test.ts`

**Interfaces:**
- Consumes: `ClosedBar`, `LiveBarSource` (`src/live/liveBarSource.ts`, Phase 5a, inchangé) ; `LiveSeriesBuilder` (`src/live/liveSeriesBuilder.ts`, Phase 5a, inchangé) ; `Strategy`, `StrategyContext`, `Intent`, `BarView` (`src/strategy/types.ts`, inchangé) ; `Portfolio`, `Trade`, `applyBuyFill`, `applySellFill`, `portfolioEquity` (`src/backtest/portfolio.ts`, inchangé) ; `FeeSchedule`, `simulateBuy`, `simulateSell` (`src/backtest/execution.ts`, inchangé) ; `sizeBuyOrder` (`src/backtest/runner.ts`, Task 1).
- Produces:
  - `interface PaperRunnerOptions { maxConcurrentPositions: number; riskPerTradePct: number; fees: FeeSchedule; slippageBps: number }`
  - `interface PaperRunnerConfig { strategy: Strategy; sources: ReadonlyMap<string, LiveBarSource>; builders: ReadonlyMap<string, LiveSeriesBuilder>; portfolio: Portfolio; options: PaperRunnerOptions; onFill?: (trade: Trade, portfolio: Portfolio) => void }`
  - `interface PaperRunner { start(): void; stop(): void }`
  - `function createPaperRunner(config: PaperRunnerConfig): PaperRunner`

- [ ] **Step 1: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/paperRunner.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ClosedBar, LiveBarSource } from '../src/live/liveBarSource.ts';
import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import { createPaperRunner } from '../src/live/paperRunner.ts';
import { createPortfolio } from '../src/backtest/portfolio.ts';
import type { Trade } from '../src/backtest/portfolio.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';

const SYMBOL_A = 'AEUR';
const SYMBOL_B = 'BEUR';
const STEP = 14_400;

function bar(symbol: string, i: number, close: number): ClosedBar {
  return { symbol, time: i * STEP, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

function createSyntheticSource(): LiveBarSource & { emit(bar: ClosedBar): void } {
  let callback: ((bar: ClosedBar) => void) | undefined;
  return {
    start(cb: (bar: ClosedBar) => void): void {
      callback = cb;
    },
    stop(): void {
      callback = undefined;
    },
    emit(b: ClosedBar): void {
      callback?.(b);
    },
  };
}

/** Stratégie de test déterministe : entre au-dessus du seuil, sort à/sous le seuil. */
function testStrategy(threshold: number): Strategy {
  return {
    name: 'test-strategy',
    warmup: 0,
    params: { threshold },
    decide(ctx: StrategyContext): readonly Intent[] {
      const intents: Intent[] = [];
      for (const [symbol, view] of ctx.views) {
        const hasPosition = ctx.positions.has(symbol);
        const price = view.close(0);
        if (!hasPosition && price > threshold) {
          intents.push({ kind: 'enter', symbol, reason: `${price} > ${threshold}` });
        } else if (hasPosition && price <= threshold) {
          intents.push({ kind: 'exit', symbol, reason: `${price} <= ${threshold}` });
        }
      }
      return intents.length > 0 ? intents : [{ kind: 'hold' }];
    },
  };
}

function setup(threshold: number, maxConcurrentPositions = 1) {
  const sourceA = createSyntheticSource();
  const sourceB = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const builderB = createLiveSeriesBuilder(SYMBOL_B, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];

  const runner = createPaperRunner({
    strategy: testStrategy(threshold),
    sources: new Map([[SYMBOL_A, sourceA], [SYMBOL_B, sourceB]]),
    builders: new Map([[SYMBOL_A, builderA], [SYMBOL_B, builderB]]),
    portfolio,
    options: { maxConcurrentPositions, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  return { runner, sourceA, sourceB, portfolio, fills };
}

test('paperRunner : applique un fill d\'achat quand la stratégie émet enter', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // 60 > 50 -> enter

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.side, 'buy');
});

test('paperRunner : applique un fill de vente quand la stratégie émet exit', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter
  sourceA.emit(bar(SYMBOL_A, 1, 40)); // 40 <= 50 -> exit

  assert.equal(portfolio.positions.size, 0);
  assert.equal(fills.length, 2);
  assert.equal(fills[1]?.side, 'sell');
});

test('paperRunner : ignore un enter si le plafond de positions est atteint', () => {
  const { portfolio, fills, sourceA, sourceB } = setup(50, 1);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter A, plafond=1 atteint
  sourceB.emit(bar(SYMBOL_B, 0, 60)); // voudrait entrer B aussi, refusé

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));
  assert.equal(fills.length, 1);
});

test('paperRunner : ignore un enter si une position est déjà ouverte sur ce symbole', () => {
  const { portfolio, fills, sourceA } = setup(50);
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // enter
  sourceA.emit(bar(SYMBOL_A, 1, 70)); // toujours > 50, mais déjà en position -> hold

  assert.equal(portfolio.positions.size, 1);
  assert.equal(fills.length, 1);
});

test('paperRunner : decide() considère toutes les paires ayant déjà une bougie, pas seulement celle qui vient de clôturer', () => {
  const { portfolio, fills, sourceA, sourceB } = setup(50, 2);
  sourceB.emit(bar(SYMBOL_B, 0, 30)); // B a une bougie mais reste sous le seuil
  sourceA.emit(bar(SYMBOL_A, 0, 60)); // déclenche decide() ; B est visible dans ctx.views

  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.positions.has(SYMBOL_A));

  sourceB.emit(bar(SYMBOL_B, 1, 60)); // B franchit le seuil à son tour -> enter B
  assert.equal(portfolio.positions.size, 2);
  assert.equal(fills.length, 2);
});

test('paperRunner : stop() détache les sources, plus aucun fill après', () => {
  const { runner, portfolio, fills, sourceA } = setup(50);
  runner.stop();
  sourceA.emit(bar(SYMBOL_A, 0, 60));

  assert.equal(portfolio.positions.size, 0);
  assert.equal(fills.length, 0);
});

test('paperRunner : ignore silencieusement une intention sur un symbole sans bougie connue', () => {
  const alwaysEnterUnknown: Strategy = {
    name: 'buggy',
    warmup: 0,
    params: {},
    decide(): readonly Intent[] {
      return [{ kind: 'enter', symbol: 'INCONNU', reason: 'test' }];
    },
  };
  const sourceA = createSyntheticSource();
  const builderA = createLiveSeriesBuilder(SYMBOL_A, 240);
  const portfolio = createPortfolio(1000);
  const fills: Trade[] = [];
  const runner = createPaperRunner({
    strategy: alwaysEnterUnknown,
    sources: new Map([[SYMBOL_A, sourceA]]),
    builders: new Map([[SYMBOL_A, builderA]]),
    portfolio,
    options: { maxConcurrentPositions: 1, riskPerTradePct: 0.01, fees: DEFAULT_FEES, slippageBps: 5 },
    onFill: (trade) => fills.push(trade),
  });
  runner.start();

  assert.doesNotThrow(() => sourceA.emit(bar(SYMBOL_A, 0, 60)));
  assert.equal(fills.length, 0);
  assert.equal(portfolio.positions.size, 0);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/paperRunner.test.ts`
Expected: FAIL — `src/live/paperRunner.ts` n'existe pas.

- [ ] **Step 3: Implémenter `paperRunner.ts`**

```ts
/**
 * Boucle de décision réactive du runner papier : à chaque bougie close
 * reçue de n'importe quelle paire, reconstruit un StrategyContext avec les
 * vues actuelles de toutes les paires connues et appelle strategy.decide()
 * — même contrat que le backtest (src/strategy/types.ts). Contrairement au
 * backtest, le fill est immédiat, au prix de la bougie qui vient de
 * clôturer : la contrainte anti-look-ahead du backtest (fill à la bougie
 * suivante) n'a pas de sens sur un flux déjà temps réel.
 *
 * Réutilise telle quelle la logique d'exécution/portefeuille du backtest
 * (execution.ts, portfolio.ts, sizeBuyOrder de runner.ts) — jamais
 * dupliquée, pour que le sizing/fills papier ne puissent pas diverger de
 * ceux déjà validés par walk-forward.
 */

import type { BarSeries } from '../data/series.ts';
import type { Intent, Strategy, StrategyContext } from '../strategy/types.ts';
import { BarView } from '../strategy/types.ts';
import type { Portfolio, Trade } from '../backtest/portfolio.ts';
import { applyBuyFill, applySellFill, portfolioEquity } from '../backtest/portfolio.ts';
import type { FeeSchedule } from '../backtest/execution.ts';
import { simulateBuy, simulateSell } from '../backtest/execution.ts';
import { sizeBuyOrder } from '../backtest/runner.ts';
import type { ClosedBar, LiveBarSource } from './liveBarSource.ts';
import type { LiveSeriesBuilder } from './liveSeriesBuilder.ts';

export interface PaperRunnerOptions {
  readonly maxConcurrentPositions: number;
  readonly riskPerTradePct: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface PaperRunnerConfig {
  readonly strategy: Strategy;
  readonly sources: ReadonlyMap<string, LiveBarSource>;
  /** Déjà amorcés (voir krakenRestSeed) avant l'appel à start(). */
  readonly builders: ReadonlyMap<string, LiveSeriesBuilder>;
  readonly portfolio: Portfolio;
  readonly options: PaperRunnerOptions;
  /** Appelé après chaque fill appliqué — le point d'accroche de la persistance. */
  readonly onFill?: (trade: Trade, portfolio: Portfolio) => void;
}

export interface PaperRunner {
  start(): void;
  stop(): void;
}

function currentSeriesOrUndefined(builder: LiveSeriesBuilder): BarSeries | undefined {
  try {
    return builder.current();
  } catch {
    return undefined;
  }
}

function marksFrom(builders: ReadonlyMap<string, LiveSeriesBuilder>): Map<string, number> {
  const marks = new Map<string, number>();
  for (const [symbol, builder] of builders) {
    const series = currentSeriesOrUndefined(builder);
    if (series !== undefined) {
      marks.set(symbol, series.close[series.length - 1]!);
    }
  }
  return marks;
}

export function createPaperRunner(config: PaperRunnerConfig): PaperRunner {
  const { strategy, sources, builders, portfolio, options } = config;

  function applyIntent(intent: Intent, now: number): void {
    if (intent.kind === 'hold') return;

    const targetBuilder = builders.get(intent.symbol);
    const targetSeries = targetBuilder ? currentSeriesOrUndefined(targetBuilder) : undefined;
    if (targetSeries === undefined) return;
    const referencePrice = targetSeries.close[targetSeries.length - 1]!;
    const execOpts = { fees: options.fees, slippageBps: options.slippageBps };

    if (intent.kind === 'enter') {
      if (portfolio.positions.size >= options.maxConcurrentPositions) return;
      if (portfolio.positions.has(intent.symbol)) return;

      const equity = portfolioEquity(portfolio, marksFrom(builders));
      const sized = sizeBuyOrder({
        cash: portfolio.cash,
        equity,
        maxConcurrentPositions: options.maxConcurrentPositions,
        riskPerTradePct: options.riskPerTradePct,
        referencePrice,
        ...(intent.stopDistance !== undefined ? { stopDistance: intent.stopDistance } : {}),
      });
      if (!sized.ok) return;

      const fill = simulateBuy(sized.budget, referencePrice, execOpts);
      applyBuyFill(portfolio, intent.symbol, fill, now);
    } else {
      const position = portfolio.positions.get(intent.symbol);
      if (!position) return;

      const fill = simulateSell(position.quantity, referencePrice, execOpts);
      applySellFill(portfolio, intent.symbol, fill, now);
    }

    const trade = portfolio.trades[portfolio.trades.length - 1];
    if (trade) config.onFill?.(trade, portfolio);
  }

  function onClosedBar(symbol: string, bar: ClosedBar): void {
    const builder = builders.get(symbol);
    if (!builder) return;
    builder.append(bar);

    const views = new Map<string, BarView>();
    for (const [sym, b] of builders) {
      const series = currentSeriesOrUndefined(b);
      if (series !== undefined) {
        views.set(sym, new BarView(series, series.length - 1));
      }
    }
    if (views.size === 0) return;

    const ctx: StrategyContext = { views, positions: portfolio.positions, now: bar.time };
    for (const intent of strategy.decide(ctx)) {
      applyIntent(intent, bar.time);
    }
  }

  return {
    start(): void {
      for (const [symbol, source] of sources) {
        source.start((bar) => onClosedBar(symbol, bar));
      }
    },
    stop(): void {
      for (const source of sources.values()) {
        source.stop();
      }
    },
  };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/paperRunner.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 6: Commit**

```bash
git add src/live/paperRunner.ts test/paperRunner.test.ts
git commit -m "$(cat <<'EOF'
feat(live): boucle de décision du runner papier

Réactif : à chaque bougie close de n'importe quelle paire, reconstruit
les vues de toutes les paires connues et appelle strategy.decide() —
même contrat que le backtest. Fill immédiat au prix de clôture
(contrairement au backtest, pas de bougie suivante à attendre en
temps réel). Réutilise sizeBuyOrder/simulateBuy/simulateSell/
applyBuyFill/applySellFill tels quels, sans les dupliquer. Testé
entièrement avec des sources synthétiques, sans réseau.
EOF
)"
```

---

## Task 5: Point d'entrée (`scripts/run-paper.ts`)

**Files:**
- Create: `scripts/run-paper.ts`

**Interfaces:**
- Consumes : tout ce qui précède — `fetchKrakenPairMappings` (Task 2), `fetchSeedBars` (Task 2), `createLiveSeriesBuilder` (Phase 5a), `createKrakenOhlcSource` (Phase 5a), `createMeanReversion`/`combineStrategies` (existants), `createPortfolio` (existant), `loadPortfolioSnapshot`/`savePortfolioSnapshot`/`appendTradeLog` (Task 3), `createPaperRunner` (Task 4).
- Produces : rien de consommé par un autre fichier — c'est le point d'entrée terminal.

- [ ] **Step 1: Implémenter `scripts/run-paper.ts`**

```ts
/**
 * Point d'entrée du runner de trading papier. Assemble le mapping de
 * paires (REST AssetPairs), l'amorçage (REST OHLC), le pipeline live
 * (Phase 5a) et la persistance, puis démarre le runner papier. Trading
 * papier uniquement — aucun ordre réel n'est jamais envoyé à Kraken.
 *
 * Usage : node --experimental-strip-types scripts/run-paper.ts
 */

import { join } from 'node:path';
import type { Interval } from '../src/data/series.ts';
import { UNIVERSE, UNIVERSE_SYMBOLS } from '../src/config/universe.ts';
import { fetchKrakenPairMappings } from '../src/live/krakenAssetPairs.ts';
import { fetchSeedBars } from '../src/live/krakenRestSeed.ts';
import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import type { LiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import { createKrakenOhlcSource } from '../src/live/krakenOhlcSource.ts';
import type { LiveBarSource } from '../src/live/liveBarSource.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';
import { createPortfolio } from '../src/backtest/portfolio.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';
import { createPaperRunner } from '../src/live/paperRunner.ts';
import {
  loadPortfolioSnapshot,
  savePortfolioSnapshot,
  appendTradeLog,
} from '../src/live/statePersistence.ts';

const INTERVAL: Interval = 240;
// Candidat provisoire trouvé en recherche de stratégie (voir README) —
// remplaçable sans changer l'architecture du runner.
const STRATEGY_PARAMS = { period: 80, entryK: 4 };

const STATE_DIR = join(process.cwd(), 'data', 'live-state');
const PORTFOLIO_PATH = join(STATE_DIR, 'portfolio.json');
const TRADES_PATH = join(STATE_DIR, 'trades.jsonl');

async function main(): Promise<void> {
  console.log(`Résolution des mappings de paires (${UNIVERSE.length} paires)...`);
  const mappings = await fetchKrakenPairMappings(UNIVERSE);

  const strategy = combineStrategies(
    UNIVERSE_SYMBOLS.map((symbol) => createMeanReversion({ symbol, ...STRATEGY_PARAMS })),
  );

  const sources = new Map<string, LiveBarSource>();
  const builders = new Map<string, LiveSeriesBuilder>();

  for (const mapping of mappings) {
    console.log(`[${mapping.symbol}] amorçage (REST OHLC)...`);
    const seedBars = await fetchSeedBars({
      restSymbol: mapping.restSymbol,
      symbol: mapping.symbol,
      interval: INTERVAL,
      count: strategy.warmup,
    });
    const builder = createLiveSeriesBuilder(mapping.symbol, INTERVAL);
    for (const bar of seedBars) {
      builder.append(bar);
    }
    builders.set(mapping.symbol, builder);
    sources.set(
      mapping.symbol,
      createKrakenOhlcSource({
        wsSymbol: mapping.wsSymbol,
        symbol: mapping.symbol,
        interval: INTERVAL,
      }),
    );
    console.log(`[${mapping.symbol}] amorcé avec ${seedBars.length} bougies.`);
  }

  console.log("Chargement de l'état persisté...");
  const portfolio = (await loadPortfolioSnapshot(PORTFOLIO_PATH)) ?? createPortfolio(10000);

  const runner = createPaperRunner({
    strategy,
    sources,
    builders,
    portfolio,
    options: {
      maxConcurrentPositions: 5,
      riskPerTradePct: 0.01,
      fees: DEFAULT_FEES,
      slippageBps: 5,
    },
    onFill: (trade, p) => {
      console.log(`[fill] ${trade.side} ${trade.symbol} qty=${trade.quantity} prix=${trade.price}`);
      // Écritures « fire-and-forget » : suffisant vu la fréquence de trading
      // très faible de la stratégie candidate (quelques trades par mois sur
      // 20 paires). Le journal JSONL reste la trace d'audit qui ne perd
      // jamais un trade même si le snapshot accuse un léger retard.
      void savePortfolioSnapshot(PORTFOLIO_PATH, p);
      void appendTradeLog(TRADES_PATH, trade);
    },
  });

  console.log('Démarrage du runner papier...');
  runner.start();

  const shutdown = (): void => {
    console.log('Arrêt en cours...');
    runner.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: aucune erreur

- [ ] **Step 3: Suite complète**

Run: `npm test`
Expected: tous les tests passent (ce fichier n'a pas de test dédié — assemblage + I/O réel, comme `scripts/convert-trades.ts`)

- [ ] **Step 4: Commit**

```bash
git add scripts/run-paper.ts
git commit -m "$(cat <<'EOF'
feat(scripts): point d'entrée du runner de trading papier

Assemble mapping de paires, amorçage REST, pipeline live (Phase 5a),
persistance et boucle de décision (Task 4). Stratégie par défaut :
candidat provisoire mean-reversion (period=80, entryK=4). Trading
papier uniquement.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — chaque section de
`docs/superpowers/specs/2026-08-23-phase5b-paper-runner-design.md` est
couverte : §1 mapping de paires → Task 2 ; §2 amorçage REST → Task 2 ;
§3 sizing partagé → Task 1 ; §4 persistance → Task 3 ; §5 boucle de
décision → Task 4 ; §6 point d'entrée → Task 5.

**Décomposition** — 5 tâches suivant les frontières de responsabilité et de
testabilité de la spec : sizing partagé (modifie du code existant critique,
sa propre porte de revue), deux modules REST non testés automatiquement
(regroupés car même forme — logique pure testée + câblage réseau non
testé), persistance testée avec I/O disque réel, boucle de décision
(cœur du runner, entièrement testable sans réseau), point d'entrée
(assemblage, non testé). L'ordre (1→5) respecte les dépendances : Task 4
consomme `sizeBuyOrder` (Task 1) ; Task 5 consomme tout.

**Cohérence des types** — vérifié que `KrakenPairMapping` (Task 2) fournit
exactement `wsSymbol`/`restSymbol`/`symbol` consommés par `scripts/run-paper.ts`
(Task 5) pour construire `KrakenOhlcSourceConfig` (Phase 5a, inchangé) et
`KrakenRestSeedConfig` (Task 2) ; `SizeBuyOrderInput`/`SizeBuyOrderResult`
(Task 1) utilisés identiquement dans `runner.ts` et `paperRunner.ts`
(Task 4) ; `PaperRunnerConfig.onFill` (Task 4) a exactement la signature
que `scripts/run-paper.ts` (Task 5) lui passe.

**Aucun placeholder** — chaque step contient le code complet à écrire, y
compris `scripts/run-paper.ts` qui n'a pourtant pas de test automatisé
associé (le code lui-même n'est jamais un placeholder, seule sa
vérification diffère — compilation + relecture). Le point de vérification
sur la forme de `/0/public/AssetPairs` (Task 2) est une incertitude
externe réelle à vérifier à l'implémentation, pas une case à deviner —
même traitement que le mapping `wsSymbol` de la Phase 5a.
