# Phase 5a — Pipeline de données live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire le pipeline qui transforme le flux WebSocket Kraken en une `BarSeries` valide et croissante, avec détection correcte de la clôture de bougie, entièrement testable sans réseau.

**Architecture:** `LiveBarSource` (interface) + `liveSeriesBuilder` (compose `MutableColumns`/`freezeSeries` existants) forment la partie 100% testable. `KrakenOhlcSource` (le vrai client WS) isole sa logique de détection de clôture dans une fonction pure (`processOhlcMessage`), testée exhaustivement sans réseau ; seul le câblage réseau autour reste non testé automatiquement.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas d'étape de build), `WebSocket` natif Node (stable depuis Node 22.4, aucune dépendance runtime ajoutée), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-24-phase5a-live-data-pipeline-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build.
- `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `noUnusedLocals: true`, `exactOptionalPropertyTypes: true`.
- Aucune dépendance npm runtime ajoutée — le projet n'en a aujourd'hui aucune (seulement des devDependencies). `WebSocket` natif de Node, pas de paquet `ws`.
- Commentaires et messages d'erreur en français, cohérents avec le style existant.
- Aucun fichier existant n'est modifié — `MutableColumns`, `freezeSeries`, `BarSeries`, `Interval` (`src/data/series.ts`) sont consommés tels quels.
- `KrakenOhlcSource` n'est jamais testée par `npm test` contre un vrai serveur — sa logique de détection de clôture doit être extraite dans une fonction pure, testée exhaustivement sans réseau ; seul le câblage réseau (connexion, envoi du message d'abonnement, parsing JSON, reconnexion) reste non testé automatiquement.
- Une coupure réseau ne doit jamais faire lever d'exception vers l'appelant de `LiveBarSource` — un processus live doit survivre à un problème réseau transitoire (reconnexion avec backoff exponentiel), contrairement à la philosophie « échec bruyant » du reste du projet qui suppose un run ponctuel.
- Commande de test par fichier : `node --experimental-strip-types --test test/<fichier>.test.ts`. Commande globale : `npm test` (`npm run typecheck` pour la vérification de types).

---

## Task 1: `LiveBarSource` et `liveSeriesBuilder`

**Files:**
- Create: `src/live/liveBarSource.ts`
- Create: `src/live/liveSeriesBuilder.ts`
- Test: `test/liveSeriesBuilder.test.ts`

**Interfaces:**
- Consumes : `MutableColumns`, `BarSeries`, `Interval`, `emptyColumns`, `freezeSeries` (`src/data/series.ts`, existant, inchangé).
- Produces :
  - `interface ClosedBar { readonly symbol: string; readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; readonly trades: number }`
  - `interface LiveBarSource { start(onClosedBar: (bar: ClosedBar) => void): void; stop(): void }`
  - `interface LiveSeriesBuilder { append(bar: ClosedBar): void; current(): BarSeries }`
  - `function createLiveSeriesBuilder(symbol: string, interval: Interval): LiveSeriesBuilder`

- [ ] **Step 1: Créer `src/live/liveBarSource.ts`**

```ts
/**
 * Interface d'une source de barres closes en temps réel. Séparée de
 * l'implémentation réelle (KrakenOhlcSource) pour rester testable sans
 * réseau — voir krakenOhlcSource.ts et son extraction de logique pure.
 */

export interface ClosedBar {
  readonly symbol: string;
  /** Timestamp d'ouverture de la barre (interval_begin), en secondes epoch. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number;
}

export interface LiveBarSource {
  /** S'abonne et commence à émettre des barres closes, une par appel. */
  start(onClosedBar: (bar: ClosedBar) => void): void;
  /** Ferme la connexion proprement. */
  stop(): void;
}
```

Ce fichier ne contient que des types — pas de test dédié (aucune logique
d'exécution).

- [ ] **Step 2: Écrire les tests de `liveSeriesBuilder.ts` (échouent — le module n'existe pas encore)**

Créer `test/liveSeriesBuilder.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveSeriesBuilder } from '../src/live/liveSeriesBuilder.ts';
import type { ClosedBar } from '../src/live/liveBarSource.ts';

