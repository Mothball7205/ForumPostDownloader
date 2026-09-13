// Filester album policy, just-in-time token resolution and bounded DIRECT preflight.
const FIL_IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.tif', '.tiff', '.jxl', '.heic', '.heif']);
const FIL_VID_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg', '.3gp']);

const filesterGuessExt = s => {
  const t = String(s || '').trim();
  const m = t.match(/\.([A-Za-z0-9]{1,8})(?=($|\?))/);
  return m ? `.${String(m[1]).toLowerCase()}` : '';
};

const filesterSlugFromUrl = u0 => {
  try {
    const s = String(u0 || '');
    const mD = /^(?:(?:https?:)?\/\/)?(?:[a-z0-9-]+\.)*filester\.(?:me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(s);
    if (mD && mD[1]) return String(mD[1]);
    // API-issued CDN streams and legacy /v/ tokens map back to their file slug.
    const s2 = String(filesterSlugByUrl.get(String(u0)) || '');
    if (s2) return s2;
  } catch (e) {}
  return '';
};

const filesterHintName = u0 => {
  try {
    const slug = filesterSlugFromUrl(u0);
    const v = (slug ? filesterNameBySlug.get(String(slug)) : '') || filesterNameByUrl.get(String(u0)) || '';
    return String(v || '').trim();
  } catch (e) {
    return '';
  }
};

const filesterHintSize = u0 => {
  try {
    const slug = filesterSlugFromUrl(u0);
    const v = (slug ? filesterSizeBySlug.get(String(slug)) : 0) || filesterSizeByUrl.get(String(u0)) || 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
};

const classifyFilesterDownload = (url, filenameHint = '') => {
  try {
    const hintedName = filenameHint || filesterHintName(url);
    const ext = filesterGuessExt(hintedName || url);
    if (ext && FIL_IMG_EXTS.has(ext)) return 'image';
    if (ext && FIL_VID_EXTS.has(ext)) return 'video';
    // If no extension, treat as "other" (safer for ZIP decisions).
    return 'other';
  } catch (e) {
    return 'other';
  }
};

const isFilesterAlbumOriginal = s =>
  /(?:^|\/\/)(?:www\.)?filester\.(me|sh|si|gg)\/f\//i.test(String(s || '')) || /filester\.(me|sh|si|gg)\/f\//i.test(String(s || ''));

const summarizeFilesterAlbum = items => {
  let hasNonImage = false;
  let totalSize = 0;
  let unknownSize = 0;

  for (const it of items) {
    if ((it.kind || 'other') !== 'image') hasNonImage = true;

    const sz0 = Number(it.size) || 0;
    if (sz0 > 0) totalSize += sz0;
    else unknownSize++;
  }

  return { hasNonImage, totalSize, unknownSize };
};

// Unknown sizes (0) cannot qualify an album for ZIP; return indexes requiring DIRECT.
const planFilesterAlbum = (items, zipped, maxBytes) => {
  const { hasNonImage, totalSize, unknownSize } = summarizeFilesterAlbum(items);
  const allSizesKnown = unknownSize === 0 && totalSize > 0;
  const canZipAll = allSizesKnown && totalSize <= maxBytes;

  const forceDirectIndexes = [];

  if (hasNonImage && (!zipped || !canZipAll)) {
    for (let i = 0; i < items.length; i++) {
      if (!zipped || (items[i].kind || 'other') !== 'image') forceDirectIndexes.push(i);
    }
  }
  // Images-only album: keep default behavior.

  return { forceDirectIndexes, totalSize, unknownSize };
};

const groupFilesterAlbumItems = resources => {
  const groups = new Map();
  for (const item of resources.filter(r => r && r.url && isFilesterAlbumOriginal(r.original))) {
    const key = String(item.original || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
};

const readFilesterAlbumSizes = async (items, readMetadata) => {
  const sizes = items.map(it => filesterHintSize(it.url));
  const unknownItems = [];
  for (let i = 0; i < items.length; i++) {
    if (!(sizes[i] > 0)) unknownItems.push({ it: items[i], index: i });
  }
  // Bound HEAD probes on large albums; unknown sizes retain the safer policy.
  if (unknownItems.length && unknownItems.length <= 10 && items.length <= 25) {
    for (const u of unknownItems) {
      const meta = await readMetadata(u.it.url);
      const size = Number(meta && meta.size) || 0;
      if (size > 0) sizes[u.index] = size;
    }
  }
  return sizes;
};

const describeFilesterAlbumPolicy = (zipped, imgCount, vidCount, otherCount, canZipAll) => {
  if (!(vidCount || otherCount)) return '';
  if (!zipped) return 'Filester album (unzipped) has non-image -> DIRECT all';
  if (imgCount) {
    return canZipAll ? 'Filester mixed album total<=~1.6GB -> ZIP all' : 'Filester mixed album -> ZIP images, DIRECT others';
  }
  const kind = vidCount > 0 && otherCount === 0 ? 'video-only' : 'non-image';
  return canZipAll ? `Filester ${kind} album total<=~1.6GB -> ZIP all` : `Filester ${kind} album >~1.6GB or unknown -> DIRECT all`;
};

const logFilesterAlbumPolicy = (albumUrl, kinds, decision, zipped, postId, postNumber) => {
  let imgCount = 0;
  let vidCount = 0;
  let otherCount = 0;
  for (const kind of kinds) {
    if (kind === 'image') imgCount++;
    else if (kind === 'video') vidCount++;
    else otherCount++;
  }
  const allSizesKnown = decision.unknownSize === 0 && decision.totalSize > 0;
  const canZipAll = allSizesKnown && decision.totalSize <= DOWNLOAD_BLOB_MAX_BYTES;
  const totalStr = allSizesKnown ? `${Math.round(decision.totalSize / 1024 / 1024)}MB` : 'unknown';
  const info = `files=${kinds.length}, images=${imgCount}, videos=${vidCount}, other=${otherCount}, total=${totalStr}, unknown=${decision.unknownSize}`;
  const message = describeFilesterAlbumPolicy(zipped, imgCount, vidCount, otherCount, canZipAll);
  if (message) log.post.info(postId, `::${message} (${info})::: ${albumUrl}`, postNumber);
};

// Decide once per post, grouped by original album URL, before transfer batching.
const applyFilesterAlbumPolicy = async (resources, { zipped, readMetadata, postId, postNumber }) => {
  try {
    const groups = groupFilesterAlbumItems(resources);
    for (const [albumUrl, items] of groups.entries()) {
      const kinds = items.map(it => classifyFilesterDownload(it.url));
      const sizes = await readFilesterAlbumSizes(items, readMetadata);

      const dec = planFilesterAlbum(
        items.map((it, i) => ({ index: i, kind: kinds[i], size: sizes[i] })),
        zipped,
        DOWNLOAD_BLOB_MAX_BYTES,
      );

      for (const idx of dec.forceDirectIndexes) items[idx].forceDirect = true;

      logFilesterAlbumPolicy(albumUrl, kinds, dec, zipped, postId, postNumber);
    }
  } catch (e) {}
};

// Album pages yield /d/<slug> links. Resolve their short-lived v2 tokens only
// when downloading; return null on failure so the caller never saves view HTML.
const prepareFilesterDownloadResource = async (resource, { postId, postNumber, tokenLogState }) => {
  const originalUrl = String((resource && resource.url) || '');
  const file = filesterParseFileUrl(originalUrl);
  if (!file) return originalUrl;
  const stream = await filesterResolveV2(h.http, file.apiBase, file.slug);
  if (!stream) return null;

  filesterNameByUrl.set(originalUrl, stream.name);
  filesterRefByUrl.set(originalUrl, stream.ref);
  filesterSlugByUrl.set(originalUrl, file.slug);
  resource.url = stream.url;
  if (!tokenLogState.filesterNoTabTokenLogged) {
    tokenLogState.filesterNoTabTokenLogged = true;
    log.post.info(postId, `::Filester slug->v2 token (no tab)::: ${file.slug} -> ${stream.url}`, postNumber);
  }
  return stream.url;
};

const probeFilesterDirectCandidate = async (candidate, ref, remaining) => {
  try {
    return await h.http.get(
      candidate,
      { onResponseHeadersReceieved: () => {} },
      { Range: 'bytes=0-0', Accept: '*/*', Referer: ref, __xfpd_withCredentials: true },
      'text',
      Math.min(FILESTER_PROBE_TIMEOUT_MS, remaining),
    );
  } catch (e) {
    return null;
  }
};

const filesterDirectProbeSucceeded = (response, status) => {
  const headers = String(response?.responseHeaders || '');
  const isGate = /(?:^|\r?\n)content-type:\s*(?:text\/html|application\/xhtml\+xml|application\/json)/i.test(headers);
  return status >= 200 && status < 400 && !isGate;
};

const acceptFilesterDirectCandidate = (response, status, candidate, originalUrl, ref, postId, postNumber) => {
  const finalUrl = String(response.finalUrl || '');
  const directUrl = /^https?:\/\//i.test(finalUrl) ? finalUrl : candidate;
  const slug = filesterSlugByUrl.get(originalUrl);
  if (filesterV2Urls.has(originalUrl)) filesterV2Urls.add(directUrl);
  if (slug) filesterSlugByUrl.set(directUrl, slug);
  filesterRefByUrl.set(directUrl, ref);
  if (directUrl !== originalUrl) {
    log.post.info(postId, `::Filester DIRECT selected stream (HTTP ${status})::: ${directUrl}`, postNumber);
  }
  return { directUrl, preflightDone: true };
};

const waitForFilesterDirectRetry = async (candidate, index, deadline, status, postId, postNumber) => {
  const delay = Math.min(650 * (index + 1), deadline - Date.now());
  if (delay <= 0) return false;
  log.post.info(postId, `::Filester DIRECT HTTP ${status} -> trying another legacy CDN::: ${candidate}`, postNumber);
  await h.delayedResolve(delay);
  return true;
};

// V2 tokens are server-bound: only preflight the issued URL. Legacy /v/ streams
// may rotate hosts, within both a per-request deadline and a total probe budget.
const selectFilesterDirectUrl = async (url, resource, { postId, postNumber }) => {
  const originalUrl = String(url || '');
  const token = filesterTokenFromVUrl(originalUrl);
  if (!token && !isFilesterUrl(originalUrl)) return { directUrl: originalUrl, preflightDone: false };

  const ref = String(filesterRefByUrl.get(originalUrl) || (resource && resource.original) || 'https://filester.me/');
  const candidates = token
    ? [...new Set([originalUrl, ...(filesterCandidatesByToken.get(token) || filesterBuildCandidates(token))])]
    : [originalUrl];
  return probeFilesterDirectCandidates(candidates, originalUrl, ref, postId, postNumber);
};

const probeFilesterDirectCandidates = async (candidates, originalUrl, ref, postId, postNumber) => {
  const deadline = Date.now() + FILESTER_PROBE_BUDGET_MS;

  for (let i = 0; i < Math.min(3, candidates.length); i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const candidate = candidates[i];
    const response = await probeFilesterDirectCandidate(candidate, ref, remaining);
    const status = Number(response?.status) || 0;
    if (filesterDirectProbeSucceeded(response, status)) {
      return acceptFilesterDirectCandidate(response, status, candidate, originalUrl, ref, postId, postNumber);
    }

    const retryable = status === 0 || [400, 403, 404, 429].includes(status) || status >= 500;
    if (!retryable) break;
    if (i + 1 < Math.min(3, candidates.length)) {
      if (!(await waitForFilesterDirectRetry(candidates[i + 1], i, deadline, status, postId, postNumber))) break;
    }
  }

  return { directUrl: originalUrl, preflightDone: true };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FIL_IMG_EXTS,
    FIL_VID_EXTS,
    classifyFilesterDownload,
    filesterGuessExt,
    filesterHintName,
    filesterHintSize,
    filesterSlugFromUrl,
    isFilesterAlbumOriginal,
    planFilesterAlbum,
    applyFilesterAlbumPolicy,
    prepareFilesterDownloadResource,
    selectFilesterDirectUrl,
  };
}
