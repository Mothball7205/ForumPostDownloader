import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const loadResolver = (file, pattern) => {
  const context = { resolvers: [], h: { re: { match: () => 'token' }, basename: url => url.split('/').pop() } };
  vm.createContext(context);
  vm.runInContext(readFileSync(file, 'utf8'), context);
  return context.resolvers.find(([patterns]) => patterns[0].source === pattern)[1];
};

test('Imgbox rejects missing documents without throwing during iteration', async () => {
  const resolve = loadResolver('src/resolvers/media-hosts.js', 'imgbox.com\\/g\\/');
  expect(await resolve('https://imgbox.com/g/album', { get: async () => ({ dom: null, source: '' }) })).toBeNull();
});

test('Imgbox can resolve images when the gallery title is absent', async () => {
  const resolve = loadResolver('src/resolvers/media-hosts.js', 'imgbox.com\\/g\\/');
  const dom = { querySelector: () => null, querySelectorAll: () => [{ getAttribute: () => 'https://thumbs2.imgbox.com/file_b.jpg' }] };
  const result = await resolve('https://imgbox.com/g/album', { get: async () => ({ dom, source: '' }) });
  expect(result.resolved).toEqual(['https://images2.imgbox.com/file_o.jpg']);
  expect(result.folderName).toBe('album');
});

test('Ibb rejects malformed album JSON without an out-of-scope variable error', async () => {
  const resolve = loadResolver('src/resolvers/gallery-hosts.js', '([a-z](\\d+)?\\.)?ibb.co\\/album\\/[a-zA-Z0-9_.-]+');
  const http = {
    get: async () => ({ source: '', dom: { querySelector: () => ({ innerText: '32' }) } }),
    post: async () => ({ source: '<html>Unavailable</html>' }),
  };
  expect(await resolve('https://ibb.co/album/test', http)).toBeNull();
});