const SYMBOL = 'TESTEUR';

function bar(time: number, close: number, symbol = SYMBOL): ClosedBar {
  return { symbol, time, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

test("createLiveSeriesBuilder : lève si current() est appelé avant tout append", () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  assert.throws(() => builder.current(), /aucune barre/);
});

test('createLiveSeriesBuilder : construit une BarSeries valide au fil des append', () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  builder.append(bar(1000, 100));
  let series = builder.current();
  assert.equal(series.length, 1);
  assert.equal(series.close[0], 100);

  builder.append(bar(2000, 110));
  series = builder.current();
  assert.equal(series.length, 2);
  assert.equal(series.close[1], 110);
  assert.equal(series.symbol, SYMBOL);
  assert.equal(series.interval, 240);
});

test('createLiveSeriesBuilder : lève si une barre reçue a un timestamp non croissant', () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  builder.append(bar(2000, 100));
  builder.append(bar(1000, 110)); // antérieure à la précédente
  assert.throws(() => builder.current(), /croissant/);
});

test('createLiveSeriesBuilder : lève si une barre reçue est pour un autre symbole', () => {
  const builder = createLiveSeriesBuilder(SYMBOL, 240);
  assert.throws(() => builder.append(bar(1000, 100, 'AUTRE')), /AUTRE/);
});
```

- [ ] **Step 3: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/liveSeriesBuilder.test.ts`
Expected: FAIL — `src/live/liveSeriesBuilder.ts` n'existe pas.

- [ ] **Step 4: Implémenter `liveSeriesBuilder.ts`**

Créer `src/live/liveSeriesBuilder.ts` :

```ts
/**
 * Construit une BarSeries croissante à partir de barres closes reçues au
 * fil de l'eau. Réutilise MutableColumns/freezeSeries (src/data/series.ts,
 * inchangés) — l'invariant de timestamps strictement croissants est
 * revalidé gratuitement par freezeSeries à chaque appel de current().
 */

import type { BarSeries, Interval, MutableColumns } from '../data/series.ts';
import { emptyColumns, freezeSeries } from '../data/series.ts';
import type { ClosedBar } from './liveBarSource.ts';

export interface LiveSeriesBuilder {
  append(bar: ClosedBar): void;
  current(): BarSeries;
}

export function createLiveSeriesBuilder(symbol: string, interval: Interval): LiveSeriesBuilder {
  const columns: MutableColumns = emptyColumns();

  return {
    append(bar: ClosedBar): void {
      if (bar.symbol !== symbol) {
        throw new Error(`createLiveSeriesBuilder(${symbol}) : barre reçue pour ${bar.symbol}`);
      }
      columns.time.push(bar.time);
      columns.open.push(bar.open);
      columns.high.push(bar.high);
      columns.low.push(bar.low);
      columns.close.push(bar.close);
      columns.volume.push(bar.volume);
      columns.trades.push(bar.trades);
      columns.synthetic.push(0);
    },
    current(): BarSeries {
      if (columns.time.length === 0) {
        throw new Error(`createLiveSeriesBuilder(${symbol}) : aucune barre ajoutée`);
      }
      return freezeSeries(symbol, interval, columns);
    },
  };
}
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/liveSeriesBuilder.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 7: Commit**

```bash
git add src/live/liveBarSource.ts src/live/liveSeriesBuilder.ts test/liveSeriesBuilder.test.ts
git commit -m "$(cat <<'EOF'
feat(live): LiveBarSource + liveSeriesBuilder

