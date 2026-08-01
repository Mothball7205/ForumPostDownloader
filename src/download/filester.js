// Filester: classification, album ZIP-vs-DIRECT policy (applied once per post,
// not once per batch), /d/->/v/ token preparation, and DIRECT cache preflight.
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
    const mD = /\/d\/([^\/?#]+)/i.exec(s);
    if (mD && mD[1]) return String(mD[1]);
    // cacheN /v/ tokens -> map back to slug when known
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

// Turn short /d/<slug> view URLs into cache /v/<token> stream URLs (no tabs).
// Album pages (/f/...) mostly contain only short slugs, which require this token step.
// Mutates resource.url; returns the (possibly unchanged) stream URL.
const prepareFilesterDownloadResource = async (resource, { postId, postNumber, tokenLogState }) => {
  const originalUrl = String((resource && resource.url) || '');
  try {
    const uF = new URL(originalUrl);
    const isFilesterD = /(^|\.)filester\.(me|sh|si|gg)$/i.test(String(uF.host || '')) && /^\/d\//i.test(String(uF.pathname || ''));
    if (!isFilesterD) return originalUrl;

    const slug =
      String(uF.pathname || '')
        .split('/')
        .filter(Boolean)
        .pop() || '';
    // Short slugs look like "d8ZdCxc" / "QnUVP6A" etc.
    const looksLikeShortSlug = /^[A-Za-z0-9]{6,12}$/.test(slug);
    if (!looksLikeShortSlug) return originalUrl;

    const apiRes = await h.http.base(
      'POST',
      'https://filester.me/api/public/download',
      {},
      {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: 'https://filester.me',
        Referer: `https://filester.me/d/${slug}`,
        __xfpd_withCredentials: true,
      },
      JSON.stringify({ file_slug: slug }),
      'text',
    );

    const txt = String((apiRes && apiRes.source) || '');
    let j = null;
    try {
      j = JSON.parse(txt);
    } catch (e) {}

    let token = '';
    try {
      if (j && typeof j.token === 'string') token = String(j.token).trim();
    } catch (e) {}
    if (!token) {
      try {
        const rel = j && (j.download_url || j.downloadUrl || j.url);
        if (typeof rel === 'string' && rel.trim()) {
          const m = /\/d\/([^\/?#]+)/i.exec(String(rel));
          if (m && m[1]) token = String(m[1]).trim();
        }
      } catch (e) {}
    }
    if (!token) {
      const m2 = /"token"\s*:\s*"([^"]+)"/i.exec(txt);
      if (m2 && m2[1]) token = String(m2[1]).trim();
    }

    if (!token) return originalUrl;

    const candidates = filesterBuildCandidates(token);
    const streamUrl = candidates && candidates.length ? candidates[0] : `https://cache6.filester.me/v/${token}`;
    try {
      filesterCandidatesByToken.set(String(token), candidates);
    } catch (e) {}
    try {
      for (const c of candidates || []) {
        try {
          filesterSlugByUrl.set(String(c), String(slug));
        } catch (e) {}
        try {
          filesterRefByUrl.set(String(c), 'https://filester.me/');
        } catch (e) {}
      }
    } catch (e) {}
    if (!tokenLogState.filesterNoTabTokenLogged) {
      tokenLogState.filesterNoTabTokenLogged = true;
      log.post.info(postId, `::Filester slug->token->cache (no tab)::: ${slug} -> ${streamUrl}`, postNumber);
    }

    try {
      filesterSlugByUrl.set(String(streamUrl), String(slug));
    } catch (e) {}
    try {
      filesterRefByUrl.set(String(streamUrl), 'https://filester.me/');
    } catch (e) {}
    try {
      filesterRefByUrl.set(String(originalUrl), 'https://filester.me/');
    } catch (e) {}
    resource.url = streamUrl;
    return streamUrl;
  } catch (e) {
    return originalUrl;
  }
};

// Filester DIRECT: probe candidate cache hosts (Range: bytes=0-0) and pick the
// first healthy one before GM_download. Returns { directUrl, preflightDone }.
const selectFilesterDirectUrl = async (url, resource, { postId, postNumber }) => {
  try {
    const ref = String(filesterRefByUrl.get(String(url)) || (resource && resource.original) || 'https://filester.me/');
    const token0 = filesterTokenFromVUrl(String(url || ''));

    if (!token0) return { directUrl: String(url), preflightDone: false };

    let candidates0 = filesterCandidatesByToken.get(token0) || filesterBuildCandidates(token0);
    candidates0 = Array.isArray(candidates0) ? candidates0.slice() : [];

    const u0 = String(url);
    const ix = candidates0.indexOf(u0);
    if (ix >= 0) candidates0.splice(ix, 1);
    candidates0.unshift(u0);

    const cacheLabel = u => {
      const m = String(u || '').match(/https?:\/\/cache(\d+)\.filester\.(me|sh|si|gg)/i);
      return m && m[1] ? `cache${m[1]}` : String(u || '').includes('filester.me') ? 'filester' : 'url';
    };

    const isRetryableStatus = st => {
      const n = Number(st || 0) || 0;
      return n === 0 || n === 400 || n === 403 || n === 404 || n === 429 || (n >= 500 && n <= 599);
    };

    const delays = [650, 1300, 2000];

    for (let i = 0; i < 3; i++) {
      const cand = candidates0[i] || u0;

      const pre = await new Promise(resolve => {
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: String(cand),
            responseType: 'text',
            anonymous: false,
            withCredentials: true,
            timeout: 5000,
            headers: { Range: 'bytes=0-0', Accept: '*/*', Referer: ref },
            onload: r => resolve(r),
            onerror: _ => resolve(null),
            ontimeout: _ => resolve(null),
          });
        } catch (e) {
          resolve(null);
        }
      });

      const st0 = Number((pre && pre.status) || 0) || 0;
      const finalUrl = pre && (pre.finalUrl || pre.responseURL) ? String(pre.finalUrl || pre.responseURL) : '';
      const ok = st0 && st0 < 400;

      if (ok) {
        const directUrl = finalUrl && /^https?:\/\//i.test(finalUrl) ? finalUrl : String(cand);

        if (i > 0 || String(cand) !== u0 || (finalUrl && finalUrl !== cand)) {
          log.post.info(postId, `::Filester DIRECT picked ${cacheLabel(cand)} (HTTP ${st0})::: ${directUrl}`, postNumber);
        }
        return { directUrl, preflightDone: true };
      }

      if (i < 2 && isRetryableStatus(st0) && candidates0[i + 1]) {
        const next = candidates0[i + 1];
        const delay = delays[i] || 1000;
        log.post.info(
          postId,
          `::Filester DIRECT HTTP ${st0 || 0} -> retry [${i + 1}/3] after ${delay}ms; switching ${cacheLabel(cand)}->${cacheLabel(next)}::: ${next}`,
          postNumber,
        );
        await h.delayedResolve(delay);
      }
    }

    return { directUrl: String(url), preflightDone: true };
  } catch (e) {
    return { directUrl: String(url), preflightDone: false };
  }
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
