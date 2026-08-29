'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const cliPath = path.join(root, 'bin', 'run-invariant.js');

test('--check reports a reproducible frozen protocol result', () => {
  const result = spawnSync(process.execPath, [cliPath, '--check'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /RunInvariant protocol 0\.1\.0 \(frozen legacy baseline\)/,
  );
  assert.match(result.stdout, /Reference conformance: \d+\/\d+ cases/);
  assert.match(result.stdout, /Mutation score: 5\/5 mutants killed/);
  assert.match(result.stdout, /Evidence check: MATCH/);
  assert.match(
    result.stdout,
    /Evidence path: evidence\/conformance-v0\.1\.0\.json/,
  );
  assert.match(result.stdout, /does not measure real-agent outcomes/i);
});

test('--json returns only the machine-readable evidence packet', () => {
  const result = spawnSync(process.execPath, [cliPath, '--json'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.protocol.version, '0.1.0');
  assert.equal(packet.reference.failed, 0);
  assert.equal(packet.mutation_analysis.killed, 5);
});

test('--help exposes only standalone conformance modes', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: run-invariant <mode>/);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--write/);
  assert.match(result.stdout, /--json/);
  assert.doesNotMatch(result.stdout, /experiment/i);
});

test('--check explains recovery when committed evidence is missing', t => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'run-invariant-cli-test-'),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const temporaryRunInvariant = path.join(temporaryRoot, 'run-invariant');
  fs.cpSync(root, temporaryRunInvariant, { recursive: true });
  fs.rmSync(
    path.join(
      temporaryRunInvariant,
      'evidence',
      'conformance-v0.1.0.json',
    ),
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(temporaryRunInvariant, 'bin', 'run-invariant.js'),
      '--check',
    ],
    {
      cwd: temporaryRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Evidence check: MISMATCH/);
  assert.match(
    result.stdout,
    /Evidence path: evidence\/conformance-v0\.1\.0\.json/,
  );
  assert.match(result.stderr, /npm run evidence:update/);
});

test('--write refuses to bless a nonconforming packet', t => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'run-invariant-cli-test-'),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const temporaryRunInvariant = path.join(temporaryRoot, 'run-invariant');
  fs.cpSync(root, temporaryRunInvariant, { recursive: true });

  const temporaryFixturesPath = path.join(
    temporaryRunInvariant,
    'fixtures',
    'cases.v0.1.0.json',
  );
  const temporaryEvidencePath = path.join(
    temporaryRunInvariant,
    'evidence',
    'conformance-v0.1.0.json',
  );
  const fixtureDocument = JSON.parse(
    fs.readFileSync(temporaryFixturesPath, 'utf8'),
  );
  fixtureDocument.cases[0].expected = {
    outcome: 'block',
    code: 'test.intentionally_wrong',
    effects: [],
  };
  fs.writeFileSync(
    temporaryFixturesPath,
    `${JSON.stringify(fixtureDocument, null, 2)}\n`,
  );
  const evidenceBefore = fs.readFileSync(temporaryEvidencePath, 'utf8');

  const result = spawnSync(
    process.execPath,
    [
      path.join(temporaryRunInvariant, 'bin', 'run-invariant.js'),
      '--write',
    ],
    {
      cwd: temporaryRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Evidence check: NOT WRITTEN/);
  assert.match(result.stderr, /Conformance failed/);
  assert.equal(
    fs.readFileSync(temporaryEvidencePath, 'utf8'),
    evidenceBefore,
  );
});
