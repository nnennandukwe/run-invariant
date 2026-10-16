"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv/dist/2020");
const { isDeepStrictEqual: equal } = require("node:util");
const { identity } = require("./codec");
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: { uint64: true, uint16: true, int32: true },
});
const validators = Object.fromEntries(
  [
    "agent-run-request",
    "terminal-run-receipt",
    "protected-effect-request",
    "protected-effect-result",
  ].map((name) => [
    name,
    ajv.compile({
      ...JSON.parse(
        fs.readFileSync(
          path.join(
            __dirname,
            "../../runtime/contracts",
            name + ".schema.json",
          ),
        ),
      ),
      $id: "urn:gaap:schema:" + name,
    }),
  ]),
);
for (const name of ["messages", "fixtures"])
  validators[name] = ajv.compile(
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../../runtime", name + ".schema.json"),
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
  schema("terminal-run-receipt", terminal.receipt);
  const { body, receipt_digest } = terminal.receipt;
  same(receipt_digest, identity(body), "receipt body digest");
  same(body.request_digest, identity(request), "Agent Run Request digest");
  same(body.request_id, request.request_id, "request identity");
  same(body.run_id, request.run_id, "run identity");
  same(body.initial_subject_digest, request.subject.digest, "initial subject");
  same(body.terminal_status, fixture.expected.status, "terminal status");
  same(body.terminal_reason, fixture.expected.reason, "terminal reason");

  same(
    body.resulting_subject_digest,
    fixture.expected.subject_digest,
    "resulting subject",
  );
  same(
    terminal.effects.map((result) => result.body.execution_status),
    fixture.expected.effects,
    "ordered effect outcomes",
  );
  same(body.usage, fixture.expected.usage, "accounted usage");
  const proposed = calls
    .filter((call) => call.port === "agent.next")
    .map((call) => call.reply)
    .filter((reply) => reply.step === "effect")
    .map((reply) => reply.request);
  const executed = calls.filter((call) => call.port === "executor.execute");
  const planned = body.events.filter(
    (event) => event.event_type === "plan_recorded",
  );
  same(planned.length, 1, "one accepted plan");
  same(
    planned[0].plan_digest,
    calls.find((call) => call.port === "agent.plan")?.reply,
    "plan observation",
  );
  const approvals = body.events.filter(
    (event) => event.event_type === "approval_recorded",
  );
  if (
    !approvals.some((event) =>
      request.approval_context.some((approval) =>
        equal(approval, event.approval),
      ),
    )
  )
    throw new Error("AUTHORITY: missing exact plan approval");
  const executing = body.events.find(
    (event) =>
      event.event_type === "status_transition" && event.to === "executing",
  );
  if (
    !executing ||
    !approvals.some(
      (event) =>
        event.sequence > planned[0].sequence &&
        event.sequence < executing.sequence &&
        request.approval_context.some((approval) =>
          equal(approval, event.approval),
        ),
    )
  )
    throw new Error("AUTHORITY: plan approval must precede execution");
  const toolEvents = body.events.filter(
    (event) => event.event_type === "tool_execution",
  );
  same(toolEvents.length, executed.length, "executor evidence count");
  // Replay only host observations; each usage snapshot follows its known attempts.
  const usageSnapshots = [];
  let observedUsage = { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 0 };
  let adapterElapsed = 0;
  let attempts = 0;
  for (const call of calls) {
    if (call.port === "executor.execute") {
      attempts++;
      const delta = call.reply.error
        ? { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 1 }
        : call.reply.usage;
      for (const key of Object.keys(observedUsage)) observedUsage[key] += delta[key];
    } else if (call.port === "clock.adapter_elapsed_ms") {
      observedUsage.elapsed_ms += call.reply - adapterElapsed;
      adapterElapsed = call.reply;
    } else continue;
    if (!usageSnapshots.length || !equal(usageSnapshots.at(-1).usage, observedUsage))
      usageSnapshots.push({ usage: { ...observedUsage }, attempts });
  }
  let usageIndex = 0;
  let recordedAttempts = 0;
  let status = "accepted";
  let subject = request.subject.digest;
  let verification;
  let verificationCurrent = false;
  let usage = { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 0 };
  for (const [index, event] of body.events.entries()) {
    if (["completed", "blocked", "failed", "interrupted"].includes(status))
      throw new Error("TERMINAL: event after terminal status");
    same(event.sequence, index + 1, "event ordering");
    if (event.event_type === "status_transition") {
      same(event.from, status, "transition source");
      if (["completed", "blocked", "failed", "interrupted"].includes(status))
        throw new Error("TERMINAL: event after terminal status");
      status = event.to;
    }
    if (event.event_type === "protected_effect_decision")
      same(event.subject_digest, subject, "decision current ledger subject");
    if (event.event_type === "tool_execution") {
      if (status !== "executing")
        throw new Error("AUTHORITY: execution outside executing state");
      recordedAttempts++;
      const observed = executed.find(
        (call) => identity(call.input) === event.protected_effect_digest,
      );
      if (!observed)
        throw new Error("EVIDENCE: tool event without observed call");
      same(
        observed.input.subject.digest,
        subject,
        "execution current ledger subject",
      );
    }
    if (event.event_type === "usage") {
      const observed = usageSnapshots[usageIndex++];
      if (!observed) throw new Error("USAGE: unobserved usage update");
      same(recordedAttempts, observed.attempts, "usage execution chronology");
      same(event.usage, observed.usage, "usage host observations");
      for (const key of Object.keys(usage))
        if (event.usage[key] < usage[key])
          throw new Error("USAGE: counters moved backwards");
      usage = event.usage;
    }
    if (event.event_type === "mutation") {
      if (status !== "executing")
        throw new Error("EVIDENCE: mutation outside execution");
      verificationCurrent = false;
      same(event.before_subject_digest, subject, "mutation chronology");
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
        throw new Error("EVIDENCE: mutation without executor result");
      same(
        event.after_subject_digest,
        result.body.observed_post_effect_subject?.digest,
        "mutation result subject",
      );
      const authorization = body.events.find(
        (item) =>
          item.event_type === "protected_effect_decision" &&
          item.decision_id === event.decision_id,
      );
      if (
        !authorization ||
        authorization.gate !== "workflow" ||
        authorization.decision.outcome !== "allow" ||
        authorization.decision.code !== "workflow.mutation_authorized" ||
        authorization.sequence >= event.sequence
      )
        throw new Error("AUTHORITY: mutation lacks prior workflow allow");
      same(
        authorization.protected_effect_digest,
        event.protected_effect_digest,
        "mutation authority effect",
      );
      same(
        event.evidence.map((item) => item.digest),
        result.body.evidence
          .filter((item) => item.evidence_type === "artifact")
          .map((item) => item.digest),
        "mutation artifact evidence",
      );
      subject = event.after_subject_digest;
    }
    if (event.event_type === "verification") {
      if (status !== "verifying")
        throw new Error("VERIFICATION: report outside verification stage");
      verification = event;
      verificationCurrent = event.subject_digest === subject;
      const observed = calls.find(
        (call) => call.port === "verifier.verify",
      )?.reply;
      if (!observed || observed.error)
        throw new Error("VERIFICATION: fabricated verifier event");
      for (const key of [
        "subject_digest",
        "verifier_id",
        "verdict",
        "evidence",
      ])
        same(event[key], observed[key], "verifier observed " + key);
    }
  }
  same(usageIndex, usageSnapshots.length, "all observed usage updates");
  same(usage, body.usage, "final usage ledger");
  same(
    body.events.at(-1).reason,
    body.terminal_reason,
    "terminal ledger reason",
  );
  same(status, body.terminal_status, "final ledger status");
  same(subject, body.resulting_subject_digest, "mutation ledger");
  for (const [index, result] of terminal.effects.entries()) {
    schema("protected-effect-result", result);
    same(result.result_digest, identity(result.body), "effect result digest");
    const effect = proposed[index];
    if (!effect) throw new Error("EVIDENCE: result without a proposal");
    const resultBody = result.body;
    same(
      resultBody.effect_request_digest,
      identity(effect),
      "effect request digest/order",
    );
    same(
      resultBody.agent_run_request_digest,
      identity(request),
      "effect parent request",
    );
    same(resultBody.run_id, request.run_id, "effect run");
    same(resultBody.effect_id, effect.effect_id, "effect identity");
    same(resultBody.effect_sequence, effect.effect_sequence, "effect sequence");
    same(
      resultBody.observed_capability,
      effect.capability,
      "observed capability",
    );
    same(
      resultBody.decision.subject_digest,
      effect.subject.digest,
      "decision subject",
    );
    same(
      resultBody.observed_pre_effect_subject,
      effect.subject,
      "pre-effect subject",
    );
    same(
      resultBody.observed_tool_schema_digest,
      effect.tool_schema_digest,
      "tool schema",
    );
    same(
      resultBody.decision.effect_request_digest,
      identity(effect),
      "decision request",
    );
    const execution = executed.find(
      (call) => identity(call.input) === identity(effect),
    );
    if (
      ["executed", "failed", "interrupted", "unknown_outcome"].includes(
        resultBody.execution_status,
      ) &&
      !execution
    )
      throw new Error("EVIDENCE: fabricated execution without executor call");
    const decisionEvent = body.events.find(
      (event) =>
        event.event_type === "protected_effect_decision" &&
        event.decision_id === resultBody.decision.decision_id,
    );
    if (!decisionEvent) throw new Error("EVIDENCE: missing decisive event");
    same(
      decisionEvent.decision,
      resultBody.decision.decision,
      "decisive authority",
    );
    same(decisionEvent.gate, resultBody.decision.gate, "decisive gate");
    same(
      decisionEvent.subject_digest,
      resultBody.decision.subject_digest,
      "decisive subject",
    );
    same(
      decisionEvent.protected_effect_digest,
      identity(effect),
      "decision event effect",
    );
    if (execution) {
      const toolEvent = toolEvents[executed.indexOf(execution)];
      same(
        toolEvent.protected_effect_digest,
        identity(effect),
        "tool event effect",
      );
      same(toolEvent.action_digest, identity(effect), "tool event action");
      same(
        toolEvent.capability_digest,
        effect.capability.digest,
        "tool event capability",
      );
      same(
        toolEvent.evidence.map((item) => item.digest),
        [result.result_digest],
        "tool event result binding",
      );
      same(
        toolEvent.decision_id,
        resultBody.decision.decision_id,
        "tool decisive authority",
      );
      if (decisionEvent.sequence >= toolEvent.sequence)
        throw new Error("AUTHORITY: effect authority must precede execution");
      const gates = body.events.filter(
        (event) =>
          event.event_type === "protected_effect_decision" &&
          event.protected_effect_digest === identity(effect),
      );
      let previous = planned[0].sequence;
      for (const gate of [
        "permission",
        "tool_trust",
        "runtime",
        ...(effect.expected_effect_class === "mutation" ? ["workflow"] : []),
      ]) {
        const authorization = gates.find((event) => event.gate === gate);
        if (
          !authorization ||
          authorization.decision.outcome !== "allow" ||
          authorization.sequence <= previous ||
          authorization.sequence >= toolEvent.sequence
        )
          throw new Error("AUTHORITY: missing or unordered " + gate + " allow");
        same(
          authorization.subject_digest,
          effect.subject.digest,
          "authorization subject",
        );
        if (gate === "workflow")
          same(
            authorization.decision.code,
            "workflow.mutation_authorized",
            "mutation workflow code",
          );
        previous = authorization.sequence;
      }
      same(
        toolEvent.evidence.map((item) => item.evidence_type),
        ["tool_execution"],
        "tool evidence type",
      );
      same(
        resultBody.decision.gate,
        "permission",
        "attempted effect permission authority",
      );
      same(
        resultBody.decision.decision.outcome,
        "allow",
        "attempted effect allow authority",
      );
      if (execution.reply.error) {
        same(
          resultBody.execution_status,
          "unknown_outcome",
          "lost reply outcome",
        );
        same(
          resultBody.observed_post_effect_subject,
          null,
          "lost reply post subject",
        );
        same(resultBody.exit, null, "lost reply exit");
        same(
          resultBody.reason,
          "executor.failed: scripted executor response lost",
          "lost reply diagnostic",
        );
        same(
          resultBody.executor,
          start.support.executor,
          "lost reply executor identity",
        );
        same(
          resultBody.sandbox_profile,
          effect.sandbox_profile,
          "lost reply sandbox identity",
        );
        same(
          resultBody.usage,
          { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 1 },
          "lost reply known usage",
        );
        same(
          resultBody.evidence,
          execution.reply.evidence,
          "lost reply host evidence",
        );
      }
      if (!execution.reply.error) {
        for (const field of [
          "execution_status",
          "observed_post_effect_subject",
          "usage",
          "executor",
          "sandbox_profile",
          "evidence",
          "exit",
          "reason",
        ])
          same(
            resultBody[field],
            execution.reply[field],
            "executor observed " + field,
          );
      }
    }
    if (!execution) {
      same(
        resultBody.decision.decision.outcome,
        resultBody.execution_status === "awaiting_authority" ? "ask" : "block",
        "non-execution decision outcome",
      );
      for (const field of [
        "executor",
        "sandbox_profile",
        "exit",
        "observed_post_effect_subject",
      ])
        same(resultBody[field], null, "non-execution " + field);
      if (
        resultBody.evidence.some(
          (item) =>
            !["subject_observation", "capability_schema"].includes(
              item.evidence_type,
            ),
        )
      )
        throw new Error(
          "EVIDENCE: non-execution contains execution-derived evidence",
        );
      same(
        resultBody.usage,
        { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 0 },
        "non-execution usage",
      );
      same(
        resultBody.reason,
        resultBody.decision.decision.code,
        "non-execution reason",
      );
    }
    if (resultBody.execution_status === "executed") {
      if (resultBody.decision.decision.outcome !== "allow")
        throw new Error("AUTHORITY: executed without allow");
      same(
        resultBody.observed_post_effect_subject,
        execution.reply.observed_post_effect_subject,
        "executor subject evidence",
      );
      for (const type of [
        "executor",
        "sandbox",
        "usage",
        "subject_observation",
      ])
        if (!resultBody.evidence.some((item) => item.evidence_type === type))
          throw new Error("EVIDENCE: missing " + type);
    }
  }
  if (body.terminal_status === "completed") {
    if (!verificationCurrent)
      throw new Error(
        "VERIFICATION: no current verification after latest mutation",
      );
    const completion = body.events.filter(
      (event) =>
        event.event_type === "protected_effect_decision" &&
        event.gate === "workflow" &&
        event.decision.code === "workflow.completion_authorized",
    );
    same(completion.length, 1, "one completion authorization");
    same(completion[0].decision.outcome, "allow", "completion authority");
    same(
      completion[0].protected_effect_digest,
      body.resulting_subject_digest,
      "completion subject binding",
    );
    same(
      completion[0].subject_digest,
      body.resulting_subject_digest,
      "completion current subject",
    );
    if (
      !verification ||
      completion[0].sequence <= verification.sequence ||
      completion[0].sequence >= body.events.at(-1).sequence
    )
      throw new Error("AUTHORITY: completion must follow verification");
    if (
      verification.implementer_id === verification.verifier_id ||
      !start.support.verifier_ids.includes(verification.verifier_id)
    )
      throw new Error("VERIFICATION: trusted independent actor required");
    const verificationCall = calls.find(
      (call) => call.port === "verifier.verify",
    );
    if (
      !verificationCall ||
      verificationCall.reply.verdict !== "PASS" ||
      verificationCall.reply.subject_digest !== body.resulting_subject_digest ||
      verificationCall.reply.verifier_id === "gaap-runtime"
    )
      throw new Error(
        "VERIFICATION: completion requires current independent evidence",
      );
    if (
      !verification ||
      verification.subject_digest !== body.resulting_subject_digest
    )
      throw new Error("VERIFICATION: missing current ledger evidence");
  }
  same(
    body.events
      .filter((event) => event.event_type === "protected_effect_decision")
      .map(({ gate, subject_digest, protected_effect_digest, decision }) => ({
        gate,
        subject_digest,
        protected_effect_digest,
        decision,
      })),
    fixture.expected.decisions,
    "independent ordered authority expectations",
  );
}
module.exports = { schema, same, validateReceipt };
