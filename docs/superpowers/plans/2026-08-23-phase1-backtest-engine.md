# Phase 1 — Moteur de backtest event-driven — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire tourner de bout en bout, sur BTC/EUR seul, un backtest event-driven (exécution simulée, frais, slippage) d'une stratégie de croisement de moyennes mobiles, et prouver qu'elle perd de l'argent après frais.

**Architecture:** Une file d'événements typés (`bar-closed` → `order-requested` → `order-filled`/`order-rejected`) traitée en FIFO synchrone par `runBacktest`. L'exécution simulée (`execution.ts`) et le portefeuille (`portfolio.ts`) sont des modules purs/mutation-locale indépendants, consommés par le runner. La stratégie de référence (`maCrossover.ts`) est strictement pure : elle recalcule ses moyennes mobiles à chaque appel de `decide()` depuis la fenêtre `BarView` déjà disponible, sans état interne persistant.

**Tech Stack:** TypeScript (Node 22.6+, `--experimental-strip-types`, pas d'étape de build), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-23-phase1-backtest-engine-design.md`

## Global Constraints

- Node 22.6+, aucune étape de build — chaque `.ts` s'exécute tel quel via `--experimental-strip-types`.
- `verbatimModuleSyntax: true` — séparer les imports de types (`import type { ... }`) des imports de valeurs, comme dans `src/data/krakenCsv.ts`.
- `erasableSyntaxOnly: true` — pas d'enum, pas de propriétés de paramètre de constructeur, pas de namespace.
- `noUnusedLocals: true` — aucun import ou variable inutilisé ne doit rester dans le code final.
- Commentaires et messages d'erreur en français, cohérents avec le style existant (`src/data/*.ts`, `src/strategy/*.ts`).
- Contrat `Strategy.decide` (`src/strategy/types.ts`) : fonction pure, ne doit rien muter — y compris ses propres champs. Aucune stratégie ne garde d'état interne persistant entre appels.
- Aucune exécution simulée sur une barre marquée `synthetic = 1` (invariant Phase 0, `src/data/series.ts`).
- Seul le taux `takerBps` du `FeeSchedule` est appliqué dans cette phase (tous les ordres sont au marché).
- Sizing : 100 % du cash disponible engagé à chaque achat, une seule position à la fois (mono-pair).
- Commande de test par fichier : `node --experimental-strip-types --test test/<fichier>.test.ts`. Commande globale : `npm test` (`npm run typecheck` pour la vérification de types).

---

## Task 1: Exécution simulée (frais + slippage)

**Files:**
- Create: `src/backtest/execution.ts`
- Test: `test/execution.test.ts`

**Interfaces:**
- Consumes: rien (module autonome, aucune dépendance projet).
- Produces:
  - `interface FeeSchedule { readonly makerBps: number; readonly takerBps: number }`
  - `const DEFAULT_FEES: FeeSchedule` (`{ makerBps: 25, takerBps: 40 }`)
  - `interface ExecutionOptions { readonly fees: FeeSchedule; readonly slippageBps: number }`
  - `interface Fill { readonly price: number; readonly quantity: number; readonly fee: number }`
  - `function simulateBuy(cash: number, referencePrice: number, opts: ExecutionOptions): Fill`
  - `function simulateSell(quantity: number, referencePrice: number, opts: ExecutionOptions): Fill`

- [ ] **Step 1: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/execution.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FEES,
  simulateBuy,
  simulateSell,
} from '../src/backtest/execution.ts';
import type { ExecutionOptions } from '../src/backtest/execution.ts';

const OPTS: ExecutionOptions = { fees: DEFAULT_FEES, slippageBps: 10 };

test("simulateBuy : le slippage majore le prix d'exécution", () => {
  const fill = simulateBuy(1000, 100, OPTS);
  assert.ok(fill.price > 100, `attendu prix > 100, obtenu ${fill.price}`);
  assert.ok(
    Math.abs(fill.price - 100 * 1.001) < 1e-9,
    `attendu 100.1 (slippage 10 bps), obtenu ${fill.price}`,
  );
});

test('simulateBuy : quantité et frais consomment exactement le cash disponible', () => {
  const cash = 1000;
  const fill = simulateBuy(cash, 100, OPTS);
  const spent = fill.quantity * fill.price + fill.fee;
  assert.ok(Math.abs(spent - cash) < 1e-9, `attendu ${cash} dépensé, obtenu ${spent}`);
});

test('simulateBuy : cash nul ou négatif lève', () => {
  assert.throws(() => simulateBuy(0, 100, OPTS), /[Cc]ash/);
  assert.throws(() => simulateBuy(-10, 100, OPTS), /[Cc]ash/);
});

test('simulateBuy : prix de référence invalide lève', () => {
  assert.throws(() => simulateBuy(1000, 0, OPTS), /[Pp]rix/);
  assert.throws(() => simulateBuy(1000, -5, OPTS), /[Pp]rix/);
});

