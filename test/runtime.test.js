'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadCorpus } = require('../src/runtime/runner');
const { invoke } = require('../src/runtime/process');
const { frame, parseMessage, hash } = require('../src/runtime/codec');
const { corpus } = loadCorpus();
const fixture = corpus.cases[0];
test('runtime corpus is separate and contains no expected results in start or replies', () => {
  assert.equal(corpus.corpus_version, '0.2.0');
  assert.equal(corpus.cases.length, 21);
  for (const item of corpus.cases) {
    const start = {
      kind: 'start',
      protocol: 'run-invariant.runtime/0.2.0',
      request: item.request,
      support: item.support,
    };
    assert.equal(Object.hasOwn(start, 'expected'), false);
    assert.equal(JSON.stringify(start).includes(item.title), false);
    assert.equal(JSON.stringify(start).includes(item.id), false);
    for (const step of item.steps)
      assert.equal(Object.hasOwn(step.reply || {}, 'expected'), false);
  }
});
test('frozen 0.1.0 files retain their accepted digests', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../runtime/legacy-digests.json')),
  );
  for (const [file, digest] of Object.entries(manifest))
    assert.equal(
      hash(fs.readFileSync(path.join(__dirname, '..', file))),
      digest,
      file,
    );
});
test('runtime codec rejects duplicate keys, malformed UTF-8 and noncanonical bytes', () => {
  for (const input of [
    Buffer.from('{"a":1,"a":2}\n'),
    Buffer.from('{ "a":1}\n'),
    Buffer.from([0xff, 10]),
    Buffer.from('{"a":9007199254740992}\n'),
  ])
    assert.throws(() => parseMessage(input));
});
for (const [name, code, pattern] of [
  ['process interruption', "process.kill(process.pid,'SIGKILL')", /INCOMPLETE/],
  [
    'missing terminal',
    'process.stdin.once("data",()=>process.exit(0))',
    /INCOMPLETE/,
  ],
  ['wall timeout', 'setInterval(()=>{},1000)', /TIMEOUT/],
  [
    'stdout flood',
    'process.stdout.write(Buffer.alloc(4194305,97))',
    /STDOUT_LIMIT/,
  ],
  [
    'stderr flood',
    'process.stderr.write(Buffer.alloc(4194305,97));setInterval(()=>{},1000)',
    /STDERR_LIMIT/,
  ],
  [
    'bad UTF-8',
    'process.stdout.write(Buffer.from([255,10]));setInterval(()=>{},1000)',
    /UTF-8/,
  ],
  [
    'unknown protocol message',
    'process.stdout.write(\'{"kind":"unknown"}\\n\');setInterval(()=>{},1000)',
    /SCHEMA messages/,
  ],
])
  test('fails closed on ' + name, async () => {
    await assert.rejects(
      invoke([process.execPath, '-e', code], fixture, { timeoutMs: 500 }),
      pattern,
    );
  });
test('spawn error gives an actionable failure', async () => {
  await assert.rejects(invoke(['/no/such/runtime-subject'], fixture), /SPAWN/);
});
test('runtime CLI usage and help', () => {
  const cli = path.join(__dirname, '../bin/run-invariant.js');
  const help = spawnSync(process.execPath, [cli, 'runtime', '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /cargo build --locked/);
  const invalid = spawnSync(process.execPath, [cli, 'runtime', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Runtime usage/);
});

test('partial protocol evidence survives a failure', async () => {
  const code =
    'process.stdin.once("data",()=>{process.stdout.write(\'{"input":{},"kind":"call","port":"clock.now","sequence":1}\\n\');setTimeout(()=>process.exit(1),20);})';
  await assert.rejects(
    invoke([process.execPath, '-e', code], fixture),
    (error) => {
      assert.equal(error.evidence.calls[0].port, 'clock.now');
      assert.match(error.evidence.transcript_digest, /^sha256:/);
      return /INCOMPLETE/.test(error.message);
    },
  );
});
