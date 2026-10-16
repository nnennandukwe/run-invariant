'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { manifest, checkManifest } = require('../src/runtime/sources');
const { frame } = require('../src/runtime/codec');
try {
  if (
    process.argv.length !== 3 ||
    !['--check', '--write'].includes(process.argv[2])
  )
    throw new Error('Usage: node scripts/runtime-manifest.js --check|--write');
  if (process.argv[2] === '--write')
    fs.writeFileSync(
      path.join(__dirname, '../runtime/manifest.v0.2.0.json'),
      frame(manifest()),
    );
  else checkManifest();
  process.stdout.write(
    'Runtime manifest: ' +
      (process.argv[2] === '--write' ? 'WRITTEN' : 'MATCH') +
      '\n',
  );
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
