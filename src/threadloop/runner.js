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

const reportLimits = Object.freeze({
  case_result_bytes: 64 * 1024,
  total_result_bytes: 2 * 1024 * 1024,
  diagnostic_bytes: 4096,
  identity_bytes: 16 * 1024,
  command_bytes: 64 * 1024,
});

function diagnostic(message) {
  const bytes = Buffer.from(message);
  let text = bytes.subarray(0, reportLimits.diagnostic_bytes).toString('utf8');
  while (Buffer.byteLength(text) > reportLimits.diagnostic_bytes) text = text.slice(0, -1);
  return { diagnostic: text, diagnostic_truncated: bytes.length > reportLimits.diagnostic_bytes };
}

function validateSubject(subject) {
  if (Buffer.byteLength(canonical(subject)) > reportLimits.identity_bytes)
    throw new Error('Subject identity exceeds report limit');
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

async function runCase(
  corpus,
  fixture,
  command,
  subject,
  limits,
  retention = { remaining: reportLimits.total_result_bytes },
) {
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
    return { ...record, status: 'transport_error', ...diagnostic(error.message) };
  }
  record.stdout_sha256 = sha256(output.stdout);
  record.stderr_sha256 = sha256(output.stderr);
  let response;
  try {
    response = validateResponse(corpus, request, output.stdout, subject);
  } catch (error) {
    return { ...record, status: 'protocol_error', ...diagnostic(error.message) };
  }
  record.response_digest = response.response_digest;
  const actual = response.response.result;
  const matches = canonical(machineResult(actual)) === canonical(machineResult(fixture.expected));
  const summary = {
    ...record,
    status: matches ? 'passed' : 'nonconforming',
    result_status: actual.status,
    controller_outcome: actual.status === 'decision' ? actual.decision.decision.outcome : null,
  };
  if (matches) return summary;
  const actualBytes = canonical(actual);
  const expectedBytes = canonical(fixture.expected);
  const size = Buffer.byteLength(actualBytes) + Buffer.byteLength(expectedBytes);
  if (size <= reportLimits.case_result_bytes && size <= retention.remaining) {
    retention.remaining -= size;
    return { ...summary, actual, expected: fixture.expected };
  }
  return {
    ...summary,
    details_omitted:
      'Result details exceed per-case or aggregate report budget; rerun the subject to inspect full output.',
    actual_result_digest: sha256(actualBytes),
    expected_result_digest: sha256(expectedBytes),
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
  if (Buffer.byteLength(canonical(command)) > reportLimits.command_bytes)
    throw new Error('Command exceeds report limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('timeout-ms must be an integer from 1 to 60000');
  const corpus = loadCorpus(checkout); // Complete validation precedes the first effect.
  const limits = { ...defaults, timeout_ms: timeoutMs };
  // Build every request before launch: no later oversized input can start a partial suite.
  for (const fixture of corpus.fixtures) buildRequest(corpus, fixture);
  const cases = [];
  const retention = { remaining: reportLimits.total_result_bytes };
  for (const fixture of corpus.fixtures) {
    const result = await runCase(corpus, fixture, command, subject, limits, retention);
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
      report_limits: reportLimits,
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

module.exports = { reportLimits, validateSubject, validateResponse, runCase, runThreadLoop };