test("simulateSell : le slippage minore le prix d'exécution", () => {
  const fill = simulateSell(1, 100, OPTS);
  assert.ok(fill.price < 100, `attendu prix < 100, obtenu ${fill.price}`);
  assert.ok(
    Math.abs(fill.price - 100 * 0.999) < 1e-9,
    `attendu 99.9 (slippage 10 bps), obtenu ${fill.price}`,
  );
});

test('simulateSell : le fee est proportionnel au produit de la vente', () => {
  const quantity = 2;
  const fill = simulateSell(quantity, 100, OPTS);
  const expectedFee = quantity * fill.price * (DEFAULT_FEES.takerBps / 10_000);
  assert.ok(Math.abs(fill.fee - expectedFee) < 1e-9, `attendu fee ${expectedFee}, obtenu ${fill.fee}`);
});

test('simulateSell : quantité nulle ou négative lève', () => {
  assert.throws(() => simulateSell(0, 100, OPTS), /[Qq]uantité/);
  assert.throws(() => simulateSell(-1, 100, OPTS), /[Qq]uantité/);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/execution.test.ts`
Expected: FAIL — `src/backtest/execution.ts` n'existe pas (erreur de résolution de module).

- [ ] **Step 3: Implémenter**

Créer `src/backtest/execution.ts` :

```ts
/**
 * Exécution simulée : frais Kraken + slippage constant.
 *
 * Seul `takerBps` est appliqué dans cette phase — tous les ordres sont au
 * marché (prochaine ouverture). `makerBps` est porté par le type dès
 * maintenant pour que le futur live-runner à ordres limites n'ait pas à
 * changer la forme de `FeeSchedule`.
 */

export interface FeeSchedule {
  readonly makerBps: number;
  readonly takerBps: number;
}

export const DEFAULT_FEES: FeeSchedule = { makerBps: 25, takerBps: 40 };

export interface ExecutionOptions {
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface Fill {
  readonly price: number;
  readonly quantity: number;
  readonly fee: number;
}

function slippagePrice(side: 'buy' | 'sell', referencePrice: number, slippageBps: number): number {
  const adj = slippageBps / 10_000;
  return side === 'buy' ? referencePrice * (1 + adj) : referencePrice * (1 - adj);
}

/**
 * Achat : engage tout le cash disponible. La quantité et le fee sont
 * résolus ensemble — pas l'inverse — pour que
 * `quantity * price + fee === cash` par construction. Calculer d'abord
 * `quantity = cash / price` puis ajouter le fee par-dessus dépenserait plus
 * que le cash disponible.
 */
export function simulateBuy(cash: number, referencePrice: number, opts: ExecutionOptions): Fill {
  if (!(cash > 0)) {
    throw new RangeError(`Cash insuffisant pour acheter : ${cash}`);
  }
  if (!(referencePrice > 0)) {
    throw new RangeError(`Prix de référence invalide : ${referencePrice}`);
  }
  const price = slippagePrice('buy', referencePrice, opts.slippageBps);
  const takerRate = opts.fees.takerBps / 10_000;
  const quantity = cash / (price * (1 + takerRate));
  const fee = quantity * price * takerRate;
  return { price, quantity, fee };
}

/** Vente : solde une quantité déjà détenue. */
export function simulateSell(quantity: number, referencePrice: number, opts: ExecutionOptions): Fill {
  if (!(quantity > 0)) {
    throw new RangeError(`Quantité invalide pour vendre : ${quantity}`);
  }
  if (!(referencePrice > 0)) {
    throw new RangeError(`Prix de référence invalide : ${referencePrice}`);
  }
  const price = slippagePrice('sell', referencePrice, opts.slippageBps);
  const fee = quantity * price * (opts.fees.takerBps / 10_000);
  return { price, quantity, fee };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/execution.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur

```bash
git add src/backtest/execution.ts test/execution.test.ts
git commit -m "$(cat <<'EOF'
feat(backtest): exécution simulée — frais taker + slippage

simulateBuy résout sizing et fee ensemble pour engager exactement tout le
cash disponible ; simulateSell solde une quantité détenue. Seul takerBps
est appliqué cette phase, makerBps est réservé au futur live à ordres
limites.
EOF
)"
```

---

## Task 2: Portefeuille

**Files:**
- Create: `src/backtest/portfolio.ts`
- Test: `test/portfolio.test.ts`

**Interfaces:**
- Consumes:
  - `Position` (`src/strategy/types.ts`) : `{ symbol, side: 'long'|'flat', quantity, entryPrice, entryTime }`
  - `Fill` (`src/backtest/execution.ts`, Task 1) : `{ price, quantity, fee }`
- Produces:
  - `interface Trade { readonly symbol: string; readonly side: 'buy'|'sell'; readonly quantity: number; readonly price: number; readonly fee: number; readonly time: number }`
  - `interface Portfolio { cash: number; readonly positions: Map<string, Position>; readonly trades: Trade[] }`
  - `function createPortfolio(initialCash: number): Portfolio`
  - `function applyBuyFill(p: Portfolio, symbol: string, fill: Fill, time: number): void`
  - `function applySellFill(p: Portfolio, symbol: string, fill: Fill, time: number): void`

- [ ] **Step 1: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/portfolio.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBuyFill,
  applySellFill,
  createPortfolio,
} from '../src/backtest/portfolio.ts';
import type { Fill } from '../src/backtest/execution.ts';

test('createPortfolio : cash initial, positions et trades vides', () => {
  const p = createPortfolio(1000);
  assert.equal(p.cash, 1000);
  assert.equal(p.positions.size, 0);
  assert.equal(p.trades.length, 0);
});

test('createPortfolio : cash initial invalide lève', () => {
  assert.throws(() => createPortfolio(0), /[Cc]ash/);
  assert.throws(() => createPortfolio(-100), /[Cc]ash/);
});

test('applyBuyFill : débite le cash, ouvre la position, journalise le trade', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: 100, quantity: 9, fee: 10 };
  applyBuyFill(p, 'TESTEUR', fill, 12345);

  assert.ok(Math.abs(p.cash - (1000 - (9 * 100 + 10))) < 1e-9);
  const position = p.positions.get('TESTEUR');
  assert.ok(position);
  assert.equal(position?.symbol, 'TESTEUR');
  assert.equal(position?.side, 'long');
  assert.equal(position?.quantity, 9);
  assert.equal(position?.entryPrice, 100);
  assert.equal(position?.entryTime, 12345);

  assert.equal(p.trades.length, 1);
  assert.equal(p.trades[0]?.side, 'buy');
});

test('applyBuyFill : achat sur une position déjà ouverte lève', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: 100, quantity: 1, fee: 1 };
  applyBuyFill(p, 'TESTEUR', fill, 1);
  assert.throws(() => applyBuyFill(p, 'TESTEUR', fill, 2), /déjà ouverte/);
});

