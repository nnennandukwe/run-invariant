'use strict';

const { spawn } = require('node:child_process');
const { MAX_BYTES } = require('./codec');

const defaults = Object.freeze({
  timeout_ms: 10_000,
  stdin_bytes: MAX_BYTES + 1,
  stdout_bytes: MAX_BYTES + 1,
  stderr_bytes: 1024 * 1024,
});

function invoke(command, input, limits = defaults) {
  return new Promise((resolve, reject) => {
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((part) => typeof part !== 'string' || part.includes('\0')) ||
      !command[0].trim()
    ) {
      reject(new Error('COMMAND: expected an executable and argument array'));
      return;
    }
    for (const key of Object.keys(defaults)) {
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > (key === 'timeout_ms' ? 60_000 : defaults[key])
      ) {
        reject(new Error(`LIMIT: invalid ${key}`));
        return;
      }
    }
    if (input.length > limits.stdin_bytes) {
      reject(new Error('STDIN_LIMIT: request exceeds runner limit'));
      return;
    }
    const grouped = process.platform !== 'win32';
    const child = spawn(command[0], command.slice(1), {
      shell: false,
      detached: grouped,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure;
    let finished = false;
    let cleanup;
    const timer = setTimeout(
      () => abort(`TIMEOUT: subject exceeded ${limits.timeout_ms}ms`),
      limits.timeout_ms,
    );
    function kill() {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') failure ||= `TERMINATION: ${error.message}`;
      }
    }
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanup);
      if (failure) reject(new Error(failure));
      else resolve({ stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) });
    }
    function abort(message) {
      if (failure || finished) return;
      failure = message;
      kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      // Closing inherited pipes cannot extend the deadline indefinitely.
      cleanup = setTimeout(finish, 1000);
    }
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (bytes) => {
        sizes[stream] += bytes.length;
        if (sizes[stream] > limits[`${stream}_bytes`])
          abort(
            `${stream.toUpperCase()}_LIMIT: subject exceeded ${limits[`${stream}_bytes`]} bytes`,
          );
        else chunks[stream].push(bytes);
      });
      child[stream].on('error', (error) => abort(`PIPE: ${error.message}`));
    }
    child.on('error', (error) => abort(`SPAWN: ${error.message}`));
    child.stdin.on('error', (error) => abort(`STDIN: ${error.message}`));
    child.on('close', (status, signal) => {
      if (status !== 0 && !failure)
        failure = `EXIT: subject status ${status}, signal ${signal}: ${Buffer.concat(chunks.stderr).toString('utf8')}`;
      kill(); // Reap remaining processes in the POSIX group, even after success.
      finish();
    });
    child.stdin.end(input);
  });
}

module.exports = { defaults, invoke };
