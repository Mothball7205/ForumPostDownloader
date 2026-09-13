import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/download/transfer.js', 'utf8');
const utilsSource = readFileSync('src/download-utils.js', 'utf8');

test('DIRECT handoff ignores stale blob completion and stall watchdog', async () => {
  let request;
  let watchdog;
  let finishDirect;
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
    h: {
      limit: s => s,
      ui: { setText() {}, setElProps() {} },
      delayedResolve: async () => {
        request.onprogress({ loaded: 1, total: 600_000_000 });
        // Aborting an already-buffered GM request may still deliver onload.
        await request.onload({});
        await watchdog();
        finishDirect();
      },
    },
    log: { post: { info() {}, error: (_, message) => errors.push(message) } },
    isFilesterUrl: () => false,
    createDownloadMetadataReader: () => ({}),
    BUNKR_DIRECT_MIN_BYTES: 500_000_000,
    GM_xmlhttpRequest: options => {
      request = options;
      return { abort() {} };
    },
    setInterval: fn => {
      watchdog = fn;
      return 1;
    },
    clearInterval() {},
    downloadResourceDirect: (run, batch, attempt, meta, actions) => {
      finishDirect = () => actions.settle(attempt);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(utilsSource + '\n' + source + '\nglobalThis.runTransfers = runDownloadTransfers;', sandbox);
  await sandbox.runTransfers(run);
  expect(run.completed).toBe(1);
  expect(errors).toEqual([]);
});
