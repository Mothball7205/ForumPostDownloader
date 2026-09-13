import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

test('legacy resolver failures remain recoverable and positional progress callbacks work without a status label', async () => {
  const { resolve, errors } = load();
  const progress = [];
  const settings = options(async (url, http, passwords, postId, postSettings, progressCB) => {
    if (url.endsWith('/first')) throw new Error('host unavailable');
    progressCB('Resolving album page 2');
    return { folderName: 'Album', resolved: ['https://media.test/surviving.mp4'] };
  });
  const resolved = await resolve({ ...settings, statusLabel: null, onProgress: text => progress.push(text) });
  expect(resolved.map(resource => resource.url)).toEqual(['https://media.test/surviving.mp4']);
  expect(errors).toHaveLength(1);
  expect(progress).toContain('Resolving album page 2');
});
