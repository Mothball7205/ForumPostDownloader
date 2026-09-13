const GOONBOX_ORIGIN = 'https://goonbox.cr';
const GOONBOX_API_TIMEOUT_MS = 20000;
const GOONBOX_READY_TIMEOUT_MS = 20000;
const GOONBOX_REQUEST_TIMEOUT_MS = 25000;
const GOONBOX_IDLE_MS = 5000;
const GOONBOX_MARKER = 'xfpd_gbx';

function goonboxPageUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !/^(?:www\.)?goonbox\.cr$/.test(url.hostname)) return null;
    if (url.username || url.password || url.port) return null;
    if (!/^\/(?:img\/[A-Za-z0-9_-]{1,64}|a\/[A-Za-z0-9._~-]{1,128})\/?$/.test(url.pathname)) return null;
    return new URL(url.pathname.replace(/\/$/, ''), GOONBOX_ORIGIN);
  } catch (e) {
    return null;
  }
}

function goonboxApiPathAllowed(path) {
  if (typeof path !== 'string') return false;
  if (!/^\/api\/(?:images\/[A-Za-z0-9_-]{1,64}|albums\/[A-Za-z0-9._~-]{1,128}\/images\?page=[1-9]\d{0,3})$/.test(path)) return false;
  const url = new URL(path, GOONBOX_ORIGIN);
  return url.pathname + url.search === path;
}

function goonboxParseJson(source) {
  try {
    const data = JSON.parse(source);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

function goonboxOriginalUrl(image) {
  for (const value of [image?.original_url, image?.originalUrl, image?.original]) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value.trim());
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password) return value.trim();
    } catch (e) {}
  }
  return null;
}

let goonboxBridgeSession = null;
let goonboxBridgeChain = Promise.resolve();

function goonboxBridgeClose(session) {
  if (!session || session.closed) return;
  session.closed = true;
  clearTimeout(session.idleTimer);
  session.pending?.finish(null);
  try {
    GM_removeValueChangeListener(session.listener);
  } catch (e) {}
  // Deleting the mailbox also tells the helper to abort any outstanding fetch.
  for (const suffix of ['request', 'response', 'owner']) {
    try {
      GM_deleteValue(`${session.key}:${suffix}`);
    } catch (e) {}
  }
  xfpdCloseTabHandle(session.tab);
  if (goonboxBridgeSession === session) goonboxBridgeSession = null;
}

function goonboxBridgeWait(session, type, timeoutMs, id = '', path = '') {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
    const finish = value => {
      if (session.pending?.finish !== finish) return;
      clearTimeout(timer);
      session.pending = null;
      resolve(value);
    };
    session.pending = { type, id, path, finish };
  });
}

function goonboxBridgeOpen(pageUrl, deadline) {
  const page = goonboxPageUrl(pageUrl);
  if (
    !page ||
    typeof GM_addValueChangeListener !== 'function' ||
    typeof GM_removeValueChangeListener !== 'function' ||
    typeof GM_deleteValue !== 'function' ||
    typeof GM_setValue !== 'function' ||
    typeof GM_openInTab !== 'function'
  )
    return null;

  const id = crypto.randomUUID();
  const session = { id, key: `xfpd_gbx_${id}`, tab: null, listener: null, pending: null, idleTimer: null, closed: false };
  goonboxBridgeSession = session;
  session.ready = goonboxBridgeWait(session, 'ready', Math.min(GOONBOX_READY_TIMEOUT_MS, deadline - Date.now()));
  try {
    // Subscribe before opening: the helper's first ready event must not race its listener.
    session.listener = GM_addValueChangeListener(`${session.key}:response`, (name, oldValue, value) => {
      if (session.closed || value?.session !== id) return;
      if (value.type === 'closed') {
        goonboxBridgeClose(session);
        return;
      }
      const pending = session.pending;
      if (!pending || value.type !== pending.type) return;
      if (value.type === 'response' && (value.id !== pending.id || value.path !== pending.path)) return;
      pending.finish(value);
    });
    GM_setValue(`${session.key}:owner`, { session: id, page: page.pathname, expires: deadline });
    page.searchParams.set(GOONBOX_MARKER, id);
    session.tab = GM_openInTab(page.href, { active: false, insert: true, setParent: true });
    if (!session.tab) goonboxBridgeClose(session);
    else if (typeof session.tab.then === 'function') session.tab.catch(() => goonboxBridgeClose(session));
  } catch (e) {
    goonboxBridgeClose(session);
  }
  return session;
}

