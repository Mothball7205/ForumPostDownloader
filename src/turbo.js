const XFPD_TURBO_SIGN_TIMEOUT_MS = 5000;
const XFPD_TURBO_SIGN_RETRIES = 2;
const XFPD_TURBO_SIGN_JITTER_MIN_MS = 700;
const XFPD_TURBO_SIGN_JITTER_MAX_MS = 1400;

const xfpdSleepMs = ms => new Promise(r => setTimeout(r, ms));
const xfpdJitterMs = (minMs, maxMs) => {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};

const xfpdGmGetText = (getUrl, headers, timeoutMs) =>
  new Promise(resolve => {
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url: String(getUrl),
        headers: headers || {},
        responseType: 'text',
        anonymous: false,
        timeout: Number(timeoutMs) || 0,
        onload: r => resolve({ ok: true, status: r.status || 0, text: String(r.responseText || r.response || '') }),
        onerror: () => resolve({ ok: false, status: 0, text: '' }),
        ontimeout: () => resolve({ ok: false, status: 0, text: '' }),
      });
    } catch (e) {
      resolve({ ok: false, status: 0, text: '' });
    }
  });

const xfpdTurboFetchSignJsonWithTimeout = async (turboId, refererUrl) => {
  const id = String(turboId || '').trim();
  if (!id) return null;

  const embedUrl = String(refererUrl || `https://turbo.cr/embed/${id}`);
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Referer: embedUrl,
  };

  const signUrls = [
    `https://turbo.cr/api/sign?v=${encodeURIComponent(id)}`,
    `https://turbo.cr/sign?v=${encodeURIComponent(id)}`, // legacy fallback
  ];

  for (let attempt = 0; attempt <= XFPD_TURBO_SIGN_RETRIES; attempt++) {
    for (const signUrl of signUrls) {
      const r = await xfpdGmGetText(signUrl, headers, XFPD_TURBO_SIGN_TIMEOUT_MS);
      if (!r || !r.ok || r.status !== 200 || !r.text) continue;

      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch (e) {
        j = null;
      }
      if (!j || !j.url) continue;

      const ok = j.success === undefined ? true : !!j.success;
      if (ok) return j;
    }
    if (attempt < XFPD_TURBO_SIGN_RETRIES) {
      await xfpdSleepMs(xfpdJitterMs(XFPD_TURBO_SIGN_JITTER_MIN_MS, XFPD_TURBO_SIGN_JITTER_MAX_MS));
    }
  }
  return null;
};

const xfpdTurboSignUrlWithTimeout = async (turboId, refererUrl, nameHint) => {
  const j = await xfpdTurboFetchSignJsonWithTimeout(turboId, refererUrl);
  if (!j || !j.url) return null;

  let signed = j.url;
  const originalName = j.original_filename || nameHint;

  // Preserve filename for Turbo CDN downloads (used later for saveAs)
  if (signed && originalName && !/[?&]fn=/.test(String(signed))) {
    const enc = encodeURIComponent(String(originalName)).replace(/%20/g, '+');
    signed += (signed.includes('?') ? '&' : '?') + 'fn=' + enc;
  }
  return signed;
};
