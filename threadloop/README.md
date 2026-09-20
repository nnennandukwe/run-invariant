# ThreadLoop Controller Conformance v0.1

RunInvariant consumes the corpus owned by ThreadLoop at the immutable revision in
[pin.json](pin.json). That revision is proposed in
[ThreadLoop PR #128](https://github.com/nnennandukwe/threadloop/pull/128), which
should be accepted before this integration is released. The pin must be updated
explicitly if accepted artifacts change; a matching version string is insufficient.

This is a separate suite from the frozen decision protocol and the future
[GAAP Agent Run suite](https://github.com/nnennandukwe/run-invariant/issues/2).
It does not import ThreadLoop code or packages, copy corpus ownership, execute
GAAP, or implement a controller. The synthetic lookup subject under `test/`
exists solely to exercise harness behavior and must not be presented as a real
controller or an independent implementation of selection semantics.

## Obtain the pinned corpus

Install RunInvariant dependencies with `npm ci`. Then obtain the separate
ThreadLoop artifacts (network access is needed only for this acquisition):

```bash
git clone https://github.com/nnennandukwe/threadloop.git .threadloop-corpus
git -C .threadloop-corpus checkout --detach a7e857cf1d9f562d597c2256365078b712c5288b
THREADLOOP_CHECKOUT="$PWD/.threadloop-corpus" npm run test:threadloop
```

The integration test command fails when its checkout is unavailable; it never
silently skips. `npm test` runs the local legacy, codec, and process tests without
an external checkout. CI runs both. Test execution and the CLI make no network
calls. A source archive with the same directory layout also works: the loader
verifies content, not a mutable Git branch name. Packet source revision is the
reviewed provenance recorded in the pin, not an assertion about checkout HEAD.

The loader checks eight exact conformance-schema hashes, the pinned manifest and
complete-fixture digests, compatibility metadata, every upstream schema checksum,
and exact fixture/schema inventories before launching a process. Unknown profiles,
duplicate JSON keys, invalid Unicode, unsafe or lossy numeric literals, missing or unlisted fixtures,
path escapes, and symlinks below the checkout root fail closed. Formatting-only
fixture changes preserve identity; upstream and conformance schema hashes bind
literal file bytes. Inputs intentionally invalid under domain rules remain valid
negative tests.

Fixture files are compact source envelopes. The loader expands local `$fixture_ref`
values from `shared.json` before validating complete fixtures and their original
manifest digests. Source/shared storage versions are checked separately from wire
versions. Cycles, missing references, sibling overrides, and unused shared values
fail before launch. Expansion is bounded while walking to depth 64 (including
reference hops), one million visits, and 16 MiB of canonical content across the whole expanded corpus. The loader checks
exact fixture inventory before reading source files, uses bounded directory enumeration,
and rejects total stored source data above 2 MiB before parsing it.
Subjects receive fully expanded inputs. This storage compaction preserves the
original 38 cases, corpus identity, and golden request/response bytes.

Artifact reads use bounded regular-file handles, so growth after a size check cannot allocate the whole replacement. Use a stable checkout during validation; these checks are not an OS filesystem sandbox. There is no automatic repair or expectation-update command.

## Run an executable

Create an identity file containing the exact fields the subject will declare:

```json
{
  "name": "your-controller",
  "version": "0.1",
  "revision": "your-source-revision",
  "artifact_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Replace the example artifact digest with the SHA-256 identity of your built
artifact and retain its provenance. The harness compares the independently supplied
identity exactly with every response. This is declared identity, not executable
attestation: an interpreter, its dependencies, and script arguments are not
independently authenticated merely because a subject echoes the file.

```bash
node bin/run-invariant.js threadloop \
  --checkout "$PWD/.threadloop-corpus" \
  --subject /absolute/path/to/identity.json \
  --subject-kind controller \
  --json -- /absolute/path/to/controller conformance
```

Use `--subject-kind synthetic` for a test double. The operator chooses this label;
it is recorded evidence scope, not an automatic determination of implementation
quality. No real controller subject is included. The output packet goes only to
stdout. Per-case progress goes to stderr, including with `--json`; redirect stdout
to retain a packet. Neither CLI mode writes fixtures or evidence files.

The command accepts `--timeout-ms N` from 1 through 60000 (default 10000). Repeated
or unknown options, missing identity fields, or invalid corpus artifacts exit 2
before any process starts. A completed suite exits 0 only when every case passes,
otherwise 1. In human output, failures include the recovery command; the JSON
packet contains case diagnostics and identities.

## Wire and comparison rules

The [pinned ThreadLoop specification](https://github.com/nnennandukwe/threadloop/blob/a7e857cf1d9f562d597c2256365078b712c5288b/docs/contracts/controller-conformance-v0.1/README.md)
and its JSON schemas are normative. Independent protocol, request/response schema,
fixture, manifest, compatibility, canonicalization, and digest identities are
checked without negotiation or fallback.

Each process receives one allowlisted `{request, request_digest}` envelope on stdin
followed by EOF. Requests contain protocol metadata, opaque case ID, operation,
normalized input, and digests. Expectations and harness descriptions remain in the
harness. The public corpus is not secret, and a malicious subject can memorize it.
Processes are launched directly with `shell: false`, once per case, with no shared
in-memory state. This is not a filesystem or network sandbox: the host environment
and filesystem remain accessible and subjects must be trusted to run there.

The codec uses compact UTF-8 JSON, UTF-16 key ordering, preserved array order,
well-formed Unicode and non-negative safe integers. One optional final LF is
framing and excluded from content digests. BOMs, duplicate keys, CRLF, extra
whitespace, multiple documents, and incomplete responses are rejected. The existing
RunInvariant pretty-printed, newline-inclusive protocol is untouched.

Runner limits recorded in every packet:

| Resource                                 | Limit                                                |
| ---------------------------------------- | ---------------------------------------------------- |
| Request / stdout bytes                   | 16 MiB plus one framing LF                           |
| Canonical content                        | 16 MiB                                               |
| Nesting / JSON values                    | 64 / 1,000,000                                       |
| Stderr                                   | 1 MiB per process                                    |
| Deadline                                 | 10 seconds by default; configurable up to 60 seconds |
| Termination cleanup wait                 | At most one additional second after abort            |
| Retained nonconforming result details    | 64 KiB per case, 2 MiB across the suite              |
| Diagnostic / identity / command metadata | 4 KiB per diagnostic / 16 KiB / 64 KiB               |

Timeout and output overflow trigger SIGKILL. POSIX launches a separate process
group and kills that group; Windows kills the direct child. Escaping process groups
and hostile OS behavior are outside this isolation claim. A subject retaining
stdout through descendants cannot indefinitely extend the deadline.

The harness validates response schema, canonical bytes, response digest, request
correlation, and pinned subject identity before comparing results. It independently
checks compiled-graph, decision, Action Request, idempotency, and decision-input
digests using the historical ThreadLoop domain preimages. Embedded Action Requests must match their enclosing decision binding or the execution scenario's initial request binding. Digest references in
execution projections have no embedded preimage; their exact values are compared
against the pinned expectation. It does not reimplement ThreadLoop's compiler,
controller selector, execution model, or production authority checks.

All machine fields and array order are compared exactly. For blocked decisions
only, after verifying the complete decision digest, reason `message`/`recovery`
and the enclosing `decision_digest` are omitted from comparison. Diagnostic triples
and all embedded request fields remain significant. No arbitrary recursive prose
stripping occurs.

## Evidence packet

`run-invariant.threadloop-packet/0.1` records the source repository/revision,
corpus digest, schema checksums, compatibility identity, independent protocol
profiles, subject identity and kind, command and runner settings. Every case records
input/request digest and one of:

- `passed`: a valid response matches the frozen expected machine result;
- `nonconforming`: a valid response differs from that result;
- `protocol_error`: bytes, schema, identity, result kind, or embedded integrity fail;
- `transport_error`: process startup, pipes, deadline, output limits, or exit fail.

Valid responses record their response digest. Completed transport captures also
record raw stdout/stderr hashes. Invalid response digests remain null; a claimed
but invalid digest is never presented as verified. Passing cases retain result kind/outcome and digests, not full results. Nonconforming cases retain expected and actual results within the recorded report budget; larger details are explicitly omitted with their canonical digests. Diagnostic text is truncated explicitly at its byte limit. These reporting limits do not bypass full response validation or change pass/fail status. A valid negative domain result can pass its case;
process and protocol failures never count as controller decisions or passes.

The packet establishes only the named subject's observed behavior on this frozen
corpus. Synthetic passes establish test-harness behavior. Neither proves a complete
controller implementation, runtime integration, storage isolation, persistence,
crash recovery, sandbox strength, production safety, certification, deployment,
or adoption. ThreadLoop retains lifecycle authority; GAAP remains an inner Agent
Run; RunInvariant reports independent observations and advances neither lifecycle.
