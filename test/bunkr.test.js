import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = ['src/helpers.js', 'src/bunkr.js', 'src/resolvers/bunkr.js'].map(file => readFileSync(file, 'utf8')).join('\n');

const load = ({ timeoutId = null, malformed = false, ids = ['42', '43'], onMetadata } = {}) => {
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
              ids.map(id => ({
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
          if (onMetadata) {
            onMetadata(id, () => options.onload({ status: 200, responseText, response }));
            return;
          }
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

const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

const flushRequests = () => new Promise(resolve => setImmediate(resolve));

test('Bunkr streams the first signed resource before the last metadata request finishes', async () => {
  const pending = new Map();
  const first = deferred();
  const context = load({ onMetadata: (id, finish) => pending.set(id, finish) });
  const emitted = [];
  let finished = false;
  const resolving = context.resolvers[1][1]('https://bunkr.cr/a/album', context.client, [], 1, {}, undefined, async resource => {
    emitted.push(resource);
    first.resolve();
  });
  resolving.then(() => {
    finished = true;
  });
  await flushRequests();
  pending.get('42')();
  await first.promise;
  expect(emitted).toEqual([{ url: mediaUrl('42'), folderName: 'Album' }]);
  expect(finished).toBe(false);
  pending.get('43')();
  expect((await resolving).resolved).toEqual([]);
  expect(emitted.map(resource => resource.url)).toEqual([mediaUrl('42'), mediaUrl('43')]);
});

test('Bunkr streams album order even when metadata finishes in reverse order', async () => {
  const pending = new Map();
  const context = load({ ids: ['42', '43', '44'], onMetadata: (id, finish) => pending.set(id, finish) });
  const emitted = [];
  const resolving = context.resolvers[1][1]('https://bunkr.cr/a/album', context.client, [], 1, {}, undefined, async resource => {
    emitted.push(resource.url);
  });
  await flushRequests();
  pending.get('44')();
  pending.get('43')();
  await flushRequests();
  expect(emitted).toEqual([]);
  pending.get('42')();
  await resolving;
  expect(emitted).toEqual([mediaUrl('42'), mediaUrl('43'), mediaUrl('44')]);
});

test('Bunkr downstream backpressure stops the resolution window from advancing beyond eight files', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => String(index + 42));
  const started = [];
  const accepting = deferred();
  const release = deferred();
  const context = load({
    ids,
    onMetadata: (id, finish) => {
      started.push(id);
      finish();
    },
  });
  const emitted = [];
  const resolving = context.resolvers[1][1]('https://bunkr.cr/a/album', context.client, [], 1, {}, undefined, async resource => {
    emitted.push(resource.url);
    if (emitted.length === 1) {
      accepting.resolve();
      await release.promise;
    }
  });
  await accepting.promise;
  await flushRequests();
  expect(started).toEqual(ids.slice(0, 8));
  expect(emitted).toEqual([mediaUrl(ids[0])]);
  release.resolve();
  await resolving;
  expect(emitted).toEqual(ids.map(mediaUrl));
});

test('Bunkr propagates consumer failure only after settling in-flight resolutions without scheduling more', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => String(index + 42));
  const pending = new Map();
  const accepting = deferred();
  const failure = new Error('consumer queue failed');
  const context = load({ ids, onMetadata: (id, finish) => pending.set(id, finish) });
  const emitted = [];
  let settled = false;
  const resolving = context.resolvers[1][1]('https://bunkr.cr/a/album', context.client, [], 1, {}, undefined, async resource => {
    emitted.push(resource.url);
    accepting.resolve();
    throw failure;
  });
  const outcome = resolving.then(
    value => {
      settled = true;
      return { value };
    },
    error => {
      settled = true;
      return { error };
    },
  );
  await flushRequests();
  pending.get(ids[0])();
  await accepting.promise;
  await flushRequests();
  expect(settled).toBe(false);
  for (const id of ids.slice(1, 8)) pending.get(id)();
  expect((await outcome).error).toBe(failure);
  expect([...pending.keys()]).toEqual(ids.slice(0, 8));
  expect(emitted).toEqual([mediaUrl(ids[0])]);
});
