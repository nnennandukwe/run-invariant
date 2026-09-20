'use strict';

const { createHash } = require('node:crypto');
const { isProxy } = require('node:util/types');

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_VALUES = 1_000_000;

function unicode(text) {
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) throw new Error('Unpaired Unicode surrogate');
  }
  return text;
}

function canonical(value) {
  const seen = new Set();
  let count = 0;
  let size = 0;
  function token(text) {
    size += Buffer.byteLength(text);
    if (size > MAX_BYTES) throw new Error('JSON byte limit exceeded');
    return text;
  }
  function encode(item, depth) {
    if (depth > MAX_DEPTH || ++count > MAX_VALUES)
      throw new Error('JSON depth/value limit exceeded');
    if (typeof item === 'string') return token(JSON.stringify(unicode(item)));
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || item < 0 || Object.is(item, -0)) {
        throw new Error('JSON numbers must be non-negative safe integers');
      }
      return token(String(item));
    }
    if (item === null || typeof item === 'boolean') return token(JSON.stringify(item));
    if (typeof item !== 'object' || isProxy(item)) throw new Error('Expected plain JSON values');
    if (seen.has(item)) throw new Error('JSON cannot contain cycles or shared references');
    seen.add(item);
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    ) {
      throw new Error('Expected plain JSON objects');
    }
    const keys = Reflect.ownKeys(item).filter((key) => !(array && key === 'length'));
    if (array && keys.length !== item.length) throw new Error('Expected dense arrays');
    if (keys.length + count > MAX_VALUES) throw new Error('JSON value limit exceeded');
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('JSON keys must be strings');
      unicode(key);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) {
        throw new Error('Expected dense arrays without named properties');
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor.enumerable || !('value' in descriptor))
        throw new Error('JSON accessors are forbidden');
    }
    if (array) {
      return (
        token('[') +
        keys
          .map((key, index) => (index ? token(',') : '') + encode(item[key], depth + 1))
          .join('') +
        token(']')
      );
    }
    return (
      token('{') +
      keys
        .sort()
        .map(
          (key, index) =>
            (index ? token(',') : '') +
            token(JSON.stringify(key) + ':') +
            encode(item[key], depth + 1),
        )
        .join('') +
      token('}')
    );
  }
  return encode(value, 0);
}

// Parse artifacts independently of JSON.parse's duplicate-key collapsing. The
// same bounds apply before schemas recurse into objects, including pretty JSON.
function parseJson(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    throw new Error('Expected UTF-8 bytes');
  if (bytes.byteLength > MAX_BYTES + 1) throw new Error('JSON byte limit exceeded');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Invalid UTF-8');
  }
  let at = 0;
  let count = 0;
  const fail = (message) => {
    throw new Error(`${message} at character ${at}`);
  };
  const space = () => {
    while (/[\x20\t\r\n]/.test(source[at] || 'x')) at++;
  };
  function string() {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') {
        at += 2;
        continue;
      }
      if (source[at++] === '"') {
        try {
          return unicode(JSON.parse(source.slice(start, at)));
        } catch {
          fail('Invalid JSON string or Unicode');
        }
      }
    }
    fail('Unterminated JSON string');
  }
  function value(depth) {
    space();
    if (depth > MAX_DEPTH || ++count > MAX_VALUES) fail('JSON depth/value limit exceeded');
    const next = source[at];
    if (next === '"') return string();
    if (next === '{' || next === '[') {
      const array = next === '[';
      const end = array ? ']' : '}';
      const result = array ? [] : {};
      at++;
      space();
      if (source[at] === end) {
        at++;
        return result;
      }
      while (true) {
        space();
        let key;
        if (!array) {
          if (source[at] !== '"') fail('Expected JSON object key');
          key = string();
          if (Object.hasOwn(result, key)) fail('Duplicate JSON key');
          space();
          if (source[at++] !== ':') fail('Expected colon');
        }
        const child = value(depth + 1);
        if (array) result.push(child);
        else
          Object.defineProperty(result, key, {
            value: child,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        space();
        if (source[at] === end) {
          at++;
          return result;
        }
        if (source[at++] !== ',') fail('Expected comma or closing delimiter');
      }
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (source.startsWith(literal, at)) {
        at += literal.length;
        return result;
      }
    }
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = at;
    const number = match.exec(source);
    if (!number) fail('Expected JSON value');
    at = match.lastIndex;
    const result = Number(number[0]);
    if (!Number.isSafeInteger(result) || result < 0 || Object.is(result, -0))
      fail('Invalid JSON integer');
    return result;
  }
  const result = value(0);
  space();
  if (at !== source.length) fail('Extra JSON content');
  canonical(result);
  return result;
}

function parseMessage(bytes) {
  const result = parseJson(bytes);
  const expected = Buffer.from(canonical(result));
  const content = bytes[bytes.length - 1] === 10 ? bytes.subarray(0, -1) : bytes;
  if (!expected.equals(Buffer.from(content)))
    throw new Error('Noncanonical JSON framing or content');
  return result;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (value) => sha256(canonical(value));

// Historical domain hashing uses ECMAScript property enumeration (integer keys
// come first), with compact JSON and no LF. It is deliberately NOT the new codec.
function domainDigest(value) {
  canonical(value);
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    }
    return item;
  }
  return sha256(JSON.stringify(ordered(value)));
}

module.exports = { MAX_BYTES, canonical, parseJson, parseMessage, sha256, digest, domainDigest };
