'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { frame, parseMessage, hash, identity } = require('./codec');
const { schema, same, validateReceipt } = require('./contracts');
const PROTOCOL = 'run-invariant.runtime/0.2.0';
const LIMIT = 4 * 1024 * 1024;
// Public fixture seed. This key demonstrates protocol binding; it isn't production trust.
const privateKey = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 7),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = crypto.createPublicKey(privateKey);
function sign(binding) {
  return {
    keyid: 'run-invariant-public-fixture',
    signature: crypto.sign(null, frame(binding), privateKey).toString('base64'),
  };
}
function invoke(command, fixture, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((part) => typeof part !== 'string' || part.includes('\0')) ||
      !command[0].trim()
    )
      return reject(new Error('COMMAND: provide an executable after --'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      return reject(new Error('LIMIT: timeout must be 1..60000ms'));
    const start = {
      kind: 'start',
      protocol: PROTOCOL,
      request: fixture.request,
      support: fixture.support,
    };
    schema('messages', start);
    const requestBytes = frame(start);
    const grouped = process.platform !== 'win32';
    const child = spawn(command[0], command.slice(1), {
      shell: false,
      detached: grouped,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = Buffer.alloc(0),
      size = 0,
      stderrSize = 0,
      terminal,
      terminalBytes,
      failure,
      finished = false,
      step = 0;
    let cleanupTimer;
    const transcript = [],
      calls = [];
    const timer = setTimeout(
      () =>
        abort(
          new Error('TIMEOUT: runtime subject exceeded ' + timeoutMs + 'ms'),
        ),
      timeoutMs,
    );
    function kill() {
      if (child.pid)
        try {
          if (grouped) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') failure ||= error;
        }
    }
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      kill();
      if (failure) {
        failure.evidence = {
          request: start,
          start_digest: hash(requestBytes),
          request_digest: identity(start.request),
          calls,
          transcript_digest: hash(Buffer.concat(transcript)),
        };
        reject(failure);
      } else
        resolve({
          start,
          start_digest: hash(requestBytes),
          request_digest: identity(start.request),
          transcript_digest: hash(Buffer.concat(transcript)),
          response_digest: hash(terminalBytes),
          terminal,
          calls,
        });
    }
    function abort(error) {
      if (finished || failure) return;
      failure = error;
      kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      cleanupTimer = setTimeout(() => {
        failure.cleanup_unconfirmed = true;
        failure.message +=
          '; CLEANUP: child closure unconfirmed; stop the suite';
        finish();
      }, 1000);
    }
    function line(bytes) {
      const message = parseMessage(bytes);
      schema('messages', message);
      if (terminal)
        throw new Error('TERMINAL: subject emitted work after receipt');
      if (message.kind === 'call') {
        same(
          Object.keys(message).sort(),
          ['input', 'kind', 'port', 'sequence'],
          'call fields',
        );
        same(message.sequence, calls.length + 1, 'call ordering');
        let reply;
        if (message.port === 'signer.sign') {
          if (step !== fixture.steps.length)
            throw new Error('TRANSCRIPT: signer before script completion');
          if (calls.some((call) => call.port === 'signer.sign'))
            throw new Error('TRANSCRIPT: repeated signer');
          same(
            Object.keys(message.input).sort(),
            ['receipt_digest', 'request_digest', 'start_digest'],
            'signer binding fields',
          );
          same(
            message.input.start_digest,
            hash(requestBytes),
            'signer request',
          );
          if (!/^sha256:[0-9a-f]{64}$/.test(message.input.receipt_digest))
            throw new Error('SIGNER: invalid digest');
          same(
            message.input.request_digest,
            identity(start.request),
            'signer Agent Run Request',
          );
          reply = sign(message.input);
        } else {
          const expected = fixture.steps[step++];
          if (!expected)
            throw new Error('TRANSCRIPT: unexpected ' + message.port);
          same(message.port, expected.port, 'port order');
          same(message.input, expected.input, 'port input ' + message.port);
          reply = expected.reply;
        }
        const replyBytes = frame({
          kind: 'reply',
          sequence: message.sequence,
          value: reply,
        });
        transcript.push(bytes, replyBytes);
        calls.push({ ...message, reply });
        child.stdin.write(replyBytes);
      } else if (message.kind === 'terminal') {
        same(
          Object.keys(message).sort(),
          [
            'effects',
            'kind',
            'protocol',
            'receipt',
            'request_digest',
            'signature',
            'start_digest',
            'subject',
            'transcript_digest',
          ],
          'terminal fields',
        );
        same(message.protocol, PROTOCOL, 'response protocol');
        same(message.start_digest, hash(requestBytes), 'start bytes');
        same(
          message.request_digest,
          identity(start.request),
          'canonical Agent Run Request',
        );
        same(
          message.transcript_digest,
          hash(Buffer.concat(transcript)),
          'transcript bytes',
        );
        same(step, fixture.steps.length, 'missing port calls');
        const signer = calls.at(-1);
        if (signer?.port !== 'signer.sign')
          throw new Error('SIGNER: missing signer call');
        same(
          signer.input.receipt_digest,
          message.receipt.receipt_digest,
          'signed receipt',
        );
        same(message.signature, signer.reply, 'signature reply');
        if (
          !crypto.verify(
            null,
            frame(signer.input),
            publicKey,
            Buffer.from(message.signature.signature, 'base64'),
          )
        )
          throw new Error('SIGNATURE: verification failed');
        same(
          Object.keys(message.subject).sort(),
          ['implementation', 'name', 'version'],
          'subject fields',
        );
        for (const value of Object.values(message.subject))
          if (typeof value !== 'string' || !value.trim())
            throw new Error('SUBJECT: empty identity');
        validateReceipt(start, message, fixture, calls);
        terminal = message;
        terminalBytes = bytes;
        child.stdin.end(
          fixture.probe_after_terminal
            ? frame({ kind: 'resume', request: fixture.request })
            : undefined,
        );
      } else throw new Error('PROTOCOL: unexpected message kind');
    }
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMIT)
        return abort(new Error('STDOUT_LIMIT: runtime output exceeded 4MiB'));
      pending = Buffer.concat([pending, chunk]);
      try {
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
          const bytes = pending.subarray(0, end + 1);
          pending = pending.subarray(end + 1);
          line(bytes);
        }
      } catch (error) {
        abort(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > LIMIT)
        abort(new Error('STDERR_LIMIT: runtime diagnostics exceeded 4MiB'));
    });
    for (const pipe of [child.stdin, child.stdout, child.stderr])
      pipe.on('error', (error) => abort(new Error('PIPE: ' + error.message)));
    child.on('error', (error) => abort(new Error('SPAWN: ' + error.message)));
    child.on('close', (code, signal) => {
      if (!failure) {
        if (!terminal || pending.length)
          failure = new Error(
            'INCOMPLETE: missing terminal receipt or unfinished frame',
          );
        else if (
          fixture.probe_after_terminal
            ? code !== 1 || signal !== null
            : code !== 0 || signal !== null
        )
          failure = new Error(
            'EXIT: unexpected runtime exit ' + code + '/' + signal,
          );
      }
      finish();
    });
    child.stdin.write(requestBytes);
  });
}
module.exports = { PROTOCOL, invoke, sign };
