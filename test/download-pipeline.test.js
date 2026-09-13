import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDownloadQueue } from '../src/download/queue.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

const load = overrides => {
  const events = [];
  const element = () => ({
    style: {},
    remove() {
      events.push('remove-progress');
    },
  });
  const status = { ...element(), ownerDocument: { createElement: element }, before() {} };
  const context = {
    events,
    createDownloadQueue,
    window: { logs: [], isFF: false },
    processing: [],
    gofileRestoreCookie: async () => {
      events.push('restore');
    },
    h: {
      ui: {
        setElProps: (el, props) => Object.assign(el.style, props),
        setText: (el, text) => {
          el.textContent = text;
        },
      },
      show() {},
    },
    log: { separator() {}, post: { info() {} } },
    parsers: { thread: { parseTitle: () => 'Thread' } },
    JSZip: class {},
    createDownloadNamePlanner: () => ({}),
    createDownloadMetadataReader: () => ({ readDownloadMetadata() {} }),
    captureDownloadHints() {},
    isFilesterAlbumOriginal: url => url.includes('filester.me/f/'),
    computeBatchLength: () => 1,
    removeDuplicateDownloadResources: resources => {
      events.push('dedupe');
      return resources;
    },
    applyFilesterAlbumPolicy: async () => {
      events.push('policy');
    },
    finalizeDownloadArtifacts: async () => {
      events.push('archive');
    },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(
    readFileSync('src/download/lifecycle.js', 'utf8') +
      '\n' +
      readFileSync('src/download.js', 'utf8') +
      '\nglobalThis.download = downloadPost;',
    context,
  );
  const run = (options = {}, hosts = [{ name: 'Bunkr', resources: ['https://bunkr.cr/a/album'] }]) =>
    context.download(
      { postId: 'post', postNumber: 1 },
      hosts,
      hosts => hosts,
      [],
      () => ({ output: [], ...options }),
      { status, filePB: element(), totalPB: element() },
      { onComplete: (...args) => events.push(['complete', ...args]) },
    );
  return { run, events, context };
};

test('post downloads start before resolution ends and finalization waits for both stages', async () => {
  const firstDownload = deferred();
  const finishResolution = deferred();
  const producedAll = deferred();
  const finishSave = deferred();
  const resources = [{ url: 'https://cdn.example/first' }, { url: 'https://cdn.example/second' }];
  const { run, events, context } = load({
    resolveDownloadResources: async ({ onResource }) => {
      await onResource(resources[0]);
      await finishResolution.promise;
      await onResource(resources[1]);
      producedAll.resolve();
      return resources;
    },
    runDownloadTransfers: async state => {
      for await (const resource of state.resourceQueue) {
        events.push(resource.url);
        firstDownload.resolve();
        await finishSave.promise;
        state.completed++;
      }
    },
  });
  const pending = run();
  await firstDownload.promise;
  expect(events).toEqual(['https://cdn.example/first']);
  expect(context.processing[0].processing).toBe(true);
  finishResolution.resolve();
  await producedAll.promise;
  expect(events).not.toContain('archive');
  expect(events).not.toContain('restore');
  finishSave.resolve();
  await pending;
  expect(events.indexOf('https://cdn.example/second')).toBeLessThan(events.indexOf('archive'));
  expect(events).toContainEqual(['complete', 2, 2]);
  expect(events.at(-1)).toBe('restore');
  expect(context.processing[0].processing).toBe(false);
});

test('post-wide duplicate filtering remains before any download', async () => {
  const { run, events } = load({
    resolveDownloadResources: async ({ onResource }) => {
      expect(onResource).toBeUndefined();
      return [{ url: 'one' }];
    },
    runDownloadTransfers: async state => {
      expect(state.resourceQueue).toBeUndefined();
      events.push('transfer');
    },
  });
  await run({ skipDuplicates: true });
  expect(events.indexOf('dedupe')).toBeLessThan(events.indexOf('transfer'));
});

test('mixed Bunkr and Filester albums keep the complete album policy before downloads', async () => {
  const { run, events } = load({
    resolveDownloadResources: async ({ onResource }) => {
      expect(onResource).toBeUndefined();
      return [{ url: 'one' }];
    },
    runDownloadTransfers: async state => {
      expect(state.resourceQueue).toBeUndefined();
      events.push('transfer');
    },
  });
  await run({}, [
    { name: 'Bunkr', resources: ['https://bunkr.cr/a/album'] },
    { name: 'Filester', resources: ['https://filester.me/f/album'] },
  ]);
  expect(events.indexOf('policy')).toBeLessThan(events.indexOf('transfer'));
});

test('consumer failure unblocks production before post cleanup', async () => {
  const failure = new Error('download worker failed');
  const { run, events } = load({
    resolveDownloadResources: async ({ onResource }) => {
      try {
        for (let index = 0; index < 30; index++) await onResource({ url: `https://cdn.example/${index}` });
        return [];
      } finally {
        events.push('producer-ended');
      }
    },
    runDownloadTransfers: async state => {
      await state.resourceQueue.next();
      throw failure;
    },
  });
  await expect(run()).rejects.toBe(failure);
  expect(events).not.toContain('archive');
  expect(events.indexOf('producer-ended')).toBeLessThan(events.indexOf('restore'));
});
