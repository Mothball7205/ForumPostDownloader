// Per-download metadata (size/name/status) with a per-instance cache. The cache
// is fresh per download batch so re-resolved URLs always get fresh HEADs.
const gmDownloadHead = url =>
  new Promise(resolve => {
    try {
      GM_xmlhttpRequest({
        method: 'HEAD',
        url,
        onload: r => resolve({ ok: true, status: r.status, headers: r.responseHeaders || '' }),
        onerror: () => resolve({ ok: false, status: 0, headers: '' }),
        ontimeout: () => resolve({ ok: false, status: 0, headers: '' }),
      });
    } catch (e) {
      resolve({ ok: false, status: 0, headers: '' });
    }
  });

const gmDownloadText = url =>
  new Promise(resolve => {
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: r => resolve({ ok: true, status: r.status, text: r.responseText || '' }),
        onerror: () => resolve({ ok: false, status: 0, text: '' }),
        ontimeout: () => resolve({ ok: false, status: 0, text: '' }),
      });
    } catch (e) {
      resolve({ ok: false, status: 0, text: '' });
    }
  });

const createDownloadMetadataReader = () => {
  const cache = new Map();

  const readDownloadMetadata = async (url, { isGoFile = false, isPixeldrain = false } = {}) => {
    const key = `${url}`;
    if (cache.has(key)) return cache.get(key);

    const meta = { size: 0, filename: '', status: 0, contentType: '', headers: '' };

    try {
      if (isPixeldrain) {
        const mFile = /(?:pixeldrain\.com|pixeldrain\.net|pixeldra\.in)\/api\/file\/([^\/?#]+)/i.exec(url || '');
        if (mFile && mFile[1]) {
          const pdOrigin = (() => {
            try {
              const uu = new URL(url || '', location.origin);
              const host = String(uu.hostname || '').toLowerCase();
              if (host.endsWith('pixeldrain.net')) return 'https://pixeldrain.net';
              if (host.endsWith('pixeldra.in')) return 'https://pixeldra.in';
              return 'https://pixeldrain.com';
            } catch (e) {
              return 'https://pixeldrain.com';
            }
          })();
          const infoUrl = `${pdOrigin}/api/file/${mFile[1]}/info`;
          const r = await gmDownloadText(infoUrl);
          if (r.ok && r.text) {
            try {
              const j = JSON.parse(r.text);
              const v = j && (j.value || j.data || j);
              meta.size = extractNum((v && (v.size ?? v.bytes ?? v.length)) ?? (j && (j.size ?? j.bytes)));
              meta.filename = String((v && (v.name ?? v.filename ?? v.title)) ?? (j && (j.name ?? j.filename)) ?? '');
            } catch (e) {}
          }
        }
      }

      // Filester hints (API gives name/size but the CDN URL may not include them)
      try {
        if (!meta.size) {
          let hintedSize = 0;
          try {
            // Prefer slug-based hints (from /f/ album page) when available.
            const s0 = String(filesterSlugByUrl.get(String(url)) || '');
            hintedSize = Number(filesterSizeBySlug.get(s0) || filesterSizeByUrl.get(String(url)) || 0) || 0;
          } catch (e) {
            hintedSize = 0;
          }
          if (hintedSize) meta.size = extractNum(hintedSize);
        }
        if (!meta.filename) {
          let hintedName = '';
          try {
            const s0 = String(filesterSlugByUrl.get(String(url)) || '');
            hintedName = String(filesterNameBySlug.get(s0) || filesterNameByUrl.get(String(url)) || '');
          } catch (e) {
            hintedName = '';
          }
          if (hintedName) meta.filename = String(hintedName);
        }
      } catch (e) {}

      // Fallback HEAD (works for GoFile store links and Pixeldrain list ZIPs)
      const nameHasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(meta.filename || ''));
      const isFilester = isFilesterUrl(url);
      const needHead = !!(isGoFile || isPixeldrain || (!isFilester && (!meta.size || !meta.filename || !nameHasExt)));
      if (needHead) {
        const hRes = await gmDownloadHead(url);
        meta.status = hRes.status || 0;
        meta.headers = hRes.headers || '';
        meta.contentType = headerValue(meta.headers, 'content-type');
        const cl = headerValue(meta.headers, 'content-length');
        if (!meta.size && cl) meta.size = extractNum(cl);
        if (!meta.filename) {
          const cdName = parseDispositionFilename(meta.headers);
          if (cdName) meta.filename = cdName;
        }
      }
    } catch (e) {}

    cache.set(key, meta);
    return meta;
  };

  return { readDownloadMetadata };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gmDownloadHead, gmDownloadText, createDownloadMetadataReader };
}
