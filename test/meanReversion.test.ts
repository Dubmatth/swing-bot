import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyColumns, freezeSeries } from '../src/data/series.ts';
import type { BarSeries } from '../src/data/series.ts';
import { BarView } from '../src/strategy/types.ts';
import type { Position, StrategyContext } from '../src/strategy/types.ts';
import { createMeanReversion } from '../src/strategy/meanReversion.ts';

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

function seriesFromWithVolume(closes: number[], volumes: number[]): BarSeries {
  const c = emptyColumns();
  closes.forEach((close, i) => {
    c.time.push(i * STEP);
    c.open.push(close);
    c.high.push(close);
    c.low.push(close);
    c.close.push(close);
    c.volume.push(volumes[i] ?? 1);
    c.trades.push(1);
    c.synthetic.push(0);
  });
  return freezeSeries(SYMBOL, 240, c);
}

function ctxForWithVolume(closes: number[], volumes: number[], position?: Position): StrategyContext {
  const series = seriesFromWithVolume(closes, volumes);
  const view = new BarView(series, series.length - 1);
  const positions = new Map<string, Position>();
  if (position) positions.set(SYMBOL, position);
  return { views: new Map([[SYMBOL, view]]), positions, now: view.time(0) };
}

test('createMeanReversion : warmup vaut la période, params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 5, entryK: 2 });
  assert.equal(s.warmup, 5);
  assert.deepEqual(s.params, { period: 5, entryK: 2 });
});

test('createMeanReversion : période invalide lève', () => {
  assert.throws(() => createMeanReversion({ symbol: SYMBOL, period: 1, entryK: 2 }), /période/i);
});

test('createMeanReversion : entryK invalide lève', () => {
  assert.throws(() => createMeanReversion({ symbol: SYMBOL, period: 5, entryK: 0 }), /entryK/);
});

test("decide : signal d'entrée quand le prix chute sous sma - entryK·std", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  // closes 10,10,10,10 -> sma=10, std=0 ; une chute nette à 5 doit franchir le seuil.
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : hold si le prix est sous la moyenne mais pas assez pour franchir le seuil', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 3 });
  // écart-type non nul avec un seuil large : un léger creux ne suffit pas.
  const ctx = ctxFor([10, 12, 8, 10, 9]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : hold si le prix a chuté mais une position est déjà ouverte (pas de réentrée)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 5, entryTime: 0 };
  const ctx = ctxFor([10, 10, 10, 10, 5], position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : signal de sortie quand le prix revient à la moyenne, position ouverte', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 5, entryTime: 0 };
  const ctx = ctxFor([5, 10, 10, 10, 10], position); // sma(4 dernières)=10, prix=10 >= sma
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test('decide : hold si position ouverte et prix encore sous la moyenne', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 5, entryTime: 0 };
  const ctx = ctxFor([10, 10, 10, 10, 5], position); // sma=8.75, prix=5 < sma
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : symbole absent du contexte renvoie hold sans lever', () => {
  const s = createMeanReversion({ symbol: 'AUTRE', period: 4, entryK: 1 });
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  assert.doesNotThrow(() => s.decide(ctx));
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('createMeanReversion : warmup vaut max(period, trendPeriod), params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, trendPeriod: 10 });
  assert.equal(s.warmup, 10);
  assert.deepEqual(s.params, { period: 4, entryK: 1, trendPeriod: 10 });
});

test('createMeanReversion : trendPeriod <= period lève', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, trendPeriod: 4 }),
    /trendPeriod/,
  );
});

test('decide : le filtre de tendance bloque une entrée en tendance baissière de fond', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, trendPeriod: 6 });
  // Baisse continue : le seuil d'entrée à court terme est franchi, mais le
  // prix reste sous la moyenne longue (tendance baissière confirmée).
  const ctx = ctxFor([100, 95, 90, 85, 80, 75, 70, 65, 60]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : le filtre de tendance autorise une entrée quand le prix reste au-dessus de la moyenne longue', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, trendPeriod: 6 });
  // Un creux plus profond plus tôt tire la moyenne longue sous le prix
  // courant : le repli récent reste un creux local, pas une tendance de fond.
  const ctx = ctxFor([100, 100, 100, 50, 100, 100, 100, 100, 95]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : sans trendPeriod, le même repli en tendance baissière déclenche quand même une entrée', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1 });
  const ctx = ctxFor([100, 95, 90, 85, 80, 75, 70, 65, 60]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('createMeanReversion : warmup inclut volumePeriod, params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 6, volumeMultiplier: 1.5 });
  assert.equal(s.warmup, 6);
  assert.deepEqual(s.params, { period: 4, entryK: 1, volumePeriod: 6, volumeMultiplier: 1.5 });
});

test('createMeanReversion : lève si volumePeriod est fourni sans volumeMultiplier', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 6 }),
    /volumePeriod.*volumeMultiplier|ensemble/,
  );
});

test('createMeanReversion : lève si volumeMultiplier est fourni sans volumePeriod', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumeMultiplier: 1.5 }),
    /volumePeriod.*volumeMultiplier|ensemble/,
  );
});

test('createMeanReversion : lève si volumePeriod est invalide', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 1, volumeMultiplier: 1.5 }),
    /volumePeriod/,
  );
});

test('createMeanReversion : lève si volumeMultiplier est invalide', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, volumePeriod: 4, volumeMultiplier: 0 }),
    /volumeMultiplier/,
  );
});

