import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync('src/goonbox.js', 'utf8');
const gallerySource = readFileSync('src/resolvers/gallery-hosts.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const blockedHttp = { get: async () => ({ status: 403, source: '<html>Challenge</html>' }) };
const imagePage = id => `https://goonbox.cr/img/${id}`;
const imageBody = id => JSON.stringify({ image: { original_url: `https://cdn.example/${id}.jpg` } });

function bridgeEnvironment(fetchImpl) {
  let now = 100000;
  let nextId = 0;
  const timers = new Map();
  const listeners = new Map();
  const storage = new Map();
  const helpers = [];
  const fetches = [];
  const emit = (key, value) => {
    const oldValue = storage.get(key);
    if (value === undefined) storage.delete(key);
    else storage.set(key, structuredClone(value));
    for (const { key: watched, callback } of listeners.values()) {
      if (key === watched) queueMicrotask(() => callback(key, oldValue, structuredClone(value), true));
    }
  };
  const tab = href => {
    const events = new Map();
    const context = {
      URL,
      URLSearchParams,
      AbortController,
      crypto: { randomUUID },
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      location: new URL(href),
      setTimeout: (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { at: now + Math.max(0, delay), callback });
        return id;
      },
      clearTimeout: id => timers.delete(id),
      GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
      GM_setValue: emit,
      GM_deleteValue: key => emit(key, undefined),
      GM_addValueChangeListener: (key, callback) => {
        const id = ++nextId;
        listeners.set(id, { key, callback });
        return id;
      },
      GM_removeValueChangeListener: id => listeners.delete(id),
      GM_openInTab: url => {
        const helper = tab(url);
        helpers.push(helper);
        helper.goonboxBridgeServe();
        return helper;
      },
      xfpdCloseTabHandle: handle => handle?.close(),
      fetch: (url, options) => {
        fetches.push(url);
        return fetchImpl(url, options);
      },
      closed: false,
      close: () => {
        if (context.closed) return;
        context.closed = true;
        for (const callback of events.get('pagehide') || []) callback();
      },
    };
    context.window = {
      addEventListener: (type, callback) => {
        if (!events.has(type)) events.set(type, []);
        events.get(type).push(callback);
      },
      close: context.close,
    };
    context.window.top = context.window.self = context.window;
    vm.createContext(context);
    vm.runInContext(source, context);
    return context;
  };
  const advance = async duration => {
    const target = now + duration;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    now = target;
    await flush();
  };
  return { tab, helpers, storage, emit, fetches, advance, now: () => now };
}

test('concurrent forum tabs reject foreign and stale replies while preserving their own originals', async () => {
  const finish = new Map();
  const env = bridgeEnvironment(url => ({
    status: 200,
    text: () => new Promise(resolve => finish.set(new URL(url).pathname.split('/').pop(), resolve)),
  }));
  const first = env.tab('https://simpcity.cr/threads/first');
  const second = env.tab('https://simpcity.cr/threads/second');
  let firstSettled = false;
  const a = first.goonboxApiJson(blockedHttp, '/api/images/first', imagePage('first')).then(value => {
    firstSettled = true;
    return value;
  });
  const b = second.goonboxApiJson(blockedHttp, '/api/images/second', imagePage('second'));
  await flush();
  const [requestKey, request] = [...env.storage].find(([key, value]) => key.endsWith(':request') && value.path === '/api/images/first');
  const responseKey = requestKey.replace(/:request$/, ':response');
  const forged = { ...request, type: 'response', status: 200, body: imageBody('wrong') };
  env.emit(responseKey, { ...forged, session: randomUUID() });
  env.emit(responseKey, { ...forged, id: randomUUID() });
  env.emit(responseKey, { ...forged, path: '/api/images/second' });
  await flush();
  expect(firstSettled).toBe(false);
  finish.get('second')(imageBody('second'));
  finish.get('first')(imageBody('first'));
  expect((await a).image.original_url).toBe('https://cdn.example/first.jpg');
  expect((await b).image.original_url).toBe('https://cdn.example/second.jpg');
});

