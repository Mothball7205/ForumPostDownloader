const fs = require('fs');
const path = require('path');
const FILES = [
  'header.js',
  'globals.js',
  'host-caches.js',
  'bunkr.js',
  'helpers.js',
  'prototypes.js',
  'parsers.js',
  'styles.js',
  'ui.js',
  'init.js',
  'hosts.js',
  'turbo.js',
  'resolvers.js',
  'download-utils.js',
  'download.js',
  'post-actions.js',
  'main.js',
];
const out = FILES.map(f => fs.readFileSync(path.join('src', f), 'utf8')).join('\n') + '\n';
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/build.user.js', out);
console.log('dist/build.user.js (%d bytes)', Buffer.byteLength(out));
