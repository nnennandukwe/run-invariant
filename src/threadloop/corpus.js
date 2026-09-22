'use strict';

const fs = require('node:fs');
const { readArtifact, verifyInventory } = require('./files');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { materializeSources } = require('./sources');
const pin = require('../../threadloop/pin.json');
const { canonical, parseJson, sha256, digest, domainDigest } = require('./codec');

const profiles = Object.freeze({
  protocol: 'threadloop.controller-conformance/0.1',
  fixture_schema: 'threadloop.conformance-fixture/0.1',
  canonicalization: 'threadloop.conformance-json/0.1',
  digest_profile: 'threadloop.conformance-sha256/0.1',
});
const requestSchema = 'threadloop.conformance-request/0.1';
const responseSchema = 'threadloop.conformance-response/0.1';
const relativeRoot = 'docs/contracts/controller-conformance-v0.1';

function requireEqual(actual, expected, label) {
  if (canonical(actual) !== canonical(expected))
    throw new Error(`${label}: identity or content mismatch`);
}

function validateDomainResult(operation, input, result) {
  const kinds = {
    compile_graph: ['compiled', 'invalid'],
    decide: ['decision', 'invalid'],
    execution_scenario: ['execution', 'invalid'],
  };
  if (!kinds[operation]?.includes(result.status))
    throw new Error('Operation/result kind mismatch');
  function envelope(value, payload, hash) {
    requireEqual(value[hash], domainDigest(value[payload]), `Embedded ${hash}`);
  }
  function action(value, binding) {
    requireEqual(value.request.binding, binding, 'Action binding');
    envelope(value, 'request', 'request_digest');
    const request = value.request;
    requireEqual(
      request.idempotency_key,
      domainDigest({
        schema_version: '0.1',
        binding: request.binding,
        action_id: request.action_id,
      }),
      'Action idempotency key',
    );
  }
  if (result.status === 'compiled') envelope(result.compiled_graph, 'graph', 'graph_digest');
  if (result.status === 'decision') {
    envelope(result.decision, 'decision', 'decision_digest');
    const decision = result.decision.decision;
    requireEqual(decision.input_digest, domainDigest(input), 'Decision input digest');
    requireEqual(decision.binding, input.binding, 'Decision binding');
    if (decision.action_request) action(decision.action_request, decision.binding);
    if (decision.outcome === 'blocked') {
      for (const reason of decision.reasons)
        if (reason.code === 'IDEMPOTENCY_CONFLICT') action(reason.request, decision.binding);
    }
  }
  if (result.status === 'execution') {
    if (result.steps.length !== input.steps.length)
      throw new Error('Execution result omits trace steps');
    const execution = result.projection.controller.execution;
    if (execution.request) action(execution.request, input.initial.request.request.binding);
  }
}

function machineResult(result) {
  if (result.status !== 'decision' || result.decision.decision.outcome !== 'blocked')
    return result;
  const decision = structuredClone(result.decision.decision);
  decision.reasons = decision.reasons.map(({ message, recovery, ...machine }) => machine);
  return { status: result.status, decision };
}

