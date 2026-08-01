// Pure helpers extracted from download.js. No DOM/GM_* access, so they're unit-testable in isolation.
const WIN_ILLEGAL_RE = /[<>:"\/\\|?*\x00-\x1F]/g;

const sanitizeWinSegment = (s, naming, fallback = '_') => {
  const sub = naming?.invalidCharSubstitute ?? '-';
  let out = String(s ?? '').trim();

  // If emojis are disabled, strip emoji/pictographs for consistent behavior across hosts.
  if (naming?.allowEmojis === false) {
    try {
      out = out.replace(/\p{Extended_Pictographic}/gu, '');
    } catch (e) {
      // Fallback: strip surrogate pairs (covers most emoji)
      out = out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
    }
    // Remove variation selectors + ZWJ
    out = out.replace(/[\uFE0E\uFE0F\u200D]/g, '');
  }
  out = out.replace(WIN_ILLEGAL_RE, sub);
  // Remove remaining control chars / oddities
  out = out.replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '');
  // Windows also hates leading/trailing dots/spaces in path segments
  out = out
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!out) out = String(fallback || '_');
  // Avoid reserved device names
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = '_' + out;
  // Very long segments can cause path issues; keep it reasonable.
  if (out.length > 180) out = out.slice(0, 180).trim();
  return out;
};

const sanitizeWinPath = (p, naming) => {
  return String(p || '')
    .split('/')
    .map(s => sanitizeWinSegment(s, naming))
    .join('/');
};

const ensureUniquePath = (path, usedPaths, { ext, fnNoExt }) => {
  let p = String(path || '').trim();
  if (!p) {
    p = 'file';
  }

  if (!usedPaths.has(p)) {
    usedPaths.add(p);
    return p;
  }

  const parts = p.split('/');
  const base = parts.pop();
  const dir = parts.length ? parts.join('/') : '';
  const ext0 = ext(base);
  const stem = ext0 ? fnNoExt(base) : base;

  let i = 2;
  while (true) {
    const candidateBase = ext0 ? `${stem} (${i}).${ext0}` : `${stem} (${i})`;
    const candidate = dir ? `${dir}/${candidateBase}` : candidateBase;
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate);
      return candidate;
    }
    i++;
  }
};

const ensureUniqueFlatName = (name, usedFlatNames, { ext, fnNoExt }) => {
  let n = String(name || '').trim();
  if (!n) {
    n = 'file';
  }

  if (!usedFlatNames.has(n)) {
    usedFlatNames.add(n);
    return n;
  }

  const ext0 = ext(n);
  const stem = ext0 ? fnNoExt(n) : n;

  let i = 2;
  while (true) {
    const candidate = ext0 ? `${stem} (${i}).${ext0}` : `${stem} (${i})`;
    if (!usedFlatNames.has(candidate)) {
      usedFlatNames.add(candidate);
      return candidate;
    }
    i++;
  }
};

const isGoFileUrl = u => /gofile\.io/i.test(String(u || ''));
const isPixeldrainUrl = u => /(?:pixeldrain\.com|pixeldrain\.net|pixeldra\.in)/i.test(String(u || ''));
const isTurboUrl = u => /turbocdn\.st|turbo\.cr|turbovid\.cr/i.test(String(u || ''));
const isImagebamCdnUrl = u => /https?:\/\/(?:images|thumbs)\d+\.imagebam\.com\//i.test(String(u || ''));
const imagebamRefererForCdn = u => {
  try {
    const uu = new URL(String(u || ''), typeof location !== 'undefined' && location.origin ? location.origin : '');
    const base = (uu.pathname || '').split('/').pop() || '';
    const id = base.replace(/\.[a-z0-9]+$/i, '');
    return id ? `https://www.imagebam.com/view/${id}` : 'https://www.imagebam.com/';
  } catch (e) {
    return 'https://www.imagebam.com/';
  }
};

const turboExtractId = u => {
  const s = String(u || '');
  const m =
    s.match(/\/\/(?:[\w-]+\.)?turbo\.cr\/(?:v|d|embed)\/([^\/?#]+)/i) ||
    s.match(/\/\/(?:[\w-]+\.)?turbovid\.cr\/(?:v|d|embed)\/([^\/?#]+)/i);
  return m && m[1] ? m[1] : '';
};

const turboExtractFn = u => {
  const s = String(u || '');
  const m = s.match(/[?&]fn=([^&]+)/i);
  if (m && m[1]) {
    try {
      return decodeURIComponent(m[1].replace(/\+/g, '%20'));
    } catch (e) {
      return m[1];
    }
  }
  return '';
};

const extractNum = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const headerValue = (headers, name) => {
  try {
    const re = new RegExp(`^${name}:\\s*([^\\r\\n]+)`, 'im');
    const m = re.exec(headers || '');
    return m && m[1] ? String(m[1]).trim() : '';
  } catch (e) {
    return '';
  }
};

const parseDispositionFilename = headers => {
  const hRaw = headers || '';
  // RFC 5987 filename*=UTF-8''...
  let m = /filename\*\s*=\s*UTF-8''([^;\r\n]+)/i.exec(hRaw);
  if (m && m[1]) {
    const raw = String(m[1]).trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  }
  m = /filename\s*=\s*"([^"\r\n]+)"/i.exec(hRaw) || /filename\s*=\s*([^;\r\n]+)/i.exec(hRaw);
  if (m && m[1]) return String(m[1]).trim().replace(/^"|"$/g, '');
  return '';
};

// Turbo/bunkr links get their own batch slot: they're throttled by the host, so
// running two at once just queues one behind the other.
const computeBatchLength = list =>
  list.some(file => /(turbocdn\.st|turbo\.cr|turbovid\.cr)/i.test(file.url))
    ? 1
    : list.some(file => /(bunkrr?\.\w+)|(bunkr-cache)/.test(file.url))
      ? 1
      : 2;

// Batch resources while keeping the batch size at batchLength and never putting more than
// one GoFile item in the same batch (prevents GoFile "gate" spam / soft-block cascades).
const buildBatches = (resources, batchLength, isGoFileUrlFn = isGoFileUrl) => {
  const batches = [];
  let tmp = [];
  let tmpHasGoFile = false;

  for (const item of resources) {
    const isGF = isGoFileUrlFn(item.url);
    if (tmp.length >= batchLength || (tmpHasGoFile && isGF)) {
      batches.push(tmp);
      tmp = [];
      tmpHasGoFile = false;
    }

    tmp.push(item);
    if (isGF) tmpHasGoFile = true;
  }

  if (tmp.length) {
    batches.push(tmp);
  }

  return batches;
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitizeWinSegment,
    sanitizeWinPath,
    ensureUniquePath,
    ensureUniqueFlatName,
    isGoFileUrl,
    isPixeldrainUrl,
    isTurboUrl,
    isImagebamCdnUrl,
    imagebamRefererForCdn,
    turboExtractId,
    turboExtractFn,
    extractNum,
    headerValue,
    parseDispositionFilename,
    computeBatchLength,
    buildBatches,
  };
}
