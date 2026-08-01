import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const build = readFileSync('build.js', 'utf8');
const filesMatch = build.match(/const FILES = (\[[\s\S]*?\]);/);
if (!filesMatch) throw new Error('could not find FILES in build.js');
const files = eval(filesMatch[1]);

const source = files
  .filter(f => f.startsWith('resolvers/'))
  .map(f => readFileSync(join('src', f), 'utf8'))
  .join('\n');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source + '\nglobalThis.__resolvers = resolvers;', sandbox);
const resolvers = sandbox.__resolvers;

const patternToRegex = pattern => {
  let str = pattern.toString();
  const neg = str.includes(':!');
  str = str.replace(':!', '');
  if (str.includes('/')) {
    const rev = [...str].reverse().join('');
    const idx = rev.indexOf('/');
    str = [...rev.slice(idx)].reverse().join('');
  }
  if (str.startsWith('/')) str = str.slice(1);
  if (str.endsWith('/')) str = str.slice(0, -1);
  return { re: new RegExp(str, 'is'), neg };
};

const firstMatch = url => {
  for (let i = 0; i < resolvers.length; i++) {
    const patterns = resolvers[i][0];
    let ok = true;
    for (const p of patterns) {
      const { re, neg } = patternToRegex(p);
      if (neg ? re.test(url) : !re.test(url)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
};

const samples = [
  'https://nitter.net/pic/orig/media%2Fabc123',
  'https://img100.imagevenue.com/loc123/456_abc.jpg',
  'https://pomf2.lain.la/f/abc123.png',
  'https://coomer.st/data/thumb/xyz',
  'https://coomer.st/onlyfans/user/123',
  'https://postimg.cc/abc123',
  'https://kemono.cr/data/xyz',
  'https://goonbox.cr/img/abc123',
  'https://goonbox.cr/a/abc123',
  'https://jpg6.church/img/abc/xyz.jpg',
  'https://jpg6.church/a/abc123',
  'https://ibb.co/abc123',
  'https://i.ibb.co/abc/xyz.jpg',
  'https://ibb.co/album/abc123',
  'https://t1.pixhost.to/thumbs/abc/xyz.jpg',
  'https://pixhost.to/gallery/abc123',
  'https://bunkr.cr/f/abc123',
  'https://bunkr.cr/a/abc123',
  'https://give.xxx/profile/abc',
  'https://pixeldrain.com/u/abc123',
  'https://www.pornhub.com/view_video.php?viewkey=abc',
  'https://gofile.io/d/abc123',
  'https://cyberfile.me/f/abc123',
  'https://cyberfile.me/folder/abc123',
  'https://turbo.cr/a/abc123',
  'https://turbo.cr/v/abc123',
  'https://public.onlyfans.com/files/abc123',
  'https://turbo.cr/embed/abc123',
  'https://www.redgifs.com/users/foo',
  'https://www.redgifs.com/watch/abc123',
  'https://cyberdrop.cr/a/abc123',
  'https://cyberdrop.cr/f/abc123',
  'https://noodlemagazine.com/watch/v123456',
  'https://spankbang.com/abc/video/name',
  'https://www.imagebam.com/view/abc123',
  'https://images2.imagebam.com/abc/xyz.jpg',
  'https://imgvb.com/images/abc/xyz.th.jpg',
  'https://imgvb.com/album/abc123',
  'https://simpcity.su/attachments/xyz-jpg.123456/',
  'https://images2.imgbox.com/abc/xyz_th.jpg',
  'https://imgbox.com/g/abc123',
  'https://filester.me/f/abc123',
  'https://filester.me/d/abc123',
  'https://m.box.com/s/abc123',
  'https://pbs.twimg.com/media/abc123.jpg',
  'https://disk.yandex.ru/d/abc123',
  'https://i.redd.it/abc123.jpg',
];

test('resolver table is complete and well-formed', () => {
  expect(Array.isArray(resolvers)).toBe(true);
  expect(resolvers).toHaveLength(47);
  for (const entry of resolvers) {
    expect(Array.isArray(entry)).toBe(true);
    expect(entry).toHaveLength(2);
    const [patterns, fn] = entry;
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(Object.prototype.toString.call(p)).toBe('[object RegExp]');
    }
    expect(patterns.some(p => !p.toString().includes(':!'))).toBe(true);
    expect(typeof fn).toBe('function');
  }
});

test('each sample URL resolves to exactly its entry', () => {
  expect(samples).toHaveLength(47);
  samples.forEach((url, i) => {
    expect(firstMatch(url)).toBe(i);
  });
});
