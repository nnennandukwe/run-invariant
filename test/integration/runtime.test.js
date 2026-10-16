'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { run, loadCorpus } = require('../../src/runtime/runner');
const { invoke } = require('../../src/runtime/process');
const binary = process.env.GAAP_BINARY;
assert.ok(
  binary,
  'Set GAAP_BINARY to the built pinned GAAP executable before running runtime integration tests.',
);
const proxy = path.join(__dirname, '../fixtures/runtime-proxy.js');
const { corpus } = loadCorpus();
test(
  'GAAP runtime passes all frozen cases through an opaque process',
  { skip: !binary },
  async () => {
    const packet = await run([binary, 'runtime-subject']);
    assert.equal(
      packet.conformance.failed,
      0,
      JSON.stringify(packet.conformance.cases.filter((item) => !item.passed)),
    );
    assert.equal(packet.conformance.passed, 25);
    assert.match(packet.subject.executable_sha256, /^sha256:[0-9a-f]{64}$/);
  },
);
test(
  'transparent proxy reproduces valid wire bindings',
  { skip: !binary },
  async () => {
    await invoke(
      [process.execPath, proxy, 'baseline', binary],
      corpus.cases[0],
    );
  },
);
const mutants = [
  ['ask-is-allow', 1],
  ['block-is-allow', 2],
  ['ignore-schema-pin', 3],
  ['wrong-request', 0],
  ['wrong-subject', 0],
  ['missing-result', 0],
  ['reordered-results', 10],
  ['fabricated-success', 1],
  ['stale-completion', 4],
  ['unknown-becomes-failure', 8],
  ['missing-executor-evidence', 0],
  ['body-tamper', 0],
  ['alter-usage', 0],
  ['forge-verifier-evidence', 0],
  ['wrong-executor', 0],
  ['omit-authorization', 0],
  ['forged-capability', 0],
  ['invented-exit', 0],
  ['invented-reason', 0],
  ['wrong-decision-subject', 0],
  ['verification-before-mutation', 0],
  ['wrong-transcript', 0],
  ['work-after-terminal', 0],
];
for (const [mutant, index] of mutants)
  test(
    'kills unsafe runtime mutant: ' + mutant,
    { skip: !binary },
    async () => {
      await assert.rejects(
        invoke([process.execPath, proxy, mutant, binary], corpus.cases[index]),
        /BINDING|TRANSCRIPT|EVIDENCE|TERMINAL|AUTHORITY|VERIFICATION/,
      );
    },
  );
