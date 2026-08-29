'use strict';

const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const { canonicalJson, sha256 } = require('./report');

const CONTRACT_VERSION = '0.1.0';
const REQUEST_SCHEMA_VERSION = 'run-invariant.subject-request/0.1.0';
const RESPONSE_SCHEMA_VERSION = 'run-invariant.subject-response/0.1.0';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OUTCOMES = new Set(['allow', 'ask', 'block']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (!isDeepStrictEqual(actual, required)) {
    throw new Error(
      `${label} must contain exactly: ${required.join(', ')}`,
    );
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function buildSubjectRequest({
  protocol,
  fixtures,
  protocolBytes,
  fixtureBytes,
}) {
  return {
    schema_version: REQUEST_SCHEMA_VERSION,
    protocol: {
      version: protocol.version,
      sha256: sha256(protocolBytes),
    },
    fixtures: {
      sha256: sha256(fixtureBytes),
    },
    cases: fixtures.cases.map(caseDefinition => ({
      id: caseDefinition.id,
      gate: caseDefinition.gate,
      input: caseDefinition.input,
    })),
  };
}

function validateDecision(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  assertExactKeys(value, ['outcome', 'code', 'effects'], label);
  if (!OUTCOMES.has(value.outcome)) {
    throw new Error(`${label}.outcome must be allow, ask, or block`);
  }
  assertNonEmptyString(value.code, `${label}.code`);
  if (
    !Array.isArray(value.effects)
    || !value.effects.every(effect => typeof effect === 'string')
  ) {
    throw new Error(`${label}.effects must be an array of strings`);
  }
}

function validateResponse(response, request, requestSha256) {
  if (!isObject(response)) throw new Error('response must be an object');
  assertExactKeys(
    response,
    ['schema_version', 'request_sha256', 'subject', 'results'],
    'response',
  );
  if (response.schema_version !== RESPONSE_SCHEMA_VERSION) {
    throw new Error(
      `response.schema_version must be ${RESPONSE_SCHEMA_VERSION}`,
    );
  }
  if (response.request_sha256 !== requestSha256) {
    throw new Error('response.request_sha256 does not bind to this request');
  }

  if (!isObject(response.subject)) {
    throw new Error('response.subject must be an object');
  }
  assertExactKeys(
    response.subject,
    ['name', 'version', 'implementation'],
    'response.subject',
  );
  for (const field of ['name', 'version', 'implementation']) {
    assertNonEmptyString(response.subject[field], `response.subject.${field}`);
  }

  if (!Array.isArray(response.results)) {
    throw new Error('response.results must be an array');
  }

  const requestedIds = new Set(request.cases.map(item => item.id));
  const resultIds = new Set();
  for (const [index, result] of response.results.entries()) {
    const label = `response.results[${index}]`;
    if (!isObject(result)) throw new Error(`${label} must be an object`);
    assertExactKeys(result, ['id', 'decision'], label);
    assertNonEmptyString(result.id, `${label}.id`);
    if (!requestedIds.has(result.id)) {
      throw new Error(`${label}.id is not present in the request: ${result.id}`);
    }
    if (resultIds.has(result.id)) {
      throw new Error(`response contains duplicate result id: ${result.id}`);
    }
    resultIds.add(result.id);
    validateDecision(result.decision, `${label}.decision`);
  }

  const missing = request.cases
    .map(item => item.id)
    .filter(id => !resultIds.has(id));
  if (missing.length > 0) {
    throw new Error(`response is missing result ids: ${missing.join(', ')}`);
  }
}

function summarizeCases(fixtures, response) {
  const actualById = new Map(
    response.results.map(result => [result.id, result.decision]),
  );
  const cases = fixtures.cases.map(caseDefinition => {
    const actual = actualById.get(caseDefinition.id);
    return {
      id: caseDefinition.id,
      gate: caseDefinition.gate,
      title: caseDefinition.title,
      passed: isDeepStrictEqual(actual, caseDefinition.expected),
      expected: caseDefinition.expected,
      actual,
    };
  });

  const byGate = {};
  for (const caseResult of cases) {
    if (!byGate[caseResult.gate]) {
      byGate[caseResult.gate] = { total: 0, passed: 0, failed: 0 };
    }
    byGate[caseResult.gate].total += 1;
    if (caseResult.passed) byGate[caseResult.gate].passed += 1;
    else byGate[caseResult.gate].failed += 1;
  }

  const passed = cases.filter(result => result.passed).length;
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    conformance_rate: cases.length === 0 ? 0 : passed / cases.length,
    by_gate: byGate,
    cases,
  };
}

function invokeSubject(command, requestBytes, timeoutMs) {
  if (
    !Array.isArray(command)
    || command.length === 0
    || !command.every(part => typeof part === 'string')
    || command[0].trim().length === 0
  ) {
    throw new TypeError('command must be a non-empty array of strings');
  }

  const result = spawnSync(command[0], command.slice(1), {
    input: requestBytes,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`subject exceeded the ${timeoutMs}ms timeout`);
    }
    throw new Error(`subject could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `subject exited with status ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `subject stdout must be one JSON document: ${error.message}`,
    );
  }
}

function runSubject({
  command,
  protocol,
  fixtures,
  protocolBytes,
  fixtureBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const request = buildSubjectRequest({
    protocol,
    fixtures,
    protocolBytes,
    fixtureBytes,
  });
  const requestBytes = Buffer.from(canonicalJson(request), 'utf8');
  const requestSha256 = sha256(requestBytes);
  const response = invokeSubject(command, requestBytes, timeoutMs);
  validateResponse(response, request, requestSha256);
  const conformance = summarizeCases(fixtures, response);

  return {
    suite: 'RunInvariant external subject conformance',
    contract: {
      version: CONTRACT_VERSION,
      request_schema: REQUEST_SCHEMA_VERSION,
      response_schema: RESPONSE_SCHEMA_VERSION,
    },
    protocol: {
      name: protocol.name,
      version: protocol.version,
      status: protocol.status,
      sha256: sha256(protocolBytes),
    },
    fixtures: {
      file: `cases.v${fixtures.protocol_version}.json`,
      sha256: sha256(fixtureBytes),
      case_count: fixtures.cases.length,
    },
    request_sha256: requestSha256,
    subject: response.subject,
    conformance,
    claim_boundary: {
      proves: [
        'The named subject returned the exact expected decision for each passing frozen case.',
        'The response is bound to the exact canonical request bytes.',
        'The result can be reproduced with the same subject, protocol, and fixtures.',
      ],
      does_not_prove: [
        'The subject governs an open-ended agent loop or real repository mutations.',
        'The subject is safe for untested inputs, integrations, or failure modes.',
        'The gates improve production quality, speed, safety, or cost.',
      ],
    },
  };
}

module.exports = {
  CONTRACT_VERSION,
  REQUEST_SCHEMA_VERSION,
  RESPONSE_SCHEMA_VERSION,
  buildSubjectRequest,
  runSubject,
};
