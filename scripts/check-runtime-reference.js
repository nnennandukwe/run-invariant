'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../src/runtime/codec');
const { same } = require('../src/runtime/contracts');
try {
  const checkout = process.argv[2];
  if (process.argv.length !== 3)
    throw new Error(
      'Usage: node scripts/check-runtime-reference.js <GAAP checkout>',
    );
  const reference = require('../runtime/reference.json');
  if (!/^[0-9a-f]{40}$/.test(reference.revision))
    throw new Error('REFERENCE: expected an immutable commit');
  same(
    execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    reference.revision,
    'GAAP reference commit',
  );
  for (const name of [
    'agent-run-request',
    'terminal-run-receipt',
    'protected-effect-request',
    'protected-effect-result',
  ]) {
    const family = name.startsWith('protected-')
      ? 'protected-effect'
      : 'agent-run';
    same(
      hash(
        fs.readFileSync(
          path.join(
            checkout,
            'schemas',
            family,
            'v0.1.0',
            name + '.schema.json',
          ),
        ),
      ),
      hash(
        fs.readFileSync(
          path.join(__dirname, '../runtime/contracts', name + '.schema.json'),
        ),
      ),
      'pinned ' + name + ' schema',
    );
  }
  process.stdout.write('GAAP reference commit and contract schemas: MATCH\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
