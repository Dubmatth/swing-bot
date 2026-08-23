import test from 'node:test';
import assert from 'node:assert/strict';

import type { Intent, Strategy, StrategyContext } from '../src/strategy/types.ts';
import { combineStrategies } from '../src/strategy/combineStrategies.ts';

function fixedStrategy(
  name: string,
  warmup: number,
  params: Record<string, number>,
  intents: readonly Intent[],
): Strategy {
  return {
    name,
    warmup,
    params,
    decide(_ctx: StrategyContext): readonly Intent[] {
      return intents;
    },
  };
}

const EMPTY_CTX: StrategyContext = { views: new Map(), positions: new Map(), now: 0 };

test('combineStrategies : lève si la liste est vide', () => {
  assert.throws(() => combineStrategies([]), /au moins une/);
});

test('combineStrategies : warmup est le max des sous-stratégies', () => {
  const a = fixedStrategy('a', 3, {}, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 7, {}, [{ kind: 'hold' }]);
  const combined = combineStrategies([a, b]);
  assert.equal(combined.warmup, 7);
});

test('combineStrategies : params fusionnés avec préfixe par index', () => {
  const a = fixedStrategy('a', 1, { fast: 3, slow: 7 }, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 1, { fast: 5, slow: 10 }, [{ kind: 'hold' }]);
  const combined = combineStrategies([a, b]);
  assert.deepEqual(combined.params, { '0_fast': 3, '0_slow': 7, '1_fast': 5, '1_slow': 10 });
});

test('combineStrategies : concatène les intentions non-hold de toutes les sous-stratégies', () => {
  const a = fixedStrategy('a', 1, {}, [{ kind: 'enter', symbol: 'AEUR', reason: 'a' }]);
  const b = fixedStrategy('b', 1, {}, [{ kind: 'exit', symbol: 'BEUR', reason: 'b' }]);
  const combined = combineStrategies([a, b]);
  const intents = combined.decide(EMPTY_CTX);
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.kind, 'enter');
  assert.equal(intents[1]?.kind, 'exit');
});

test('combineStrategies : renvoie hold si toutes les sous-stratégies renvoient hold', () => {
  const a = fixedStrategy('a', 1, {}, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 1, {}, [{ kind: 'hold' }]);
  const combined = combineStrategies([a, b]);
  const intents = combined.decide(EMPTY_CTX);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'hold');
});

test('combineStrategies : filtre les hold individuels sans perdre les intentions actionnables des autres', () => {
  const a = fixedStrategy('a', 1, {}, [{ kind: 'hold' }]);
  const b = fixedStrategy('b', 1, {}, [{ kind: 'enter', symbol: 'AEUR', reason: 'b' }]);
  const combined = combineStrategies([a, b]);
  const intents = combined.decide(EMPTY_CTX);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.kind, 'enter');
});
