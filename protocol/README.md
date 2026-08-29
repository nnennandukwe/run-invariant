# RunInvariant Protocol History

RunInvariant protocol files are immutable after they are marked `frozen`.

The initial compatibility release is [`v0.1.0.json`](./v0.1.0.json). Its
fixture corpus is
[`cases.v0.1.0.json`](../fixtures/cases.v0.1.0.json), and its reproducible
packet is
[`conformance-v0.1.0.json`](../evidence/conformance-v0.1.0.json).

## Preserved Identity

Version `0.1.0` originated under the BoundaryBench name inside
`governed-agent-autonomy-patterns`. The protocol, fixtures, and evidence bytes
remain unchanged in this repository so their recorded SHA-256 digests continue
to verify. The legacy name in those frozen files is historical protocol
identity, not the current project name.

Future machine-behavior releases will use the RunInvariant name and a new
version. They must not overwrite or relabel `0.1.0`.

## Versioning Rule

- Editorial clarifications that do not change machine behavior belong in this
  README.
- Any change to an input field, decision outcome, precedence rule, decision
  code, workflow invariant, evidence calculation, or subject interface
  requires a new protocol version and a new versioned fixture file.
- Existing frozen files remain available so prior evidence packets can be
  reproduced.
- Each evidence packet records SHA-256 digests of the literal protocol and
  fixture bytes. Changing either frozen file invalidates `--check`.

Protocol `0.1.0` covers deterministic reference conformance only. It does not
define an external subject adapter, model adapter, prompt, task corpus,
sampling strategy, provider configuration, or statistical claim for real
coding agents.
