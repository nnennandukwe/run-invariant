# Subject Protocol

The RunInvariant subject protocol is a language-neutral process interface for
testing an implementation without importing it into this repository.

## Version 0.1.0

RunInvariant starts the subject directly, without a shell. The subject:

1. reads one UTF-8 JSON request document from standard input;
2. evaluates every case independently;
3. writes one UTF-8 JSON response document to standard output;
4. writes diagnostics only to standard error; and
5. exits with status `0` after producing a complete response.

The request and response schemas are:

- [`v0.1.0/request.schema.json`](./v0.1.0/request.schema.json)
- [`v0.1.0/response.schema.json`](./v0.1.0/response.schema.json)

The request contains case IDs, gate names, and normalized inputs. It does not
contain case titles or expected decisions. The response must return each
requested ID exactly once and must not return unknown IDs.

`request_sha256` is the SHA-256 digest of the exact request bytes received on
standard input, including the trailing newline. This binds results to the
protocol, fixtures, and inputs used for that run.

The subject has ten seconds to complete and may write at most four MiB to each
output buffer. Version `0.1.0` has no network transport, streaming
mode, discovery handshake, provider field, or implementation-language field
beyond the subject's informational `implementation` string.

Any change to fields, validation rules, process behavior, timeout, or output
limits requires a new subject-protocol version.
