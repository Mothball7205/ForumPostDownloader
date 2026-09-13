// GoFile filename hints (from API) so we don't rely on URL-encoded path segments
const gofileNameById = new Map();
const gofileNameByUrl = new Map();

// GoFile CDN requests require the accountToken cookie used during resolution.
// Capture the user's cookie before replacing it; restore it after the last active post.
let gofileCookieCaptured = false;
let gofileOriginalCookieValue = null; // null = no cookie existed originally

const gofileCaptureOriginalCookie = () =>
  new Promise(resolve => {
    if (gofileCookieCaptured || typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.list !== 'function') {
      resolve();
      return;
    }
    try {
      GM_cookie.list({ url: 'https://gofile.io/', domain: 'gofile.io', name: 'accountToken' }, (cookies, error) => {
        if (error) {
          console.warn('[GoFile] GM_cookie.list failed while capturing original accountToken cookie:', error);
        } else {
          const existing = Array.isArray(cookies) ? cookies.find(c => c && c.name === 'accountToken') : null;
          gofileOriginalCookieValue = existing ? existing.value : null;
        }
        gofileCookieCaptured = true;
        resolve();
      });
    } catch (e) {
      console.warn('[GoFile] GM_cookie.list threw while capturing original accountToken cookie:', e);
      gofileCookieCaptured = true;
      resolve();
    }
  });

const gofileSyncCookie = token =>
  new Promise(resolve => {
    (async () => {
      try {
        if (!token || typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.set !== 'function') {
          resolve(false);
          return;
        }
        await gofileCaptureOriginalCookie();
        GM_cookie.set(
          {
            url: 'https://gofile.io/',
            name: 'accountToken',
            value: String(token),
            domain: 'gofile.io',
            path: '/',
            secure: true,
            sameSite: 'lax',
          },
          error => {
            if (error) console.warn('[GoFile] GM_cookie.set failed for accountToken:', error);
            resolve(!error);
          },
        );
      } catch (e) {
        console.warn('[GoFile] gofileSyncCookie threw:', e);
        resolve(false);
      }
    })();
  });

// Restore the original accountToken, or remove ours if none existed.
const gofileRestoreCookie = () =>
  new Promise(resolve => {
    try {
      if (!gofileCookieCaptured || typeof GM_cookie === 'undefined' || !GM_cookie) {
        resolve();
        return;
      }
      const originalValue = gofileOriginalCookieValue;
      gofileCookieCaptured = false;
      gofileOriginalCookieValue = null;

      if (originalValue === null) {
        if (typeof GM_cookie.delete === 'function') {
          GM_cookie.delete({ url: 'https://gofile.io/', name: 'accountToken', domain: 'gofile.io', path: '/' }, error => {
            if (error) console.warn('[GoFile] Failed to remove guest accountToken cookie during restore:', error);
            resolve();
          });
          return;
        }
        resolve();
        return;
      }

      GM_cookie.set(
        {
          url: 'https://gofile.io/',
          name: 'accountToken',
          value: originalValue,
          domain: 'gofile.io',
          path: '/',
          secure: true,
          sameSite: 'lax',
        },
        error => {
          if (error) console.warn('[GoFile] Failed to restore original accountToken cookie:', error);
          resolve();
        },
      );
    } catch (e) {
      resolve();
    }
  });

// Cyberdrop filename hints (from API)
const cyberdropNameBySlug = new Map();
const cyberdropNameByUrl = new Map();

// Filester filename/size hints (from API)
const filesterNameBySlug = new Map();
const filesterNameByUrl = new Map();
const filesterSizeBySlug = new Map();
const filesterSizeByUrl = new Map();
const filesterSlugByUrl = new Map();
const filesterRefByUrl = new Map();
const filesterV2Urls = new Set();

// Legacy /v/ streams can move between CDN hosts. V2 tokens are bound to their
// API-selected server and must never enter this candidate ladder.
const filesterCandidatesByToken = new Map(); // token -> string[]
const filesterTriedByToken = new Map(); // token -> Set<string> of tried candidate URLs
const filesterRetryAttemptsByKey = new Map(); // token/url -> number of retries on transient HTTP errors (429/400/etc)

