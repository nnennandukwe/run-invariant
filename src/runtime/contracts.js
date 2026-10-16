'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const { isDeepStrictEqual: equal } = require('node:util');
const { identity } = require('./codec');
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: { uint64: true, uint16: true, int32: true },
});
const validators = Object.fromEntries(
  [
    'agent-run-request',
    'terminal-run-receipt',
    'protected-effect-request',
    'protected-effect-result',
  ].map((name) => [
    name,
    ajv.compile({
      ...JSON.parse(
        fs.readFileSync(
          path.join(
            __dirname,
            '../../runtime/contracts',
            name + '.schema.json',
          ),
        ),
      ),
      $id: 'urn:gaap:schema:' + name,
    }),
  ]),
);
for (const name of ['messages', 'fixtures'])
  validators[name] = ajv.compile(
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../runtime', name + '.schema.json'),
      ),
    ),
  );
function schema(name, value) {
  const validate = validators[name];
  if (!validate(value))
    throw new Error(`SCHEMA ${name}: ${ajv.errorsText(validate.errors)}`);
}
function same(actual, expected, label) {
  if (!equal(actual, expected)) throw new Error(`BINDING: ${label}`);
}
function validateReceipt(start, terminal, fixture, calls) {
  const request = start.request;
  schema('terminal-run-receipt', terminal.receipt);
  const { body, receipt_digest } = terminal.receipt;
  same(receipt_digest, identity(body), 'receipt body digest');
  same(body.request_digest, identity(request), 'Agent Run Request digest');
  same(body.request_id, request.request_id, 'request identity');
  same(body.run_id, request.run_id, 'run identity');
  same(body.initial_subject_digest, request.subject.digest, 'initial subject');
  same(body.terminal_status, fixture.expected.status, 'terminal status');
  same(body.terminal_reason, fixture.expected.reason, 'terminal reason');
  same(
    body.resulting_subject_digest,
    fixture.expected.subject_digest,
    'resulting subject',
  );
  same(
    terminal.effects.map((result) => result.body.execution_status),
    fixture.expected.effects,
    'ordered effect outcomes',
  );
  same(body.usage, fixture.expected.usage, 'accounted usage');
  const proposed = calls
    .filter((call) => call.port === 'agent.next')
    .map((call) => call.reply)
    .filter((reply) => reply.step === 'effect')
    .map((reply) => reply.request);
  const executed = calls.filter((call) => call.port === 'executor.execute');
  const toolEvents = body.events.filter(
    (event) => event.event_type === 'tool_execution',
  );
  same(toolEvents.length, executed.length, 'executor evidence count');
  let status = 'accepted';
  let subject = request.subject.digest;
  let verification;
  for (const [index, event] of body.events.entries()) {
    if (['completed', 'blocked', 'failed', 'interrupted'].includes(status))
      throw new Error('TERMINAL: event after terminal status');
    same(event.sequence, index + 1, 'event ordering');
    if (event.event_type === 'status_transition') {
      same(event.from, status, 'transition source');
      if (['completed', 'blocked', 'failed', 'interrupted'].includes(status))
        throw new Error('TERMINAL: event after terminal status');
      status = event.to;
    }
    if (event.event_type === 'mutation') {
      same(event.before_subject_digest, subject, 'mutation chronology');
      const result = terminal.effects.find(
        (result) =>
          result.body.effect_request_digest === event.protected_effect_digest,
      );
      if (
        !result ||
        !executed.some(
          (call) => identity(call.input) === event.protected_effect_digest,
        )
      )
        throw new Error('EVIDENCE: mutation without executor result');
      same(
        event.after_subject_digest,
        result.body.observed_post_effect_subject?.digest,
        'mutation result subject',
      );
      subject = event.after_subject_digest;
    }
    if (event.event_type === 'verification') {
      verification = event;
      const observed = calls.find(
        (call) => call.port === 'verifier.verify',
      )?.reply;
      if (!observed || observed.error)
        throw new Error('VERIFICATION: fabricated verifier event');
      for (const key of [
        'subject_digest',
        'verifier_id',
        'verdict',
        'evidence',
      ])
        same(event[key], observed[key], 'verifier observed ' + key);
    }
  }
  same(status, body.terminal_status, 'final ledger status');
  same(subject, body.resulting_subject_digest, 'mutation ledger');
  for (const [index, result] of terminal.effects.entries()) {
    schema('protected-effect-result', result);
    same(result.result_digest, identity(result.body), 'effect result digest');
    const effect = proposed[index];
    if (!effect) throw new Error('EVIDENCE: result without a proposal');
    const resultBody = result.body;
    same(
      resultBody.effect_request_digest,
      identity(effect),
      'effect request digest/order',
    );
    same(
      resultBody.agent_run_request_digest,
      identity(request),
      'effect parent request',
    );
    same(resultBody.run_id, request.run_id, 'effect run');
    same(resultBody.effect_id, effect.effect_id, 'effect identity');
    same(resultBody.effect_sequence, effect.effect_sequence, 'effect sequence');
    same(
      resultBody.observed_pre_effect_subject,
      effect.subject,
      'pre-effect subject',
    );
    same(
      resultBody.observed_tool_schema_digest,
      effect.tool_schema_digest,
      'tool schema',
    );
    same(
      resultBody.decision.effect_request_digest,
      identity(effect),
      'decision request',
    );
    const execution = executed.find(
      (call) => identity(call.input) === identity(effect),
    );
    if (
      ['executed', 'failed', 'interrupted', 'unknown_outcome'].includes(
        resultBody.execution_status,
      ) &&
      !execution
    )
      throw new Error('EVIDENCE: fabricated execution without executor call');
    const decisionEvent = body.events.find(
      (event) =>
        event.event_type === 'protected_effect_decision' &&
        event.decision_id === resultBody.decision.decision_id,
    );
    if (!decisionEvent) throw new Error('EVIDENCE: missing decisive event');
    same(
      decisionEvent.decision,
      resultBody.decision.decision,
      'decisive authority',
    );
    same(
      decisionEvent.protected_effect_digest,
      identity(effect),
      'decision event effect',
    );
    if (execution) {
      const toolEvent = toolEvents[executed.indexOf(execution)];
      same(
        toolEvent.protected_effect_digest,
        identity(effect),
        'tool event effect',
      );
      same(toolEvent.action_digest, identity(effect), 'tool event action');
      same(
        toolEvent.capability_digest,
        effect.capability.digest,
        'tool event capability',
      );
      same(
        toolEvent.evidence.map((item) => item.digest),
        [result.result_digest],
        'tool event result binding',
      );
      if (!execution.reply.error) {
        for (const field of [
          'execution_status',
          'observed_post_effect_subject',
          'usage',
          'executor',
          'sandbox_profile',
          'evidence',
        ])
          same(
            resultBody[field],
            execution.reply[field],
            'executor observed ' + field,
          );
      }
    }
    if (resultBody.execution_status === 'executed') {
      if (resultBody.decision.decision.outcome !== 'allow')
        throw new Error('AUTHORITY: executed without allow');
      same(
        resultBody.observed_post_effect_subject,
        execution.reply.observed_post_effect_subject,
        'executor subject evidence',
      );
      for (const type of [
        'executor',
        'sandbox',
        'usage',
        'subject_observation',
      ])
        if (!resultBody.evidence.some((e) => e.evidence_type === type))
          throw new Error('EVIDENCE: missing ' + type);
    }
  }
  if (body.terminal_status === 'completed') {
    const verificationCall = calls.find(
      (call) => call.port === 'verifier.verify',
    );
    if (
      !verificationCall ||
      verificationCall.reply.verdict !== 'PASS' ||
      verificationCall.reply.subject_digest !== body.resulting_subject_digest ||
      verificationCall.reply.verifier_id === 'gaap-runtime'
    )
      throw new Error(
        'VERIFICATION: completion requires current independent evidence',
      );
    if (
      !verification ||
      verification.subject_digest !== body.resulting_subject_digest
    )
      throw new Error('VERIFICATION: missing current ledger evidence');
  }
}
module.exports = { schema, same, validateReceipt };
