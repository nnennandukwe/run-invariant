'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { invoke } = require('../src/threadloop/process');

function run(source, overrides = {}) {
  return invoke([process.execPath, '-e', source], Buffer.from('{}'), {
    timeout_ms: 500,
    stdin_bytes: 100,
    stdout_bytes: 100,
    stderr_bytes: 100,
    ...overrides,
  });
}

test('process exchange sends EOF and captures bytes without shell parsing', async () => {
  const result = await run(
    'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("{}"))',
  );
  assert.equal(result.stdout.toString(), '{}');
});

test('timeouts kill a subject even when SIGTERM is ignored', async () => {
  await assert.rejects(run('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'), /TIMEOUT/);
});

test('output limits, nonzero exit and missing executables fail transport', async () => {
  await assert.rejects(run('process.stdout.write("x".repeat(101))'), /STDOUT_LIMIT/);
  await assert.rejects(run('process.stderr.write("x".repeat(101))'), /STDERR_LIMIT/);
  await assert.rejects(run('process.stderr.write("refused");process.exit(7)'), /EXIT.*7.*refused/);
  await assert.rejects(invoke(['/nonexistent-runinvariant-subject'], Buffer.from('{}')), /SPAWN/);
  await assert.rejects(run('process.stdout.write("{}")', { stdin_bytes: 1 }), /STDIN_LIMIT/);
});

test('descendants retaining stdout cannot extend the process deadline', async () => {
  const result = run(
    'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});process.exit(0)',
  );
  await assert.rejects(result, /TIMEOUT/);
});

test('literal shell metacharacters reach the executable unchanged', async () => {
  const literal = '$(touch never-create-this); echo unsafe';
  const result = await invoke(
    [
      process.execPath,
      '-e',
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(process.argv[1]))',
      literal,
    ],
    Buffer.from('{}'),
  );
  assert.equal(result.stdout.toString(), literal);
});
