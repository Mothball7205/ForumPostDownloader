const fs = require('fs');

const content = fs.readFileSync('dist/build.user.js', 'utf8');
const lines = content.split('\n');
if (lines[lines.length - 1] === '') lines.pop();

const FILES = [
  ['header.js', 1, 152],
  ['globals.js', 153, 279],
  ['host-caches.js', 280, 443],
  ['bunkr.js', 444, 756],
  ['helpers.js', 757, 1133],
  ['prototypes.js', 1134, 1137],
  ['parsers.js', 1138, 1498],
  ['styles.js', 1499, 1504],
  ['ui.js', 1505, 2039],
  ['init.js', 2040, 2102],
  ['hosts.js', 2103, 2163],
  ['turbo.js', 2164, 2242],
  ['resolvers.js', 2243, 5728],
  ['download.js', 5729, 8127],
  ['post-actions.js', 8128, 8294],
  ['main.js', 8295, 8521],
];

fs.mkdirSync('src', { recursive: true });
for (const [file, start, end] of FILES) {
  fs.writeFileSync(`src/${file}`, lines.slice(start - 1, end).join('\n'));
}
