import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleOhlcMessages,
  isValidOhlcEntry,
  parseOhlcEntry,
  processOhlcMessage,
} from '../src/live/krakenOhlcSource.ts';
import type { OhlcMessage, TrackedBar } from '../src/live/krakenOhlcSource.ts';

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

test('isValidOhlcEntry : accepte une entrée OHLC cohérente', () => {
  assert.equal(isValidOhlcEntry(1000, 100, 110, 90, 105), true);
});

test('isValidOhlcEntry : rejette un interval_begin NaN (date invalide côté réseau)', () => {
  // Reproduit le cas d'un interval_begin syntaxiquement une string mais
  // représentant une date invalide : new Date(...).getTime() vaut NaN, ce qui
  // sans ce garde-fou déjoue silencieusement les comparaisons de
  // processOhlcMessage (NaN === x et NaN < x sont toutes deux fausses).
  assert.equal(isValidOhlcEntry(Number.NaN, 100, 110, 90, 105), false);
});

test('isValidOhlcEntry : rejette un interval_begin nul ou négatif', () => {
  assert.equal(isValidOhlcEntry(0, 100, 110, 90, 105), false);
  assert.equal(isValidOhlcEntry(-1, 100, 110, 90, 105), false);
});

test('isValidOhlcEntry : rejette un OHLC incohérent (high < low)', () => {
  assert.equal(isValidOhlcEntry(1000, 100, 90, 110, 105), false);
});

test('isValidOhlcEntry : rejette un OHLC incohérent (open hors de [low, high])', () => {
  assert.equal(isValidOhlcEntry(1000, 200, 110, 90, 105), false);
});

test('isValidOhlcEntry : rejette un prix nul ou négatif', () => {
  assert.equal(isValidOhlcEntry(1000, 0, 110, 0, 105), false);
  assert.equal(isValidOhlcEntry(1000, -1, 110, -1, 105), false);
});

test("handleOhlcMessages : un snapshot avec plusieurs bougies historiques n'émet aucune ClosedBar", () => {
  const tracked = new Map<string, TrackedBar>();
  const messages: OhlcMessage[] = [msg(1000, 10), msg(2000, 20), msg(3000, 30), msg(4000, 40)];
  const closed = handleOhlcMessages(tracked, 'snapshot', messages);
  assert.deepEqual(closed, []);
});

test('handleOhlcMessages : un snapshot amorce le suivi de clôture avec la dernière entrée uniquement', () => {
  const tracked = new Map<string, TrackedBar>();
  const messages: OhlcMessage[] = [msg(1000, 10), msg(2000, 20), msg(3000, 30)];
  handleOhlcMessages(tracked, 'snapshot', messages);

  // Un message "update" qui avance encore l'intervalle doit clôturer la
  // DERNIÈRE bougie du snapshot (3000/30), jamais une des bougies
  // historiques plus anciennes (1000 ou 2000) — celles-ci ne doivent
  // jamais être rejouées comme ClosedBar.
  const closed = handleOhlcMessages(tracked, 'update', [msg(4000, 40)]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.time, 3000);
  assert.equal(closed[0]?.close, 30);
});

test('handleOhlcMessages : reproduit la forme du snapshot réel observé contre Kraken (10 bougies) sans jamais rejouer l\'historique', () => {
  // Bug réel observé en lançant scripts/run-paper.ts contre l'API Kraken en
  // direct : le message "snapshot" de la souscription WS v2 (snapshot:true)
  // renvoie jusqu'à 10 bougies historiques en une seule fois, pas
  // uniquement la bougie en cours. Avant ce correctif, chaque entrée était
  // rejouée via processOhlcMessage, émettant des ClosedBar avec des
  // timestamps bien antérieurs à l'historique déjà amorcé par REST — ce
  // qui faisait échouer freezeSeries pour les 20 paires de l'univers.
  const intervalBegins = Array.from({ length: 10 }, (_, i) => 1_800_000_000 + i * 14_400);
  const tracked = new Map<string, TrackedBar>();
  const messages = intervalBegins.map((t, i) => msg(t, 100 + i, 'DOTEUR'));

  const closed = handleOhlcMessages(tracked, 'snapshot', messages);
  assert.deepEqual(closed, []);

  const trackedState = tracked.get('DOTEUR');
  assert.ok(trackedState);
  assert.equal(trackedState?.intervalBegin, intervalBegins[9]);

  // Le premier "update" réel qui arrive ensuite doit clôturer uniquement
  // la dernière bougie du snapshot — jamais une des 9 bougies historiques
  // déjà couvertes par l'amorçage REST.
  const nextUpdate = handleOhlcMessages(tracked, 'update', [msg(intervalBegins[9]! + 14_400, 999, 'DOTEUR')]);
  assert.equal(nextUpdate.length, 1);
  assert.equal(nextUpdate[0]?.time, intervalBegins[9]);
});

test('handleOhlcMessages : un tableau vide ne mute pas tracked et ne renvoie rien', () => {
  const tracked = new Map<string, TrackedBar>();
  const closed = handleOhlcMessages(tracked, 'update', []);
  assert.deepEqual(closed, []);
  assert.equal(tracked.size, 0);
});

test('handleOhlcMessages : un message qui n\'est pas un snapshot traite chaque entrée via processOhlcMessage', () => {
  const tracked = new Map<string, TrackedBar>();
  const closedFirst = handleOhlcMessages(tracked, undefined, [msg(1000, 10)]);
  assert.deepEqual(closedFirst, []); // première bougie vue, pas de clôture
  const closedSecond = handleOhlcMessages(tracked, undefined, [msg(2000, 20)]);
  assert.equal(closedSecond.length, 1);
  assert.equal(closedSecond[0]?.time, 1000);
});

test('parseOhlcEntry : parse une entrée valide', () => {
  const entry = {
    interval_begin: '2026-08-24T12:00:00.000000000Z',
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1.5,
    trades: 10,
  };
  const result = parseOhlcEntry('DOTEUR', entry);
  assert.ok(result);
  assert.equal(result?.symbol, 'DOTEUR');
  assert.equal(result?.open, 100);
});

test('parseOhlcEntry : renvoie undefined si un champ est manquant ou du mauvais type', () => {
  assert.equal(
    parseOhlcEntry('DOTEUR', { interval_begin: '2026-08-24T12:00:00Z', open: 100 }),
    undefined,
  );
});

test('parseOhlcEntry : renvoie undefined sur un OHLC incohérent', () => {
  const entry = {
    interval_begin: '2026-08-24T12:00:00.000000000Z',
    open: 100,
    high: 90,
    low: 110,
    close: 105,
    volume: 1.5,
    trades: 10,
  };
  assert.equal(parseOhlcEntry('DOTEUR', entry), undefined);
});

test('parseOhlcEntry : renvoie undefined si interval_begin est une date invalide', () => {
  const entry = {
    interval_begin: 'pas-une-date',
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1.5,
    trades: 10,
  };
  assert.equal(parseOhlcEntry('DOTEUR', entry), undefined);
});