const FILESTER_STREAM_HOSTS = [
  'https://fsc1.cdn.cr',
  'https://fsc2.cdn.cr',
  'https://fsc3.cdn.cr',
  'https://cache2.filester.me',
  'https://cache3.filester.me',
  'https://cache4.filester.me',
  'https://cache5.filester.me',
  'https://cache7.filester.me',
  'https://cache8.filester.me',
  'https://cache6.filester.me',
  'https://cache1.filester.me',
];
const FILESTER_PROBE_TIMEOUT_MS = 8000;
const FILESTER_PROBE_BUDGET_MS = 25000;
const FILESTER_API_TIMEOUT_MS = 20000;

function filesterTokenFromVUrl(url) {
  try {
    if (filesterV2Urls.has(String(url))) return '';
    const match = /^\/v\/([^/]+)\/?$/i.exec(new URL(String(url)).pathname);
    return match ? match[1] : '';
  } catch (e) {
    return '';
  }
}

function filesterBuildCandidates(token, apiBase = 'https://filester.me') {
  const value = String(token || '').trim();
  if (!value) return [];
  return [...FILESTER_STREAM_HOSTS, String(apiBase).replace(/\/+$/, '')].map(base => `${base}/v/${value}`);
}

function filesterParseFileUrl(url) {
  try {
    let value = String(url || '').trim();
    if (value.startsWith('//')) value = `https:${value}`;
    else if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    const parsed = new URL(value);
    if (!/^(?:[a-z0-9-]+\.)*filester\.(me|sh|si|gg)$/i.test(parsed.hostname)) return null;
    const match = /^\/d\/([^/]+)\/?$/i.exec(parsed.pathname);
    if (!match) return null;
    return { slug: match[1], apiBase: `https://${parsed.hostname}`, url: parsed.href };
  } catch (e) {
    return null;
  }
}

// Recognise API-issued streams by provenance, not a fixed CDN hostname list.
function isFilesterUrl(url) {
  const value = String(url || '');
  return (
    filesterSlugByUrl.has(value) ||
    /^(?:https?:)?\/\/(?:[a-z0-9-]+\.)*filester\.(me|sh|si|gg)\/(?:d|v)\//i.test(value) ||
    !!filesterParseFileUrl(value)
  );
}

// Resolve short-lived v2 tokens at download time for both single files and album items.
async function filesterResolveV2(http, apiBase, slug, progressCB) {
  const base = String(apiBase || 'https://filester.me').replace(/\/+$/, '');
  const value = String(slug || '').trim();
  if (!value) return null;
  const ref = `${base}/d/${value}`;

  try {
    if (typeof progressCB === 'function') progressCB('[Filester] Requesting download token (v2)...');
    const response = await http.post(
      `${base}/v2/api/public/download`,
      JSON.stringify({ file_slug: value }),
      {},
      {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        Origin: base,
        Referer: ref,
        __xfpd_withCredentials: true,
      },
      'text',
      FILESTER_API_TIMEOUT_MS,
    );
    if (!(response?.status >= 200 && response.status < 300)) return null;
    const data = JSON.parse(response.source);
    const server = typeof data?.server === 'string' ? data.server.replace(/\/+$/, '') : '';
    const file = typeof data?.file === 'string' ? data.file : '';
    const token = typeof data?.token === 'string' ? data.token : '';
    if (!server || !file || !token) return null;
    const serverUrl = new URL(server);
    if (!/^https?:$/.test(serverUrl.protocol) || serverUrl.username || serverUrl.password || serverUrl.search || serverUrl.hash) {
      return null;
    }

    const name =
      (typeof data.name === 'string' && data.name.trim()) ||
      filesterNameBySlug.get(value) ||
      `Filester_${value}${(/\.[A-Za-z0-9]{1,8}$/.exec(file) || [''])[0]}`;
    const filePath = file.split('/').map(encodeURIComponent).join('/');
    const streamUrl = `${server}/v2/${filePath}?token=${encodeURIComponent(token)}&download=true&n=${encodeURIComponent(name)}`;
    filesterV2Urls.add(streamUrl);
    filesterNameBySlug.set(value, name);
    for (const key of [ref, streamUrl]) {
      filesterSlugByUrl.set(key, value);
      filesterRefByUrl.set(key, ref);
      filesterNameByUrl.set(key, name);
      const size = filesterSizeBySlug.get(value);
      if (size > 0) filesterSizeByUrl.set(key, size);
    }
    return { url: streamUrl, name, ref };
  } catch (e) {
    return null;
  }
}

// Bunkr filename hints (from /v/ pages)
const bunkrNameByUrl = new Map();
