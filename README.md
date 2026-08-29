# RunInvariant

RunInvariant runs a frozen decision corpus against either its included
reference evaluator or an external executable, then returns a JSON conformance
packet.

Harness maintainers use it to test whether an implementation returns the exact
`allow`, `ask`, or `block` decision required at each agent-run integrity gate.
The external executable can be written in any language and does not need to
link to this repository.

## Interfaces And Artifacts

| Path or interface | Role | Developer use |
| --- | --- | --- |
| [`protocol/v0.1.0.json`](./protocol/v0.1.0.json) | Frozen canonical decision protocol | Review gate invariants, outcomes, precedence, and decision codes. |
| [`fixtures/cases.v0.1.0.json`](./fixtures/cases.v0.1.0.json) | Frozen canonical corpus | Review the 35 normalized inputs, expected decisions, and five unsafe reference mutants. |
| [`subject-protocol`](./subject-protocol/README.md) | Language-neutral, versioned process interface | Implement stdin request and stdout response documents in an external harness. |
| `npm run check` | Reference conformance check | Recompute the included evaluator's packet and compare it with committed evidence. |
| `run-invariant subject` | External subject check | Execute a harness process against cases that do not disclose their expected decisions. |
| [`evidence/conformance-v0.1.0.json`](./evidence/conformance-v0.1.0.json) | Committed derived reference packet | Reproduce the historical 35/35 reference and 5/5 mutation result. |

Reference evidence and external-subject evidence are different proof states.
`--write` updates only the committed reference packet. Subject mode prints a
new packet and never changes a file.

## Quick Start

RunInvariant requires Node.js 20 or newer. It has no package dependencies,
credentials, network calls, or environment variables.

```bash
git clone https://github.com/nnennandukwe/run-invariant.git
cd run-invariant
npm test
npm run check
```

A successful reference check prints:

```text
RunInvariant protocol 0.1.0 (frozen legacy baseline)
Reference conformance: 35/35 cases
Mutation score: 5/5 mutants killed
Evidence check: MATCH
Evidence path: evidence/conformance-v0.1.0.json
Claim boundary: deterministic conformance only; this does not measure real-agent outcomes.
```

## Test An External Subject

Build an executable that implements the
[`0.1.0` subject protocol](./subject-protocol/README.md), then pass its command
after `--`. RunInvariant starts the executable directly without a shell.

```bash
node bin/run-invariant.js subject -- /absolute/path/to/subject subject-command
```

A conforming subject prints:

```text
RunInvariant subject contract 0.1.0
Subject: example 0.1.0 (rust)
Protocol: 0.1.0 (frozen legacy baseline)
Subject conformance: 35/35 cases
Request: sha256:...
Claim boundary: normalized decision conformance only; this does not prove a governed agent loop.
```

Use `--json` to receive the external conformance packet on standard output:

```bash
node bin/run-invariant.js subject --json -- /absolute/path/to/subject subject-command
```

RunInvariant exits nonzero when the subject cannot start, times out, violates
the response contract, omits or duplicates a result, returns a response for a
different request, or produces a nonconforming decision. Subject diagnostics
belong on standard error because standard output must contain exactly one JSON
response document.

The subject receives IDs, gate names, and normalized inputs. It does not
receive case titles or expected decisions. The response is bound to the exact
request bytes with `request_sha256`.

## Reference Evidence Commands

Print a fresh reference packet without changing a file:

```bash
node bin/run-invariant.js --json
```

Refresh committed reference evidence only after an intentional, reviewed
protocol or evaluator change:

```bash
npm run evidence:update
```

The write command refuses to replace evidence if any reference case fails or
any named unsafe mutant survives. Writing a packet records a local result; it
does not approve, publish, or certify that result.

## What Protocol 0.1.0 Covers

The frozen decision protocol defines:

- exact-subject approval before plan mutation;
- deny precedence and explicit approval for risky, wrapped, or unknown actions;
- capability approval bound to an exact digest rather than a display name;
- independent, subject-bound, evidence-bearing verification;
- fail-closed runtime accounting and bounded overage approval; and
- separate authorization for mutation and completion.

The corpus contains 35 plan, permission, tool-trust, verification, runtime, and
workflow cases. Its five reference mutants deliberately skip plan approval,
allow unknown authority, trust a capability by name, permit self-verification,
or continue with missing usage.

## Proof Boundary

A passing reference packet proves that the included JavaScript evaluator
matches all frozen expected decisions and that the public corpus detects all
five named reference mutants.

A passing subject packet proves that the named executable returned every
frozen expected decision for the exact request recorded in that packet.

Neither packet proves that an implementation:

- owns or governs an open-ended agent loop;
- intercepts real repository mutations or provider tool calls;
- is safe for inputs and failures outside the frozen corpus;
- improves production quality, speed, safety, or cost; or
- has been certified, adopted, released, or deployed.

Teams still need integration, failure-path, and end-to-end evidence for those
claims.

## Preserved BoundaryBench Baseline

The decision protocol, fixtures, and committed reference evidence originated
inside
[`governed-agent-autonomy-patterns`](https://github.com/nnennandukwe/governed-agent-autonomy-patterns)
under the BoundaryBench name. RunInvariant preserves their literal bytes and
relevant Git history so their SHA-256 digests remain reproducible.

The project and CLI are now RunInvariant. New machine-behavior changes require
a new versioned protocol and fixture file; frozen `0.1.0` artifacts will not be
relabeled in place. See [`protocol/README.md`](./protocol/README.md).

## Development

Run all tests and reproduce committed reference evidence before submitting a
change:

```bash
npm test
npm run check
```

Changes to subject fields, validation, process behavior, timeout, or output
limits require a new subject-protocol version. Changes to frozen decision
behavior require a new decision-protocol and fixture version.

RunInvariant is licensed under the [Apache License 2.0](./LICENSE).
