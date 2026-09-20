'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { materializeSources } = require('../src/threadloop/sources');
const ref = (name) => ({ $fixture_ref: name });
const source = (fixture) => ({ schema: 'threadloop.conformance-source/0.1', fixture });

test('shared values expand without mutation or aliasing', () => {
  const values = { snapshot: { graph: ref('graph') }, graph: { states: ['ready'] } };
  const sources = { case: source([ref('snapshot'), ref('snapshot')]) };
  const before = structuredClone({ sources, values });
  const result = materializeSources(sources, values);
  assert.deepEqual(result.case, [
    { graph: { states: ['ready'] } },
    { graph: { states: ['ready'] } },
  ]);
  assert.notEqual(result.case[0], result.case[1]);
  assert.deepEqual({ sources, values }, before);
});

for (const [name, fixture, values, error] of [
  ['missing', ref('missing'), {}, /missing/],
  ['external', ref('../path'), {}, /reference/],
  ['override', { ...ref('graph'), extra: true }, { graph: {} }, /reference/],
  ['self cycle', ref('loop'), { loop: ref('loop') }, /cycle/],
  ['indirect cycle', ref('first'), { first: ref('second'), second: ref('first') }, /cycle/],
  ['unused', {}, { unused: {} }, /unused/],
  ['inherited name', ref('constructor'), {}, /reference/],
])
  test(`source expansion rejects ${name}`, () => {
    assert.throws(() => materializeSources({ case: source(fixture) }, values), error);
  });

test('expansion has byte, visit and reference-depth bounds before allocation', () => {
  for (const [leaf, levels] of [
    ['x'.repeat(1024), 20],
    [null, 21],
  ]) {
    const values = { leaf };
    let name = 'leaf';
    for (let index = 0; index < levels; index++) {
      values[`level_${index}`] = [ref(name), ref(name)];
      name = `level_${index}`;
    }
    assert.throws(() => materializeSources({ case: source(ref(name)) }, values), /limit/);
  }
  const values = { leaf: null };
  let name = 'leaf';
  for (let index = 0; index < 66; index++) {
    values[`level_${index}`] = ref(name);
    name = `level_${index}`;
  }
  assert.throws(() => materializeSources({ case: source(ref(name)) }, values), /limit/);
});

test('aggregate expansion rejects two individually bounded cases', () => {
  const values = { leaf: 'x'.repeat(1024) };
  let name = 'leaf';
  for (let index = 0; index < 13; index++) {
    values[`level_${index}`] = [ref(name), ref(name)];
    name = `level_${index}`;
  }
  const one = source(ref(name));
  assert.doesNotThrow(() => materializeSources({ first: one }, values));
  assert.throws(() => materializeSources({ first: one, second: one }, values), /byte limit/);
});
