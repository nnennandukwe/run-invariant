'use strict';
// Deliberately synthetic: lookup responses exercise the process protocol, not
// controller selection. Never ship or label this as a controller implementation.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [checkout, mode = 'conforming'] = process.argv.slice(2);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function domain(value) {
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    return item;
  }
  return hash(JSON.stringify(ordered(value)));
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const { request, request_digest } = JSON.parse(input);
  const allowed = [
    'protocol',
    'fixture_schema',
    'canonicalization',
    'digest_profile',
    'schema',
    'corpus_digest',
    'case_id',
    'operation',
    'input',
    'input_digest',
  ].sort();
  if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(allowed))
    throw new Error('Expectation leakage or missing input');
  if (
    hash(canonical(request)) !== request_digest ||
    hash(canonical(request.input)) !== request.input_digest
  )
    throw new Error('Bad request digest');
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(
        checkout,
        'docs/contracts/controller-conformance-v0.1/fixtures',
        request.case_id + '.json',
      ),
    ),
  );
  const result = fixture.expected;
  const subject = {
    name: 'synthetic-threadloop',
    version: '0.1',
    revision: 'test-double',
    artifact_digest: hash(fs.readFileSync(__filename)),
  };
  const response = {
    protocol: request.protocol,
    fixture_schema: request.fixture_schema,
    canonicalization: request.canonicalization,
    digest_profile: request.digest_profile,
    schema: 'threadloop.conformance-response/0.1',
    request_digest,
    subject,
    result,
  };
  const first = request.case_id === 'case_001';
  if (first) {
    if (mode === 'nonzero') {
      process.stderr.write('intentional failure');
      process.exit(7);
    }
    if (mode === 'timeout') {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === 'stdout-overflow') {
      process.stdout.write('x'.repeat(17 * 1024 * 1024));
      return;
    }
    if (mode === 'stderr-overflow') {
      process.stderr.write('x'.repeat(2 * 1024 * 1024));
      return;
    }
    if (mode === 'invalid-utf8') {
      process.stdout.write(Buffer.from([0xff]));
      return;
    }
    if (mode === 'missing') return;
    if (mode === 'wrong-request') response.request_digest = '0'.repeat(64);
    if (mode === 'wrong-subject') response.subject.revision = 'different';
    if (mode === 'nested-digest') response.result.compiled_graph.graph_digest = '0'.repeat(64);
    if (mode === 'unknown-version') response.schema = 'threadloop.conformance-response/99';
    if (mode === 'extra-field') response.extra = true;
    if (mode === 'omitted-result') delete response.result;
  }
  if (
    mode === 'prose' &&
    result.status === 'decision' &&
    result.decision.decision.outcome === 'blocked'
  ) {
    result.decision.decision.reasons[0].message = 'Alternative diagnostic prose';
    result.decision.decision.reasons[0].recovery = 'Alternative recovery prose';
    result.decision.decision_digest = domain(result.decision.decision);
  }
  if (mode === 'untrusted-receipt' && request.case_id === 'case_033')
    Object.assign(result.steps[2], { code: 'RECEIPT_ACCEPTED', disposition: 'applied' });
  if (mode === 'fenced-claim' && request.case_id === 'case_032')
    Object.assign(result.steps[3], { code: 'RECEIPT_ACCEPTED', disposition: 'applied' });
  if (mode === 'overwrite-conflict' && request.case_id === 'case_035')
    result.steps[0].disposition = 'applied';
  if (mode === 'arbitrary-remedy' && request.case_id === 'case_024') {
    const template = JSON.parse(
      fs.readFileSync(
        path.join(checkout, 'docs/contracts/controller-conformance-v0.1/fixtures/case_004.json'),
      ),
    ).expected;
    const decision = template.decision.decision;
    decision.binding = request.input.binding;
    decision.input_digest = domain(request.input);
    const action = decision.action_request.request;
    action.binding = request.input.binding;
    action.idempotency_key = domain({
      schema_version: '0.1',
      binding: action.binding,
      action_id: action.action_id,
    });
    decision.action_request.request_digest = domain(action);
    result.decision = { decision, decision_digest: domain(decision) };
  }
  if (mode === 'revive-proof' && ['case_026', 'case_027'].includes(request.case_id)) {
    const template = JSON.parse(
      fs.readFileSync(
        path.join(checkout, 'docs/contracts/controller-conformance-v0.1/fixtures/case_008.json'),
      ),
    ).expected;
    const decision = template.decision.decision;
    decision.binding = request.input.binding;
    decision.input_digest = domain(request.input);
    result.decision = { decision, decision_digest: domain(decision) };
  }
  if (mode === 'no-human-authority' && request.case_id === 'case_009') {
    const { binding, input_digest, schema_version } = result.decision.decision;
    result.decision.decision = {
      binding,
      input_digest,
      schema_version,
      outcome: 'terminal',
      terminal_state: 'completed',
    };
    result.decision.decision_digest = domain(result.decision.decision);
  }
  const envelope = { response, response_digest: hash(canonical(response)) };
  let output = canonical(envelope);
  if (first && mode === 'wrong-digest') {
    envelope.response_digest = '0'.repeat(64);
    output = canonical(envelope);
  }
  if (first && mode === 'extra-document') output += '{}';
  if (first && mode === 'duplicate-key') output = '{"response":null,' + output.slice(1);
  if (first && mode === 'truncated') output = output.slice(0, -1);
  if (first && mode === 'bom') output = '\ufeff' + output;
  if (first && mode === 'crlf') output += '\r\n';
  if (mode === 'lf') output += '\n';
  process.stdout.write(output);
});
