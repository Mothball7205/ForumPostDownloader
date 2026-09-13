import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDownloadQueue } from '../src/download/queue.js';

const source = ['src/helpers.js', 'src/download/resolution.js'].map(file => readFileSync(file, 'utf8')).join('\n');

const load = () => {
  const errors = [];
  const sandbox = {
    URL,
    log: { separator() {}, post: { info() {}, error: (_, message) => errors.push(message) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.resolveResources = resolveDownloadResources;', sandbox);
  return { resolve: sandbox.resolveResources, errors };
};

const options = resolver => ({
  parsedPost: { postId: 42, postNumber: 3, spoilers: ['Password'] },
  enabledHosts: [{ name: 'Bunkr', type: 'folder', resources: ['https://bunkr.cr/a/first', 'https://bunkr.cr/a/second'] }],
  resolvers: [[[/bunkr/], resolver]],
  postSettings: {},
  statusLabel: { style: {} },
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

const flushResolution = () => new Promise(resolve => setImmediate(resolve));

test('streamed and returned resources share normalized album order without invalid entries or double emission', async () => {
  const { resolve } = load();
  const accepted = [];
  const settings = options(async (url, http, passwords, postId, postSettings, progress, onResolved) => {
    if (url.endsWith('/first')) {
      await onResolved({ url: 'https://media.test/first.mp4', folderName: 'Streamed' });
      await onResolved({ url: 'https://media.test/second.mp4', folderName: 'Streamed' });
      return { folderName: 'Streamed', resolved: [] };
    }
    return {
      folderName: 'Returned',
      resolved: [
        null,
        '',
        { url: undefined },
        'https://media.test/third.mp4',
        { url: 'https://media.test/fourth.mp4', folderName: 'Nested' },
      ],
    };
  });
  const resolved = await resolve({ ...settings, onResource: async resource => accepted.push(resource) });
  expect(accepted.map(resource => [resource.url, resource.folderName, resource.original])).toEqual([
    ['https://media.test/first.mp4', 'Streamed', 'https://bunkr.cr/a/first'],
    ['https://media.test/second.mp4', 'Streamed', 'https://bunkr.cr/a/first'],
    ['https://media.test/third.mp4', 'Returned', 'https://bunkr.cr/a/second'],
    ['https://media.test/fourth.mp4', 'Nested', 'https://bunkr.cr/a/second'],
  ]);
  expect(resolved).toEqual(accepted);
});

test('returned resolver arrays await downstream acceptance before forwarding another resource or resolving the next link', async () => {
  const { resolve } = load();
  const accepting = deferred();
  const release = deferred();
  const visited = [];
  const accepted = [];
  const settings = options(async url => {
    visited.push(url);
    return { folderName: 'Album', resolved: [`${url}/one.mp4`, `${url}/two.mp4`] };
  });
  const resolving = resolve({
    ...settings,
    onResource: async resource => {
      accepted.push(resource.url);
      if (accepted.length === 1) {
        accepting.resolve();
        await release.promise;
      }
    },
  });
  await accepting.promise;
  await flushResolution();
  expect(visited).toEqual(['https://bunkr.cr/a/first']);
  expect(accepted).toEqual(['https://bunkr.cr/a/first/one.mp4']);
  release.resolve();
  await resolving;
  expect(accepted).toEqual([
    'https://bunkr.cr/a/first/one.mp4',
    'https://bunkr.cr/a/first/two.mp4',
    'https://bunkr.cr/a/second/one.mp4',
    'https://bunkr.cr/a/second/two.mp4',
  ]);
});

test('streaming consumer errors propagate unchanged instead of being swallowed as host resolution failures', async () => {
  const { resolve, errors } = load();
  const failure = new Error('queue closed unexpectedly');
  const visited = [];
  const settings = options(async (url, http, passwords, postId, postSettings, progress, onResolved) => {
    visited.push(url);
    await onResolved({ url: 'https://media.test/first.mp4', folderName: 'Album' });
    return { resolved: [] };
  });
  await expect(
    resolve({
      ...settings,
      onResource: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(visited).toEqual(['https://bunkr.cr/a/first']);
  expect(errors).toEqual([]);
});

test('returned-array consumer errors stop forwarding and prevent subsequent link resolution', async () => {
  const { resolve, errors } = load();
  const failure = new Error('download failed');
  const visited = [];
  const accepted = [];
  const settings = options(async url => {
    visited.push(url);
    return { resolved: [`${url}/one.mp4`, `${url}/two.mp4`] };
  });
  await expect(
    resolve({
      ...settings,
      onResource: async resource => {
        accepted.push(resource.url);
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(visited).toEqual(['https://bunkr.cr/a/first']);
  expect(accepted).toEqual(['https://bunkr.cr/a/first/one.mp4']);
  expect(errors).toEqual([]);
});

test('legacy resolver failures remain recoverable for later links', async () => {
  const { resolve, errors } = load();
  const settings = options(async (url, http, passwords, postId, postSettings, progressCB) => {
    if (url.endsWith('/first')) throw new Error('host unavailable');
    progressCB('Resolving album page 2');
    return { folderName: 'Album', resolved: ['https://media.test/surviving.mp4'] };
  });
  const resolved = await resolve({ ...settings, statusLabel: null, onProgress() {} });
  expect(resolved.map(resource => resource.url)).toEqual(['https://media.test/surviving.mp4']);
  expect(errors).toHaveLength(1);
});

test('different sites resolve concurrently while each site keeps one ordered lane', async () => {
  const { resolve } = load();
  const urls = [
    'https://bunkr.cr/first',
    'https://bunkr.cr/second',
    'https://cyberdrop.cr/album',
    'https://bunkr.cr/album',
    'https://redgifs.com/profile',
  ];
  const gates = new Map(urls.map(url => [url, deferred()]));
  const visited = [];
  const accepted = [];
  const queue = createDownloadQueue(2);
  const consuming = (async () => {
    for await (const resource of queue) accepted.push(resource.original);
  })();
  const resolving = resolve({
    ...options(null),
    enabledHosts: [
      { name: 'Bunkr', type: 'file', resources: urls.slice(0, 2) },
      { name: 'Cyberdrop', resources: [urls[2]] },
      { name: 'bUnKr', type: 'folder', resources: [urls[3]] },
      { name: 'Redgifs', resources: [urls[4]] },
    ],
    resolvers: [
      [
        [/https:/],
        async url => {
          visited.push(url);
          await gates.get(url).promise;
          return `${url}/download.mp4`;
        },
      ],
    ],
    onResource: resource => queue.push(resource),
    onError: queue.fail,
    onProgress() {},
  });
  await flushResolution();
  expect(visited).toEqual([urls[0], urls[2], urls[4]]);
  gates.get(urls[2]).resolve();
  await flushResolution();
  expect(accepted).toEqual([urls[2]]);
  gates.get(urls[0]).resolve();
  await flushResolution();
  expect(visited).toEqual([urls[0], urls[2], urls[4], urls[1]]);
  gates.get(urls[1]).resolve();
  await flushResolution();
  expect(visited.at(-1)).toBe(urls[3]);
  gates.get(urls[3]).resolve();
  gates.get(urls[4]).resolve();
  const result = await resolving;
  queue.close();
  await consuming;
  expect(result.map(resource => resource.original)).toEqual(urls);
  expect(new Set(accepted)).toEqual(new Set(urls));
});

test('a fatal acceptance error wakes other sites blocked on the full ready queue', async () => {
  const { resolve } = load();
  const queue = createDownloadQueue(1);
  await queue.push({ url: 'already queued' });
  const failure = new Error('consumer failed');
  const accepting = deferred();
  const resolving = resolve({
    ...options(null),
    enabledHosts: [
      { name: 'Bunkr', resources: ['https://bunkr.cr/one', 'https://bunkr.cr/two'] },
      { name: 'Cyberdrop', resources: ['https://cyberdrop.cr/one'] },
    ],
    resolvers: [[[/https:/], async url => `${url}/download.mp4`]],
    onProgress() {},
    onError: queue.fail,
    onResource: async resource => {
      if (resource.host.name === 'Cyberdrop') {
        await accepting.promise;
        throw failure;
      }
      accepting.resolve();
      await queue.push(resource);
    },
  });
  await expect(resolving).rejects.toBe(failure);
  await expect(queue.next()).rejects.toBe(failure);
});

test('fatal resolution waits for active sites to drain without starting their next link', async () => {
  const { resolve } = load();
  const release = deferred();
  const notified = deferred();
  const visited = [];
  const failure = new Error('queue failed');
  let finished = false;
  const resolving = resolve({
    ...options(null),
    enabledHosts: [
      { name: 'Bunkr', resources: ['https://bunkr.cr/one'] },
      { name: 'Cyberdrop', resources: ['https://cyberdrop.cr/one', 'https://cyberdrop.cr/two'] },
    ],
    resolvers: [
      [
        [/https:/],
        async url => {
          visited.push(url);
          if (url.includes('cyberdrop')) await release.promise;
          return `${url}/download.mp4`;
        },
      ],
    ],
    onResource: async () => {
      throw failure;
    },
    onError: () => notified.resolve(),
    onProgress() {},
  }).finally(() => {
    finished = true;
  });
  await notified.promise;
  await flushResolution();
  expect(finished).toBe(false);
  release.resolve();
  await expect(resolving).rejects.toBe(failure);
  expect(visited).toEqual(['https://bunkr.cr/one', 'https://cyberdrop.cr/one']);
});