Interface injectable pour préserver la testabilité déterministe malgré
la nature réseau du futur client Kraken. liveSeriesBuilder compose
MutableColumns/freezeSeries existants, sans dupliquer leur validation.
EOF
)"
```

---

## Task 2: `KrakenOhlcSource`

**Files:**
- Create: `src/live/krakenOhlcSource.ts`
- Test: `test/krakenOhlcSource.test.ts`

**Interfaces:**
- Consumes : `ClosedBar`, `LiveBarSource` (`src/live/liveBarSource.ts`, Task 1) ; `Interval` (`src/data/series.ts`, existant, inchangé).
- Produces :
  - `interface KrakenOhlcSourceConfig { readonly wsSymbol: string; readonly symbol: string; readonly interval: Interval; readonly wsUrl?: string }`
  - `function createKrakenOhlcSource(config: KrakenOhlcSourceConfig): LiveBarSource`
  - (exportés uniquement pour les tests de ce module, pas consommés ailleurs) `interface OhlcMessage`, `function processOhlcMessage(tracked: Map<string, TrackedBar>, msg: OhlcMessage): ClosedBar | null`

- [ ] **Step 1: Écrire les tests de la logique pure (échouent — le module n'existe pas encore)**

Créer `test/krakenOhlcSource.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { processOhlcMessage } from '../src/live/krakenOhlcSource.ts';
import type { OhlcMessage } from '../src/live/krakenOhlcSource.ts';

function msg(intervalBegin: number, close: number, symbol = 'XBTEUR'): OhlcMessage {
  return { symbol, intervalBegin, open: close, high: close, low: close, close, volume: 1, trades: 1 };
}

test('processOhlcMessage : la première barre vue pour un symbole ne déclenche aucune clôture', () => {
  const tracked = new Map();
  const result = processOhlcMessage(tracked, msg(1000, 100));
  assert.equal(result, null);
});

test('processOhlcMessage : une mise à jour avec le même interval_begin ne déclenche aucune clôture', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100));
  const result = processOhlcMessage(tracked, msg(1000, 105));
  assert.equal(result, null);
});

test('processOhlcMessage : un nouvel interval_begin ferme la bougie précédente avec ses dernières valeurs connues', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100));
  processOhlcMessage(tracked, msg(1000, 105)); // mise à jour avant clôture
  const result = processOhlcMessage(tracked, msg(2000, 200)); // nouvelle bougie
  assert.ok(result);
  assert.equal(result?.time, 1000);
  assert.equal(result?.close, 105); // dernière valeur connue de la bougie 1000, pas 100
});

test('processOhlcMessage : un interval_begin déjà dépassé (rejeu/doublon) est ignoré', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100));
  processOhlcMessage(tracked, msg(2000, 200)); // ferme 1000, ouvre 2000
  const result = processOhlcMessage(tracked, msg(1000, 999)); // rejeu de la bougie déjà close
  assert.equal(result, null);
});