test('applyBuyFill : un fill dont le coût dépasse le cash disponible lève', () => {
  const p = createPortfolio(100);
  const fill: Fill = { price: 100, quantity: 2, fee: 0 }; // coût 200 > cash 100
  assert.throws(() => applyBuyFill(p, 'TESTEUR', fill, 1), /dépasse le cash/);
});

test('applySellFill : crédite le cash, retire la position, journalise le trade', () => {
  const p = createPortfolio(1000);
  const buyFill: Fill = { price: 100, quantity: 9, fee: 10 };
  applyBuyFill(p, 'TESTEUR', buyFill, 1);
  const cashAfterBuy = p.cash;

  const sellFill: Fill = { price: 110, quantity: 9, fee: 9.9 };
  applySellFill(p, 'TESTEUR', sellFill, 2);

  assert.ok(Math.abs(p.cash - (cashAfterBuy + (9 * 110 - 9.9))) < 1e-9);
  assert.equal(p.positions.has('TESTEUR'), false);
  assert.equal(p.trades.length, 2);
  assert.equal(p.trades[1]?.side, 'sell');
});

test('applySellFill : vente sans position ouverte lève', () => {
  const p = createPortfolio(1000);
  const fill: Fill = { price: 100, quantity: 1, fee: 1 };
  assert.throws(() => applySellFill(p, 'TESTEUR', fill, 1), /[Aa]ucune position/);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/portfolio.test.ts`
Expected: FAIL — `src/backtest/portfolio.ts` n'existe pas.

- [ ] **Step 3: Implémenter**

Créer `src/backtest/portfolio.ts` :

```ts
/**
 * Comptabilité du backtest. Seul endroit du système où la mutation est
 * légitime — le contrat `Strategy.decide` (src/strategy/types.ts) interdit
 * toute mutation, y compris interne à la stratégie.
 */

import type { Position } from '../strategy/types.ts';
import type { Fill } from './execution.ts';

export interface Trade {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly price: number;
  readonly fee: number;
  /** Timestamp d'exécution, en secondes epoch (pas un index de barre). */
  readonly time: number;
}

export interface Portfolio {
  cash: number;
  readonly positions: Map<string, Position>;
  readonly trades: Trade[];
}

export function createPortfolio(initialCash: number): Portfolio {
  if (!(initialCash > 0)) {
    throw new RangeError(`Cash initial invalide : ${initialCash}`);
  }
  return { cash: initialCash, positions: new Map(), trades: [] };
}

export function applyBuyFill(p: Portfolio, symbol: string, fill: Fill, time: number): void {
  if (p.positions.has(symbol)) {
    throw new Error(`Position déjà ouverte sur ${symbol}, achat refusé`);
  }
  const cost = fill.quantity * fill.price + fill.fee;
  if (cost > p.cash + 1e-6) {
    throw new Error(
      `Fill d'achat dépasse le cash disponible sur ${symbol} : coût ${cost}, cash ${p.cash}`,
    );
  }
  p.cash -= cost;
  p.positions.set(symbol, {
    symbol,
    side: 'long',
    quantity: fill.quantity,
    entryPrice: fill.price,
    entryTime: time,
  });
  p.trades.push({
    symbol,
    side: 'buy',
    quantity: fill.quantity,
    price: fill.price,
    fee: fill.fee,
    time,
  });
}

export function applySellFill(p: Portfolio, symbol: string, fill: Fill, time: number): void {
  if (!p.positions.has(symbol)) {
    throw new Error(`Aucune position ouverte sur ${symbol}, vente refusée`);
  }
  p.cash += fill.quantity * fill.price - fill.fee;
  p.positions.delete(symbol);
  p.trades.push({
    symbol,
    side: 'sell',
    quantity: fill.quantity,
    price: fill.price,
    fee: fill.fee,
    time,
  });
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/portfolio.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur

```bash
git add src/backtest/portfolio.ts test/portfolio.test.ts
git commit -m "$(cat <<'EOF'
feat(backtest): portefeuille — cash, positions, journal de trades

applyBuyFill/applySellFill sont le seul point de mutation du système ;
le contrat Strategy.decide interdit toute mutation, y compris interne.
EOF
)"
```

---

## Task 3: Stratégie de référence — croisement de moyennes mobiles

**Files:**
- Create: `src/strategy/maCrossover.ts`
- Test: `test/maCrossover.test.ts`

**Interfaces:**
- Consumes:
  - `BarView`, `Intent`, `Strategy`, `StrategyContext`, `Position` (`src/strategy/types.ts`, existant)
  - `Sma` (`src/strategy/indicators.ts`, existant) : `new Sma(period)`, `.update(x): number`, `.value: number`
- Produces:
  - `interface MaCrossoverParams { readonly symbol: string; readonly fast: number; readonly slow: number }`
  - `function createMaCrossover(params: MaCrossoverParams): Strategy`

- [ ] **Step 1: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/maCrossover.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

function seriesFrom(closes: number[]): BarSeries {
  const c = emptyColumns();
  closes.forEach((close, i) => {
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(SYMBOL, 240, c);
}

function ctxFor(closes: number[], position?: Position): StrategyContext {
  const series = seriesFrom(closes);
  const view = new BarView(series, series.length - 1);
  const positions = new Map<string, Position>();
  if (position) positions.set(SYMBOL, position);
  return { views: new Map([[SYMBOL, view]]), positions, now: view.time(0) };
}

test('createMaCrossover : warmup vaut la période lente, params exposés', () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 3, slow: 8 });
  assert.equal(s.warmup, 8);
  assert.deepEqual(s.params, { fast: 3, slow: 8 });
});

test('createMaCrossover : période fast invalide lève', () => {
  assert.throws(() => createMaCrossover({ symbol: SYMBOL, fast: 0, slow: 8 }), /fast/);
});

test('createMaCrossover : période slow <= fast lève', () => {
  assert.throws(() => createMaCrossover({ symbol: SYMBOL, fast: 5, slow: 5 }), /slow/);
});

test("decide : signal d'entrée quand fast > slow et pas de position", () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const ctx = ctxFor([10, 10, 10, 40]); // sma(2)=25 > sma(4)=17.5
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test("decide : hold si fast > slow mais déjà en position (pas de réentrée)", () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor([10, 10, 10, 40], position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : signal de sortie quand fast < slow et position ouverte', () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 40, entryTime: 0 };
  const ctx = ctxFor([40, 10, 10, 10], position); // sma(2)=10 < sma(4)=17.5
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test('decide : hold si fast < slow et pas de position (pas de short)', () => {
  const s = createMaCrossover({ symbol: SYMBOL, fast: 2, slow: 4 });
  const ctx = ctxFor([40, 10, 10, 10]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : symbole absent du contexte renvoie hold sans lever', () => {
  const s = createMaCrossover({ symbol: 'AUTRE', fast: 2, slow: 4 });
  const ctx = ctxFor([10, 10, 10, 40]);
  assert.doesNotThrow(() => s.decide(ctx));
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/maCrossover.test.ts`
Expected: FAIL — `src/strategy/maCrossover.ts` n'existe pas.

- [ ] **Step 3: Implémenter**

Créer `src/strategy/maCrossover.ts` :

```ts
/**
 * Stratégie de référence : croisement de deux moyennes mobiles simples.
 *
 * Sert à prouver que le moteur de backtest (file d'événements, exécution
 * simulée, frais, slippage) fonctionne de bout en bout — pas une stratégie
 * de production.
 *
 * `decide()` recalcule les deux moyennes à chaque appel depuis la fenêtre
 * `BarView` déjà disponible, sans état interne persistant : le contrat
 * `Strategy.decide` interdit toute mutation, y compris des propres champs
 * de la stratégie, ce qu'un indicateur incrémental mis à jour au fil des
 * appels violerait.
 */

import type { BarView, Intent, Strategy, StrategyContext } from './types.ts';
import { Sma } from './indicators.ts';

export interface MaCrossoverParams {
  readonly symbol: string;
  readonly fast: number;
  readonly slow: number;
}

function sma(view: BarView, period: number): number {
  const s = new Sma(period);
  for (let ago = period - 1; ago >= 0; ago--) {
    s.update(view.close(ago));
  }
  return s.value;
}

export function createMaCrossover(params: MaCrossoverParams): Strategy {
  const { symbol, fast, slow } = params;
  if (!Number.isInteger(fast) || fast < 1) {
    throw new RangeError(`Période fast invalide : ${fast}`);
  }
  if (!Number.isInteger(slow) || slow <= fast) {
    throw new RangeError(`Période slow invalide : ${slow} (doit être > fast=${fast})`);
  }

  return {
    name: 'ma-crossover',
    warmup: slow,
    params: { fast, slow },
    decide(ctx: StrategyContext): readonly Intent[] {
      const view = ctx.views.get(symbol);
      if (!view) return [{ kind: 'hold' }];

      const fastVal = sma(view, fast);
      const slowVal = sma(view, slow);
      const hasPosition = ctx.positions.has(symbol);

      if (!hasPosition && fastVal > slowVal) {
        return [{
          kind: 'enter',
          symbol,
          reason: `sma(${fast})=${fastVal.toFixed(4)} > sma(${slow})=${slowVal.toFixed(4)}`,
        }];
      }
      if (hasPosition && fastVal < slowVal) {
        return [{
          kind: 'exit',
          symbol,
          reason: `sma(${fast})=${fastVal.toFixed(4)} < sma(${slow})=${slowVal.toFixed(4)}`,
        }];
      }
      return [{ kind: 'hold' }];
    },
  };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/maCrossover.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur

```bash
git add src/strategy/maCrossover.ts test/maCrossover.test.ts
git commit -m "$(cat <<'EOF'
feat(strategy): croisement de moyennes mobiles — stratégie de référence

decide() recalcule sma(fast)/sma(slow) à chaque appel depuis BarView, sans
état interne persistant, pour respecter le contrat de pureté stricte de
Strategy.decide (aucune mutation, y compris des propres champs).
EOF
)"
```

---

## Task 4: Runner event-driven

**Files:**
- Create: `src/backtest/events.ts`
- Create: `src/backtest/runner.ts`
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes:
  - `BarSeries` (`src/data/series.ts`, existant)
  - `Strategy`, `StrategyContext`, `BarView` (`src/strategy/types.ts`, existant)
  - `FeeSchedule`, `simulateBuy`, `simulateSell` (`src/backtest/execution.ts`, Task 1)
  - `Portfolio`, `createPortfolio`, `applyBuyFill`, `applySellFill` (`src/backtest/portfolio.ts`, Task 2)
- Produces:
  - `type BacktestEvent` (union `bar-closed` | `order-requested` | `order-filled` | `order-rejected`)
  - `interface BacktestOptions { readonly initialCash: number; readonly fees: FeeSchedule; readonly slippageBps: number }`
  - `interface EquityPoint { readonly time: number; readonly equity: number }`
  - `interface BacktestResult { readonly portfolio: Portfolio; readonly equityCurve: readonly EquityPoint[]; readonly rejectedOrders: number }`
  - `function runBacktest(series: BarSeries, strategy: Strategy, opts: BacktestOptions): BacktestResult`

- [ ] **Step 1: Écrire les tests (échouent — le module n'existe pas encore)**

Créer `test/runner.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import type { Strategy, StrategyContext } from '../src/strategy/types.ts';
import { DEFAULT_FEES, simulateBuy, simulateSell } from '../src/backtest/execution.ts';
import { runBacktest } from '../src/backtest/runner.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400;

function seriesFrom(opens: number[], closes: number[], synthetic: number[]): BarSeries {
  const c = emptyColumns();
  opens.forEach((o, i) => {
    c.time.push(i * STEP);
    c.open.push(o);
    c.high.push(Math.max(o, closes[i]!));
    c.low.push(Math.min(o, closes[i]!));
    c.close.push(closes[i]!);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(synthetic[i]!);
  });
  return freezeSeries(SYMBOL, 240, c);
}

/** Achète dès qu'elle est flat, vend dès qu'elle est en position — à chaque barre. */
function alwaysFlipStrategy(): Strategy {
  return {
    name: 'test-always-flip',
    warmup: 1,
    params: {},
    decide(ctx: StrategyContext) {
      const hasPosition = ctx.positions.has(SYMBOL);
      return [{ kind: hasPosition ? 'exit' : 'enter', symbol: SYMBOL, reason: 'test' } as const];
    },
  };
}

const EXEC_OPTS = { initialCash: 1000, fees: DEFAULT_FEES, slippageBps: 10 };

test('runBacktest : exécute un cycle achat puis vente au prochain open', () => {
  const opens = [100, 100, 110, 120];
  const closes = [100, 100, 110, 120];
  const series = seriesFrom(opens, closes, [0, 0, 0, 0]);
  const strategy = alwaysFlipStrategy();

  const result = runBacktest(series, strategy, EXEC_OPTS);

  assert.equal(result.portfolio.trades.length, 2);
  assert.equal(result.portfolio.trades[0]?.side, 'buy');
  assert.equal(result.portfolio.trades[1]?.side, 'sell');
  assert.equal(result.portfolio.positions.size, 0);

  const expectedBuy = simulateBuy(1000, 110, { fees: DEFAULT_FEES, slippageBps: 10 });
  assert.ok(Math.abs((result.portfolio.trades[0]?.price ?? 0) - expectedBuy.price) < 1e-9);
  assert.ok(Math.abs((result.portfolio.trades[0]?.quantity ?? 0) - expectedBuy.quantity) < 1e-9);

  const expectedSell = simulateSell(expectedBuy.quantity, 120, { fees: DEFAULT_FEES, slippageBps: 10 });
  assert.ok(Math.abs((result.portfolio.trades[1]?.price ?? 0) - expectedSell.price) < 1e-9);

  assert.equal(result.equityCurve.length, 2);
  assert.equal(result.rejectedOrders, 0);
});

test("runBacktest : rejette l'exécution sur une barre suivante synthétique et réessaie", () => {
  const opens = [100, 100, 100, 120];
  const closes = [100, 100, 100, 120];
  const series = seriesFrom(opens, closes, [0, 0, 1, 0]);
  const strategy = alwaysFlipStrategy();

  const result = runBacktest(series, strategy, EXEC_OPTS);

  assert.equal(result.rejectedOrders, 1);
  assert.equal(result.portfolio.trades.length, 1);
  assert.equal(result.portfolio.trades[0]?.side, 'buy');
  assert.equal(result.portfolio.positions.size, 1);
});

test('runBacktest : lève si la série est trop courte pour le warmup', () => {
  const series = seriesFrom([100, 100], [100, 100], [0, 0]);
  const strategy = alwaysFlipStrategy();
  assert.throws(() => runBacktest(series, strategy, EXEC_OPTS), /insuffisant/);
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `node --experimental-strip-types --test test/runner.test.ts`
Expected: FAIL — `src/backtest/runner.ts` n'existe pas.

- [ ] **Step 3: Implémenter**

Créer `src/backtest/events.ts` :

```ts
/** Événements du backtest, traités en FIFO synchrone par runBacktest. */
export type BacktestEvent =
  | { readonly kind: 'bar-closed'; readonly symbol: string; readonly t: number }
  | { readonly kind: 'order-requested'; readonly symbol: string; readonly side: 'buy' | 'sell'; readonly reason: string }
  | {
      readonly kind: 'order-filled';
      readonly symbol: string;
      readonly side: 'buy' | 'sell';
      readonly quantity: number;
      readonly price: number;
      readonly fee: number;
      readonly time: number;
    }
  | {
      readonly kind: 'order-rejected';
      readonly symbol: string;
      readonly side: 'buy' | 'sell';
      readonly reason: string;
      readonly time: number;
    };
```

Créer `src/backtest/runner.ts` :

```ts
/**
 * Runner event-driven du backtest.
 *
 * Rejoue une BarSeries barre par barre à travers une file d'événements
 * typés (bar-closed → order-requested → order-filled/order-rejected). Le
 * futur live-runner alimentera la même file depuis un flux temps réel — la
 * logique d'exécution et de portefeuille est déjà écrite pour être
 * réutilisée telle quelle.
 */

import type { BarSeries } from '../data/series.ts';
import type { Strategy, StrategyContext } from '../strategy/types.ts';
import { BarView } from '../strategy/types.ts';
import type { FeeSchedule } from './execution.ts';
import { simulateBuy, simulateSell } from './execution.ts';
import type { Portfolio } from './portfolio.ts';
import { applyBuyFill, applySellFill, createPortfolio } from './portfolio.ts';
import type { BacktestEvent } from './events.ts';

export interface BacktestOptions {
  readonly initialCash: number;
  readonly fees: FeeSchedule;
  readonly slippageBps: number;
}

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
}

export interface BacktestResult {
  readonly portfolio: Portfolio;
  readonly equityCurve: readonly EquityPoint[];
  readonly rejectedOrders: number;
}

export function runBacktest(
  series: BarSeries,
  strategy: Strategy,
  opts: BacktestOptions,
): BacktestResult {
  if (series.length < strategy.warmup + 2) {
    throw new Error(
      `${series.symbol} : ${series.length} barre(s), insuffisant pour un warmup de ` +
        `${strategy.warmup} barre(s) avec exécution sur la barre suivante`,
    );
  }

  const symbol = series.symbol;
  const portfolio = createPortfolio(opts.initialCash);
  const equityCurve: EquityPoint[] = [];
  let rejectedOrders = 0;
  const execOpts = { fees: opts.fees, slippageBps: opts.slippageBps };

  for (let t = strategy.warmup; t <= series.length - 2; t++) {
    const queue: BacktestEvent[] = [{ kind: 'bar-closed', symbol, t }];

    while (queue.length > 0) {
      const event = queue.shift()!;

      switch (event.kind) {
        case 'bar-closed': {
          const view = new BarView(series, event.t);
          const ctx: StrategyContext = {
            views: new Map([[symbol, view]]),
            positions: portfolio.positions,
            now: series.time[event.t]!,
          };
          for (const intent of strategy.decide(ctx)) {
            if (intent.kind === 'enter') {
              queue.push({ kind: 'order-requested', symbol: intent.symbol, side: 'buy', reason: intent.reason });
            } else if (intent.kind === 'exit') {
              queue.push({ kind: 'order-requested', symbol: intent.symbol, side: 'sell', reason: intent.reason });
            }
          }
          break;
        }

        case 'order-requested': {
          const fillT = t + 1;
          const fillTime = series.time[fillT]!;

          if (series.synthetic[fillT] === 1) {
            queue.push({
              kind: 'order-rejected',
              symbol: event.symbol,
              side: event.side,
              reason: 'barre suivante synthétique',
              time: fillTime,
            });
            break;
          }

          const referencePrice = series.open[fillT]!;
          if (event.side === 'buy') {
            const fill = simulateBuy(portfolio.cash, referencePrice, execOpts);
            queue.push({
              kind: 'order-filled',
              symbol: event.symbol,
              side: 'buy',
              quantity: fill.quantity,
              price: fill.price,
              fee: fill.fee,
              time: fillTime,
            });
          } else {
            const position = portfolio.positions.get(event.symbol);
            if (!position) {
              queue.push({
                kind: 'order-rejected',
                symbol: event.symbol,
                side: 'sell',
                reason: 'aucune position ouverte',
                time: fillTime,
              });
              break;
            }
            const fill = simulateSell(position.quantity, referencePrice, execOpts);
            queue.push({
              kind: 'order-filled',
              symbol: event.symbol,
              side: 'sell',
              quantity: fill.quantity,
              price: fill.price,
              fee: fill.fee,
              time: fillTime,
            });
          }
          break;
        }

        case 'order-filled': {
          const fill = { price: event.price, quantity: event.quantity, fee: event.fee };
          if (event.side === 'buy') {
            applyBuyFill(portfolio, event.symbol, fill, event.time);
          } else {
            applySellFill(portfolio, event.symbol, fill, event.time);
          }
          break;
        }

        case 'order-rejected': {
          rejectedOrders++;
          break;
        }
      }
    }

    const position = portfolio.positions.get(symbol);
    const markPrice = series.close[t]!;
    const equity = portfolio.cash + (position ? position.quantity * markPrice : 0);
    equityCurve.push({ time: series.time[t]!, equity });
  }

  return { portfolio, equityCurve, rejectedOrders };
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node --experimental-strip-types --test test/runner.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck et commit**

Run: `npm run typecheck`
Expected: aucune erreur

```bash
git add src/backtest/events.ts src/backtest/runner.ts test/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(backtest): runner event-driven

File bar-closed → order-requested → order-filled/order-rejected, traitée
en FIFO synchrone. Le runner lit series.open[t+1]/series.synthetic[t+1]
directement (légitime : il constate un fait pour exécuter une décision
déjà prise, il n'en prend aucune). Pas de remise en file automatique sur
rejet — la stratégie level-triggered réémet naturellement à l'itération
suivante.
EOF
)"
```

---

## Task 5: Test du critère de sortie de la Phase 1

**Files:**
- Create: `test/phase1.test.ts`

**Interfaces:**
- Consumes:
  - `runBacktest`, `BacktestOptions`, `BacktestResult` (`src/backtest/runner.ts`, Task 4)
  - `DEFAULT_FEES` (`src/backtest/execution.ts`, Task 1)
  - `createMaCrossover` (`src/strategy/maCrossover.ts`, Task 3)
  - `emptyColumns`, `freezeSeries`, `BarSeries` (`src/data/series.ts`, existant)
- Produces: rien (fichier de test terminal, pas de nouveau module source)

- [ ] **Step 1: Écrire le test (échoue tant que le scénario n'est pas validé)**

Créer `test/phase1.test.ts` :

```ts
/**
 * Critère de sortie de la Phase 1 (voir README) : un croisement de
 * moyennes mobiles tourne de bout en bout à travers le moteur de backtest
 * et perd de l'argent après frais.
 *
 * Marché synthétique sans drift net (oscillation autour d'un niveau
 * constant) : le gain brut cumulé sur un cycle complet est proche de zéro
 * quel que soit le nombre d'allers-retours, alors que chaque aller-retour
 * coûte des frais + slippage. La comparaison frictionless vs avec frais
 * prouve que c'est bien le coût de transaction qui creuse la perte, pas un
 * marché simplement défavorable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { createMaCrossover } from '../src/strategy/maCrossover.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { DEFAULT_FEES } from '../src/backtest/execution.ts';

const SYMBOL = 'TESTEUR';
const STEP = 14_400; // barres de 240 minutes, en secondes

function oscillatingSeries(bars: number, base: number, amplitude: number, cycleLen: number): BarSeries {
  const c = emptyColumns();
  for (let i = 0; i < bars; i++) {
    const close = base + amplitude * Math.sin((2 * Math.PI * i) / cycleLen);
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(1);
    c.trades.push(1);
    c.synthetic.push(0);
  }
  return freezeSeries(SYMBOL, 240, c);
}

test("Phase 1 — critère de sortie : un croisement de moyennes mobiles perd de l'argent après frais", () => {
  const series = oscillatingSeries(100, 100, 2, 10);
  const strategy = createMaCrossover({ symbol: SYMBOL, fast: 3, slow: 7 });
  const initialCash = 1000;

  const withFees = runBacktest(series, strategy, {
    initialCash,
    fees: DEFAULT_FEES,
    slippageBps: 5,
  });

  assert.ok(
    withFees.portfolio.trades.length > 1,
    `attendu plusieurs trades, obtenu ${withFees.portfolio.trades.length}`,
  );

  const finalMarkPrice = series.close[series.length - 1]!;
  const finalEquityWithFees =
    withFees.portfolio.cash +
    (withFees.portfolio.positions.get(SYMBOL)?.quantity ?? 0) * finalMarkPrice;

  assert.ok(
    finalEquityWithFees < initialCash,
    `attendu une perte nette après frais, équité finale ${finalEquityWithFees} vs cash initial ${initialCash}`,
  );

  const frictionless = runBacktest(series, strategy, {
    initialCash,
    fees: { makerBps: 0, takerBps: 0 },
    slippageBps: 0,
  });
  const finalEquityFrictionless =
    frictionless.portfolio.cash +
    (frictionless.portfolio.positions.get(SYMBOL)?.quantity ?? 0) * finalMarkPrice;

  assert.ok(
    finalEquityFrictionless > finalEquityWithFees,
    `attendu un résultat frictionless meilleur (${finalEquityFrictionless}) que celui avec frais (${finalEquityWithFees})`,
  );
});
```

- [ ] **Step 2: Lancer le test**

Run: `node --experimental-strip-types --test test/phase1.test.ts`

Si une assertion échoue (paramètres de marché mal calibrés), ajuster
`amplitude`, `cycleLen`, `fast` ou `slow` dans `oscillatingSeries`/
`createMaCrossover` et relancer. Le principe reste valable quel que soit le
réglage exact : un marché sans drift net alterne les signaux, et chaque
aller-retour coûte des frais — augmenter `cycleLen` par rapport à
`fast`/`slow` produit plus de croisements ; réduire `amplitude` réduit le
gain brut capturable par cycle sans changer le coût de transaction fixe par
aller-retour.

Expected une fois calibré : PASS (1 test)

- [ ] **Step 3: Lancer la suite complète et le typecheck**

Run: `npm test`
Expected: tous les tests passent (Phase 0 + Phase 1)

Run: `npm run typecheck`
Expected: aucune erreur

- [ ] **Step 4: Commit**

```bash
git add test/phase1.test.ts
git commit -m "$(cat <<'EOF'
test(phase1): critère de sortie — MA crossover perd après frais

Marché synthétique sans drift net : la comparaison frictionless vs avec
frais isole la perte due aux coûts de transaction d'une perte due à un
marché défavorable, ce qui est le sens littéral du critère de sortie de
la Phase 1 (README).
EOF
)"
```

---

## Self-Review

**Couverture de la spec** — chaque section de
`docs/superpowers/specs/2026-08-23-phase1-backtest-engine-design.md` est
couverte : §1 événements/runner → Task 4 ; §2 exécution simulée → Task 1 ;
§3 portefeuille → Task 2 ; §4 stratégie de référence → Task 3 ; §5 test du
critère de sortie → Task 5.

**Corrections apportées pendant l'écriture du plan** (au-delà de la spec,
détectées en écrivant le code réel) :
- `MaCrossoverParams` n'incluait pas `symbol` dans la spec alors que
  `decide()` en a besoin pour indexer `ctx.views`/`ctx.positions` — ajouté.
- `Trade`/`BacktestEvent`/`Portfolio` utilisaient un champ `t` ambigu (index
  de barre ou timestamp epoch ?) — renommé `time` partout, documenté comme
  timestamp epoch en secondes, cohérent avec `Position.entryTime`.

**Cohérence des types** — vérifié que les signatures utilisées dans les
tasks tardives correspondent à celles produites plus tôt : `Fill` (Task 1)
a les champs `price`/`quantity`/`fee` utilisés tels quels par
`applyBuyFill`/`applySellFill` (Task 2) et par le runner (Task 4) ;
`createMaCrossover` (Task 3) a la signature `{ symbol, fast, slow }`
utilisée identiquement en Task 5.

**Aucun placeholder** — chaque step contient le code complet à écrire ; le
seul point d'itération possible (Task 5, Step 2 : calibrage des paramètres
de marché synthétique) porte sur des valeurs numériques d'un test déjà
entièrement écrit, pas sur du code manquant.
