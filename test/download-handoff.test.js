import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/download/transfer.js', 'utf8');
const utilsSource = readFileSync('src/download-utils.js', 'utf8');

const createHandoff = () => {
  const requests = [];
  const watchdogs = [];
  const directs = [];
  const errors = [];
  const run = {
    postId: 1,
    postNumber: 1,
    completed: 0,
    postSettings: { zipped: false },
    statusUI: { status: {}, filePB: {}, totalPB: {} },
    resolved: [{ url: 'https://media.cdn.cr/video.mp4', original: 'https://bunkr.cr/f/video', host: { name: 'Bunkr' } }],
  };
  const sandbox = {
    URL,
    h: { limit: s => s, ui: { setText() {}, setElProps() {} } },
    log: { post: { info() {}, error: (_, message) => errors.push(message) } },
    isFilesterUrl: () => false,
    createDownloadMetadataReader: () => ({}),
    GM_xmlhttpRequest: options => {
      requests.push(options);
      return { abort: () => options.onabort() };
    },
    setInterval: fn => {
      watchdogs.push(fn);
      return watchdogs.length;
    },
    clearInterval() {},
    downloadResourceDirect: (run, batch, attempt, meta, actions) => {
      directs.push({ finish: () => actions.settle(attempt), retry: () => actions.retry(attempt.resource, 2) });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(utilsSource + '\n' + source + '\nglobalThis.runTransfers = runDownloadTransfers;', sandbox);
  return { run, requests, watchdogs, directs, errors, start: () => sandbox.runTransfers(run) };
};

test('DIRECT handoff ignores stale blob completion, errors and watchdogs until DIRECT finishes', async () => {
  const { run, requests, watchdogs, directs, errors, start } = createHandoff();
  const transferring = start();
  requests[0].onprogress({ loaded: 1, total: 600_000_000 });
  // Aborting an already-buffered GM request may still deliver any callback.
  await requests[0].onload({});
  requests[0].onerror();
  requests[0].ontimeout();
  requests[0].onprogress({ loaded: 2, total: 600_000_000 });
  await watchdogs[0]();
  expect(run.completed).toBe(0);
  expect(run.activeTransfers).toBe(1);
  expect(directs).toHaveLength(1);

  directs[0].finish();
  directs[0].finish();
  await transferring;
  await requests[0].onload({});
  expect(run.completed).toBe(1);
  expect(run.activeTransfers).toBe(0);
  expect(errors).toEqual([]);
});

test('DIRECT retry keeps the logical slot and ignores the previous DIRECT completion', async () => {
  const { run, requests, watchdogs, directs, errors, start } = createHandoff();
  const transferring = start();
  requests[0].onprogress({ loaded: 1, total: 600_000_000 });
  await directs[0].retry();
  directs[0].finish();
  await watchdogs[0]();
  expect(run.completed).toBe(0);
  expect(run.activeTransfers).toBe(1);

  requests[1].onprogress({ loaded: 1, total: 600_000_000 });
  directs[1].finish();
  await transferring;
  directs[0].finish();
  expect(run.completed).toBe(1);
  expect(run.activeTransfers).toBe(0);
  expect(errors).toEqual([]);
});

test('the final stalled buffered resource settles instead of resetting its completion counter', async () => {
  const { run, watchdogs, errors, start } = createHandoff();
  const transferring = start();
  await watchdogs[0]();
  await transferring;
  expect(run.completed).toBe(1);
  expect(run.activeTransfers).toBe(0);
  expect(errors).toEqual([expect.stringContaining('Stalled/Failed')]);
});
