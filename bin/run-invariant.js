#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  buildEvidencePacket,
  canonicalJson,
} = require('../src/report');

const runInvariantRoot = path.resolve(__dirname, '..');
const protocolPath = path.join(
  runInvariantRoot,
  'protocol',
  'v0.1.0.json',
);
const fixturesPath = path.join(
  runInvariantRoot,
  'fixtures',
  'cases.v0.1.0.json',
);
const evidencePath = path.join(
  runInvariantRoot,
  'evidence',
  'conformance-v0.1.0.json',
);
const evidenceDisplayPath = path.relative(
  runInvariantRoot,
  evidencePath,
).split(path.sep).join('/');

function loadPacket() {
  const protocolBytes = fs.readFileSync(protocolPath);
  const fixtureBytes = fs.readFileSync(fixturesPath);
  const protocol = JSON.parse(protocolBytes);
  const fixtures = JSON.parse(fixtureBytes);

  return buildEvidencePacket({
    protocol,
    fixtures,
    protocolBytes,
    fixtureBytes,
  });
}

function printSummary(packet, evidenceState) {
  process.stdout.write(
    [
      `RunInvariant protocol ${packet.protocol.version} (${packet.protocol.status} legacy baseline)`,
      `Reference conformance: ${packet.reference.passed}/${packet.reference.total} cases`,
      `Mutation score: ${packet.mutation_analysis.killed}/${packet.mutation_analysis.total} mutants killed`,
      `Evidence check: ${evidenceState}`,
      `Evidence path: ${evidenceDisplayPath}`,
      'Claim boundary: deterministic conformance only; this does not measure real-agent outcomes.',
      '',
    ].join('\n'),
  );
}

function checkEvidence(packet) {
  if (!fs.existsSync(evidencePath)) return false;

  const committed = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  return canonicalJson(committed) === canonicalJson(packet);
}

function passesProtocol(packet) {
  return (
    packet.reference.failed === 0
    && packet.mutation_analysis.survived === 0
  );
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: run-invariant <mode>',
      '       node bin/run-invariant.js <mode>',
      '',
      'Modes:',
      '  --check  Compare a fresh packet with committed evidence.',
      '  --write  Replace committed evidence with a fresh packet.',
      '  --json   Print a fresh packet as JSON without writing.',
      '',
    ].join('\n'),
  );
}

function main(argv) {
  const mode = argv[0] || '--check';
  if (!['--check', '--write', '--json', '--help'].includes(mode)) {
    process.stderr.write(`Unknown mode: ${mode}\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (mode === '--help') {
    printHelp();
    return;
  }

  const packet = loadPacket();

  if (mode === '--json') {
    process.stdout.write(canonicalJson(packet));
    return;
  }

  if (mode === '--write') {
    if (!passesProtocol(packet)) {
      printSummary(packet, 'NOT WRITTEN');
      process.stderr.write(
        'Conformance failed: fix the reference decisions or surviving mutants '
        + 'before refreshing committed evidence.\n',
      );
      process.exitCode = 1;
      return;
    }

    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, canonicalJson(packet));
    printSummary(packet, 'WRITTEN');
    return;
  }

  const matches = checkEvidence(packet);
  const conforms = passesProtocol(packet);
  printSummary(packet, matches ? 'MATCH' : 'MISMATCH');
  if (!conforms) {
    process.stderr.write(
      'Conformance failed: committed evidence cannot make a failing '
      + 'reference or surviving mutant acceptable.\n',
    );
    process.exitCode = 1;
  } else if (!matches) {
    process.stderr.write(
      'Recovery: inspect the protocol, fixture, or evaluator change; '
      + 'then run npm run evidence:update only when the new packet is intentional.\n',
    );
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
