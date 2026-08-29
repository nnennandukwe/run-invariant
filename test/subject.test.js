'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildSubjectRequest,
  runSubject,
} = require('../src/subject');

const root = path.resolve(__dirname, '..');
const protocolBytes = fs.readFileSync(
  path.join(root, 'protocol', 'v0.1.0.json'),
);
const fixtureBytes = fs.readFileSync(
  path.join(root, 'fixtures', 'cases.v0.1.0.json'),
);
const protocol = JSON.parse(protocolBytes);
const fixtures = JSON.parse(fixtureBytes);
const subjectPath = path.join(
  root,
  'test',
  'fixtures',
  'reference-subject.js',
);

function run(mode = 'conforming') {
  return runSubject({
    command: [process.execPath, subjectPath, mode],
    protocol,
    fixtures,
    protocolBytes,
    fixtureBytes,
  });
}

test('subject requests never disclose expected decisions or case titles', () => {
  const request = buildSubjectRequest({
    protocol,
    fixtures,
    protocolBytes,
    fixtureBytes,
  });

  assert.equal(request.schema_version, 'run-invariant.subject-request/0.1.0');
  assert.equal(request.cases.length, 35);
  for (const caseDefinition of request.cases) {
    assert.deepEqual(Object.keys(caseDefinition), ['id', 'gate', 'input']);
    assert.equal('expected' in caseDefinition, false);
    assert.equal('title' in caseDefinition, false);
  }
});

test('a black-box subject can conform to every frozen case', () => {
  const packet = run();

  assert.equal(packet.contract.version, '0.1.0');
  assert.equal(packet.subject.implementation, 'javascript');
  assert.equal(packet.conformance.total, 35);
  assert.equal(packet.conformance.passed, 35);
  assert.equal(packet.conformance.failed, 0);
});

test('a response must bind to the exact request bytes', () => {
  assert.throws(
    () => run('stale'),
    /request_sha256 does not bind to this request/,
  );
});

test('a response must contain every requested case exactly once', () => {
  assert.throws(() => run('missing'), /missing result ids/);
  assert.throws(() => run('duplicate'), /duplicate result id/);
});

test('subject process failures retain status and stderr diagnostics', () => {
  assert.throws(
    () => run('nonzero'),
    /exited with status 7: intentional subject failure/,
  );
});

test('subject protocol schemas are valid JSON with fixed versions', () => {
  const requestSchema = JSON.parse(fs.readFileSync(
    path.join(root, 'subject-protocol', 'v0.1.0', 'request.schema.json'),
    'utf8',
  ));
  const responseSchema = JSON.parse(fs.readFileSync(
    path.join(root, 'subject-protocol', 'v0.1.0', 'response.schema.json'),
    'utf8',
  ));

  assert.equal(
    requestSchema.properties.schema_version.const,
    'run-invariant.subject-request/0.1.0',
  );
  assert.equal(
    responseSchema.properties.schema_version.const,
    'run-invariant.subject-response/0.1.0',
  );
});
