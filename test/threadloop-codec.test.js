'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canonical,
  parseJson,
  parseMessage,
  digest,
  domainDigest,
} = require('../src/threadloop/codec');

test('ThreadLoop bytes are compact, UTF-16 ordered and separate from legacy hashing', () => {
  assert.equal(canonical({ 2: 2, 10: 10 }), '{"10":10,"2":2}');
  assert.equal(canonical({ '\ue000': 1, '\ud800\udc00': 2 }), '{"\ud800\udc00":2,"\ue000":1}');
  assert.equal(digest({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.notEqual(digest({ 2: 2, 10: 10 }), domainDigest({ 2: 2, 10: 10 }));
  assert.deepEqual(parseMessage(Buffer.from('{}\n')), {});
});

test('transport refuses malformed bytes, duplicate keys, alternate encodings and framing', () => {
  for (const source of [
    ' {"a":1}',
    '{}\r\n',
    '{}\n\n',
    '{}{}',
    '{"a":1,"a":1}',
    '{"a":1e0}',
    '{"a":-0}',
    '{"a":0.5}',
    '{"a":9007199254740992}',
    '"\\ud800"',
    '\ufeff{}',
  ]) {
    assert.throws(() => parseMessage(Buffer.from(source)), undefined, source);
  }
  assert.throws(() => parseMessage(Buffer.from([0xff])), /UTF-8/);
  assert.throws(() => parseJson(Buffer.from('{"a":0,"\\u0061":1}')), /duplicate/i);
  assert.throws(() => parseJson(Buffer.from('['.repeat(66) + '0' + ']'.repeat(66))), /depth/);
  assert.throws(() => parseJson(Buffer.alloc(16 * 1024 * 1024 + 2, 32)), /limit/);
});

test('artifact JSON admits presentation whitespace but preserves bounded JSON and unique keys', () => {
  assert.deepEqual(parseJson(Buffer.from(' { "a": [true, null, 0] }\n')), { a: [true, null, 0] });
  assert.deepEqual(parseJson(Buffer.from('{"__proto__":1}')), JSON.parse('{"__proto__":1}'));
  const bad = {
    get value() {
      throw new Error('getter executed');
    },
  };
  assert.throws(() => canonical(bad), /accessor/);
  const shared = {};
  assert.throws(() => canonical([shared, shared]), /shared/);
  assert.throws(() => canonical(new Proxy({}, {})), /plain/);
  assert.throws(() => canonical([, 1]), /dense/);
});

test('numeric lexemes cannot round or underflow into a pinned integer (7df65ae8)', () => {
  for (const literal of [
    '1e-324',
    '1.0000000000000001',
    '9007199254740991.1',
    '1e99999',
    '1e-99999',
    '-0e3',
  ]) {
    assert.throws(() => parseJson(Buffer.from(literal)), /integer/i, literal);
  }
  for (const [literal, integer] of [
    ['1e0', 1],
    ['10e-1', 1],
    ['1.000', 1],
    ['1.25e2', 125],
    ['0e999999999999999999999999', 0],
    ['90071992547409910e-1', 9007199254740991],
  ]) {
    assert.equal(parseJson(Buffer.from(literal)), integer, literal);
  }
});
