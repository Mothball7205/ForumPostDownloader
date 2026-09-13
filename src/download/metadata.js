// Cache metadata per batch so re-resolved URLs receive fresh HEAD requests.
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

const downloadPixeldrainOrigin = url => {
  try {
    const parsed = new URL(url || '', location.origin);
    const host = String(parsed.hostname || '').toLowerCase();
    if (host.endsWith('pixeldrain.net')) return 'https://pixeldrain.net';
    if (host.endsWith('pixeldra.in')) return 'https://pixeldra.in';
    return 'https://pixeldrain.com';
  } catch (e) {
    return 'https://pixeldrain.com';
  }
};

const applyPixeldrainMetadata = (meta, text) => {
  try {
    const json = JSON.parse(text);
    const value = json && (json.value || json.data || json);
    meta.size = extractNum((value && (value.size ?? value.bytes ?? value.length)) ?? (json && (json.size ?? json.bytes)));
    meta.filename = String((value && (value.name ?? value.filename ?? value.title)) ?? (json && (json.name ?? json.filename)) ?? '');
  } catch (e) {}
};

const collectPixeldrainMetadata = async (url, meta) => {
  const match = /(?:pixeldrain\.com|pixeldrain\.net|pixeldra\.in)\/api\/file\/([^\/?#]+)/i.exec(url || '');
  if (!match || !match[1]) return;
  const infoUrl = `${downloadPixeldrainOrigin(url)}/api/file/${match[1]}/info`;
  const response = await gmDownloadText(infoUrl);
  if (response.ok && response.text) applyPixeldrainMetadata(meta, response.text);
};

const filesterMetadataSizeHint = url => {
  try {
    // Prefer slug-based hints (from /f/ album page) when available.
    const slug = String(filesterSlugByUrl.get(String(url)) || '');
    return Number(filesterSizeBySlug.get(slug) || filesterSizeByUrl.get(String(url)) || 0) || 0;
  } catch (e) {
    return 0;
  }
};

const filesterMetadataNameHint = url => {
  try {
    const slug = String(filesterSlugByUrl.get(String(url)) || '');
    return String(filesterNameBySlug.get(slug) || filesterNameByUrl.get(String(url)) || '');
  } catch (e) {
    return '';
  }
};

const collectFilesterMetadata = (url, meta) => {
  // API hints supply names and sizes that may be absent from CDN URLs.
  try {
    if (!meta.size) {
      const hintedSize = filesterMetadataSizeHint(url);
      if (hintedSize) meta.size = extractNum(hintedSize);
    }
    if (!meta.filename) {
      const hintedName = filesterMetadataNameHint(url);
      if (hintedName) meta.filename = hintedName;
    }
  } catch (e) {}
};

const needsDownloadMetadataHead = (url, meta, isGoFile, isPixeldrain) => {
  const nameHasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(meta.filename || ''));
  const isFilester = isFilesterUrl(url);
  return !!(isGoFile || isPixeldrain || (!isFilester && (!meta.size || !meta.filename || !nameHasExt)));
};

const collectDownloadHeadMetadata = async (url, meta) => {
  const response = await gmDownloadHead(url);
  meta.status = response.status || 0;
  meta.headers = response.headers || '';
  meta.contentType = headerValue(meta.headers, 'content-type');
  const contentLength = headerValue(meta.headers, 'content-length');
  if (!meta.size && contentLength) meta.size = extractNum(contentLength);
  if (!meta.filename) {
    const filename = parseDispositionFilename(meta.headers);
    if (filename) meta.filename = filename;
  }
};

const createDownloadMetadataReader = () => {
  const cache = new Map();

  const readDownloadMetadata = async (url, { isGoFile = false, isPixeldrain = false } = {}) => {
    const key = `${url}`;
    if (cache.has(key)) return cache.get(key);

    const meta = { size: 0, filename: '', status: 0, contentType: '', headers: '' };

    try {
      if (isPixeldrain) await collectPixeldrainMetadata(url, meta);
      collectFilesterMetadata(url, meta);

      // HEAD remains mandatory for GoFile and Pixeldrain; otherwise skip Filester.
      if (needsDownloadMetadataHead(url, meta, isGoFile, isPixeldrain)) {
        await collectDownloadHeadMetadata(url, meta);
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
