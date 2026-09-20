'use strict';
const fs = require('node:fs');
const { MAX_BYTES, parseJson } = require('./codec');
const { runThreadLoop } = require('./runner');

const usage =
  'run-invariant threadloop --checkout <ThreadLoop directory> --subject <identity.json> --subject-kind <synthetic|controller> [--timeout-ms <1..60000>] [--json] -- <executable> [arguments...]';

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(
      `${usage}\n\nRead threadloop/README.md for the pinned checkout and identity file.\nThe suite is offline and writes no packet files. --json keeps stdout machine-readable.\nExit 0: all cases pass; 1: case failure; 2: configuration/corpus failure.\n`,
    );
    return;
  }
  try {
    const separator = argv.indexOf('--');
    if (separator < 0 || separator === argv.length - 1) throw new Error(`Usage: ${usage}`);
    const options = {};
    for (let index = 0; index < separator; index++) {
      const name = argv[index];
      if (
        !['--checkout', '--subject', '--subject-kind', '--timeout-ms', '--json'].includes(name) ||
        Object.hasOwn(options, name)
      )
        throw new Error(`Unknown or duplicate option: ${name}`);
      if (name === '--json') {
        options[name] = true;
        continue;
      }
      if (++index >= separator || argv[index].startsWith('--'))
        throw new Error(`Missing value for ${name}`);
      options[name] = argv[index];
    }
    for (const name of ['--checkout', '--subject', '--subject-kind'])
      if (!options[name]) throw new Error(`Required option: ${name}`);
    const metadata = fs.lstatSync(options['--subject']);
    if (!metadata.isFile() || metadata.size > MAX_BYTES)
      throw new Error('Subject identity must be a bounded regular JSON file');
    const subject = parseJson(fs.readFileSync(options['--subject']));
    const timeoutMs =
      options['--timeout-ms'] === undefined ? undefined : Number(options['--timeout-ms']);
    const packet = await runThreadLoop({
      checkout: options['--checkout'],
      command: argv.slice(separator + 1),
      subject,
      subjectKind: options['--subject-kind'],
      timeoutMs,
      onCase: ({ id, status }) => process.stderr.write(`${id}: ${status}\n`),
    });
    if (options['--json']) process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    else {
      const result = packet.conformance;
      process.stdout.write(
        `ThreadLoop Controller Conformance v0.1 (${packet.subject_kind})\nCorpus: ${packet.source.corpus_digest}\nPassed: ${result.passed}/${result.total}; nonconforming: ${result.nonconforming}; protocol errors: ${result.protocol_error}; transport errors: ${result.transport_error}\n${packet.claim_boundary.proves}\n`,
      );
      if (result.failed)
        process.stdout.write(
          'Recovery: rerun with --json, inspect case diagnostics and exact digests, then correct the subject or restore the pinned corpus.\n',
        );
    }
    if (packet.conformance.failed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `ThreadLoop setup error: ${error.message}\nRecovery: restore the pinned ThreadLoop artifacts and check the subject identity/options. Use threadloop --help.\n`,
    );
    process.exitCode = 2;
  }
}

module.exports = { main, usage };
