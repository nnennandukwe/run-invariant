'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { invoke, PROTOCOL } = require('./process');
const { parseJson, hash, identity, frame } = require('./codec');
const { schema } = require('./contracts');
const root = path.join(__dirname, '../../runtime');
function loadCorpus() {
  const fixtureBytes = fs.readFileSync(path.join(root, 'corpus.v0.2.0.json'));
  const corpus = parseJson(fixtureBytes);
  schema('fixtures', corpus);
  if (
    corpus.schema_version !== 'run-invariant.runtime-fixtures/0.1.0' ||
    corpus.corpus_version !== '0.2.0' ||
    !corpus.cases.length ||
    corpus.cases.length > 128
  )
    throw new Error('CORPUS: unsupported fixture identity/count');
  const ids = new Set();
  for (const fixture of corpus.cases) {
    if (ids.has(fixture.id)) throw new Error('CORPUS: duplicate case identity');
    ids.add(fixture.id);
    schema('agent-run-request', fixture.request);
    for (const step of fixture.steps)
      if (step.port === 'agent.next' && step.reply.step === 'effect')
        schema('protected-effect-request', step.reply.request);
  }
  return { corpus, fixtureBytes };
}
function commandFiles(command) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((part) => typeof part !== 'string' || part.includes('\0')) ||
    !command[0].trim()
  )
    throw new Error('COMMAND: provide an executable after --');
  const candidates = command[0].includes(path.sep)
    ? [path.resolve(command[0])]
    : (process.env.PATH || '')
        .split(path.delimiter)
        .map((dir) => path.join(dir, command[0]));
  const executable = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!executable)
    throw new Error(
      'SPAWN: executable not found; build the subject or pass an absolute executable path',
    );
  return [
    executable,
    ...command.slice(1).filter((arg) => {
      try {
        return fs.statSync(arg).isFile();
      } catch {
        return false;
      }
    }),
  ].map((file) => ({
    path: fs.realpathSync(file),
    sha256: hash(fs.readFileSync(file)),
  }));
}
async function run(command, options = {}) {
  require('./sources').checkManifest();
  const { corpus, fixtureBytes } = loadCorpus();
  const artifacts = commandFiles(command);
  const cases = [];
  let subject;
  for (const fixture of corpus.cases) {
    try {
      const result = await invoke(command, fixture, options);
      if (subject && identity(subject) !== identity(result.terminal.subject))
        throw new Error('SUBJECT: identity changed between cases');
      subject = result.terminal.subject;
      cases.push({
        id: fixture.id,
        title: fixture.title,
        passed: true,
        start_digest: result.start_digest,
        request_digest: result.request_digest,
        transcript_digest: result.transcript_digest,
        response_digest: result.response_digest,
        status: result.terminal.receipt.body.terminal_status,
        evidence: {
          request: result.start,
          transcript: result.calls.flatMap(({ reply, ...call }) => [
            call,
            { kind: 'reply', sequence: call.sequence, value: reply },
          ]),
          response: result.terminal,
        },
      });
    } catch (error) {
      cases.push({
        id: fixture.id,
        title: fixture.title,
        passed: false,
        error: error.message,
        evidence: error.evidence || null,
      });
    }
  }
  require('./contracts').same(
    commandFiles(command),
    artifacts,
    'subject files changed during conformance',
  );
  const passed = cases.filter((item) => item.passed).length;
  const schemas = Object.fromEntries(
    fs
      .readdirSync(path.join(root, 'contracts'))
      .sort()
      .map((name) => [
        name,
        hash(fs.readFileSync(path.join(root, 'contracts', name))),
      ]),
  );
  const protocolBytes = fs.readFileSync(
    path.join(root, 'protocol.v0.2.0.json'),
  );
  const schemaBytes = fs.readFileSync(path.join(root, 'messages.schema.json'));
  const fixtureSchemaBytes = fs.readFileSync(
    path.join(root, 'fixtures.schema.json'),
  );
  return {
    suite: 'RunInvariant governed Agent Run conformance',
    protocol: {
      version: PROTOCOL,
      sha256: hash(protocolBytes),
      schema_sha256: hash(schemaBytes),
    },
    fixtures: {
      version: corpus.schema_version,
      sha256: hash(fixtureBytes),
      schema_sha256: hash(fixtureSchemaBytes),
    },
    corpus: { version: corpus.corpus_version, digest: identity(corpus) },
    contract_schemas: schemas,
    manifest_sha256: hash(
      fs.readFileSync(path.join(root, 'manifest.v0.2.0.json')),
    ),
    subject: {
      reported: subject || null,
      command,
      executable_sha256: artifacts[0].sha256,
      artifacts,
    },
    conformance: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      cases,
    },
    claim_boundary:
      "Passing covers only these frozen scripted cases. It doesn't prove production safety, sandbox strength, model quality, certification, adoption, DSSE authenticity or crash recovery.",
  };
}
async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: run-invariant runtime [--json] -- <executable> [arguments...]\nTests a bounded runtime through live canonical JSON port calls.\nBuild GAAP first: cargo build --locked\nExample: node bin/run-invariant.js runtime -- /path/to/target/debug/gaap runtime-subject\n',
    );
    return;
  }
  const separator = args.indexOf('--');
  const flags = args.slice(0, separator < 0 ? args.length : separator);
  if (
    separator < 0 ||
    separator === args.length - 1 ||
    flags.length > 1 ||
    flags.some((flag) => flag !== '--json')
  ) {
    process.stderr.write(
      'Runtime usage: run-invariant runtime [--json] -- <executable> [arguments...]\n',
    );
    process.exitCode = 2;
    return;
  }
  try {
    const packet = await run(args.slice(separator + 1));
    process.stdout.write(
      flags.includes('--json')
        ? frame(packet)
        : `Runtime conformance: ${packet.conformance.passed}/${packet.conformance.total} cases\n${packet.conformance.failed ? 'Run with --json to inspect failed cases.\n' : ''}${packet.claim_boundary}\n`,
    );
    if (packet.conformance.failed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `Runtime error: ${error.message}\nRecovery: check the executable and rebuild the pinned GAAP runtime-subject adapter.\n`,
    );
    process.exitCode = 1;
  }
}
module.exports = { run, main, loadCorpus };