test("decide : le filtre de volume bloque une entrée sur volume ordinaire", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, volumePeriod: 4, volumeMultiplier: 2 });
  // Seuil d'entrée franchi (comme le test sans filtre), mais volume de la
  // barre courante égal à la moyenne — pas de confirmation de capitulation.
  const ctx = ctxForWithVolume([10, 10, 10, 10, 5], [1, 1, 1, 1, 1]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test("decide : le filtre de volume autorise une entrée sur volume élevé", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1, volumePeriod: 4, volumeMultiplier: 2 });
  // Même repli de prix, mais la barre courante a un volume 5x la moyenne
  // des barres précédentes (1,1,1) -> confirmation de capitulation.
  const ctx = ctxForWithVolume([10, 10, 10, 10, 5], [1, 1, 1, 1, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : sans volumePeriod/volumeMultiplier, le volume est ignoré (comportement inchangé)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 3, entryK: 1 });
  const ctx = ctxForWithVolume([10, 10, 10, 10, 5], [1, 1, 1, 1, 0.01]); // volume très faible
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter'); // toujours une entrée : le volume n'est pas pris en compte
});

test('createMeanReversion : lève si maxVolatilityRatio est invalide', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 0 }),
    /maxVolatilityRatio/,
  );
});

test('createMeanReversion : maxVolatilityRatio n\'affecte pas warmup, params exposés', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 0.05 });
  assert.equal(s.warmup, 4);
  assert.deepEqual(s.params, { period: 4, entryK: 1, maxVolatilityRatio: 0.05 });
});

test('decide : le filtre de régime de volatilité bloque une entrée en régime trop volatil', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 0.05 });
  // closes 10,10,10,10 -> sma=10, std=0 (ratio=0, filtre neutre à ce point) ;
  // une chute nette à 5 franchit le seuil d'entrée MAIS fait aussi bondir le
  // ratio std/sma (les 5 dernières closes incluent maintenant le 5) bien
  // au-dessus de 0.05 — le filtre doit bloquer.
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : le filtre de régime de volatilité autorise une entrée en régime calme', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 100 });
  // Même repli que le test précédent, mais un seuil de ratio si large qu'il
  // n'exclut jamais rien -> comportement identique au cas sans filtre.
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test('decide : sans maxVolatilityRatio, le régime de volatilité est ignoré (comportement inchangé)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  const ctx = ctxFor([10, 10, 10, 10, 5]);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});

test("decide : le filtre de régime de volatilité n'affecte jamais la sortie", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxVolatilityRatio: 0.05 });
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 5, entryTime: 0 };
  // closes 5,10,10,10,20 -> sma(4 dernières)=12.5, ratio std/sma≈0.35, très
  // au-dessus de maxVolatilityRatio=0.05 (régime que le filtre bloquerait à
  // l'entrée) ; prix=20 >= sma -> la sortie doit quand même être émise.
  const ctx = ctxFor([5, 10, 10, 10, 20], position);
  assert.equal(s.decide(ctx)[0]?.kind, 'exit');
});

test('createMeanReversion : lève si maxHoldBars est invalide (non entier)', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 2.5 }),
    /maxHoldBars/,
  );
});

test('createMeanReversion : lève si maxHoldBars est invalide (< 1)', () => {
  assert.throws(
    () => createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 0 }),
    /maxHoldBars/,
  );
});

test("createMeanReversion : maxHoldBars n'affecte pas warmup, params exposés", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 5 });
  assert.equal(s.warmup, 4);
  assert.deepEqual(s.params, { period: 4, entryK: 1, maxHoldBars: 5 });
});

test('decide : le stop de temps force une sortie après maxHoldBars barres sans retour à la moyenne', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 5 });
  // closes[4..7]=[10,10,10,9] -> sma=9.75, prix=9 < sma : pas de sortie par
  // retour à la moyenne. Position ouverte à l'index 0 (barre 0), barre
  // courante = index 7 -> 7 barres détenues >= maxHoldBars=5.
  const closes = [10, 10, 10, 10, 10, 10, 10, 9];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});

test("decide : pas de sortie forcée tant que maxHoldBars n'est pas atteint", () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 10 });
  // Même série (7 barres détenues), mais maxHoldBars=10 > 7 : pas encore atteint.
  const closes = [10, 10, 10, 10, 10, 10, 10, 9];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : sans maxHoldBars, aucune sortie forcée par le temps (comportement inchangé)', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1 });
  // Même série que les deux tests précédents (7 barres détenues), mais pas
  // de maxHoldBars : la position resterait ouverte indéfiniment.
  const closes = [10, 10, 10, 10, 10, 10, 10, 9];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  assert.equal(s.decide(ctx)[0]?.kind, 'hold');
});

test('decide : le retour à la moyenne reste prioritaire sur le stop de temps', () => {
  const s = createMeanReversion({ symbol: SYMBOL, period: 4, entryK: 1, maxHoldBars: 5 });
  // Retour à la moyenne (prix=10 >= sma=10) ET maxHoldBars atteint (7 >= 5)
  // simultanément : la sortie doit se déclencher (peu importe la raison
  // exacte rapportée), pas rester bloquée.
  const closes = [10, 10, 10, 10, 10, 10, 10, 10];
  const position: Position = { symbol: SYMBOL, side: 'long', quantity: 1, entryPrice: 10, entryTime: 0 };
  const ctx = ctxFor(closes, position);
  const intents = s.decide(ctx);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'exit');
});
