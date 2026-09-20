'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  canonical,
  parseMessage,
  digest,
  sha256,
  domainDigest,
} = require('../../src/threadloop/codec');
const { pin, profiles, loadCorpus, buildRequest } = require('../../src/threadloop/corpus');
const { validateResponse, runCase, runThreadLoop } = require('../../src/threadloop/runner');
const { defaults } = require('../../src/threadloop/process');

const checkout = process.env.THREADLOOP_CHECKOUT;
if (!checkout)
  throw new Error('Set THREADLOOP_CHECKOUT to the pinned checkout; see threadloop/README.md');
const corpus = loadCorpus(checkout);
const subjectPath = path.resolve(__dirname, '../fixtures/threadloop-subject.js');
const subject = {
  name: 'synthetic-threadloop',
  version: '0.1',
  revision: 'test-double',
  artifact_digest: sha256(fs.readFileSync(subjectPath)),
};
const command = (mode) => [process.execPath, subjectPath, checkout, mode];
const byId = (id) => corpus.fixtures.find((item) => item.id === id);
const run = (mode) =>
  runThreadLoop({ checkout, command: command(mode), subject, subjectKind: 'synthetic' });
function response(request, result) {
  const payload = {
    ...profiles,
    schema: 'threadloop.conformance-response/0.1',
    request_digest: request.request_digest,
    subject,
    result,
  };
  return { response: payload, response_digest: digest(payload) };
}

test('pinned corpus loads and requests match independently published golden bytes', () => {
  assert.equal(corpus.fixtures.length, 38);
  const vectorsRoot = path.join(checkout, 'docs/contracts/controller-conformance-v0.1/vectors');
  const golden = JSON.parse(fs.readFileSync(path.join(vectorsRoot, 'golden.json')));
  for (const vector of golden.vectors) {
    assert.equal(canonical(vector.value), vector.canonical);
    assert.equal(digest(vector.value), vector.digest);
  }
  const published = parseMessage(fs.readFileSync(path.join(vectorsRoot, 'request.canonical')));
  assert.deepEqual(buildRequest(corpus, byId(published.request.case_id)), published);
  assert.equal(published.request_digest, golden.request_digest);
  assert.equal(
    domainDigest(byId('case_001').expected.compiled_graph.graph),
    golden.legacy_graph_digest,
  );
  assert.equal(
    parseMessage(fs.readFileSync(path.join(vectorsRoot, 'response.canonical'))).response_digest,
    golden.response_digest,
  );
  for (const fixture of corpus.fixtures) {
    const request = buildRequest(corpus, fixture).request;
    assert.deepEqual(Object.keys(request).sort(), [
      'canonicalization',
      'case_id',
      'corpus_digest',
      'digest_profile',
      'fixture_schema',
      'input',
      'input_digest',
      'operation',
      'protocol',
      'schema',
    ]);
    assert.deepEqual(request.input, fixture.input);
  }
});

test('synthetic process exercises all operations and six outcomes without controller claims', async () => {
  const packet = await run('conforming');
  assert.equal(
    packet.conformance.passed,
    38,
    JSON.stringify(packet.conformance.cases.filter((item) => item.status !== 'passed')),
  );
  assert.equal(packet.conformance.failed, 0);
  assert.equal(packet.subject_kind, 'synthetic');
  assert.equal(packet.source.revision, pin.revision);
  assert.equal(packet.source.corpus_digest, pin.corpus_digest);
  assert.equal(packet.runner.shell, false);
  assert.equal(
    new Set(
      packet.conformance.cases
        .filter((item) => item.actual.status === 'decision')
        .map((item) => item.actual.decision.decision.outcome),
    ).size,
    6,
  );
  assert.match(packet.claim_boundary.proves, /Synthetic/);
  for (const result of packet.conformance.cases)
    assert.match(result.response_digest, /^[0-9a-f]{64}$/);
});

test('valid alternate prose and optional LF remain conforming', async () => {
  for (const [mode, id] of [
    ['prose', 'case_024'],
    ['lf', 'case_001'],
  ]) {
    const result = await runCase(corpus, byId(id), command(mode), subject, defaults);
    assert.equal(result.status, 'passed', JSON.stringify(result));
  }
});

