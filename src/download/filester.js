// Filester: classification, album ZIP-vs-DIRECT policy (applied once per post,
// not once per batch), /d/->v2 token preparation, and bounded DIRECT preflight.
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

// Pure decision planner: given per-item kind ('image'|'video'|'other') and size
// (0 = unknown), decide which items must leave the ZIP. Returns the ascending
// indexes to force DIRECT plus the size totals used for logging.
const planFilesterAlbum = (items, zipped, maxBytes) => {
  let hasImage = false;
  let hasNonImage = false;
  let imgCount = 0;
  let vidCount = 0;
  let otherCount = 0;
  let totalSize = 0;
  let unknownSize = 0;

  for (const it of items) {
    const kind = it.kind || 'other';
    if (kind === 'image') {
      hasImage = true;
      imgCount++;
    } else if (kind === 'video') {
      hasNonImage = true;
      vidCount++;
    } else {
      hasNonImage = true;
      otherCount++;
    }

    const sz0 = Number(it.size) || 0;
    if (sz0 > 0) totalSize += sz0;
    else unknownSize++;
  }

  const allSizesKnown = unknownSize === 0 && totalSize > 0;
  const canZipAll = allSizesKnown && totalSize <= maxBytes;

  const forceDirectIndexes = [];

  if (!zipped) {
    // Unzipped: if there is ANY non-image (mixed or video-only) -> DIRECT all.
    if (hasNonImage) {
      for (let i = 0; i < items.length; i++) forceDirectIndexes.push(i);
    }
  } else if (hasImage && hasNonImage) {
    // Zipped mixed: ZIP images only; everything else DIRECT when we can't ZIP all.
    if (!canZipAll) {
      for (let i = 0; i < items.length; i++) {
        const kind = items[i].kind || 'other';
        if (kind !== 'image') forceDirectIndexes.push(i);
      }
    }
  } else if (!hasImage && hasNonImage) {
    // Zipped non-image only: DIRECT all when we can't ZIP all.
    if (!canZipAll) {
      for (let i = 0; i < items.length; i++) forceDirectIndexes.push(i);
    }
  }
  // Images-only album: keep default behavior.

  return { forceDirectIndexes, totalSize, unknownSize };
};

// ONE pass over the resolved resources (defect fix: the old code ran this inside
// the per-batch loop, re-probing and re-deciding for every batch). Groups by the
// original /f/ album URL; bounded unknown-size HEAD probes (<=10 items / <=25 total).
const applyFilesterAlbumPolicy = async (resources, { zipped, readMetadata, postId, postNumber }) => {
  try {
    const albumItems = resources.filter(r => r && r.url && isFilesterAlbumOriginal(r.original));
    if (!albumItems.length) return;

    // Group by the original album URL so each album is handled independently.
    const groups = new Map();
    for (const it of albumItems) {
      const k = String(it.original || '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }

    for (const [albumUrl, items] of groups.entries()) {
      const kinds = items.map(it => classifyFilesterDownload(it.url));
      const sizes = items.map(it => filesterHintSize(it.url));

      const unknownItems = [];
      for (let i = 0; i < items.length; i++) {
        if (!(sizes[i] > 0)) unknownItems.push({ it: items[i], index: i });
      }

      // Best-effort: only attempt HEAD for missing sizes on small albums.
      // (Avoids 100x HEAD calls on huge albums; in that case we default to the safer policy.)
      if (unknownItems.length && unknownItems.length <= 10 && items.length <= 25) {
        for (const u of unknownItems) {
          const meta = await readMetadata(u.it.url);
          const sz = Number(meta && meta.size) || 0;
          if (sz > 0) sizes[u.index] = sz;
        }
      }

      const dec = planFilesterAlbum(
        items.map((it, i) => ({ index: i, kind: kinds[i], size: sizes[i] })),
        zipped,
        DOWNLOAD_BLOB_MAX_BYTES,
      );

      for (const idx of dec.forceDirectIndexes) items[idx].forceDirect = true;

      let hasImage = false;
      let hasNonImage = false;
      let imgCount = 0;
      let vidCount = 0;
      let otherCount = 0;
      for (const k of kinds) {
        if (k === 'image') {
          hasImage = true;
          imgCount++;
        } else if (k === 'video') {
          hasNonImage = true;
          vidCount++;
        } else {
          hasNonImage = true;
          otherCount++;
        }
      }

      const allSizesKnown = dec.unknownSize === 0 && dec.totalSize > 0;
      const canZipAll = allSizesKnown && dec.totalSize <= DOWNLOAD_BLOB_MAX_BYTES;
      const totalStr = allSizesKnown ? `${Math.round(dec.totalSize / 1024 / 1024)}MB` : 'unknown';
      const info = `files=${items.length}, images=${imgCount}, videos=${vidCount}, other=${otherCount}, total=${totalStr}, unknown=${dec.unknownSize}`;

      if (!zipped) {
        if (hasNonImage) {
          log.post.info(postId, `::Filester album (unzipped) has non-image -> DIRECT all (${info})::: ${albumUrl}`, postNumber);
        }
        continue;
      }

      if (hasImage && hasNonImage) {
        if (!canZipAll) {
          log.post.info(postId, `::Filester mixed album -> ZIP images, DIRECT others (${info})::: ${albumUrl}`, postNumber);
        } else {
          log.post.info(postId, `::Filester mixed album total<=~1.6GB -> ZIP all (${info})::: ${albumUrl}`, postNumber);
        }
      } else if (!hasImage && hasNonImage) {
        const isVideoOnly = vidCount > 0 && otherCount === 0;
        if (!canZipAll) {
          log.post.info(
            postId,
            `::Filester ${isVideoOnly ? 'video-only' : 'non-image'} album >~1.6GB or unknown -> DIRECT all (${info})::: ${albumUrl}`,
            postNumber,
          );
        } else {
          log.post.info(
            postId,
            `::Filester ${isVideoOnly ? 'video-only' : 'non-image'} album total<=~1.6GB -> ZIP all (${info})::: ${albumUrl}`,
            postNumber,
          );
        }
      }
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
  const deadline = Date.now() + FILESTER_PROBE_BUDGET_MS;

  for (let i = 0; i < Math.min(3, candidates.length); i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const candidate = candidates[i];
    let response = null;
    try {
      response = await h.http.get(
        candidate,
        { onResponseHeadersReceieved: () => {} },
        { Range: 'bytes=0-0', Accept: '*/*', Referer: ref, __xfpd_withCredentials: true },
        'text',
        Math.min(FILESTER_PROBE_TIMEOUT_MS, remaining),
      );
    } catch (e) {}

    const status = Number(response?.status) || 0;
    const headers = String(response?.responseHeaders || '');
    const isGate = /(?:^|\r?\n)content-type:\s*(?:text\/html|application\/xhtml\+xml|application\/json)/i.test(headers);
    if (status >= 200 && status < 400 && !isGate) {
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
    }

    const retryable = status === 0 || [400, 403, 404, 429].includes(status) || status >= 500;
    if (!retryable) break;
    if (i + 1 < Math.min(3, candidates.length)) {
      const delay = Math.min(650 * (i + 1), deadline - Date.now());
      if (delay <= 0) break;
      log.post.info(postId, `::Filester DIRECT HTTP ${status} -> trying another legacy CDN::: ${candidates[i + 1]}`, postNumber);
      await h.delayedResolve(delay);
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