function loadCorpus(checkout) {
  const root = path.resolve(checkout);
  if (!fs.lstatSync(root).isDirectory())
    throw new Error('ThreadLoop checkout must be a real directory');
  const read = (relative) => {
    try {
      return parseJson(readArtifact(root, relative));
    } catch (error) {
      throw new Error(`${relative}: ${error.message}`, { cause: error });
    }
  };
  const ajv = new Ajv2020({ strict: true, strictTypes: false, validateFormats: true });
  addFormats(ajv);
  const validators = {};
  const schemaDirectory = path.join(root, relativeRoot, 'schemas');
  // Reading each pinned path also rejects symlinks in every ancestor below root.
  for (const [filename, expected] of Object.entries(pin.schemas)) {
    const bytes = readArtifact(root, `${relativeRoot}/schemas/${filename}`);
    requireEqual(sha256(bytes), expected, `Schema ${filename}`);
    validators[filename.replace('.schema.json', '')] = ajv.compile(parseJson(bytes));
  }
  verifyInventory(schemaDirectory, Object.keys(pin.schemas));
  function validate(name, value) {
    canonical(value);
    const validator = validators[name];
    if (!validator(value))
      throw new Error(`${name} schema: ${ajv.errorsText(validator.errors)}`);
  }
  const manifest = read(`${relativeRoot}/manifest.json`);
  validate('manifest', manifest);
  requireEqual(manifest.corpus_digest, pin.corpus_digest, 'Pinned corpus');
  requireEqual(digest(manifest.manifest), pin.corpus_digest, 'Manifest digest');
  const compatibility = read(`${relativeRoot}/compatibility.json`);
  validate('compatibility', compatibility);
  requireEqual(
    digest(compatibility),
    manifest.manifest.compatibility_digest,
    'Compatibility digest',
  );
  requireEqual(
    compatibility.contracts.map((contract) => contract.name).sort(),
    ['controller', 'execution', 'executor', 'workflow-graph'],
    'Compatibility inventory',
  );
  for (const contract of compatibility.contracts) {
    const directory = `docs/contracts/${contract.name}-v${contract.version}/schemas`;
    for (const schema of contract.schemas) {
      requireEqual(
        sha256(readArtifact(root, `${directory}/${schema.path}`)),
        schema.sha256,
        `${directory}/${schema.path}`,
      );
    }
    verifyInventory(
      path.join(root, directory),
      contract.schemas.map((schema) => schema.path),
    );
  }
  const entries = manifest.manifest.entries;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (
      entry.path !== `fixtures/${entry.id}.json` ||
      (index && entries[index - 1].id >= entry.id)
    ) {
      throw new Error('Manifest identities must be sorted, unique and match paths');
    }
  }
  verifyInventory(
    path.join(root, relativeRoot, 'fixtures'),
    entries.map((entry) => `${entry.id}.json`),
  );
  let sourceBytes = 0;
  for (const relative of ['shared.json', ...entries.map((entry) => entry.path)]) {
    const metadata = fs.lstatSync(path.join(root, relativeRoot, relative));
    if (!metadata.isFile()) throw new Error(`${relative}: expected regular file`);
    sourceBytes += metadata.size;
    if (sourceBytes > 2 * 1024 * 1024)
      throw new Error('Corpus source-byte limit exceeded (2 MiB)');
  }
  const shared = read(`${relativeRoot}/shared.json`);
  validate('shared', shared);
  const sources = Object.fromEntries(
    entries.map((entry) => {
      const source = read(`${relativeRoot}/${entry.path}`);
      validate('source', source);
      return [entry.path, source];
    }),
  );
  const expanded = materializeSources(sources, shared.values);
  const fixtures = entries.map((entry) => {
    const fixture = expanded[entry.path];
    validate('fixture', fixture);
    requireEqual(
      [fixture.id, fixture.operation, digest(fixture.input), digest(fixture)],
      [entry.id, entry.operation, entry.input_digest, entry.fixture_digest],
      entry.path,
    );
    if (fixture.operation === 'execution_scenario')
      validate('execution-scenario', fixture.input);
    validateDomainResult(fixture.operation, fixture.input, fixture.expected);
    return fixture;
  });
  return { manifest, fixtures, compatibility, validate };
}

function buildRequest(corpus, fixture) {
  const entry = corpus.manifest.manifest.entries.find((item) => item.id === fixture.id);
  if (!entry || entry.fixture_digest !== digest(fixture))
    throw new Error('Fixture binding mismatch');
  const request = {
    ...profiles,
    schema: requestSchema,
    corpus_digest: corpus.manifest.corpus_digest,
    case_id: fixture.id,
    operation: fixture.operation,
    input: structuredClone(fixture.input),
    input_digest: entry.input_digest,
  };
  const envelope = { request, request_digest: digest(request) };
  corpus.validate('request', envelope);
  return envelope;
}

module.exports = {
  pin,
  profiles,
  responseSchema,
  readArtifact,
  requireEqual,
  validateDomainResult,
  machineResult,
  loadCorpus,
  buildRequest,
};