test('processOhlcMessage : chaque symbole a son propre état, indépendant des autres', () => {
  const tracked = new Map();
  processOhlcMessage(tracked, msg(1000, 100, 'XBTEUR'));
  processOhlcMessage(tracked, msg(1000, 50, 'ETHEUR'));
  const resultXbt = processOhlcMessage(tracked, msg(2000, 110, 'XBTEUR'));
  const resultEth = processOhlcMessage(tracked, msg(1000, 55, 'ETHEUR'));
  assert.ok(resultXbt);
  assert.equal(resultXbt?.symbol, 'XBTEUR');
  assert.equal(resultEth, null);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/krakenOhlcSource.test.ts`
Expected: FAIL — `src/live/krakenOhlcSource.ts` n'existe pas.

- [ ] **Step 3: Implémenter `krakenOhlcSource.ts`**

Créer `src/live/krakenOhlcSource.ts` :

```ts
/**
 * Client WebSocket Kraken (canal OHLC, WS v2). La logique de détection de
 * clôture de bougie (processOhlcMessage) est une fonction pure, testée
 * exhaustivement sans réseau. Le câblage autour (connexion, abonnement,
 * parsing JSON, reconnexion) n'est PAS testé par npm test — vérifié
 * manuellement en le faisant tourner, seule pièce du projet dans ce cas.
 *
 * Kraken WS v2 n'a pas de flag « bougie fermée » : la bougie en cours se
 * met à jour en place (même interval_begin) jusqu'à ce qu'un nouvel
 * interval_begin apparaisse pour ce symbole — c'est ce changement qui
 * signe la clôture de la précédente.
 */

import type { Interval } from '../data/series.ts';
import type { ClosedBar, LiveBarSource } from './liveBarSource.ts';

export interface KrakenOhlcSourceConfig {
  /** Symbole au format Kraken WS v2 (ex. 'BTC/EUR'). */
  readonly wsSymbol: string;
  /** Symbole interne du projet (ex. 'XBTEUR'), utilisé dans ClosedBar.symbol. */
  readonly symbol: string;
  readonly interval: Interval;
  readonly wsUrl?: string;
}

export interface OhlcMessage {
  readonly symbol: string;
  /** interval_begin déjà converti en secondes epoch. */
  readonly intervalBegin: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number;
}

interface TrackedBar {
  readonly intervalBegin: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trades: number;
}

/**
 * Logique pure de détection de clôture — testable sans réseau. Maintient
 * un état par symbole (dernière bougie en cours) et renvoie la barre
 * précédente comme close dès qu'un nouvel interval_begin apparaît pour ce
 * symbole. Ne mute que `tracked`, aucune I/O.
 */
export function processOhlcMessage(
  tracked: Map<string, TrackedBar>,
  msg: OhlcMessage,
): ClosedBar | null {
  const current = tracked.get(msg.symbol);

  if (current === undefined || msg.intervalBegin === current.intervalBegin) {
    tracked.set(msg.symbol, {
      intervalBegin: msg.intervalBegin,
      open: msg.open,
      high: msg.high,
      low: msg.low,
      close: msg.close,
      volume: msg.volume,
      trades: msg.trades,
    });
    return null;
  }

  if (msg.intervalBegin < current.intervalBegin) {
    return null; // rejeu / doublon après reconnexion
  }

  const closed: ClosedBar = {
    symbol: msg.symbol,
    time: current.intervalBegin,
    open: current.open,
    high: current.high,
    low: current.low,
    close: current.close,
    volume: current.volume,
    trades: current.trades,
  };
  tracked.set(msg.symbol, {
    intervalBegin: msg.intervalBegin,
    open: msg.open,
    high: msg.high,
    low: msg.low,
    close: msg.close,
    volume: msg.volume,
    trades: msg.trades,
  });
  return closed;
}

const DEFAULT_WS_URL = 'wss://ws.kraken.com/v2';
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function parseIntervalBeginToEpochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export function createKrakenOhlcSource(config: KrakenOhlcSourceConfig): LiveBarSource {
  const tracked = new Map<string, TrackedBar>();
  let ws: WebSocket | undefined;
  let stopped = false;
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  let onClosedBar: ((bar: ClosedBar) => void) | undefined;

  function connect(): void {
    if (stopped) return;
    const url = config.wsUrl ?? DEFAULT_WS_URL;
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_BASE_DELAY_MS;
      socket.send(
        JSON.stringify({
          method: 'subscribe',
          params: {
            channel: 'ohlc',
            symbol: [config.wsSymbol],
            interval: config.interval,
            snapshot: true,
          },
        }),
      );
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // message non-JSON (heartbeat, etc.) — ignoré
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { channel?: unknown }).channel !== 'ohlc' ||
        !('data' in parsed)
      ) {
        return;
      }
      const data = (parsed as { data: unknown }).data;
      if (!Array.isArray(data)) return;

      for (const entry of data) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (
          typeof e.interval_begin !== 'string' ||
          typeof e.open !== 'number' ||
          typeof e.high !== 'number' ||
          typeof e.low !== 'number' ||
          typeof e.close !== 'number' ||
          typeof e.volume !== 'number' ||
          typeof e.trades !== 'number'
        ) {
          continue;
        }
        const message: OhlcMessage = {
          symbol: config.symbol,
          intervalBegin: parseIntervalBeginToEpochSeconds(e.interval_begin),
          open: e.open,
          high: e.high,
          low: e.low,
          close: e.close,
          volume: e.volume,
          trades: e.trades,
        };
        const closed = processOhlcMessage(tracked, message);
        if (closed && onClosedBar) {
          onClosedBar(closed);
        }
      }
    });

    socket.addEventListener('close', () => {
      if (stopped) return;
      console.error(
        `KrakenOhlcSource(${config.symbol}) : connexion fermée, reconnexion dans ${reconnectDelay}ms`,
      );
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    });

    socket.addEventListener('error', (event: Event) => {
      console.error(`KrakenOhlcSource(${config.symbol}) : erreur WebSocket`, event);
    });
  }

  return {
    start(callback: (bar: ClosedBar) => void): void {
      onClosedBar = callback;
      connect();
    },
    stop(): void {
      stopped = true;
      ws?.close();
    },
  };
}
```

**Point de vérification important** : ce fichier utilise les types
globaux `WebSocket`, `MessageEvent` et `Event`, natifs de Node depuis la
version 22.4 (stable, aucune dépendance ajoutée). Avant de continuer,
lancer `npm run typecheck` — si TypeScript ne reconnaît pas ces types
globaux (erreur du type « Cannot find name 'WebSocket' »), c'est que la
version de `@types/node` installée ne les expose pas ambiantement dans la
configuration actuelle (`lib: ["ES2023"]`, sans `dom`). Dans ce cas,
**ne pas ajouter `"dom"` à `lib`** dans `tsconfig.json` (ça importerait
tout un univers de types DOM sans rapport avec ce projet Node) — chercher
plutôt si `@types/node` expose ces types sous un sous-chemin dédié (voir
son `package.json` / ses fichiers `.d.ts` dans `node_modules/@types/node`)
et les référencer explicitement si besoin (`/// <reference types="..." />`
ou équivalent). Documenter dans le rapport de tâche ce qui a été trouvé.

