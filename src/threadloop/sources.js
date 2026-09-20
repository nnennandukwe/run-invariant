'use strict';

const { canonical, MAX_BYTES, MAX_DEPTH, MAX_VALUES } = require('./codec');

// Called after the pinned source/shared schemas validate the storage envelopes.
// References are local literal values, never paths, patches, or executable recipes.
function materializeSources(sources, values) {
  canonical(values);
  const used = new Set();
  const fixtures = Object.fromEntries(
    Object.entries(sources).map(([filename, source]) => {
      try {
        canonical(source);
        let visits = 0;
        let bytes = 0;
        const active = new Set();
        function charge(count) {
          bytes += count;
          if (bytes > MAX_BYTES) throw new Error('Fixture expansion byte limit exceeded');
        }
        function expand(value, depth) {
          if (++visits > MAX_VALUES || depth > MAX_DEPTH)
            throw new Error('Fixture expansion depth/value limit exceeded');
          if (Array.isArray(value)) {
            charge(2 + Math.max(0, value.length - 1));
            return value.map((item) => expand(item, depth + 1));
          }
          if (value !== null && typeof value === 'object') {
            const entries = Object.entries(value);
            if (Object.hasOwn(value, '$fixture_ref')) {
              const name = value.$fixture_ref;
              if (
                entries.length !== 1 ||
                typeof name !== 'string' ||
                !Object.hasOwn(values, name)
              )
                throw new Error(`Invalid or missing shared reference: ${String(name)}`);
              if (active.has(name)) throw new Error(`Shared reference cycle: ${name}`);
              active.add(name);
              used.add(name);
              const result = expand(values[name], depth + 1);
              active.delete(name);
              return result;
            }
            charge(2 + Math.max(0, entries.length - 1));
            return Object.fromEntries(
              entries.map(([key, item]) => {
                charge(Buffer.byteLength(JSON.stringify(key)) + 1);
                return [key, expand(item, depth + 1)];
              }),
            );
          }
          charge(Buffer.byteLength(JSON.stringify(value)));
          return value;
        }
        return [filename, expand(source.fixture, 0)];
      } catch (error) {
        throw new Error(`${filename}: ${error.message}`, { cause: error });
      }
    }),
  );
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length) throw new Error(`shared.json: unused values: ${unused.join(', ')}`);
  return fixtures;
}

module.exports = { materializeSources };
