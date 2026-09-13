import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = ['src/helpers.js', 'src/bunkr.js', 'src/resolvers/bunkr.js'].map(file => readFileSync(file, 'utf8')).join('\n');

const load = ({ timeoutId = null, malformed = false } = {}) => {
  const sandbox = {
    URL,
    resolvers: [],
    bunkrNameByUrl: new Map(),
    console,
    setTimeout,
    clearTimeout,
    http: options => {
      queueMicrotask(() => {
        const url = new URL(options.url);
        let responseText = '',
          response = null;
        if (url.pathname.startsWith('/a/')) {
          response = {
            querySelector: selector => (selector === 'h1' ? { textContent: 'Album' } : null),
            querySelectorAll: () =>
              ['42', '43'].map(id => ({
                getAttribute: () => `original-${id}.mp4`,
                querySelector: () => ({ getAttribute: () => `/f/${id}` }),
              })),
          };
        } else if (/\/(f|v)\//.test(url.pathname)) {
          response = {
            querySelector: selector =>
              selector === '[data-file-id]'
                ? {
                    getAttribute: () =>
                      url.pathname
                        .split('/')
                        .pop()
                        .replace(/\.mp4$/, ''),
                  }
                : null,
          };
        } else if (url.origin === 'https://dl.bunkr.cr' && url.pathname === '/api/_001_v2') {
          const { id } = JSON.parse(options.data);
          if (id === timeoutId) {
            // A nonresponding request only settles when the caller sets a deadline.
            if (options.timeout > 0) options.ontimeout();
            return;
          }
          responseText = JSON.stringify(
            malformed ? {} : { mediafiles: 'https://media.cdn.cr', path: `/storage/${id}.mp4`, original: `original-${id}.mp4` },
          );
        } else if (url.origin === 'https://glb-apisign.cdn.cr') {
          responseText = JSON.stringify({ token: 'signed', ex: 123 });
        } else {
          options.onerror(new Error(`Unexpected endpoint: ${url}`));
          return;
        }
        options.onload({ status: 200, responseText, response });
      });
      return { abort() {} };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.client = h.http;', sandbox);
  return sandbox;
};

const mediaUrl = id => `https://media.cdn.cr/storage/${id}.mp4?n=original-${id}.mp4&token=signed&ex=123`;

test('legacy Bunkr CDN media uses current metadata, original filename and signing', async () => {
  const context = load();
  expect(await context.resolvers[0][1]('https://cdn12.bunkr.cr/42.mp4', context.client)).toBe(mediaUrl('42'));
});

test('non-legacy direct media remains directly downloadable', async () => {
  const context = load();
  expect(await context.resolvers[0][1]('https://i.bunkr.cr/photo.jpg', context.client)).toBe('https://i.bunkr.cr/photo.jpg');
});

test('failed Bunkr resolution does not download an HTML view page', async () => {
  const context = load({ malformed: true });
  expect(await context.resolvers[0][1]('https://bunkr.cr/f/42', context.client)).toBeNull();
});

test('Bunkr album resolves current metadata and stops on a repeated page', async () => {
  const context = load();
  const result = await context.resolvers[1][1]('https://bunkr.cr/a/album', context.client);
  expect(result.folderName).toBe('Album');
  expect(result.resolved).toEqual([mediaUrl('42'), mediaUrl('43')]);
  expect(context.bunkrNameByUrl.get(mediaUrl('42'))).toBe('original-42.mp4');
});

test('a stalled Bunkr metadata request does not hold the album worker pool open', async () => {
  const context = load({ timeoutId: '42' });
  const result = await context.resolvers[1][1]('https://bunkr.cr/a/album', context.client);
  expect(result.resolved).toEqual([mediaUrl('43')]);
});