function goonboxBridgeGet(path, pageUrl) {
  if (!goonboxApiPathAllowed(path) || !goonboxPageUrl(pageUrl)) return Promise.resolve(null);
  // Includes time spent queued behind other requests in this forum tab.
  const deadline = Date.now() + GOONBOX_READY_TIMEOUT_MS + GOONBOX_REQUEST_TIMEOUT_MS;
  const run = async () => {
    if (Date.now() >= deadline) return null;
    const session = goonboxBridgeSession || goonboxBridgeOpen(pageUrl, deadline);
    if (!session) return null;
    clearTimeout(session.idleTimer);
    try {
      if (!(await session.ready) || session.closed || Date.now() >= deadline) {
        goonboxBridgeClose(session);
        return null;
      }
      const id = crypto.randomUUID();
      const expires = Math.min(deadline, Date.now() + GOONBOX_REQUEST_TIMEOUT_MS);
      const response = goonboxBridgeWait(session, 'response', expires - Date.now(), id, path);
      GM_setValue(`${session.key}:request`, { session: session.id, id, path, expires });
      const result = await response;
      if (!result) goonboxBridgeClose(session);
      return result;
    } catch (e) {
      goonboxBridgeClose(session);
      return null;
    } finally {
      // Runs only after the request settles. A queued request cancels this timer before waiting.
      if (!session.closed) session.idleTimer = setTimeout(() => goonboxBridgeClose(session), GOONBOX_IDLE_MS);
    }
  };
  const result = goonboxBridgeChain.then(run, run);
  goonboxBridgeChain = result.catch(() => null);
  return result;
}

async function goonboxApiJson(http, path, pageUrl) {
  const page = goonboxPageUrl(pageUrl);
  if (!page || !goonboxApiPathAllowed(path)) return null;
  try {
    const response = await http.get(
      `${GOONBOX_ORIGIN}${path}`,
      {},
      { Referer: page.href, Accept: 'application/json' },
      'text',
      GOONBOX_API_TIMEOUT_MS,
    );
    if (response?.status >= 200 && response.status < 300) {
      const data = goonboxParseJson(response.source);
      if (data) return data;
    }
  } catch (e) {}
  // Firefox may partition GM request cookies under the forum origin. Fetching in a real
  // Goonbox tab uses its first-party cookies instead; no cookies are copied across origins.
  const response = await goonboxBridgeGet(path, page.href);
  return response?.status >= 200 && response.status < 300 ? goonboxParseJson(response.body) : null;
}

function goonboxBridgeServe() {
  if (window.top !== window.self || location.protocol !== 'https:') return;
  const page = goonboxPageUrl(location.href);
  const id = new URLSearchParams(location.search).get(GOONBOX_MARKER);
  if (!page || !/^[a-f0-9-]{36}$/.test(id || '')) return;
  if (
    typeof GM_getValue !== 'function' ||
    typeof GM_setValue !== 'function' ||
    typeof GM_addValueChangeListener !== 'function' ||
    typeof GM_removeValueChangeListener !== 'function'
  )
    return;
  const key = `xfpd_gbx_${id}`;
  const owner = GM_getValue(`${key}:owner`, null);
  if (owner?.session !== id || owner.page !== page.pathname || !Number.isFinite(owner.expires) || owner.expires <= Date.now()) return;

  let closed = false;
  let busy = false;
  let lastId = '';
  let controller = null;
  let listener = null;
  let idleTimer = null;
  const reply = value => GM_setValue(`${key}:response`, { session: id, ...value });
  const stop = (notify = true) => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    controller?.abort();
    try {
      GM_removeValueChangeListener(listener);
    } catch (e) {}
    if (notify) {
      try {
        reply({ type: 'closed' });
      } catch (e) {}
    }
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    // A requester crash must not leave an authenticated bridge listening indefinitely.
    idleTimer = setTimeout(() => {
      stop();
      window.close();
    }, GOONBOX_READY_TIMEOUT_MS + GOONBOX_REQUEST_TIMEOUT_MS);
  };
  const handle = async request => {
    if (closed || busy || request?.session !== id || typeof request.id !== 'string' || request.id === lastId) return;
    if (!/^[a-f0-9-]{36}$/.test(request.id) || !goonboxApiPathAllowed(request.path)) return;
    if (!Number.isFinite(request.expires) || request.expires <= Date.now() || request.expires > Date.now() + GOONBOX_REQUEST_TIMEOUT_MS)
      return;
    lastId = request.id;
    busy = true;
    clearTimeout(idleTimer);
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(GOONBOX_API_TIMEOUT_MS, request.expires - Date.now()));
    let status = 0;
    let body = '';
    try {
      // Use this tab's exact origin (including a www redirect); never follow API redirects
      // or accept caller-supplied URLs, methods, headers, or credentials.
      const response = await fetch(`${location.origin}${request.path}`, {
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      status = response.status;
      body = await response.text();
    } catch (e) {
      status = 0;
    } finally {
      clearTimeout(timer);
      controller = null;
      busy = false;
    }
    if (closed) return;
    try {
      reply({ type: 'response', id: request.id, path: request.path, status, body });
    } catch (e) {}
    armIdle();
  };

  try {
    // Event values, not cross-tab polling: Tampermonkey's GM_getValue cache can be stale.
    listener = GM_addValueChangeListener(`${key}:request`, (name, oldValue, value) => {
      if (value == null) stop(false);
      else void handle(value);
    });
    window.addEventListener('pagehide', stop, { once: true });
    armIdle();
    reply({ type: 'ready' });
  } catch (e) {
    stop();
  }
}

window.addEventListener('pagehide', () => goonboxBridgeClose(goonboxBridgeSession));
