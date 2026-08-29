# RunInvariant

RunInvariant evaluates a reference agent-run boundary engine against a frozen
JSON protocol and fixture corpus, then emits a deterministic JSON evidence
packet.

The current `0.1.0` compatibility release gives harness maintainers a
reproducible baseline for five governed-autonomy gates and two workflow
boundaries. It answers two bounded questions:

1. Does the included reference evaluator return the exact expected decision
   for every public case?
2. Does the same fixture corpus detect each included deliberately unsafe
   implementation?

It does not currently execute GAAP or any other external harness. A black-box
subject adapter and a provider-neutral harness profile are future work, not
features claimed by this release.

## What It Reads And Produces

| Path or interface | Role | What a developer does with it |
| --- | --- | --- |
| [`protocol/v0.1.0.json`](./protocol/v0.1.0.json) | Frozen canonical input | Review the decision vocabulary, precedence rules, and workflow invariants. |
| [`fixtures/cases.v0.1.0.json`](./fixtures/cases.v0.1.0.json) | Frozen canonical input | Inspect the 35 expected decisions and five unsafe mutants. |
| `npm run check` | Human-readable CLI result | Recompute conformance and fail if behavior or committed evidence has drifted. |
| `node bin/run-invariant.js --json` | Machine-readable CLI result | Read a freshly computed evidence packet from standard output. |
| [`evidence/conformance-v0.1.0.json`](./evidence/conformance-v0.1.0.json) | Committed derived output | Compare or reproduce the recorded 35/35 reference result and 5/5 mutation result. |

The evidence packet records SHA-256 digests of the literal protocol and fixture
bytes. It is reproducible evidence for this evaluator and this corpus; it is
not certification of an agent, model, or production system.

## Run It

RunInvariant `0.1.0` requires Node.js 20 or newer. It has no package
dependencies, credentials, network calls, or environment variables.

```bash
git clone https://github.com/nnennandukwe/run-invariant.git
cd run-invariant
npm test
npm run check
```

A successful check prints:

```text
RunInvariant protocol 0.1.0 (frozen legacy baseline)
Reference conformance: 35/35 cases
Mutation score: 5/5 mutants killed
Evidence check: MATCH
Evidence path: evidence/conformance-v0.1.0.json
Claim boundary: deterministic conformance only; this does not measure real-agent outcomes.
```

To consume the freshly computed packet without changing a file:

```bash
node bin/run-invariant.js --json
```

Use the write command only when a protocol or evaluator change is intentional
and has been reviewed:

```bash
npm run evidence:update
```

The write command refuses to replace committed evidence if any reference case
fails or any named unsafe mutant survives. Writing a packet records a local
result; it does not approve, publish, or certify that result.

## What Protocol 0.1.0 Covers

The frozen baseline defines:

- `allow`, `ask`, and `block`, with `block` taking highest precedence;
- exact-subject approval for plans, actions, capabilities, and budget;
- deny and hard-stop decisions that approval cannot override;
- independent, subject-bound, evidence-bearing verification;
- fail-closed behavior when authority or usage is unknown; and
- separate authorization for mutation and completion.

The 35 cases exercise plan, permission, tool-trust, verification, runtime, and
workflow decisions. The five mutants deliberately:

- skip exact plan approval;
- allow an action whose authority is unknown;
- trust a changed capability by display name;
- allow implementer self-verification; and
- continue when usage data is missing.

A 35/35 and 5/5 result proves only that the included evaluator matches the
frozen expected decisions and that at least one public case detects each named
mutant. It does not prove that an open-ended coding agent obeys the gates, that
the gates improve production outcomes, or that usage telemetry equals billed
cost.

## Why The Frozen Files Say BoundaryBench

Protocol `0.1.0`, its fixtures, and its evidence packet were originally
published inside
[`governed-agent-autonomy-patterns`](https://github.com/nnennandukwe/governed-agent-autonomy-patterns)
under the BoundaryBench name. RunInvariant preserves their literal bytes and
relevant Git history so existing SHA-256 digests and results remain
reproducible.

The project identity and CLI are now RunInvariant. New machine-behavior changes
must use a new versioned protocol and fixture file; the frozen `0.1.0` artifacts
will not be relabeled in place. See [`protocol/README.md`](./protocol/README.md)
for the versioning rule.

## Project Boundary

RunInvariant is the implementation-independent conformance side of the planned
GAAP ecosystem. This release includes a JavaScript reference evaluator because
an executable oracle is necessary to reproduce the historical baseline. It
does not import a GAAP implementation, call an AI provider, run a coding agent,
or test real repository mutations.

The next interoperability milestone is a versioned black-box subject contract:
a harness process will receive a neutral case document and return a neutral
decision record. That contract is not yet implemented. Until it is, use this
repository to inspect and reproduce the frozen semantics, not to claim that an
external harness conforms.

## License

RunInvariant is licensed under the [Apache License 2.0](./LICENSE).
