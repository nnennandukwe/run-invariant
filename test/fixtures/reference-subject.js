#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { evaluateCase } = require('../../src/conformance');

const requestText = fs.readFileSync(0, 'utf8');
const request = JSON.parse(requestText);
const mode = process.argv[2] || 'conforming';

if (mode === 'nonzero') {
  process.stderr.write('intentional subject failure\n');
  process.exit(7);
}

const results = request.cases.map(caseDefinition => ({
  id: caseDefinition.id,
  decision: evaluateCase(caseDefinition),
}));

if (mode === 'missing') results.pop();
if (mode === 'duplicate') results.push(results[0]);
if (mode === 'nonconforming') {
  results[0].decision = {
    outcome: 'block',
    code: 'test.intentionally_wrong',
    effects: [],
  };
}

const requestSha256 = `sha256:${crypto
  .createHash('sha256')
  .update(Buffer.from(requestText, 'utf8'))
  .digest('hex')}`;

process.stdout.write(`${JSON.stringify({
  schema_version: 'run-invariant.subject-response/0.1.0',
  request_sha256: mode === 'stale' ? `sha256:${'0'.repeat(64)}` : requestSha256,
  subject: {
    name: 'run-invariant-reference-fixture',
    version: '0.1.0',
    implementation: 'javascript',
  },
  results,
})}\n`);
