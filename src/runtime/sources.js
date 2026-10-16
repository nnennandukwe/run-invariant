'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, identity } = require('./codec');
const { same } = require('./contracts');
const root = path.join(__dirname, '../../runtime');
const files = [
  'protocol.v0.2.0.json',
  'messages.schema.json',
  'fixtures.schema.json',
  'corpus.v0.2.0.json',
  ...fs
    .readdirSync(path.join(root, 'contracts'))
    .sort()
    .map((file) => 'contracts/' + file),
];
function manifest() {
  const corpus = JSON.parse(
    fs.readFileSync(path.join(root, 'corpus.v0.2.0.json')),
  );
  return {
    schema_version: 'run-invariant.runtime-manifest/0.1.0',
    corpus_version: corpus.corpus_version,
    files: Object.fromEntries(
      files.map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
    ),
    cases: corpus.cases.map((fixture) => ({
      id: fixture.id,
      input_digest: identity({
        request: fixture.request,
        support: fixture.support,
        steps: fixture.steps,
      }),
      expectation_digest: identity(fixture.expected),
    })),
  };
}
function checkManifest() {
  same(
    JSON.parse(fs.readFileSync(path.join(root, 'manifest.v0.2.0.json'))),
    manifest(),
    'runtime manifest; inspect versioned sources before refreshing',
  );
}
module.exports = { manifest, checkManifest };
