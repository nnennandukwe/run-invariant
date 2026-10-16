'use strict';
// Shared strict JSON byte codec; no ThreadLoop corpus or controller code is used.
const codec = require('../threadloop/codec');
module.exports = {
  ...codec,
  frame: (value) => Buffer.from(codec.canonical(value) + '\n'),
  hash: (bytes) => 'sha256:' + codec.sha256(bytes),
  identity: (value) => 'sha256:' + codec.digest(value),
};
