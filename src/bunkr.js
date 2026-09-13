const BUNKR_RESOLVE_TIMEOUT_MS = 20000;

// Warm-up can clear JS-only Cloudflare interstitials; interactive CAPTCHAs need manual completion.
const BUNKR_CF_WARMUP_MS = 6000;
const BUNKR_CF_MAX_RETRIES = 3;
const BUNKR_CF_WARMUP_ACTIVE_TAB = false;

const BUNKR_CF_WARMUP_COOLDOWN_MS = 15000; // reduce repeated warm-up tabs

// Skip and temporarily ban blocked domains; reserve warm-up retries for the last resort.
const BUNKR_FASTFAIL_ON_403 = true;
const BUNKR_DOMAIN_BLACKLIST_MS = 60 * 60 * 1000; // 60 minutes
const xfpdBunkrDomainBanUntil = new Map(); // baseOrigin -> timestamp

function xfpdBunkrNormalizeBase(baseOrUrl) {
  try {
    const u = new URL(String(baseOrUrl || ''));
    return u.origin;
  } catch (e) {
    return String(baseOrUrl || '').replace(/\/+$/, '');
  }
}

function xfpdBunkrIsBaseBanned(baseOrUrl) {
  try {
    const base = xfpdBunkrNormalizeBase(baseOrUrl);
    const until = xfpdBunkrDomainBanUntil.get(base);
    if (!until) return false;
    if (Date.now() >= until) {
      xfpdBunkrDomainBanUntil.delete(base);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function xfpdBunkrBanBase(baseOrUrl) {
  try {
    const base = xfpdBunkrNormalizeBase(baseOrUrl);
    // Don't blacklist the last-resort domain (it may be the only thing left).
    if (base === 'https://bunkr.cr') return;
    xfpdBunkrDomainBanUntil.set(base, Date.now() + BUNKR_DOMAIN_BLACKLIST_MS);
  } catch (e) {}
}

function xfpdBunkrFilterBases(bases) {
  const uniq = [];
  const seen = new Set();
  for (const b of bases || []) {
    const base = xfpdBunkrNormalizeBase(b);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    uniq.push(base);
  }
  const filtered = uniq.filter(b => b === 'https://bunkr.cr' || !xfpdBunkrIsBaseBanned(b));
  // Never return an empty list; keep last-resort behavior intact.
  return filtered.length ? filtered : uniq;
}

function xfpdLooksLikeCfChallenge(source, dom) {
  try {
    const s = String(source || '');
    const head = s.slice(0, 8000).toLowerCase();

    const title = String(dom?.querySelector?.('title')?.textContent || '').trim();

    if (title && /just a moment|attention required|checking your browser/i.test(title)) return true;
    if (title && /cloudflare/i.test(title)) return true;

    if (head.includes('cdn-cgi/challenge-platform')) return true;
    if (head.includes('challenges.cloudflare.com')) return true;
    if (head.includes('cf-browser-verification')) return true;
    if (head.includes('checking your browser')) return true;
    if (head.includes('just a moment')) return true;
    if (head.includes('attention required')) return true;

    if (dom?.querySelector?.('#cf-challenge-running, #challenge-form, .cf-browser-verification, .cf-challenge')) return true;
  } catch (e) {}
  return false;
}

function xfpdLooksLikeCfFilenameHint(name) {
  const n = String(name || '').trim();
  return /^(?:just a moment\.{0,3}|checking your browser\.{0,3}|attention required\.{0,3})$/i.test(n) || /cloudflare/i.test(n);
}

// Try to extract the original filename from Bunkr /api/vs JSON (when /v/ is blocked by CF/403).
function xfpdBunkrExtractNameFromVsData(data) {
  try {
    const cands = [];
    const add = v => {
      if (!v) return;
      if (typeof v === 'string') cands.push(v);
      else if (typeof v === 'number') cands.push(String(v));
    };

    add(data?.name);
    add(data?.filename);
    add(data?.file_name);
    add(data?.original);
    add(data?.title);

    if (data?.data && typeof data.data === 'object') {
      add(data.data.name);
      add(data.data.filename);
      add(data.data.file_name);
      add(data.data.original);
      add(data.data.title);
    }
    if (data?.file && typeof data.file === 'object') {
      add(data.file.name);
      add(data.file.filename);
      add(data.file.original);
      add(data.file.title);
    }

    const norm = s => {
      let t = String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
      t = t.replace(/\s*\|\s*Bunkr\s*$/i, '').trim();
      return t;
    };

    // Prefer candidates that look like a real filename with an extension.
    for (const raw of cands) {
      const t = norm(raw);
      if (!t) continue;
      if (xfpdLooksLikeCfFilenameHint(t)) continue;
      if (/\.[A-Za-z0-9]{1,8}$/.test(t)) return t;
    }
    // Otherwise, return the first non-empty non-CF string.
    for (const raw of cands) {
      const t = norm(raw);
      if (!t) continue;
      if (xfpdLooksLikeCfFilenameHint(t)) continue;
      return t;
    }
  } catch (e) {}
  return '';
}

async function xfpdWarmupTab(url, ms = BUNKR_CF_WARMUP_MS, active = BUNKR_CF_WARMUP_ACTIVE_TAB) {
  try {
    const tab = GM_openInTab(url, { active: !!active, insert: true, setParent: true });
    await h.delayedResolve(ms);
    try {
      tab?.close?.();
    } catch (e) {}
  } catch (e) {
    // Keep the retry delay even when opening the tab fails.
    try {
      await h.delayedResolve(ms);
    } catch (e2) {}
  }
}

let xfpdBunkrCfWarmupPromise = null;
let xfpdBunkrCfWarmupLastAt = 0;

// Share one warm-up tab across callers and enforce a cooldown.
async function xfpdBunkrCfWarmup(url) {
  try {
    const now = Date.now();

    if (xfpdBunkrCfWarmupPromise) {
      return await xfpdBunkrCfWarmupPromise;
    }

    // Wait without opening another tab during cooldown.
    if (now - xfpdBunkrCfWarmupLastAt < BUNKR_CF_WARMUP_COOLDOWN_MS) {
      try {
        await h.delayedResolve(Math.min(1000, BUNKR_CF_WARMUP_MS));
      } catch (e) {}
      return null;
    }

    xfpdBunkrCfWarmupLastAt = now;

    xfpdBunkrCfWarmupPromise = (async () => {
      await xfpdWarmupTab(url);
    })();

    try {
      return await xfpdBunkrCfWarmupPromise;
    } finally {
      xfpdBunkrCfWarmupPromise = null;
    }
  } catch (e) {
    return null;
  }
}

async function xfpdBunkrGetWithCfRetry(http, url, warmUrlOrOrigin, allowWarmup = true) {
  let last = null;
  for (let attempt = 0; attempt <= BUNKR_CF_MAX_RETRIES; attempt++) {
    try {
      last = await http.get(url, {}, {}, 'document', BUNKR_RESOLVE_TIMEOUT_MS);
    } catch (e) {
      last = null;
    }

    const dom = last?.dom;
    const source = last?.source || '';

    // Ban blocked non-last domains so the caller can try the next one.
    const status = Number(last?.status || 0);
    if (BUNKR_FASTFAIL_ON_403 && status === 403 && !allowWarmup) {
      xfpdBunkrBanBase(warmUrlOrOrigin || url);
      return last || { dom: null, source: '' };
    }
    if (BUNKR_FASTFAIL_ON_403 && !allowWarmup && last && xfpdLooksLikeCfChallenge(source, dom)) {
      xfpdBunkrBanBase(warmUrlOrOrigin || url);
      return last || { dom: null, source: '' };
    }

    if (last && !xfpdLooksLikeCfChallenge(source, dom)) return last;

    if (attempt < BUNKR_CF_MAX_RETRIES) {
      if (allowWarmup) {
        await xfpdBunkrCfWarmup(String(warmUrlOrOrigin || url));
      } else {
        try {
          await h.delayedResolve(200);
        } catch (e) {}
      }
    }
  }
  return last || { dom: null, source: '' };
}

// Sign a bunkr cdn.cr URL via glb-apisign.cdn.cr — required for download (unsigned URLs return 403).
async function xfpdBunkrSignCdnUrl(http, rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    const path = decodeURIComponent(urlObj.pathname);
    const signRes = await http.get(
      `https://glb-apisign.cdn.cr/sign?path=${encodeURIComponent(path)}`,
      {},
      {},
      'text',
      BUNKR_RESOLVE_TIMEOUT_MS,
    );
    const signText = String(signRes?.source || '');
    const signData = JSON.parse(signText);
    if (signData?.token && signData?.ex) {
      urlObj.searchParams.set('token', String(signData.token));
      urlObj.searchParams.set('ex', String(signData.ex));
      return urlObj.toString();
    }
  } catch (e) {}
  return rawUrl;
}

// Turbo mapping: signed turbocdn URL -> Turbo id (needed for re-sign when resolving from /a/ albums)
const turboIdBySignedUrl = new Map();
