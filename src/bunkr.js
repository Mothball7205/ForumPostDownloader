// Bunkr/Cloudflare: best-effort warm-up to let the browser complete a JS-only CF interstitial ("Just a moment...").
// NOTE: This does NOT solve interactive Turnstile/CAPTCHA challenges; in that case you still need to do it manually.
const BUNKR_CF_WARMUP_MS = 6000;
const BUNKR_CF_MAX_RETRIES = 3;
const BUNKR_CF_WARMUP_ACTIVE_TAB = false;

const BUNKR_CF_WARMUP_COOLDOWN_MS = 15000; // reduce repeated warm-up tabs

// Bunkr fast-fail + domain blacklist:
// - On first 403 or obvious CF interstitial on a non-last domain, immediately switch to next domain (no extra retries).
// - Blacklist the failing domain for a while so subsequent links skip it entirely.
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

    // DOM markers (when we have it)
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

    // common nesting patterns
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
    // Ignore - warm-up is best-effort
    try {
      await h.delayedResolve(ms);
    } catch (e2) {}
  }
}

let xfpdBunkrCfWarmupPromise = null;
let xfpdBunkrCfWarmupLastAt = 0;

// Ensure we open at most ONE warm-up tab at a time (and no more than once per cooldown window).
async function xfpdBunkrCfWarmup(url) {
  try {
    const now = Date.now();

    // If a warm-up is already running, just wait for it.
    if (xfpdBunkrCfWarmupPromise) {
      return await xfpdBunkrCfWarmupPromise;
    }

    // If we recently warmed up, don't open another tab; just wait a bit to avoid hammering.
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
    // Best-effort
    return null;
  }
}

async function xfpdBunkrGetWithCfRetry(http, url, warmUrlOrOrigin, allowWarmup = true) {
  let last = null;
  for (let attempt = 0; attempt <= BUNKR_CF_MAX_RETRIES; attempt++) {
    try {
      last = await http.get(url);
    } catch (e) {
      last = null;
    }

    const dom = last?.dom;
    const source = last?.source || '';

    // Fast-fail on 403 / CF interstitial for non-last domains:
    // Immediately blacklist this domain and return, so the caller can try the next domain.
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

async function xfpdBunkrPostVsWithCfRetry(http, endpoint, slug, refererUrl, originUrl, allowWarmup = true) {
  let lastText = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt <= BUNKR_CF_MAX_RETRIES; attempt++) {
    try {
      const response = await http.post(
        endpoint,
        JSON.stringify({ slug }),
        {},
        {
          'Content-Type': 'application/json',
          Referer: refererUrl,
          Origin: originUrl,
        },
      );
      lastText = String(response?.source || '');
      lastStatus = Number(response?.status || 0);
    } catch (e) {
      lastText = '';
      lastStatus = 0;
    }

    // Fast-fail on 403 / CF interstitial for non-last domains:
    // Immediately blacklist this domain and return null so the caller tries the next domain.
    if (BUNKR_FASTFAIL_ON_403 && Number(lastStatus || 0) === 403 && !allowWarmup) {
      xfpdBunkrBanBase(originUrl || refererUrl || endpoint);
      return null;
    }
    if (BUNKR_FASTFAIL_ON_403 && !allowWarmup && xfpdLooksLikeCfChallenge(lastText, null)) {
      xfpdBunkrBanBase(originUrl || refererUrl || endpoint);
      return null;
    }
    try {
      return JSON.parse(lastText || '{}');
    } catch (e) {
      if (xfpdLooksLikeCfChallenge(lastText, null) && attempt < BUNKR_CF_MAX_RETRIES) {
        if (allowWarmup) {
          await xfpdBunkrCfWarmup(String(refererUrl || originUrl || endpoint));
        } else {
          try {
            await h.delayedResolve(200);
          } catch (e2) {}
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

// Sign a bunkr cdn.cr URL via glb-apisign.cdn.cr — required for download (unsigned URLs return 403).
async function xfpdBunkrSignCdnUrl(http, rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    const path = decodeURIComponent(urlObj.pathname);
    const signRes = await http.get(`https://glb-apisign.cdn.cr/sign?path=${encodeURIComponent(path)}`);
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
