'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { MAX_BYTES } = require('./codec');

function readArtifact(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':'))
    throw new Error(`Unsafe artifact path: ${relative}`);
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || path.isAbsolute(relative))
    throw new Error(`Unsafe artifact path: ${relative}`);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (!fs.lstatSync(current).isDirectory())
      throw new Error(`${relative}: expected real directory`);
  }
  current = path.join(current, parts.at(-1));
  const handle = fs.openSync(
    current,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const opened = fs.fstatSync(handle);
    const named = fs.lstatSync(current);
    if (
      !opened.isFile() ||
      !named.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.size > MAX_BYTES + 1
    ) {
      throw new Error(`${relative}: expected bounded regular file`);
    }
    const confined = path.join(fs.realpathSync(root), ...parts);
    if (fs.realpathSync(current) !== confined)
      throw new Error(`${relative}: path escaped through a symlink`);
    const chunks = [];
    let size = 0;
    while (size <= MAX_BYTES + 1) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 2 - size));
      const count = fs.readSync(handle, chunk, 0, chunk.length, null);
      if (!count) return Buffer.concat(chunks, size);
      size += count;
      if (size > MAX_BYTES + 1) throw new Error(`${relative}: byte limit exceeded`);
      chunks.push(chunk.subarray(0, count));
    }
    throw new Error(`${relative}: byte limit exceeded`);
  } finally {
    fs.closeSync(handle);
  }
}

function verifyInventory(directory, expected) {
  const remaining = new Set(expected);
  if (remaining.size !== expected.length) throw new Error(`${directory}: duplicate inventory`);
  const handle = fs.opendirSync(directory);
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      if (!remaining.delete(entry.name))
        throw new Error(`${directory}: unlisted artifact: ${entry.name}`);
    }
  } finally {
    handle.closeSync();
  }
  if (remaining.size)
    throw new Error(`${directory}: missing artifacts: ${[...remaining].join(', ')}`);
}

module.exports = { readArtifact, verifyInventory };
