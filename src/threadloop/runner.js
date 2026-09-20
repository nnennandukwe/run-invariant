'use strict';

const { canonical, parseMessage, digest, sha256 } = require('./codec');
const { defaults, invoke } = require('./process');
const {
  pin,
  profiles,
  responseSchema,
  requireEqual,
  validateDomainResult,
  machineResult,
  loadCorpus,
  buildRequest,
} = require('./corpus');

function validateSubject(subject) {
  canonical(subject);
  if (!subject || Array.isArray(subject) || typeof subject !== 'object')
    throw new Error('Subject identity must be an object');
  requireEqual(
    Object.keys(subject).sort(),
    ['artifact_digest', 'name', 'revision', 'version'],
    'Subject identity fields',
  );
  for (const key of ['name', 'revision', 'version']) {
    if (typeof subject[key] !== 'string' || !/\S/.test(subject[key]))
      throw new Error(`Subject ${key} is required`);
  }
  if (!/^[a-f0-9]{64}$/.test(subject.artifact_digest))
    throw new Error('Subject artifact_digest must be lowercase SHA-256');
}

function validateResponse(corpus, request, bytes, subject) {
  const response = parseMessage(bytes);
  corpus.validate('response', response);
  requireEqual(response.response_digest, digest(response.response), 'Response digest');
  requireEqual(response.response.request_digest, request.request_digest, 'Request correlation');
  requireEqual(response.response.subject, subject, 'Subject identity');
  validateDomainResult(request.request.operation, request.request.input, response.response.result);
  return response;
}

async function runCase(corpus, fixture, command, subject, limits) {
  const request = buildRequest(corpus, fixture);
  const record = {
    id: fixture.id,
    operation: fixture.operation,
    input_digest: request.request.input_digest,
    request_digest: request.request_digest,
    response_digest: null,
    stdout_sha256: null,
    stderr_sha256: null,
  };
  let output;
  try {
    output = await invoke(command, Buffer.from(canonical(request)), limits);
  } catch (error) {
    return { ...record, status: 'transport_error', diagnostic: error.message };
  }
  record.stdout_sha256 = sha256(output.stdout);
  record.stderr_sha256 = sha256(output.stderr);
  let response;
  try {
    response = validateResponse(corpus, request, output.stdout, subject);
  } catch (error) {
    return { ...record, status: 'protocol_error', diagnostic: error.message };
  }
  record.response_digest = response.response_digest;
  const actual = response.response.result;
  const matches = canonical(machineResult(actual)) === canonical(machineResult(fixture.expected));
  return {
    ...record,
    status: matches ? 'passed' : 'nonconforming',
    actual,
    ...(matches ? {} : { expected: fixture.expected }),
  };
}

async function runThreadLoop({
  checkout,
  command,
  subject,
  subjectKind,
  timeoutMs = defaults.timeout_ms,
  onCase = () => {},
}) {
  validateSubject(subject);
  subject = structuredClone(subject);
  command = structuredClone(command);
  if (typeof onCase !== 'function') throw new Error('onCase must be a function');
  if (!['synthetic', 'controller'].includes(subjectKind))
    throw new Error('subject-kind must be synthetic or controller');
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((part) => typeof part !== 'string' || part.includes('\0')) ||
    !command[0].trim()
  ) {
    throw new Error('Command must be an executable and argument array');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('timeout-ms must be an integer from 1 to 60000');
  const corpus = loadCorpus(checkout); // Complete validation precedes the first effect.
  const limits = { ...defaults, timeout_ms: timeoutMs };
  // Build every request before launch: no later oversized input can start a partial suite.
  for (const fixture of corpus.fixtures) buildRequest(corpus, fixture);
  const cases = [];
  for (const fixture of corpus.fixtures) {
    const result = await runCase(corpus, fixture, command, subject, limits);
    cases.push(result);
    onCase({ id: result.id, status: result.status });
  }
  const counts = Object.fromEntries(
    ['passed', 'nonconforming', 'protocol_error', 'transport_error'].map((status) => [
      status,
      cases.filter((item) => item.status === status).length,
    ]),
  );
  return {
    schema: 'run-invariant.threadloop-packet/0.1',
    source: pin,
    contract: {
      ...profiles,
      request_schema: 'threadloop.conformance-request/0.1',
      response_schema: responseSchema,
      manifest_schema: corpus.manifest.manifest.schema,
      compatibility_schema: corpus.compatibility.schema,
      compatibility_digest: corpus.manifest.manifest.compatibility_digest,
    },
    subject: structuredClone(subject),
    subject_kind: subjectKind,
    runner: {
      command: [...command],
      limits,
      shell: false,
      process_cleanup:
        process.platform === 'win32' ? 'direct-child-SIGKILL' : 'POSIX-process-group-SIGKILL',
    },
    conformance: { total: cases.length, ...counts, failed: cases.length - counts.passed, cases },
    claim_boundary: {
      proves:
        subjectKind === 'synthetic'
          ? 'Synthetic process and checker behavior on the pinned corpus only.'
          : 'The declared controller subject matched only the passing frozen cases.',
      does_not_prove: [
        'Authenticated artifact identity',
        'Runtime integration',
        'Persistence or crash recovery',
        'Sandbox isolation',
        'Production safety',
        'Certification, deployment or adoption',
      ],
    },
  };
}

module.exports = { validateSubject, validateResponse, runCase, runThreadLoop };
