# Governed Agent Run conformance v0.2

This suite tests a bounded runtime through an external process. RunInvariant owns
the scripts, expected outcomes and independent receipt checks. The subject owns
its runtime implementation and receives one canonical Agent Run Request plus
host-owned trust configuration. Independently specified gate outcomes and ordered
authority bindings stay in each fixture. It never receives case titles, case IDs, expected
decisions, expected terminal outcomes or future script steps.

The 0.1.0 decision protocol, fixtures, evidence and subject interface remain frozen.
This suite also stays separate from ThreadLoop's controller corpus: it doesn't
advance a workflow or test ThreadLoop lifecycle transitions.

## Run the reference

Use Node.js 20 or newer and the GAAP Rust toolchain. The reference revision is
pinned in `reference.json`; building a different checkout doesn't reproduce that
source identity.

```sh
npm ci
git clone https://github.com/nnennandukwe/governed-agent-autonomy-patterns.git .gaap-runtime
git -C .gaap-runtime checkout "$(node -p 'require("./runtime/reference.json").revision')"
cargo build --locked --manifest-path .gaap-runtime/Cargo.toml
node bin/run-invariant.js runtime --json -- .gaap-runtime/target/debug/gaap runtime-subject > runtime-packet.json
GAAP_BINARY="$PWD/.gaap-runtime/target/debug/gaap" npm run test:runtime
npm run check:runtime
```

`runtime` prints a packet without editing files. Exit 0 means every frozen case
passed, exit 1 means conformance or protocol failure, and exit 2 means invalid CLI
usage. `runtime --help` gives the command shape. Build the executable explicitly;
`cargo test` alone doesn't promise that a standalone binary exists.

## Versioned sources

| Source | Identity |
| --- | --- |
| `protocol.v0.2.0.json` | Runtime subject protocol 0.2.0 and process limits |
| `messages.schema.json` | Wire schema 0.1.0 |
| `fixtures.schema.json` | Fixture schema 0.1.0 |
| `corpus.v0.2.0.json` | Corpus 0.2.0 with 25 independently specified cases |
| `manifest.v0.2.0.json` | Source byte hashes and every case's input/expectation digests |

`contracts/` contains unchanged copies of the accepted GAAP request, receipt,
effect-request and effect-result schemas. Their source revision is pinned in
`reference.json`. The packet hashes each schema separately. `legacy-digests.json`
protects the accepted 0.1.0 sources and evidence in tests.

The manifest check refuses a changed source. Adding or changing accepted cases,
expectations or protocol rules requires the relevant new version. During the
initial review of this new suite, `node scripts/runtime-manifest.js --write`
regenerates its derived manifest after intentional source edits. This command never
updates legacy evidence.

## Process and binding rules

Each case gets a fresh process started directly without a shell. The host writes a
`start` object with `kind`, `protocol`, `request` and `support`. Support pins policy
identities, capability identities, capability/schema approval pairs, permission,
executor identity, verifier IDs, the effect limit and an effect usage estimate. The host serves only the
next scripted reply after validating the actual port name, input and sequence.

Subject messages are canonical UTF-8 JSON followed by exactly one LF. Object keys
use UTF-16 lexical ordering. The profile accepts only non-negative safe integers;
it rejects duplicate keys, lossy numbers, invalid UTF-8, extra content and unpaired
surrogates. The shared byte codec has no dependency on ThreadLoop's corpus or
controller semantics. Receipt hashes use canonical JSON without LF, matching GAAP.

The ports are `agent.plan`, `agent.next`, `executor.execute`, `verifier.verify`,
`subject.observe`, `clock.adapter_elapsed_ms` and `signer.sign`. Executor responses describe host
observations, including failed, interrupted or uncertain effects. They aren't
expected terminal outcomes. A lost executor reply retains only host-provided evidence,
the configured identities, a fixed transport-loss diagnostic and the known one-call
usage lower bound. It can't assert an exit, a post-effect subject or an external outcome.
Denied effects can't claim execution-derived evidence. Usage updates match the
ordered cumulative host executor and clock observations and follow their tool attempts. The clock reports cumulative adapter milliseconds from
run start zero, after an operation, including failed operations with an observed reply; executor
usage is counted separately. Zero-time effects can use a zero elapsed estimate.
If no clock observation survives a transport failure, recorded usage remains a
lower bound. After
valid verification, a final physical subject observation must still match before
completion. A failed receipt retains the last governed subject; the transcript
also records a later physical observation that prevented completion.

`start_digest` hashes the exact start frame including LF. `request_digest` hashes
the canonical Agent Run Request without LF and must match the receipt. The terminal
`transcript_digest` hashes the concatenated call and reply frames including LF,
excluding start and terminal. The packet records `response_digest` over the exact
terminal frame including LF and includes all three source records for inspection.
It also identifies corpus, fixture, protocol, schema, manifest and executable bytes.
The executable is resolved to an absolute path before invocation. Executable and
file arguments are hashed before and after the suite; changed observed bytes
invalidate the packet. These are file observations, not authenticated loader
measurements or digests of every transitive dependency. A privileged local process
can race a file change; this suite doesn't defend against a hostile host. Subject
name/version fields remain self-reported metadata.

The signer signs the canonical start/request/receipt digest object plus LF with a
published Ed25519 fixture seed. This checks binding and signer interaction. Anyone
can reproduce that key, so it supplies no production identity or trust. It isn't
the GAAP in-toto/DSSE attestation protocol; the accepted GAAP attestation adapter
owns that separate boundary.

A case has a ten-second wall deadline and four-MiB stdout/stderr limits. Exceeded
limits, signals, missing/partial responses and extra messages fail closed. On POSIX,
the runner kills the original process group after completion or failure.
This covers descendants in that group; a process that creates another session can
escape that cleanup. Run only explicitly trusted local subjects. The runner isn't
an execution sandbox. Native Windows termination covers the immediate child only. The runner
waits for process exit before accepting a result and reaps a rejected child before
starting the next case. If closure can't be confirmed, the suite stops. The post-terminal case submits
additional input after a valid receipt and requires refusal with exit 1 and no
further stdout. This checks observable process behavior; it can't prove an internal
stdin read. Other cases require exit 0.

## Cases and unsafe subjects

The corpus covers allowed execution with current verification, ask and deny with
zero dispatch, changed schema under the same capability, cross-capability schema
approval reuse, stale verification, post-verification mutation, resource and clock
budgets, cancellation, known failure, interruption, unknown outcome, lost executor
response, changed duplicate effect identity, adapter/verifier failure and terminal
input refusal.

Integration tests run the GAAP binary as an opaque subject. A transparent proxy
first reproduces valid bindings; test-only unsafe proxies then alter authority,
trust, receipt content, result presence/order or transcript behavior. Several
proxies reseal receipt bodies and obtain fresh fixture signatures, so hash checking
alone can't kill them. Tests separately reject process death, deadlines, output
floods, malformed bytes and missing terminal receipts. Tests retain the partial
transcript on failure. They never import GAAP Rust types.

Passing proves only the frozen scripted cases against the recorded executable. It
doesn't prove production safety, sandbox strength, model quality, certification,
adoption, DSSE authenticity, persistence, crash recovery or arbitrary live-agent
behavior. A host script and a public fixture signature don't establish real-world
effect execution or independent production signer trust.
