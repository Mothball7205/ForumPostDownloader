import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = ['src/download-utils.js', 'src/download/queue.js', 'src/download/transfer.js']
  .map(path => readFileSync(path, 'utf8'))
  .join('\n');

const mailbox = () => {
  const values = [];
  const readers = [];
  return {
    push(value) {
      const reader = readers.shift();
      if (reader) reader(value);
      else values.push(value);
    },
    next() {
      if (values.length) return Promise.resolve(values.shift());
      return new Promise(resolve => readers.push(resolve));
    },
  };
};

const resource = (name, url = `https://cdn.example.com/${name}`) => ({
  url,
  original: url,
  host: { name: 'Example' },
});
const response = name => ({ status: 200, responseHeaders: 'content-type: application/octet-stream', response: { name, size: 100_000 } });

const createTransfers = ({ zipped = true, concurrency = 2, metadata = async () => ({}) } = {}) => {
  const requests = mailbox();
  const saves = mailbox();
  const started = [];
  const archived = [];
  const revoked = [];
  const errors = [];
  const changes = [];
  let timerId = 0;
  const run = {
    postId: 1,
    postNumber: 1,
    completed: 0,
    totalDownloadable: 0,
    transferConcurrency: concurrency,
    resolving: true,
    postSettings: { zipped },
    statusUI: { status: {}, filePB: {}, totalPB: {} },
    resolved: [],
    names: {
      capture() {},
      plan: ({ url }) => {
        const name = new URL(url).pathname.split('/').pop();
        return { basename: name, relativePath: name, saveAsName: name };
      },
    },
    zip: { file: name => archived.push(name) },
    zipFileCount: 0,
    onTransferProgress: () => changes.push({ active: run.activeTransfers, completed: run.completed }),
  };
  class DownloadURL extends URL {
    static createObjectURL(blob) {
      return `blob:${blob.name}`;
    }
    static revokeObjectURL(url) {
      revoked.push(url);
    }
  }
  const sandbox = {
    URL: DownloadURL,
    h: { limit: value => value, ui: { setText() {}, setElProps() {} } },
    log: { separator() {}, post: { info() {}, error: (_, message) => errors.push(message) } },
    isFilesterUrl: () => false,
    createDownloadMetadataReader: () => ({ readDownloadMetadata: metadata }),
    GM_xmlhttpRequest: options => {
      started.push(options.url);
      requests.push(options);
      return { abort: () => options.onabort() };
    },
    GM_download: options => saves.push(options),
    setInterval: () => ++timerId,
    clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.createQueue = createDownloadQueue; globalThis.runTransfers = runDownloadTransfers;', sandbox);
  run.resourceQueue = sandbox.createQueue(4);
  return {
    run,
    requests,
    saves,
    started,
    archived,
    revoked,
    errors,
    changes,
    enqueue: item => {
      run.totalDownloadable++;
      return run.resourceQueue.push(item);
    },
    start: () => sandbox.runTransfers(run),
  };
};

test('production overlaps transfers and each free slot refills before slower siblings finish', async () => {
  const { run, requests, started, archived, changes, enqueue, start } = createTransfers();
  let finished = false;
  const transferring = start().then(() => {
    finished = true;
  });
  await enqueue(resource('first'));
  const first = await requests.next();
  expect(run.totalDownloadable).toBe(1);
  expect(run.resolving).toBe(true);

  await enqueue(resource('second'));
  const second = await requests.next();
  await enqueue(resource('third'));
  expect(run.activeTransfers).toBe(2);
  expect(started).toEqual([resource('first').url, resource('second').url]);

  await second.onload(response('second'));
  const third = await requests.next();
  expect(started).toEqual([resource('first').url, resource('second').url, resource('third').url]);
  expect(run.activeTransfers).toBe(2);
  expect(archived).toEqual(['second']);

  run.resolving = false;
  run.resourceQueue.close();
  await third.onload(response('third'));
  expect(finished).toBe(false);
  expect(run.activeTransfers).toBe(1);
  await first.onload(response('first'));
  await transferring;
  expect(archived.sort()).toEqual(['first', 'second', 'third']);
  expect(run.completed).toBe(3);
  expect(run.totalDownloadable).toBe(3);
  expect(changes).toEqual([
    { active: 1, completed: 0 },
    { active: 2, completed: 0 },
    { active: 1, completed: 1 },
    { active: 2, completed: 1 },
    { active: 1, completed: 2 },
    { active: 0, completed: 3 },
  ]);
});

test('async setup and network errors settle their logical resources and release the single slot', async () => {
  const { run, requests, archived, errors, enqueue, start } = createTransfers({
    concurrency: 1,
    metadata: async () => {
      throw new Error('metadata unavailable');
    },
  });
  await enqueue(resource('broken', 'https://pixeldrain.com/api/file/broken'));
  await enqueue(resource('network'));
  await enqueue(resource('saved'));
  run.resourceQueue.close();
  const transferring = start();
  const network = await requests.next();
  expect(network.url).toBe(resource('network').url);
  expect(run.completed).toBe(1);
  network.onerror();
  const saved = await requests.next();
  expect(saved.url).toBe(resource('saved').url);
  expect(run.activeTransfers).toBe(1);
  await network.onload(response('network'));
  await saved.onload(response('saved'));
  await transferring;
  expect(run.completed).toBe(3);
  expect(run.activeTransfers).toBe(0);
  expect(archived).toEqual(['saved']);
  expect(errors).toEqual([expect.stringContaining('metadata unavailable'), expect.stringContaining('Network request failed')]);
});

test('blob disk saves hold the slot after queue close and settle once after success or failure', async () => {
  const { run, requests, saves, revoked, errors, enqueue, start } = createTransfers({ zipped: false, concurrency: 1 });
  await enqueue(resource('first'));
  await enqueue(resource('second'));
  run.resourceQueue.close();
  const transferring = start();
  const first = await requests.next();
  const loadingFirst = first.onload(response('first'));
  const firstSave = await saves.next();
  expect(firstSave.name).toBe('first');
  expect(run.completed).toBe(0);
  expect(run.activeTransfers).toBe(1);
  // Blob delivery is terminal even when the asynchronous disk save is pending.
  first.onerror();
  await first.onload(response('first'));
  firstSave.onerror(new Error('disk full'));
  firstSave.onload();
  await loadingFirst;

  const second = await requests.next();
  const loadingSecond = second.onload(response('second'));
  const secondSave = await saves.next();
  expect(run.completed).toBe(1);
  expect(run.activeTransfers).toBe(1);
  secondSave.onload();
  secondSave.ontimeout(new Error('late timeout'));
  await loadingSecond;
  await transferring;
  expect(run.completed).toBe(2);
  expect(run.activeTransfers).toBe(0);
  expect(revoked).toEqual(['blob:first', 'blob:second']);
  expect(errors).toEqual([expect.stringContaining('disk full')]);
});

test('consumer failure fails the queue immediately but waits for active sibling saves before rejecting', async () => {
  const { run, requests, saves, enqueue, start } = createTransfers({ zipped: false });
  const failure = new Error('progress callback failed');
  run.onTransferProgress = () => {
    if (run.completed === 1) throw failure;
  };
  await enqueue(resource('first'));
  await enqueue(resource('second'));
  let finished = false;
  const transferring = start().catch(error => {
    finished = true;
    throw error;
  });
  const first = await requests.next();
  const second = await requests.next();
  const loadingSecond = second.onload(response('second'));
  const secondSave = await saves.next();
  first.onerror();
  await expect(run.resourceQueue.next()).rejects.toBe(failure);
  expect(finished).toBe(false);
  expect(run.activeTransfers).toBe(1);
  secondSave.onload();
  await loadingSecond;
  await expect(transferring).rejects.toBe(failure);
  expect(run.activeTransfers).toBe(0);
});

test('queue concurrency two still allows only one GoFile transfer at a time', async () => {
  const { run, requests, started, archived, enqueue, start } = createTransfers();
  const firstResource = resource('first', 'https://gofile.io/download/web/id/first');
  const secondResource = resource('second', 'https://gofile.io/download/web/id/second');
  await enqueue(firstResource);
  await enqueue(secondResource);
  await enqueue(resource('third'));
  run.resourceQueue.close();
  const transferring = start();
  const first = await requests.next();
  expect(started).toEqual([firstResource.url]);
  expect(run.activeTransfers).toBe(1);
  await first.onload(response('first'));
  const next = await requests.next();
  const last = await requests.next();
  expect(new Set([next.url, last.url])).toEqual(new Set([secondResource.url, resource('third').url]));
  expect(run.activeTransfers).toBe(2);
  await next.onload(response('next'));
  await last.onload(response('last'));
  await transferring;
  expect(archived.sort()).toEqual(['first', 'second', 'third']);
  expect(run.completed).toBe(3);
});