for (const mode of [
  'wrong-request',
  'wrong-subject',
  'nested-digest',
  'unknown-version',
  'extra-field',
  'omitted-result',
  'missing',
  'invalid-utf8',
  'extra-document',
  'duplicate-key',
  'truncated',
  'bom',
  'crlf',
  'wrong-digest',
]) {
  test(`process response rejects ${mode}`, async () => {
    const result = await runCase(corpus, byId('case_001'), command(mode), subject, defaults);
    assert.equal(result.status, 'protocol_error', JSON.stringify(result));
    assert.equal(result.response_digest, null);
  });
}
for (const mode of ['nonzero', 'timeout', 'stdout-overflow', 'stderr-overflow']) {
  test(`transport failure stays distinct: ${mode}`, async () => {
    const result = await runCase(corpus, byId('case_001'), command(mode), subject, {
      ...defaults,
      timeout_ms: 1000,
    });
    assert.equal(result.status, 'transport_error', JSON.stringify(result));
    assert.equal(result.response_digest, null);
  });
}
for (const [mode, ids] of [
  ['untrusted-receipt', ['case_033']],
  ['fenced-claim', ['case_032']],
  ['arbitrary-remedy', ['case_024']],
  ['revive-proof', ['case_026', 'case_027']],
  ['overwrite-conflict', ['case_035']],
  ['no-human-authority', ['case_009']],
]) {
  test(`frozen cases kill mutant: ${mode}`, async () => {
    for (const id of ids) {
      const result = await runCase(corpus, byId(id), command(mode), subject, defaults);
      assert.equal(result.status, 'nonconforming', JSON.stringify(result));
    }
  });
}

test('each independently versioned response field fails closed even with a new outer digest', () => {
  const request = buildRequest(corpus, byId('case_001'));
  for (const key of [
    'protocol',
    'schema',
    'fixture_schema',
    'canonicalization',
    'digest_profile',
  ]) {
    const changed = response(request, byId('case_001').expected);
    changed.response[key] = 'unsupported/99';
    changed.response_digest = digest(changed.response);
    assert.throws(
      () => validateResponse(corpus, request, Buffer.from(canonical(changed)), subject),
      /schema/,
    );
  }
});

test('rehashed nested decision and action digests do not bypass independent checks', () => {
  const fixture = byId('case_004');
  const request = buildRequest(corpus, fixture);
  for (const mutation of ['decision', 'action', 'idempotency', 'input']) {
    const result = structuredClone(fixture.expected);
    const decision = result.decision.decision;
    if (mutation === 'decision') result.decision.decision_digest = '0'.repeat(64);
    if (mutation === 'action') decision.action_request.request_digest = '0'.repeat(64);
    if (mutation === 'idempotency') {
      decision.action_request.request.idempotency_key = '0'.repeat(64);
      decision.action_request.request_digest = domainDigest(decision.action_request.request);
    }
    if (mutation === 'input') decision.input_digest = '0'.repeat(64);
    if (mutation !== 'decision') result.decision.decision_digest = domainDigest(decision);
    assert.throws(
      () =>
        validateResponse(
          corpus,
          request,
          Buffer.from(canonical(response(request, result))),
          subject,
        ),
      /digest|idempotency/,
    );
  }
});