test('helper ignores foreign, expired, and out-of-scope requests rather than acting as an authenticated proxy', async () => {
  const env = bridgeEnvironment(async () => ({ status: 200, text: async () => imageBody('allowed') }));
  const session = randomUUID();
  const key = `xfpd_gbx_${session}`;
  env.emit(`${key}:owner`, { session, page: '/img/allowed', expires: env.now() + 45000 });
  const helper = env.tab(`${imagePage('allowed')}?xfpd_gbx=${session}`);
  helper.goonboxBridgeServe();
  const request = { session, id: randomUUID(), path: '/api/images/allowed', expires: env.now() + 25000 };
  env.emit(`${key}:request`, { ...request, session: randomUUID() });
  env.emit(`${key}:request`, { ...request, expires: env.now() - 1 });
  env.emit(`${key}:request`, { ...request, path: 'https://other.example/private' });
  env.emit(`${key}:request`, { ...request, path: '/api/albums/../images?page=1' });
  env.emit(`${key}:request`, { ...request, path: '/api/account' });
  await flush();
  expect(env.fetches).toEqual([]);
  env.emit(`${key}:request`, request);
  await flush();
  expect(env.fetches).toEqual(['https://goonbox.cr/api/images/allowed']);
  expect(JSON.parse(env.storage.get(`${key}:response`).body).image.original_url).toBe('https://cdn.example/allowed.jpg');
});

test('a copied marker without matching live ownership never activates a helper', async () => {
  const env = bridgeEnvironment(async () => ({ status: 200, text: async () => imageBody('unexpected') }));
  const session = randomUUID();
  const key = `xfpd_gbx_${session}`;
  env.emit(`${key}:owner`, { session, page: '/img/other', expires: env.now() + 45000 });
  env.tab(`${imagePage('requested')}?xfpd_gbx=${session}`).goonboxBridgeServe();
  env.emit(`${key}:request`, { session, id: randomUUID(), path: '/api/images/requested', expires: env.now() + 25000 });
  await flush();
  expect(env.fetches).toEqual([]);
});

test('helper request deadline covers a body that stalls after successful response headers', async () => {
  let aborted = false;
  const env = bridgeEnvironment(async (url, { signal }) => ({
    status: 200,
    text: () =>
      new Promise((resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        ),
      ),
  }));
  const client = env.tab('https://simpcity.cr/threads/example');
  const result = client.goonboxApiJson(blockedHttp, '/api/images/stalled', imagePage('stalled'));
  await flush();
  await env.advance(20000);
  expect(await result).toBe(null);
  expect(aborted).toBe(true);
});

test('a reused helper stays open during a slow second request and closes only after it settles', async () => {
  let finish;
  const env = bridgeEnvironment(async url => ({
    status: 200,
    text: () =>
      url.endsWith('/first')
        ? imageBody('first')
        : new Promise(resolve => {
            finish = resolve;
          }),
  }));
  const client = env.tab('https://simpcity.cr/threads/example');
  await client.goonboxApiJson(blockedHttp, '/api/images/first', imagePage('first'));
  const result = client.goonboxApiJson(blockedHttp, '/api/images/second', imagePage('second'));
  await flush();
  await env.advance(6000);
  expect(env.helpers[0].closed).toBe(false);
  finish(imageBody('second'));
  expect((await result).image.original_url).toBe('https://cdn.example/second.jpg');
  await env.advance(5000);
  expect(env.helpers[0].closed).toBe(true);
});

test('a helper that never announces readiness cannot leave resolution pending forever', async () => {
  const env = bridgeEnvironment(async () => {
    throw new Error('unexpected fetch');
  });
  const client = env.tab('https://simpcity.cr/threads/example');
  let closed = false;
  client.GM_openInTab = () => ({
    close: () => {
      closed = true;
    },
  });
  const result = client.goonboxApiJson(blockedHttp, '/api/images/missing', imagePage('missing'));
  await flush();
  await env.advance(20000);
  expect(await result).toBe(null);
  expect(closed).toBe(true);
});

test('image resolution keeps the requested original and never selects a related image as fallback', async () => {
  const env = bridgeEnvironment(async () => {
    throw new Error('unexpected bridge');
  });
  const client = env.tab('https://simpcity.cr/threads/example');
  client.resolvers = [];
  client.h = { isArray: Array.isArray };
  vm.runInContext(gallerySource, client);
  const resolve = client.resolvers.find(([patterns]) => patterns.some(pattern => pattern.test(imagePage('original'))))[1];
  const http = {
    get: async url => ({
      status: 200,
      source: url.endsWith('/original')
        ? JSON.stringify({ data: { image: { original_url: 'https://cdn.example/Original.jpg?token=A%2fb' } } })
        : JSON.stringify({ image: {}, related: [{ original_url: 'https://cdn.example/other.jpg' }] }),
    }),
    base: async () => ({ status: 403 }),
  };
  expect(await resolve(imagePage('original'), http)).toBe('https://cdn.example/Original.jpg?token=A%2fb');
  expect(await resolve(imagePage('missing'), http)).toBe(null);
});