- [ ] **Step 4: Vérifier que les tests de logique pure passent**

Run: `node --experimental-strip-types --test test/krakenOhlcSource.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck et suite complète**

Run: `npm run typecheck`
Expected: aucune erreur (voir le point de vérification du Step 3 si ce
n'est pas le cas)

Run: `npm test`
Expected: tous les tests passent

- [ ] **Step 6: Commit**

```bash
git add src/live/krakenOhlcSource.ts test/krakenOhlcSource.test.ts
git commit -m "$(cat <<'EOF'
feat(live): KrakenOhlcSource — client WebSocket OHLC v2

processOhlcMessage isole la détection de clôture de bougie en fonction
pure, testée exhaustivement sans réseau. Le câblage réseau autour
(connexion, abonnement, reconnexion avec backoff) n'est testé par
aucun test automatisé — seule pièce du projet dans ce cas, documentée
comme telle dans le fichier.
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — chaque section de
`docs/superpowers/specs/2026-08-24-phase5a-live-data-pipeline-design.md`
est couverte : §1 `LiveBarSource` → Task 1 ; §2 `KrakenOhlcSource` +
§3 `liveSeriesBuilder` → Task 1 (liveSeriesBuilder) et Task 2
(KrakenOhlcSource).

**Décomposition** — 2 tâches : la partie 100% testable
(`LiveBarSource`/`liveSeriesBuilder`, Task 1) séparée de la partie qui
mélange logique pure testée et câblage réseau non testé
(`KrakenOhlcSource`, Task 2) — la frontière de tâche suit exactement la
frontière de testabilité, cohérent avec le défi méthodologique posé par
la spec.

**Cohérence des types** — vérifié que `ClosedBar` (Task 1) a exactement
les mêmes champs utilisés par `processOhlcMessage`/`createKrakenOhlcSource`
(Task 2) ; `LiveBarSource` (Task 1) est l'interface exacte implémentée par
`createKrakenOhlcSource` (Task 2, `start`/`stop`) ; `Interval` (existant)
utilisé identiquement dans `KrakenOhlcSourceConfig` et
`createLiveSeriesBuilder`.

**Aucun placeholder** — chaque step contient le code complet à écrire, y
compris `KrakenOhlcSource`'s câblage réseau qui n'a pourtant pas de test
automatisé associé (le code lui-même n'est jamais un placeholder, seule
sa vérification diffère — compilation + relecture, pas d'assertion
`node:test`). Le seul point de vérification manuelle explicite (Task 2,
Step 3) porte sur une incertitude d'environnement réelle (disponibilité
des types ambiants `WebSocket` sous la configuration `lib` actuelle du
projet), pas sur un comportement métier à deviner.