function copyCorpus(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-invariant-threadloop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.cpSync(path.join(checkout, 'docs/contracts'), path.join(root, 'docs/contracts'), {
    recursive: true,
  });
  return root;
}
for (const mutation of [
  'input',
  'expectation',
  'metadata',
  'missing',
  'unlisted',
  'duplicate',
  'escaped-path',
  'membership',
  'schema',
  'schema-link',
  'compatibility',
  'fixture-duplicate-key',
  'version',
  'rehashed-expectation',
]) {
  test(`corpus ${mutation} fails before any subject process starts`, async (t) => {
    const root = copyCorpus(t);
    const directory = path.join(root, 'docs/contracts/controller-conformance-v0.1');
    const fixturePath = path.join(directory, 'fixtures/case_001.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath));
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    if (mutation === 'input') fixture.input.profile.id = 'changed';
    if (mutation === 'expectation') fixture.expected.compiled_graph.graph_digest = '0'.repeat(64);
    if (mutation === 'metadata') fixture.title += ' changed';
    if (['input', 'expectation', 'metadata'].includes(mutation))
      fs.writeFileSync(fixturePath, JSON.stringify(fixture));
    if (mutation === 'rehashed-expectation') {
      fixture.expected.compiled_graph.graph_digest = '0'.repeat(64);
      fs.writeFileSync(fixturePath, JSON.stringify(fixture));
      manifest.manifest.entries[0].fixture_digest = digest(fixture);
      manifest.corpus_digest = digest(manifest.manifest);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    if (mutation === 'missing') fs.unlinkSync(fixturePath);
    if (mutation === 'unlisted')
      fs.writeFileSync(path.join(directory, 'fixtures/case_999.json'), '{}');
    if (mutation === 'fixture-duplicate-key')
      fs.writeFileSync(fixturePath, '{"title":"duplicate",' + JSON.stringify(fixture).slice(1));
    if (mutation === 'duplicate')
      manifest.manifest.entries.push(structuredClone(manifest.manifest.entries[0]));
    if (mutation === 'escaped-path') manifest.manifest.entries[0].path = '../case_001.json';
    if (mutation === 'membership') manifest.manifest.entries.pop();
    if (mutation === 'version') manifest.manifest.protocol = 'unsupported/99';
    if (['duplicate', 'escaped-path', 'membership', 'version'].includes(mutation)) {
      manifest.corpus_digest = digest(manifest.manifest);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    if (mutation === 'schema')
      fs.appendFileSync(path.join(directory, 'schemas/request.schema.json'), ' ');
    if (mutation === 'schema-link') {
      const source = path.join(directory, 'schemas/request.schema.json');
      const target = path.join(root, 'request.json');
      fs.renameSync(source, target);
      fs.symlinkSync(target, source);
    }
    if (mutation === 'compatibility')
      fs.appendFileSync(
        path.join(root, 'docs/contracts/controller-v0.1/schemas/action-request.schema.json'),
        ' ',
      );
    const sentinel = path.join(root, 'subject-started');
    await assert.rejects(
      runThreadLoop({
        checkout: root,
        command: [
          process.execPath,
          '-e',
          'require("fs").writeFileSync(process.argv[1],"started")',
          sentinel,
        ],
        subject,
        subjectKind: 'synthetic',
      }),
    );
    assert.equal(fs.existsSync(sentinel), false);
  });
}

test('CLI emits a separate packet and rejects unsupported or incomplete configuration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-invariant-cli-threadloop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = path.join(root, 'identity.json');
  fs.writeFileSync(identity, JSON.stringify(subject));
  const cli = path.resolve(__dirname, '../../bin/run-invariant.js');
  const args = [
    'threadloop',
    '--checkout',
    checkout,
    '--subject',
    identity,
    '--subject-kind',
    'synthetic',
    '--json',
  ];
  const result = spawnSync(process.execPath, [cli, ...args, '--', ...command('conforming')], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).conformance.passed, 38);
  assert.match(result.stderr, /case_038: passed/);
  const nonconforming = spawnSync(
    process.execPath,
    [cli, ...args, '--', ...command('untrusted-receipt')],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(nonconforming.status, 1, nonconforming.stderr);
  const packet = JSON.parse(nonconforming.stdout);
  assert.equal(packet.conformance.nonconforming, 1);
  assert.equal(packet.conformance.failed, 1);
  assert.equal(packet.conformance.passed, 37);
  assert.equal(packet.conformance.transport_error, 0);
  assert.equal(packet.conformance.protocol_error, 0);

  for (const invalid of [
    ['threadloop'],
    [...args, '--unknown'],
    [...args, '--timeout-ms', '0'],
    [...args, '--subject-kind', 'controller'],
  ]) {
    const failed = spawnSync(process.execPath, [cli, ...invalid, '--', ...command('conforming')], {
      encoding: 'utf8',
    });
    assert.equal(failed.status, 2, failed.stderr);
    assert.match(failed.stderr, /Recovery:/);
  }
});

test('CI and the acquisition guide use the exact reviewed corpus revision', () => {
  for (const file of ['.github/workflows/ci.yml', 'threadloop/README.md']) {
    assert.ok(
      fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8').includes(pin.revision),
      file,
    );
  }
});

test('wrong operation result and missing execution steps are protocol errors', () => {
  const request = buildRequest(corpus, byId('case_004'));
  const wrong = response(request, byId('case_001').expected);
  assert.throws(
    () => validateResponse(corpus, request, Buffer.from(canonical(wrong)), subject),
    /kind mismatch/,
  );
  const executionRequest = buildRequest(corpus, byId('case_029'));
  const incomplete = structuredClone(byId('case_029').expected);
  incomplete.steps.pop();
  assert.throws(
    () =>
      validateResponse(
        corpus,
        executionRequest,
        Buffer.from(canonical(response(executionRequest, incomplete))),
        subject,
      ),
    /omits trace steps/,
  );
});

test('underflowed corpus number fails before launch despite identical JSON.parse digest (7df65ae8)', async (t) => {
  const root = copyCorpus(t);
  const file = path.join(root, 'docs/contracts/controller-conformance-v0.1/fixtures/case_029.json');
  const original = fs.readFileSync(file, 'utf8');
  const altered = original.replace('"expected_revision": 0,', '"expected_revision": 1e-324,');
  assert.notEqual(original, altered);
  assert.deepEqual(JSON.parse(original), JSON.parse(altered));
  fs.writeFileSync(file, altered);
  const sentinel = path.join(root, 'subject-started');
  await assert.rejects(
    runThreadLoop({
      checkout: root,
      command: [
        process.execPath,
        '-e',
        'require("fs").writeFileSync(process.argv[1],"started")',
        sentinel,
      ],
      subject,
      subjectKind: 'synthetic',
    }),
    /integer/,
  );
  assert.equal(fs.existsSync(sentinel), false);
});
