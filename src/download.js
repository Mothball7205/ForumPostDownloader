const setProcessing = (isProcessing, postId) => {
  const p = processing.find(p => p.postId === postId);
  if (p) {
    p.processing = isProcessing;
  } else {
    processing.push({ postId, processing: isProcessing });
  }
};

const downloadPost = async (parsedPost, parsedHosts, enabledHostsCB, resolvers, getSettingsCB, statusUI, callbacks = {}) => {
  const { postId, postNumber } = parsedPost;

  const postSettings = getSettingsCB();

  const enabledHosts = enabledHostsCB(parsedHosts);

  // TODO: Fix this filth.
  window.logs = window.logs.filter(l => l.postId !== postId);

  log.separator(postId);
  log.post.info(postId, `::Using ${enabledHosts.length} host(s)::: ${enabledHosts.map(h => h.name).join(', ')}`, postNumber);

  log.separator(postId);
  log.post.info(postId, `::Preparing download::`, postNumber);

  let completed = 0;
  const zip = new JSZip();
  let zipFileCount = 0;
  let resolved = [];

  const statusLabel = statusUI.status;
  const filePB = statusUI.filePB;
  const totalPB = statusUI.totalPB;

  h.ui.setElProps(statusLabel, {
    color: '#469cf3',
    marginBottom: '3px',
    fontSize: '12px',
  });

  h.ui.setElProps(filePB, {
    width: '0%',
    marginBottom: '1px',
  });

  h.ui.setElProps(totalPB, {
    width: '0%',
    marginBottom: '10px',
  });

  h.show(statusLabel);
  h.show(filePB);
  h.show(totalPB);

  h.ui.setText(statusLabel, 'Resolving...');

  // Bunkr: capture filename hints from visible link text (works even when CF blocks /v/ pages).
  try {
    const cc = parsedPost && parsedPost.contentContainer;
    if (cc && cc.querySelectorAll) {
      const strip = s =>
        String(s || '')
          .split('#')[0]
          .split('?')[0];
      const normUrl = u => {
        u = String(u || '')
          .replace(/&amp;/g, '&')
          .trim();
        u = u.split(/[\s"'<>]/)[0].trim();
        if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
        if (u.endsWith('/')) u = u.slice(0, -1);
        return u;
      };
      const extractName = t => {
        let s = String(t || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!s) return '';
        // If link text is itself a URL, it isn't a filename hint.
        if (/^https?:\/\//i.test(s)) return '';
        // Whole string looks like a filename (keep spaces).
        if (/\.[A-Za-z0-9]{1,8}$/.test(s) && s.length <= 200) return s;
        // Otherwise pick the last token-like filename.
        const m = s.match(/[^\\/:*?"<>|\s]+\.[A-Za-z0-9]{1,8}/g);
        if (m && m.length) {
          const cand = m[m.length - 1];
          if (cand && cand.length <= 200) return cand;
        }
        return '';
      };

      cc.querySelectorAll('a[href]').forEach(a => {
        const href0 = normUrl(a.getAttribute('href'));
        if (!href0) return;

        // only for bunkr-ish links (skip direct scdn links)
        if (!/bunkrr?r?\./i.test(href0)) return;
        if (/scdn\.st\//i.test(href0)) return;

        const nm = extractName(a.textContent || '');
        if (!nm) return;
        if (xfpdLooksLikeCfFilenameHint(nm)) return;

        bunkrNameByUrl.set(href0, nm);
        bunkrNameByUrl.set(strip(href0), nm);
      });

      cc.querySelectorAll('a[href*="goonbox.cr/img/"]').forEach(a => {
        const href0 = strip(normUrl(a.getAttribute('href')));
        if (!href0) return;

        const img = a.querySelector('img');
        const thumbUrl = img && (img.getAttribute('data-url') || img.getAttribute('src'));
        if (!thumbUrl) return;

        goonboxThumbByUrl.set(href0, thumbUrl);
      });
    }
  } catch (e) {}

  log.post.info(postId, '::Url resolution started::', postNumber);

  const totalResourcesToResolve = enabledHosts.reduce((acc, host) => acc + host.resources.length, 0);
  let resolvingIndex = 0;

  for (const host of enabledHosts.filter(host => host.resources.length)) {
    const resources = host.resources;

    for (const resource of resources) {
      resolvingIndex++;
      h.ui.setElProps(statusLabel, { color: '#469cf3', fontWeight: 'bold' });
      h.ui.setText(statusLabel, `Resolving: ${resolvingIndex} / ${totalResourcesToResolve} 🢒 ${h.limit(resource, 80)}`);

      for (const resolver of resolvers) {
        const patterns = resolver[0];
        const resolverCB = resolver[1];

        let matched = true;

        for (const pattern of patterns) {
          let strPattern = pattern.toString();

          let shouldMatch = !h.contains(':!', strPattern);

          strPattern = strPattern.replace(':!', '');
          strPattern = h.re.toRegExp(h.re.toString(strPattern), 'is');

          if (shouldMatch && !strPattern.test(resource)) {
            matched = false;
            break;
          } else if (!shouldMatch && strPattern.test(resource)) {
            matched = false;
            break;
          }
        }

        if (!matched) {
          continue;
        }

        const passwords = parsedPost.spoilers.concat(parsedPost.spoilers.map(s => s.toLowerCase()));

        let r = null;

        try {
          const progressCB = t => {
            try {
              h.ui.setElProps(statusLabel, { color: '#469cf3', fontWeight: 'bold' });
              h.ui.setText(statusLabel, t);
            } catch (e) {}
          };

          r = await h.promise(resolve => resolve(resolverCB(resource, h.http, passwords, postId, postSettings, progressCB)));
        } catch (e) {
          if (host.name === 'Cyberdrop' && /cyberdrop\.[a-z]{2,}\/a\//i.test(String(resource))) {
            continue;
          }
          log.post.error(postId, `::Error resolving::: ${resource}`, postNumber);
          continue;
        }

        if (h.isNullOrUndef(r)) {
          log.post.error(postId, `::Could not resolve::: ${resource}`, postNumber);
          continue;
        }

        h.ui.setElProps(statusLabel, { color: '#47ba24', fontWeight: 'bold' });
        h.ui.setText(statusLabel, `Resolved: ${resolved.length}`);

        const addResolved = (url, folderName) => {
          if (!resolved.length) {
            log.separator(postId);
          }

          if (h.isObject(url)) {
            resolved.push({
              url: url.url,
              host,
              original: resource,
              folderName: url.folderName,
              forceUnzipped: false, // Filester can be zipped when using blob; DIRECT always saves outside ZIP
              forceDirect: false,
            });
            log.post.info(postId, `::Resolved::: ${url.url}`, postNumber);
          } else {
            resolved.push({
              url,
              host,
              original: resource,
              folderName,
              forceUnzipped: false, // Filester can be zipped when using blob; DIRECT always saves outside ZIP
              forceDirect: false,
            });
            log.post.info(postId, `::Resolved::: ${url}`, postNumber);
          }
        };

        if (h.isArray(r.resolved)) {
          r.resolved.forEach(url => {
            try {
              addResolved(url, r.folderName);
            } catch (e) {}
          });
        } else {
          addResolved(r, null);
        }
      }
    }
  }

  if (resolved.length) {
    log.separator(postId);
  }

  log.post.info(postId, '::Url resolution completed::', postNumber);

  let totalDownloadable = resolved.filter(r => r.url).length;

  const totalResources = enabledHosts.reduce((acc, h) => h.resources.length + acc, 0);

  h.ui.setElProps(statusLabel, { color: '#47ba24', fontWeight: 'bold' });
  h.ui.setText(statusLabel, `Resolved: ${resolved.length} / ${totalDownloadable} 🢒 ${totalResources} Total Links`);

  const filenames = [];
  const mimeTypes = [];

  const usedPaths = new Set();
  const usedFlatNames = new Set();

  setProcessing(true, postId);

  log.separator(postId);
  log.post.info(postId, `::Found ${totalDownloadable} resource(s)::`, postNumber);
  log.separator(postId);

  const threadTitle = parsers.thread.parseTitle();

  let customFilename = postSettings.output.find(o => o.postId === postId)?.value;

  if (customFilename) {
    customFilename = customFilename.replace(/:title:/g, threadTitle);
    customFilename = customFilename.replace(/:#:/g, postNumber);
    customFilename = customFilename.replace(/:id:/g, postId);
  }

  if (postSettings.skipDuplicates) {
    const unique = [];
    for (const r of resolved.filter(r => r.url).sort((a, b) => (a.host.type !== 'folder' || b.host.type !== 'folder' ? -1 : 1))) {
      const filename = h.basename(r.url);
      if (unique.find(u => u.filename.toLowerCase() === filename.toLowerCase())) {
        log.post.info(postId, `::Skipped duplicate::: ${filename} ::from:: ${r.url}`, postNumber);
        continue;
      }
      unique.push({ ...r, filename });
    }

    if (unique.length !== resolved.length) {
      h.ui.setText(statusLabel, `Removed ${resolved.length - unique.length} duplicates...`);
      unique.forEach(u => delete u.filename);
      resolved = unique;
      totalDownloadable = resolved.length;
    }
  }

  const isFF = window.isFF;

  if (!postSettings.skipDownload) {
    const resources = resolved.filter(r => r.url);
    totalDownloadable = resources.length;

    const batchLength = computeBatchLength(resolved);

    let currentBatch = 0;

    const batches = buildBatches(resources, batchLength);

    const getNextBatch = () => {
      const batch = currentBatch < batches.length ? batches[currentBatch] : [];
      currentBatch++;
      return batch;
    };

    const requestProgress = [];

    const requests = [];

    let completedBatchedDownloads = 0;

    let cyberdropDirectWarmupDone = false;

    let batch = getNextBatch();

    while (batch.length) {
      const GOFILE_WARMUP_MS = 3000;

      // Turbo: if a signed turbocdn URL stalls (no progress), re-sign and retry quickly before falling back.
      const TURBO_STALL_MS = 5000;
      const TURBO_RESIGN_RETRIES = 3; // number of re-sign + retry attempts
      const TURBO_DIRECT_FALLBACKS = 1; // number of direct-download fallbacks after re-sign retries
      const TURBO_RETRY_DELAY_MS = 600; // small pause before re-sign retry
      const TURBO_DIRECT_DELAY_MS = 800; // small pause before DIRECT fallback
      const turboRetryState = new Map(); // key -> { resign: n, direct: n }

      const gmGetTextWithHeaders = (getUrl, headers) =>
        new Promise(resolve => {
          try {
            GM_xmlhttpRequest({
              method: 'GET',
              url: getUrl,
              headers: headers || {},
              onload: r => resolve({ ok: true, status: r.status, text: r.responseText || '' }),
              onerror: () => resolve({ ok: false, status: 0, text: '' }),
              ontimeout: () => resolve({ ok: false, status: 0, text: '' }),
            });
          } catch (e) {
            resolve({ ok: false, status: 0, text: '' });
          }
        });

      const turboResignSignedUrl = async (turboId, currentUrl) => {
        if (!turboId) return null;

        const embedUrl = `https://turbo.cr/embed/${turboId}`;
        const keepFn = turboExtractFn(currentUrl) || '';

        try {
          const j = await xfpdTurboFetchSignJsonWithTimeout(turboId, embedUrl);
          if (j && j.url) {
            let signed = j.url;
            const name = (j.original_filename || keepFn || '').toString();
            if (signed && name && !/[?&]fn=/i.test(String(signed))) {
              const enc = encodeURIComponent(String(name)).replace(/%20/g, '+');
              signed += (signed.includes('?') ? '&' : '?') + 'fn=' + enc;
            }
            try {
              turboIdBySignedUrl.set(String(signed), String(turboId));
            } catch (e) {}
            return signed;
          }
        } catch (e) {}

        return null;
      };
      const gofileWarmupAttempted = new Set();
      // url -> highest pass number currently authoritative. GM_xmlhttpRequest's abort()
      // isn't always reliable once a blob response is substantially buffered, so a
      // "stalled" pass-1 request can still fire onload after we've already moved on to a
      // warm-up retry -- checked in the blob onload handler to stop that stale pass from
      // also saving the file (duplicate download alongside the retry's result).
      const gofileActivePass = new Map();
      const CYBERDROP_WARMUP_MS = 1500;

      const BLOB_MAX_BYTES = Math.floor(1.6 * 1024 * 1024 * 1024);
      const BUNKR_DIRECT_MIN_BYTES = 500 * 1024 * 1024;
      const preflightMetaCache = new Map();

      const gmHead = (headUrl, reflink) =>
        new Promise(resolve => {
          try {
            GM_xmlhttpRequest({
              method: 'HEAD',
              url: headUrl,
              onload: r => resolve({ ok: true, status: r.status, headers: r.responseHeaders || '' }),
              onerror: () => resolve({ ok: false, status: 0, headers: '' }),
              ontimeout: () => resolve({ ok: false, status: 0, headers: '' }),
            });
          } catch (e) {
            resolve({ ok: false, status: 0, headers: '' });
          }
        });

      const gmGetText = (getUrl, reflink) =>
        new Promise(resolve => {
          try {
            GM_xmlhttpRequest({
              method: 'GET',
              url: getUrl,
              onload: r => resolve({ ok: true, status: r.status, text: r.responseText || '' }),
              onerror: () => resolve({ ok: false, status: 0, text: '' }),
              ontimeout: () => resolve({ ok: false, status: 0, text: '' }),
            });
          } catch (e) {
            resolve({ ok: false, status: 0, text: '' });
          }
        });

      const preflightMeta = async (dlUrl, reflink, isGoFile, isPixeldrain) => {
        const key = `${dlUrl}`;
        if (preflightMetaCache.has(key)) return preflightMetaCache.get(key);

        const meta = { size: 0, filename: '', status: 0, contentType: '', headers: '' };

        try {
          if (isPixeldrain) {
            const mFile = /(?:pixeldrain\.com|pixeldrain\.net|pixeldra\.in)\/api\/file\/([^\/?#]+)/i.exec(dlUrl || '');
            if (mFile && mFile[1]) {
              const pdOrigin = (() => {
                try {
                  const uu = new URL(dlUrl || '', location.origin);
                  const host = String(uu.hostname || '').toLowerCase();
                  if (host.endsWith('pixeldrain.net')) return 'https://pixeldrain.net';
                  if (host.endsWith('pixeldra.in')) return 'https://pixeldra.in';
                  return 'https://pixeldrain.com';
                } catch (e) {
                  return 'https://pixeldrain.com';
                }
              })();
              const infoUrl = `${pdOrigin}/api/file/${mFile[1]}/info`;
              const r = await gmGetText(infoUrl, reflink);
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
                const s0 = String(filesterSlugByUrl.get(String(dlUrl)) || '');
                hintedSize = Number(filesterSizeBySlug.get(s0) || filesterSizeByUrl.get(String(dlUrl)) || 0) || 0;
              } catch (e) {
                hintedSize = 0;
              }
              if (hintedSize) meta.size = extractNum(hintedSize);
            }
            if (!meta.filename) {
              let hintedName = '';
              try {
                const s0 = String(filesterSlugByUrl.get(String(dlUrl)) || '');
                hintedName = String(filesterNameBySlug.get(s0) || filesterNameByUrl.get(String(dlUrl)) || '');
              } catch (e) {
                hintedName = '';
              }
              if (hintedName) meta.filename = String(hintedName);
            }
          } catch (e) {}

          // Fallback HEAD (works for GoFile store links and Pixeldrain list ZIPs)
          const nameHasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(meta.filename || ''));
          const isFilester = /(?:^https?:\/\/)?(?:cache\d+\.)?filester\.(me|sh|si|gg)\/v\//i.test(String(dlUrl || ''));
          const needHead = !!(isGoFile || isPixeldrain || (!isFilester && (!meta.size || !meta.filename || !nameHasExt)));
          if (needHead) {
            const hRes = await gmHead(dlUrl, reflink);
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

        preflightMetaCache.set(key, meta);
        return meta;
      };

      // Filester album policy (location stays unchanged; this only decides ZIP vs DIRECT per file).
      // Rules:
      // - Zipped ON:
      //   * If album contains images + other files:
      //       - If total (all files) <= ~1.6GB AND all sizes are known -> ZIP all.
      //       - Else -> ZIP images only, save the rest via DIRECT (outside ZIP).
      //   * If album contains only non-image files:
      //       - If total <= ~1.6GB AND all sizes are known -> ZIP all.
      //       - Else -> DIRECT all (skip ZIP).
      // - Zipped OFF:
      //   * If album contains any non-image file (mixed OR video-only) -> DIRECT all.
      //   * Images-only album keeps default behavior.

      const FIL_IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.tif', '.tiff', '.jxl', '.heic', '.heif']);
      const FIL_VID_EXTS = new Set([
        '.mp4',
        '.m4v',
        '.webm',
        '.mkv',
        '.mov',
        '.avi',
        '.wmv',
        '.flv',
        '.ts',
        '.m2ts',
        '.mpg',
        '.mpeg',
        '.3gp',
      ]);

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

      const filesterClassify = u0 => {
        try {
          const hintedName = filesterHintName(u0);
          const ext = filesterGuessExt(hintedName || u0);
          if (ext && FIL_IMG_EXTS.has(ext)) return 'image';
          if (ext && FIL_VID_EXTS.has(ext)) return 'video';
          // If no extension, treat as "other" (safer for ZIP decisions).
          return 'other';
        } catch (e) {
          return 'other';
        }
      };

      const applyFilesterAlbumPolicy = async () => {
        try {
          const isFilesterAlbumOriginal = s =>
            /(?:^|\/\/)(?:www\.)?filester\.(me|sh|si|gg)\/f\//i.test(String(s || '')) ||
            /filester\.(me|sh|si|gg)\/f\//i.test(String(s || ''));
          const albumItems = resolved.filter(r => r && r.url && isFilesterAlbumOriginal(r.original));
          if (!albumItems.length) return;

          // Group by the original album URL so each album is handled independently.
          const groups = new Map();
          for (const it of albumItems) {
            const k = String(it.original || '');
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(it);
          }

          for (const [albumUrl, items] of groups.entries()) {
            let hasImage = false;
            let hasNonImage = false;
            let imgCount = 0;
            let vidCount = 0;
            let otherCount = 0;
            let nonImgCount = 0;
            let totalSize = 0;
            let unknownSize = 0;

            const unknownItems = [];

            // Collect classification + sizes.
            for (const it of items) {
              const kind = filesterClassify(it.url);
              if (kind === 'image') {
                hasImage = true;
                imgCount++;
              } else if (kind === 'video') {
                hasNonImage = true;
                vidCount++;
                nonImgCount++;
              } else {
                hasNonImage = true;
                otherCount++;
                nonImgCount++;
              }

              const sz0 = filesterHintSize(it.url);
              if (sz0 > 0) totalSize += sz0;
              else {
                unknownSize++;
                unknownItems.push(it);
              }
            }

            // Best-effort: only attempt HEAD for missing sizes on small albums.
            // (Avoids 100x HEAD calls on huge albums; in that case we default to the safer policy.)
            if (unknownItems.length && unknownItems.length <= 10 && items.length <= 25) {
              for (const it of unknownItems) {
                const meta = await preflightMeta(it.url, String(albumUrl || 'https://filester.me/'), false, false);
                const sz = Number(meta && meta.size) || 0;
                if (sz > 0) {
                  totalSize += sz;
                  unknownSize--;
                }
              }
            }

            const allSizesKnown = unknownSize === 0 && totalSize > 0;
            const canZipAll = allSizesKnown && totalSize <= BLOB_MAX_BYTES;

            const totalStr = allSizesKnown ? `${Math.round(totalSize / 1024 / 1024)}MB` : 'unknown';
            const info = `files=${items.length}, images=${imgCount}, videos=${vidCount}, other=${otherCount}, total=${totalStr}, unknown=${unknownSize}`;

            if (!postSettings.zipped) {
              // Unzipped: if there is ANY non-image (mixed or video-only) -> DIRECT all.
              if (hasNonImage) {
                for (const it of items) it.forceDirect = true;
                log.post.info(postId, `::Filester album (unzipped) has non-image -> DIRECT all (${info})::: ${albumUrl}`, postNumber);
              }
              continue;
            }

            // Zipped ON
            if (hasImage && hasNonImage) {
              if (!canZipAll) {
                // ZIP images only; everything else DIRECT.
                for (const it of items) {
                  const kind = filesterClassify(it.url);
                  if (kind !== 'image') it.forceDirect = true;
                }
                log.post.info(postId, `::Filester mixed album -> ZIP images, DIRECT others (${info})::: ${albumUrl}`, postNumber);
              } else {
                log.post.info(postId, `::Filester mixed album total<=~1.6GB -> ZIP all (${info})::: ${albumUrl}`, postNumber);
              }
            } else if (!hasImage && hasNonImage) {
              // Non-image only (videos and/or other file types)
              const isVideoOnly = vidCount > 0 && otherCount === 0;

              if (!canZipAll) {
                for (const it of items) it.forceDirect = true;
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
            // Images-only album: keep default behavior.
          }
        } catch (e) {}
      };

      await applyFilesterAlbumPolicy();

      const gofileWarmupOpenTab = warmUrl => {
        try {
          const tab = GM_openInTab(warmUrl, { active: false, insert: true, setParent: true });
          setTimeout(() => {
            try {
              xfpdCloseTabHandle(tab);
            } catch (e) {}
          }, GOFILE_WARMUP_MS);
        } catch (e) {}
      };

      let filesterNoTabTokenLogged = false;

      const startDownload = async (resource, pass = 1) => {
        let { url, host, original, folderName } = resource;
        const zippedForThis = !!(postSettings.zipped && !(resource && (resource.forceDirect || resource.forceUnzipped)));
        const isGoFile = isGoFileUrl(url);
        const isPixeldrain = isPixeldrainUrl(url);
        const isTurbo = isTurboUrl(url);
        const isCyberdrop = String(host || '').toLowerCase() === 'cyberdrop';
        const isBunkr =
          String((host && host.name) || '').toLowerCase() === 'bunkr' ||
          /bunkr/i.test(String(url || '')) ||
          /bunkr/i.test(String(original || ''));
        const isFilester =
          String((host && host.name) || '').toLowerCase() === 'filester' || /(?:^|\.)filester\.(me|sh|si|gg)/i.test(String(url || ''));

        // GoFile: make sure the browser's accountToken cookie matches the token that
        // resolved this album BEFORE the first request (store links gate on this too,
        // not just DIRECT) -- see gofileSyncCookie definition for why.
        if (isGoFile) {
          try {
            const gfToken = settings?.hosts?.goFile?.token;
            if (gfToken) await gofileSyncCookie(gfToken);
          } catch (e) {}
        }

        // Filester: turn short /d/<slug> view URLs into cache /v/<token> stream URLs (no tabs).
        // Album pages (/f/...) mostly contain only short slugs, which require this token step.
        if (isFilester) {
          try {
            const uF = new URL(String(url || ''));
            const isFilesterD = /(^|\.)filester\.(me|sh|si|gg)$/i.test(String(uF.host || '')) && /^\/d\//i.test(String(uF.pathname || ''));
            if (isFilesterD) {
              const slug =
                String(uF.pathname || '')
                  .split('/')
                  .filter(Boolean)
                  .pop() || '';
              // Short slugs look like "d8ZdCxc" / "QnUVP6A" etc.
              const looksLikeShortSlug = /^[A-Za-z0-9]{6,12}$/.test(slug);
              if (looksLikeShortSlug) {
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

                if (token) {
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
                  if (!filesterNoTabTokenLogged) {
                    filesterNoTabTokenLogged = true;
                    log.post.info(postId, `::Filester slug->token->cache (no tab)::: ${slug} -> ${streamUrl}`, postNumber);
                  }

                  try {
                    filesterSlugByUrl.set(String(streamUrl), String(slug));
                  } catch (e) {}
                  try {
                    filesterRefByUrl.set(String(streamUrl), 'https://filester.me/');
                  } catch (e) {}
                  try {
                    filesterRefByUrl.set(String(url), 'https://filester.me/');
                  } catch (e) {}
                  url = streamUrl;
                  try {
                    resource.url = streamUrl;
                  } catch (e) {}
                }
              }
            }
          } catch (e) {}
        }

        const turboId = isTurbo ? turboIdBySignedUrl.get(String(url)) || turboExtractId(original) || turboExtractId(url) || '' : '';
        const turboKey = isTurbo ? (turboId ? `turbo:${turboId}` : `turbo-url:${url}`) : '';

        let cyberOrigin = '';
        let cyberSlug = '';
        let cyberFilePage = '';
        const progressKey = isGoFile ? `${url}@@gofilepass${pass}` : url;

        h.ui.setElProps(statusLabel, { fontWeight: 'normal' });

        var reflink = original;
        if (url.includes('bunkr')) {
          reflink = 'https://bunkr.si';
        }
        if (url.includes('pomf2')) {
          reflink = 'https://pomf2.lain.la';
        }
        if (url.includes('turbocdn.st')) {
          reflink = 'https://turbo.cr/';
        }
        if (/(?:\bfilester\.(me|sh|si|gg)\b|cache\d+\.filester\.(me|sh|si|gg))/i.test(String(url || ''))) {
          reflink = 'https://filester.me/';
        }

        // Cyberdrop: normalize referer/origin and build a /f/ page for optional warm-up.
        if (isCyberdrop) {
          try {
            const o = new URL(/^https?:\/\//i.test(String(original || '')) ? String(original) : `https://${String(original)}`);
            cyberOrigin = o.origin;
            // Prefer slug from the original /e/ or /f/ URL, fallback to the resolved download URL.
            const m1 = /\/[ef]\/([^\/?#]+)/i.exec(String(original || ''));
            const m2 = /\/api\/file\/(?:d|info|auth)\/([^\/?#]+)/i.exec(String(original || ''));
            const m3 = /\/api\/file\/d\/([^\/?#]+)/i.exec(String(url || ''));
            cyberSlug = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || '';
            if (cyberSlug) cyberFilePage = `${cyberOrigin}/f/${cyberSlug}`;
            // Match browser requests: Referer/Origin are usually just https://cyberdrop.cr/
            reflink = `${cyberOrigin}/`;
          } catch (e) {}
        }

        const ellipsedUrl = h.limit(url, 80);
        log.post.info(postId, `::Downloading${isGoFile && pass > 1 ? ' (retry)' : ''}::: ${url}`, postNumber);

        if (
          isCyberdrop &&
          pass === 1 &&
          cyberOrigin &&
          cyberFilePage &&
          /gigachad-cdn\.ru|cuckcapital\.cr/i.test(String(url || '')) &&
          !cyberdropDirectWarmupDone
        ) {
          cyberdropDirectWarmupDone = true;
          log.post.info(postId, `::Cyberdrop warm-up -> open tab (${CYBERDROP_WARMUP_MS}ms) then continue::: ${cyberFilePage}`, postNumber);
          await cyberdropWarmupOnce(cyberOrigin, cyberFilePage, CYBERDROP_WARMUP_MS);
        }

        let switchedToDirect = false;

        const startDirectDownload = async (metaHint = null) => {
          switchedToDirect = true;

          try {
            const baseMeta = isTurbo ? {} : (await preflightMeta(url, reflink, isGoFile, isPixeldrain)) || {};
            const meta = { ...baseMeta, ...(metaHint || {}) };
            const sizeBytes = Number(meta.size || 0) || 0;

            // GoFile: if HEAD already shows an HTML gate / bad status, do the same warm-up + one retry.
            if (isGoFile) {
              const ct = String(meta.contentType || '');
              const badStatus = meta.status && meta.status >= 400;
              const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
              if ((badStatus || isHtml) && pass === 1 && !gofileWarmupAttempted.has(url)) {
                gofileWarmupAttempted.add(url);
                log.post.info(postId, `::GoFile warm-up -> open tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
                gofileWarmupOpenTab(url);
                setTimeout(() => startDownload(resource, 2), GOFILE_WARMUP_MS);
                return;
              }
            }

            if (postSettings.zipped) {
              log.post.info(postId, `::Zipped ON -> saving standalone (not in ZIP)::: ${url}`, postNumber);
            }

            // Try to reuse the existing GoFile filename hints, if available.
            let filename = filenames.find(f => f.url === url);
            if (!filename && isGoFile) {
              const mGf = String(url).match(/\/download\/(?:web|direct)\/([^\/?#]+)\//i);
              const gid = mGf && mGf[1] ? mGf[1] : null;
              if (gid) {
                filename = filenames.find(f => f && f.gofileId === gid);
                if (!filename) {
                  const hinted = gofileNameById.get(String(gid)) || gofileNameByUrl.get(String(url));
                  if (hinted) {
                    filename = { url, name: String(hinted), gofileId: String(gid) };
                  }
                }
              }
            }

            let basename = '';

            if (isPixeldrain) {
              basename = String(meta.filename || '') || parseDispositionFilename(meta.headers || '') || '';
            } else if (isGoFile) {
              basename =
                (filename && filename.name ? String(filename.name) : '') ||
                String(meta.filename || '') ||
                parseDispositionFilename(meta.headers || '') ||
                '';
            }

            if (!basename && isTurbo) {
              basename = turboExtractFn(url) || '';
            }

            if (!basename) {
              basename = filename && filename.name ? String(filename.name) : '';
            }
            if (!basename) {
              basename = h.basename(url);
            }

            // Bunkr: prefer the human filename (og:title / h1) captured during resolution.
            if (isBunkr) {
              try {
                const strip = u =>
                  String(u || '')
                    .split('#')[0]
                    .split('?')[0];
                const hinted =
                  bunkrNameByUrl.get(String(url)) ||
                  bunkrNameByUrl.get(strip(url)) ||
                  bunkrNameByUrl.get(String((resource && resource.original) || '')) ||
                  bunkrNameByUrl.get(strip((resource && resource.original) || '')) ||
                  '';
                if (hinted && String(hinted).trim() && !xfpdLooksLikeCfFilenameHint(hinted)) {
                  basename = String(hinted).trim();

                  // If hinted has no extension, derive it from URL first, then content-type.
                  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(basename);
                  if (!hasExt) {
                    const urlExt = h.ext(h.basename(strip(url))) || '';
                    const ct0 = String((meta && (meta.contentType || meta.content_type)) || '');
                    let ext0 = '';
                    if (urlExt) ext0 = String(urlExt);
                    else if (/video\/mp4/i.test(ct0)) ext0 = 'mp4';
                    else if (/video\/webm/i.test(ct0)) ext0 = 'webm';
                    else if (/image\/jpe?g/i.test(ct0)) ext0 = 'jpg';
                    else if (/image\/png/i.test(ct0)) ext0 = 'png';
                    else if (/image\/gif/i.test(ct0)) ext0 = 'gif';
                    else if (/application\/zip/i.test(ct0)) ext0 = 'zip';
                    else if (/application\/(x-7z-compressed)/i.test(ct0)) ext0 = '7z';
                    else if (/application\/(x-rar|vnd\.rar)|application\/octet-stream/i.test(ct0)) ext0 = 'rar';
                    else if (/application\/pdf/i.test(ct0)) ext0 = 'pdf';
                    if (ext0) basename = `${basename}.${ext0}`;
                  }

                  basename = sanitizeWinSegment(String(basename || ''), settings?.naming);
                  if (!basename) basename = sanitizeWinSegment(String(h.basename(strip(url)) || ''), settings?.naming);
                }
              } catch (e) {}
            }

            // Filester: prefer the real filename (from view page / API hints); fallback to a safe slug-based name.
            if (isFilester) {
              try {
                let slug0 = '';
                const m = /https?:\/\/(?:www\.)?filester\.(me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(
                  String((resource && resource.original) || ''),
                );
                if (m && m[1]) slug0 = m[1];
                if (!slug0) slug0 = String(filesterSlugByUrl.get(String(url)) || '');
                const ct0 = String((meta && (meta.contentType || meta.content_type)) || '');
                let ext0 = 'bin';
                if (/video\/mp4/i.test(ct0)) ext0 = 'mp4';
                else if (/video\/webm/i.test(ct0)) ext0 = 'webm';
                else if (/image\/jpe?g/i.test(ct0)) ext0 = 'jpg';
                else if (/image\/png/i.test(ct0)) ext0 = 'png';
                else if (/image\/gif/i.test(ct0)) ext0 = 'gif';
                else if (/application\/zip/i.test(ct0)) ext0 = 'zip';
                else if (/application\/x-7z-compressed/i.test(ct0)) ext0 = '7z';
                else if (/application\/(x-rar|vnd\.rar)/i.test(ct0)) ext0 = 'rar';

                const hinted =
                  String((meta && (meta.filename || meta.fileName)) || '') ||
                  String(filesterNameByUrl.get(String(url)) || '') ||
                  (slug0 ? String(filesterNameBySlug.get(String(slug0)) || '') : '');

                if (hinted && hinted.trim()) {
                  basename = hinted.trim();
                  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(basename || ''));
                  if (!hasExt && ext0) basename = `${basename}.${ext0}`;
                } else if (slug0) {
                  basename = `Filester_${slug0}.${ext0}`;
                }
              } catch (e) {}
            }

            const originalName = basename;

            // Handle duplicates within this run.
            const same = filenames.filter(f => f && (f.original === basename || f.name === basename));
            if (same.length) {
              const ext2 = h.extension(basename);
              if (ext2) {
                basename = `${h.fnNoExt(basename)} (${same.length + 1}).${ext2}`;
              } else {
                basename = `${basename} (${same.length + 1})`;
              }
            }

            if (!filename) {
              const extra = {};
              if (isGoFile) {
                const mGf2 = String(url).match(/\/download\/(?:web|direct)\/([^\/?#]+)\//i);
                const gid2 = mGf2 && mGf2[1] ? mGf2[1] : null;
                if (gid2) extra.gofileId = String(gid2);
              }
              filenames.push({ url, name: basename, original: originalName, ...extra });
            }

            const folder = folderName || '';
            let fn = basename;

            if (!postSettings.flatten && folder && folder.trim() !== '') {
              fn = `${folder}/${basename}`;
            }

            log.separator(postId);
            log.post.info(postId, `::Handed off (direct)::: ${url}`, postNumber);

            if (folder && folder.trim() !== '') {
              log.post.info(postId, `::Saving as (direct)::: ${basename} ::to:: ${folder}`, postNumber);
            } else {
              log.post.info(postId, `::Saving as (direct)::: ${basename}`, postNumber);
            }

            let title = sanitizeWinSegment(threadTitle, settings?.naming);

            fn = sanitizeWinPath(fn, settings?.naming);
            fn = ensureUniquePath(fn, usedPaths, { ext: h.ext, fnNoExt: h.fnNoExt });
            basename = h.basename(fn);
            const saveAsFF = `${title} #${postNumber} - ${ensureUniqueFlatName(fn.replace(/\//g, ' - '), usedFlatNames, { ext: h.ext, fnNoExt: h.fnNoExt })}`;
            const saveAsPath = `${title}/${fn}`;
            const saveAsName = isFF ? saveAsFF : saveAsPath;

            h.ui.setElProps(statusLabel, { color: '#469cf3' });
            h.show(filePB);

            const origUrl = String(url);
            let directUrl = String(url);
            let filesterDirectPreflightDone = false;

            // Filester DIRECT: retry a few times on transient HTTP errors (429/400/etc) and rotate cache hosts (cache6 <-> cache1 ...)
            // before starting GM_download. Keeps pauses short (<=~2s).
            if (isFilester) {
              try {
                const ref = String(filesterRefByUrl.get(String(url)) || (resource && resource.original) || 'https://filester.me/');
                const token0 = filesterTokenFromVUrl(String(url || ''));

                if (token0) {
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

                    filesterDirectPreflightDone = true;

                    const st0 = Number((pre && pre.status) || 0) || 0;
                    const finalUrl = pre && (pre.finalUrl || pre.responseURL) ? String(pre.finalUrl || pre.responseURL) : '';
                    const ok = st0 && st0 < 400;

                    if (ok) {
                      directUrl = finalUrl && /^https?:\/\//i.test(finalUrl) ? finalUrl : String(cand);

                      if (i > 0 || String(cand) !== u0 || (finalUrl && finalUrl !== cand)) {
                        log.post.info(postId, `::Filester DIRECT picked ${cacheLabel(cand)} (HTTP ${st0})::: ${directUrl}`, postNumber);
                      }
                      break;
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
                }
              } catch (e) {}
            }

            const imagebamHeaders = isImagebamCdnUrl(url) ? { Referer: imagebamRefererForCdn(url) } : null;
            const dlOpts = {
              url: directUrl,
              name: saveAsName,
              onprogress: e => {
                const loadedMB = Number((e.loaded || 0) / 1024 / 1024).toFixed(2);
                const totalBytes = e.total && e.total > 0 ? e.total : sizeBytes || 0;
                const totalMB = totalBytes ? Number(totalBytes / 1024 / 1024).toFixed(2) : '??';
                if (!totalBytes) {
                  h.ui.setElProps(filePB, { width: '0%' });
                  h.ui.setText(
                    statusLabel,
                    `${completed} / ${totalDownloadable} 🢒 ${host.name} 🢒 DIRECT 🢒 ${loadedMB} MB 🢒 ${ellipsedUrl}`,
                  );
                } else {
                  h.ui.setText(
                    statusLabel,
                    `${completed} / ${totalDownloadable} 🢒 ${host.name} 🢒 DIRECT 🢒 ${loadedMB} MB / ${totalMB} MB  🢒 ${ellipsedUrl}`,
                  );
                  h.ui.setElProps(filePB, {
                    width: `${(e.loaded / totalBytes) * 100}%`,
                  });
                }
              },
              onload: () => {
                completed++;
                completedBatchedDownloads++;

                h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
                h.ui.setElProps(statusLabel, { color: '#2d9053' });
                h.ui.setElProps(totalPB, {
                  width: `${(completed / totalDownloadable) * 100}%`,
                });
              },
              onerror: err => {
                completed++;
                completedBatchedDownloads++;

                h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
                h.ui.setElProps(statusLabel, { color: '#b23b3b' });
                h.ui.setElProps(totalPB, {
                  width: `${(completed / totalDownloadable) * 100}%`,
                });

                log.post.error(postId, `::DIRECT download failed::: ${url}`, postNumber);
                console.log(err);
              },
              ontimeout: err => {
                completed++;
                completedBatchedDownloads++;
                log.post.error(postId, `::DIRECT download timed out::: ${url}`, postNumber);
                console.log(err);
              },
            };
            if (imagebamHeaders && isFF) {
              // Imagebam CDN often blocks hotlinking without a Referer. In Firefox, GM_download headers
              // are unreliable, so fetch as a blob with GM_xmlhttpRequest (with Referer) then save.
              try {
                GM_xmlhttpRequest({
                  method: 'GET',
                  url,
                  headers: imagebamHeaders,
                  responseType: 'blob',
                  anonymous: false,
                  timeout: 60000,
                  onprogress: dlOpts.onprogress,
                  onload: r => {
                    const ct = headerValue(r.responseHeaders || '', 'content-type');
                    const isHtml = /text\/html|application\/xhtml\+xml/i.test(String(ct || ''));
                    if (!(r.status >= 200 && r.status < 300) || !r.response || isHtml) {
                      dlOpts.onerror({ status: r.status, contentType: ct });
                      return;
                    }
                    const blob = r.response;
                    // Guard against tiny non-image responses (common for blocked hotlinks)
                    if (blob && blob.size && blob.size < 2048 && isHtml) {
                      dlOpts.onerror({ status: r.status, contentType: ct });
                      return;
                    }
                    const blobUrl = URL.createObjectURL(blob);
                    GM_download({
                      url: blobUrl,
                      name: saveAsName,
                      onload: () => {
                        try {
                          URL.revokeObjectURL(blobUrl);
                        } catch (e) {}
                        dlOpts.onload();
                      },
                      onerror: err => {
                        try {
                          URL.revokeObjectURL(blobUrl);
                        } catch (e) {}
                        dlOpts.onerror(err);
                      },
                      ontimeout: err => {
                        try {
                          URL.revokeObjectURL(blobUrl);
                        } catch (e) {}
                        dlOpts.ontimeout(err);
                      },
                    });
                  },
                  onerror: dlOpts.onerror,
                  ontimeout: dlOpts.ontimeout,
                });
              } catch (e) {
                dlOpts.onerror(e);
              }
            } else {
              if (imagebamHeaders) dlOpts.headers = { ...(dlOpts.headers || {}), ...imagebamHeaders };

              // Filester (Chrome): preflight a 1-byte range request to capture the final URL.
              // This helps when the downloads API drops cookies or when Filester redirects to a signed URL.
              if (isFilester && !isFF && !filesterDirectPreflightDone) {
                try {
                  const ref = String(filesterRefByUrl.get(String(url)) || (resource && resource.original) || 'https://filester.me/');
                  const pre = await new Promise(resolve => {
                    try {
                      GM_xmlhttpRequest({
                        method: 'GET',
                        url: String(dlOpts.url),
                        responseType: 'text',
                        anonymous: false,
                        withCredentials: true,
                        timeout: 15000,
                        headers: { Range: 'bytes=0-0', Accept: '*/*', Referer: ref },
                        onload: r => resolve(r),
                        onerror: _ => resolve(null),
                        ontimeout: _ => resolve(null),
                      });
                    } catch (e) {
                      resolve(null);
                    }
                  });
                  const finalUrl = pre && (pre.finalUrl || pre.responseURL);
                  if (finalUrl && typeof finalUrl === 'string' && /^https?:\/\//i.test(finalUrl)) {
                    dlOpts.url = finalUrl;
                  }
                } catch (e) {}
              }

              GM_download(dlOpts);
            }
          } catch (e) {
            // Safety: never hang the batch loop.
            completed++;
            completedBatchedDownloads++;
            log.post.error(postId, `::DIRECT download error::: ${url}`, postNumber);
            console.log(e);
          }
        };

        // Forced DIRECT (used by Filester album policy: mixed albums, unzipped mixed/video-only, etc.)
        if (resource && resource.forceDirect) {
          log.post.info(postId, `::Forced DIRECT (skip blob/ZIP)::: ${url}`, postNumber);
          setTimeout(() => startDirectDownload(), TURBO_DIRECT_DELAY_MS);
          return;
        }

        const isPixeldrainList = isPixeldrain && /pixeldrain\.com\/l\//i.test(String(original || ''));
        if (isPixeldrainList) {
          log.post.info(postId, `::Pixeldrain list (/l/) -> DIRECT (skip blob)::: ${url}`, postNumber);
          setTimeout(() => startDirectDownload(), TURBO_DIRECT_DELAY_MS);
          return;
        }

        if (isGoFile || isPixeldrain || isFilester) {
          const meta0 = await preflightMeta(url, reflink, isGoFile, isPixeldrain);
          if (meta0 && meta0.size && meta0.size > BLOB_MAX_BYTES) {
            log.post.info(postId, `::Large file (${meta0.size} bytes > ~1.6GB) -> DIRECT (skip blob)::: ${url}`, postNumber);
            startDirectDownload(meta0);
            return;
          }
        }
        let abortReason = '';
        let bunkrMaintenanceHandled = false;

        const isTurboCdn = /turbocdn\.st/i.test(String(url || ''));
        const filesterRef = isFilester
          ? String(filesterRefByUrl.get(String(url)) || (resource && resource.original) || 'https://filester.me/')
          : '';
        const reqHeaders = isTurboCdn ? { Referer: 'https://turbo.cr/' } : isFilester ? { Referer: filesterRef } : { Referer: reflink };

        const request = GM_xmlhttpRequest({
          url,
          headers: reqHeaders,
          responseType: 'blob',
          anonymous: false,
          ...(isFilester ? { withCredentials: true } : {}),
          onreadystatechange: response => {
            if (response.readyState === 2) {
              let matches = h.re.matchAll(/(?<=attachment;filename=").*?(?=")/gis, response.responseHeaders);
              if (matches.length && !filenames.find(f => f.url === url)) {
                filenames.push({ url, name: matches[0] });
              }
              matches = h.re.matchAll(/(?<=content-type:\s).*$/gi, response.responseHeaders);
              if (matches.length && !mimeTypes.find(m => m.url === url)) {
                mimeTypes.push({ url, type: matches[0] });
              }

              // Bunkr: detect maintenance placeholder redirect (maint.mp4) early and abort (skip).
              if (isBunkr && !abortReason) {
                const loc = headerValue(response.responseHeaders || '', 'location');
                const fu = String(response.finalUrl || '');
                if (/\/maint\.mp4(\?|$)/i.test(loc) || /\/maint\.mp4(\?|$)/i.test(fu)) {
                  abortReason = 'bunkr_maint';
                  try {
                    request.abort();
                  } catch (e) {}
                }
              }
            }
          },
          onprogress: response => {
            h.ui.setElProps(statusLabel, {
              color: '#469cf3',
            });

            // Pixeldrain/GoFile: if size only becomes known mid-download and it's > ~1.6GB, switch to direct download.
            if (
              !switchedToDirect &&
              (isGoFile || isPixeldrain || isFilester) &&
              response &&
              response.total &&
              response.total > BLOB_MAX_BYTES
            ) {
              log.post.info(postId, `::Large file (${response.total} bytes > ~1.6GB) detected -> switch to DIRECT::: ${url}`, postNumber);
              switchedToDirect = true;
              try {
                request.abort();
              } catch (e) {}
              startDirectDownload({ size: response.total });
              return;
            }
            // Bunkr: large videos cause MV3 port disconnection via blob; switch to direct download above 500MB.
            if (!switchedToDirect && isBunkr && response && response.total && response.total > BUNKR_DIRECT_MIN_BYTES) {
              log.post.info(postId, `::Bunkr large file (${response.total} bytes > 500MB) -> switch to DIRECT::: ${url}`, postNumber);
              switchedToDirect = true;
              try {
                request.abort();
              } catch (e) {}
              startDirectDownload({ size: response.total });
              return;
            }

            const downloadedSizeInMB = Number(response.loaded / 1024 / 1024).toFixed(2);
            const totalSizeInMB = Number(response.total / 1024 / 1024).toFixed(2);
            if (response.total === -1 || response.totalSize === -1) {
              h.ui.setElProps(filePB, { width: '0%' });
              h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${host.name} 🢒 ${downloadedSizeInMB} MB 🢒 ${ellipsedUrl}`);
            } else {
              h.show(filePB);
              h.ui.setText(
                statusLabel,
                `${completed} / ${totalDownloadable} 🢒 ${host.name} 🢒 ${downloadedSizeInMB} MB / ${totalSizeInMB} MB  🢒 ${ellipsedUrl}`,
              );
              h.ui.setElProps(filePB, {
                width: `${(response.loaded / response.total) * 100}%`,
              });
            }
            const p = requestProgress.find(r => r.url === progressKey);
            if (p) p.new = response.loaded;
          },
          onload: async response => {
            const p = requestProgress.find(r => r.url === progressKey);
            if (p) clearInterval(p.intervalId);

            if (abortReason === 'bunkr_maint' && bunkrMaintenanceHandled) return;
            // GoFile: this pass was superseded by a stall-triggered warm-up retry
            // (request.abort() above isn't always reliable once a blob response is
            // substantially buffered) -- a newer pass now owns saving this file.
            if (isGoFile && (gofileActivePass.get(url) || pass) > pass) return;
            // GoFile: detect soft-block / HTML gate
            if (isGoFile) {
              const mCt = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '');
              const ct = mCt && mCt[1] ? mCt[1] : '';
              const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
              const badStatus = !response.status || response.status >= 400;

              if (badStatus || isHtml) {
                if (pass === 1 && !gofileWarmupAttempted.has(url)) {
                  gofileWarmupAttempted.add(url);
                  log.post.info(postId, `::GoFile warm-up -> open tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
                  gofileWarmupOpenTab(url);
                  setTimeout(() => startDownload(resource, 2), GOFILE_WARMUP_MS);
                  return;
                }

                // Retry failed -> mark as unsuccessful and continue.
                completed++;
                completedBatchedDownloads++;

                h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
                h.ui.setElProps(statusLabel, { color: '#b23b3b' });
                h.ui.setElProps(totalPB, {
                  width: `${(completed / totalDownloadable) * 100}%`,
                });

                log.post.error(postId, `::GoFile failed (after retry)::: ${url}`, postNumber);
                return;
              }
            }

            // Cyberdrop: detect anti-bot / API responses (often tiny JSON/HTML) and retry once after warm-up.
            if (isCyberdrop) {
              const mCt = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '');
              const ct = mCt && mCt[1] ? mCt[1] : '';
              const isGate = /text\/html|application\/xhtml\+xml|application\/json/i.test(ct);
              const badStatus = !response.status || response.status >= 400;
              const size = response.response && typeof response.response.size === 'number' ? response.response.size : 0;
              const isTiny = size > 0 && size <= 16384;

              if (badStatus || isGate || isTiny) {
                if (pass === 1 && cyberOrigin && cyberFilePage) {
                  log.post.info(
                    postId,
                    `::Cyberdrop warm-up -> open tab (${CYBERDROP_WARMUP_MS}ms) then retry [1/2]::: ${cyberFilePage}`,
                    postNumber,
                  );
                  cyberdropWarmupOnce(cyberOrigin, cyberFilePage, CYBERDROP_WARMUP_MS)
                    .then(() => startDownload(resource, 2))
                    .catch(() => startDownload(resource, 2));
                  return;
                }

                // Retry failed -> mark as unsuccessful and continue.
                completed++;
                completedBatchedDownloads++;

                h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
                h.ui.setElProps(statusLabel, { color: '#b23b3b' });
                h.ui.setElProps(totalPB, {
                  width: `${(completed / totalDownloadable) * 100}%`,
                });

                log.post.error(postId, `::Cyberdrop failed (gate/tiny response)::: ${url}`, postNumber);
                return;
              }
            }

            // Filester: detect blocked/tiny responses (often an error thumbnail or HTML gate) and fall back to DIRECT once.
            if (isFilester) {
              const mCt = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '');
              const ct = mCt && mCt[1] ? mCt[1] : '';
              const isGate = /text\/html|application\/xhtml\+xml|application\/json/i.test(ct);
              const badStatus = !response.status || response.status >= 400;

              const blob = response.response;
              const size = blob && typeof blob.size === 'number' ? blob.size : 0;

              let hintSize = 0;
              try {
                const s0 = String(filesterSlugByUrl.get(String(url)) || '');
                hintSize = Number(filesterSizeBySlug.get(s0) || filesterSizeByUrl.get(String(url)) || 0) || 0;
              } catch (e) {
                hintSize = 0;
              }

              // Only treat "tiny" as suspicious when we have a meaningful expected size.
              const suspiciousTiny = !!hintSize && size > 0 && size <= 16384 && hintSize >= 32768;

              if (badStatus || isGate || suspiciousTiny) {
                if (pass === 1) {
                  // Filester: some tokens are not available on cache6 (404). Try other cacheN hosts before falling back.
                  if (badStatus && Number(response.status || 0) === 404) {
                    const token0 = filesterTokenFromVUrl(String(url || ''));
                    if (token0) {
                      const candidates0 = filesterCandidatesByToken.get(token0) || filesterBuildCandidates(token0);
                      let tried0 = filesterTriedByToken.get(token0);
                      if (!tried0) {
                        tried0 = new Set();
                        filesterTriedByToken.set(token0, tried0);
                      }
                      tried0.add(String(url));
                      let nextUrl = '';
                      for (const c of candidates0 || []) {
                        if (!tried0.has(c)) {
                          nextUrl = c;
                          tried0.add(c);
                          break;
                        }
                      }
                      if (nextUrl) {
                        log.post.info(
                          postId,
                          `::Filester cache 404 -> try next cache [${tried0.size}/${(candidates0 || []).length}]::: ${nextUrl}`,
                          postNumber,
                        );
                        try {
                          filesterRefByUrl.set(String(nextUrl), 'https://filester.me/');
                        } catch (e) {}
                        try {
                          resource.url = nextUrl;
                        } catch (e) {}
                        try {
                          url = nextUrl;
                        } catch (e) {}
                        startDownload(resource, pass);
                        return;
                      }
                    }
                  }

                  // Filester: retry a few times on transient HTTP errors (429/400/etc) before switching to DIRECT.
                  // Keep pauses short (<=~2.5s) and try alternate cacheN hosts (cache6 <-> cache1) when possible.
                  if (badStatus) {
                    const st0 = Number(response.status || 0) || 0;
                    const isRetryable =
                      st0 === 429 ||
                      st0 === 400 ||
                      st0 === 403 ||
                      st0 === 408 ||
                      st0 === 409 ||
                      st0 === 425 ||
                      st0 === 500 ||
                      st0 === 502 ||
                      st0 === 503 ||
                      st0 === 504;

                    if (isRetryable) {
                      const token0 = filesterTokenFromVUrl(String(url || ''));
                      const key0 = token0 || String(url || '');
                      const max0 = 3;

                      let a0 = Number(filesterRetryAttemptsByKey.get(key0) || 0) || 0;
                      a0++;
                      filesterRetryAttemptsByKey.set(key0, a0);

                      let waitMs = 0;
                      const ra0 = headerValue(response.responseHeaders || '', 'retry-after');
                      if (ra0) {
                        const n0 = Number(String(ra0).trim());
                        if (Number.isFinite(n0) && n0 > 0) waitMs = Math.floor(n0 * 1000);
                      }
                      if (!waitMs) {
                        waitMs = 650 * a0 + Math.floor(Math.random() * 250);
                      }
                      waitMs = Math.min(2500, Math.max(0, waitMs));

                      let nextUrl = '';
                      if (token0) {
                        const candidates0 = filesterCandidatesByToken.get(token0) || filesterBuildCandidates(token0);
                        let tried0 = filesterTriedByToken.get(token0);
                        if (!tried0) {
                          tried0 = new Set();
                          filesterTriedByToken.set(token0, tried0);
                        }
                        tried0.add(String(url));

                        const isOn6 = /https?:\/\/cache6\.filester\.(me|sh|si|gg)\//i.test(String(url || ''));
                        const isOn1 = /https?:\/\/cache1\.filester\.(me|sh|si|gg)\//i.test(String(url || ''));

                        // Prefer swapping cache6 <-> cache1 first.
                        if (isOn6) {
                          for (const c of candidates0 || []) {
                            if (/https?:\/\/cache1\.filester\.(me|sh|si|gg)\//i.test(c) && !tried0.has(c)) {
                              nextUrl = c;
                              tried0.add(c);
                              break;
                            }
                          }
                        } else if (isOn1) {
                          for (const c of candidates0 || []) {
                            if (/https?:\/\/cache6\.filester\.(me|sh|si|gg)\//i.test(c) && !tried0.has(c)) {
                              nextUrl = c;
                              tried0.add(c);
                              break;
                            }
                          }
                        }

                        if (!nextUrl) {
                          for (const c of candidates0 || []) {
                            if (!tried0.has(c)) {
                              nextUrl = c;
                              tried0.add(c);
                              break;
                            }
                          }
                        }
                      }

                      if (a0 <= max0) {
                        const tgt = nextUrl || String(url || '');
                        // retry logging: include cache switch info (cache6<->cache1 etc.)
                        let switchInfo = '';
                        try {
                          const fromU = String(url || '');
                          const toU = String(nextUrl || '');
                          if (toU && toU !== fromU) {
                            const mf = /https?:\/\/(cache\d+)\.filester\.(me|sh|si|gg)\//i.exec(fromU);
                            const mt = /https?:\/\/(cache\d+)\.filester\.(me|sh|si|gg)\//i.exec(toU);
                            if (mf && mt) switchInfo = `; switching ${mf[1]}->${mt[1]}`;
                            else if (mf && !mt) switchInfo = `; switching ${mf[1]}->other`;
                            else if (!mf && mt) switchInfo = `; switching other->${mt[1]}`;
                            else switchInfo = '; switching host';
                          }
                        } catch (e) {}
                        log.post.info(
                          postId,
                          `::Filester HTTP ${st0} -> retry [${a0}/${max0}] after ${waitMs}ms${switchInfo}::: ${tgt}`,
                          postNumber,
                        );

                        setTimeout(() => {
                          try {
                            if (nextUrl) {
                              try {
                                filesterRefByUrl.set(String(nextUrl), 'https://filester.me/');
                              } catch (e) {}
                              try {
                                resource.url = nextUrl;
                              } catch (e) {}
                              try {
                                url = nextUrl;
                              } catch (e) {}
                            }
                          } catch (e) {}
                          startDownload(resource, pass);
                        }, waitMs);

                        return;
                      }
                    }
                  }

                  const isView = /https?:\/\/(?:www\.)?filester\.(me|sh|si|gg)\/d\//i.test(String(url || ''));
                  if (!isView) {
                    log.post.info(postId, `::Filester blocked/tiny response -> switch to DIRECT [1/2]::: ${url}`, postNumber);
                    startDirectDownload({ size: hintSize || 0 });
                    return;
                  }

                  // If we only have a /d/ view URL, DIRECT would just save HTML.
                  completed++;
                  completedBatchedDownloads++;

                  h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
                  h.ui.setElProps(statusLabel, { color: '#b23b3b' });
                  h.ui.setElProps(totalPB, {
                    width: `${(completed / totalDownloadable) * 100}%`,
                  });

                  log.post.error(postId, `::Filester failed (resolved to /d/ HTML view)::: ${url}`, postNumber);
                  return;
                }

                completed++;
                completedBatchedDownloads++;

                h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
                h.ui.setElProps(statusLabel, { color: '#b23b3b' });
                h.ui.setElProps(totalPB, {
                  width: `${(completed / totalDownloadable) * 100}%`,
                });

                const reason = badStatus ? `HTTP ${response.status || 0}` : isGate ? 'HTML/JSON gate' : 'tiny/blocked response';
                log.post.error(postId, `::Filester failed (${reason})::: ${url}`, postNumber);
                return;
              }
            }

            // Bunkr: skip maintenance/dead placeholder responses (often tiny HTML) instead of saving a tiny file.
            if (
              String((host && host.name) || '').toLowerCase() === 'bunkr' ||
              /bunkr/i.test(String(url || '')) ||
              /bunkr/i.test(String((resource && resource.original) || ''))
            ) {
              const mCt = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '');
              const ct = mCt && mCt[1] ? mCt[1] : '';
              const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
              const badStatus = !response.status || response.status >= 400;

              const bunkrFinalUrl = String(response.finalUrl || '');
              const bunkrLoc = headerValue(response.responseHeaders || '', 'location');
              const isMaint =
                abortReason === 'bunkr_maint' || /\/maint\.mp4(\?|$)/i.test(bunkrFinalUrl) || /\/maint\.mp4(\?|$)/i.test(bunkrLoc);

              const blob = response.response;
              const size = blob && typeof blob.size === 'number' ? blob.size : 0;
              const tinyLimit = 32768;

              let tinyLooksLikeHtml = false;
              if (!isHtml && !badStatus && postSettings.verifyBunkrLinks && size > 0 && size <= tinyLimit) {
                try {
                  const t = await blob.text();
                  const head = String(t || '')
                    .slice(0, 2048)
                    .toLowerCase();
                  tinyLooksLikeHtml =
                    head.includes('<!doctype') ||
                    head.includes('<html') ||
                    head.includes('<head') ||
                    head.includes('<body') ||
                    head.includes('temporarily not available') ||
                    head.includes('maintenance') ||
                    head.includes('cloudflare');
                } catch (e) {
                  tinyLooksLikeHtml = false;
                }
              }

              if (badStatus || isHtml || tinyLooksLikeHtml || isMaint) {
                if (isMaint) bunkrMaintenanceHandled = true;
                completed++;
                completedBatchedDownloads++;

                h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
                h.ui.setElProps(statusLabel, { color: '#b23b3b' });
                h.ui.setElProps(totalPB, {
                  width: `${(completed / totalDownloadable) * 100}%`,
                });

                const reason = isMaint
                  ? 'maintenance redirect (maint.mp4)'
                  : badStatus
                    ? `HTTP ${response.status || 0}`
                    : isHtml
                      ? 'HTML/maintenance response'
                      : 'tiny HTML placeholder';
                log.post.error(postId, `::Bunkr skipped (${reason})::: ${url}`, postNumber);
                return;
              }
            }

            // Success path (unchanged)
            completed++;
            completedBatchedDownloads++;

            h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
            h.ui.setElProps(statusLabel, { color: '#2d9053' });
            h.ui.setElProps(totalPB, {
              width: `${(completed / totalDownloadable) * 100}%`,
            });

            // TODO: Extract to method.
            let filename = filenames.find(f => f.url === url);
            if (!filename && isGoFile) {
              // GoFile URLs may be re-resolved to a file-*.gofile.io host, so match by GoFile fileId.
              const mGf = String(url).match(/\/download\/(?:web|direct)\/([^\/?#]+)\//i);
              const gid = mGf && mGf[1] ? mGf[1] : null;
              if (gid) {
                filename = filenames.find(f => f && f.gofileId === gid);

                // If the per-run filenames list doesn't know this URL (e.g. re-resolved host),
                // fall back to the global GoFile hint maps populated during /d/ resolution.
                if (!filename) {
                  const hinted = gofileNameById.get(String(gid)) || gofileNameByUrl.get(String(url));
                  if (hinted) {
                    filename = { url, name: String(hinted), gofileId: String(gid) };
                  }
                }
              }
            }

            if (!filename) {
              const hintedFilester = filesterNameByUrl.get(String(url));
              if (hintedFilester) {
                filename = { url, name: String(hintedFilester) };
              }
            }

            if (!filename) {
              const hintedByUrl = cyberdropNameByUrl.get(String(url));
              if (hintedByUrl) {
                filename = { url, name: String(hintedByUrl) };
              } else {
                const mCd =
                  String(url).match(/\/api\/file\/d\/([^\/\?#]+)\b/i) || String(url).match(/cyberdrop\.[^\/]+\/(?:f|e)\/([^\/\?#]+)/i);
                const slug = mCd && mCd[1] ? mCd[1] : null;
                if (slug) {
                  const hintedBySlug = cyberdropNameBySlug.get(String(slug));
                  if (hintedBySlug) {
                    filename = { url, name: String(hintedBySlug), cyberdropSlug: String(slug) };
                  }
                }
              }
            }

            let basename;

            if (/(?:pixeldrain\.(?:com|net)|pixeldra\.in)/i.test(String(url || ''))) {
              const rh = response && response.responseHeaders ? String(response.responseHeaders) : '';
              basename =
                parseDispositionFilename(rh) || (filename ? filename.name : h.basename(url).replace(/\?.*/, '').replace(/#.*/, ''));
            } else if (url.includes('https://simpcity.su/attachments/')) {
              basename = filename ? filename.name : h.basename(url).replace(/(.*)-(.{3,4})\.\d*$/i, '$1.$2');
            } else if (url.includes('kemono.cr')) {
              basename = filename
                ? filename.name
                : h
                    .basename(url)
                    .replace(/(.*)\?f=(.*)/, '$2')
                    .replace('%20', ' ');
            } else if (url.includes('cyberdrop')) {
              const rh = response && response.responseHeaders ? String(response.responseHeaders) : '';
              const cdName = parseDispositionFilename(rh);
              basename = cdName ? cdName : filename ? filename.name : h.basename(url).replace(/\?.*/, '').replace(/#.*/, '');

              try {
                basename = decodeURI(basename);
              } catch (e) {}

              const extMatch = basename.match(/\.\w{3,6}$/);
              const basename_ext = extMatch ? extMatch[0] : '';
              if (basename_ext) {
                basename = basename.replace(basename_ext, '').replace(/(\.\w{3,6}-\w{8}$)|(-\w{8}$)/, '') + basename_ext;
              }
            } else {
              // Turbo CDN signed URLs include the original filename in the fn= query param.
              // Without this, we'd end up saving as the short id (e.g. uVOxoqFFlDGrZ.mp4).
              if (url.includes('turbocdn.st')) {
                const m = url.match(/[?&]fn=([^&]+)/i);
                if (m && m[1]) {
                  try {
                    basename = decodeURIComponent(m[1].replace(/\+/g, '%20'));
                  } catch (e) {
                    basename = m[1];
                  }
                }
              }

              if (!basename) {
                basename = filename ? filename.name : h.basename(url).replace(/\?.*/, '').replace(/#.*/, '');
              }
            }

            // Bunkr: prefer the human filename (og:title / h1) captured during resolution.
            if (isBunkr) {
              try {
                const strip = u =>
                  String(u || '')
                    .split('#')[0]
                    .split('?')[0];
                const hinted =
                  bunkrNameByUrl.get(String(url)) ||
                  bunkrNameByUrl.get(strip(url)) ||
                  bunkrNameByUrl.get(String((resource && resource.original) || '')) ||
                  bunkrNameByUrl.get(strip((resource && resource.original) || '')) ||
                  '';
                if (hinted && String(hinted).trim() && !xfpdLooksLikeCfFilenameHint(hinted)) {
                  basename = String(hinted).trim();

                  // If hinted has no extension, derive it from URL first, then content-type.
                  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(basename);
                  if (!hasExt) {
                    const urlExt = h.ext(h.basename(strip(url))) || '';
                    const ct0 = headerValue(response.responseHeaders || '', 'content-type');
                    let ext0 = '';
                    if (urlExt) ext0 = String(urlExt);
                    else if (/video\/mp4/i.test(ct0)) ext0 = 'mp4';
                    else if (/video\/webm/i.test(ct0)) ext0 = 'webm';
                    else if (/image\/jpe?g/i.test(ct0)) ext0 = 'jpg';
                    else if (/image\/png/i.test(ct0)) ext0 = 'png';
                    else if (/image\/gif/i.test(ct0)) ext0 = 'gif';
                    else if (/application\/zip/i.test(ct0)) ext0 = 'zip';
                    else if (/application\/(x-7z-compressed)/i.test(ct0)) ext0 = '7z';
                    else if (/application\/(x-rar|vnd\.rar)|application\/octet-stream/i.test(ct0)) ext0 = 'rar';
                    else if (/application\/pdf/i.test(ct0)) ext0 = 'pdf';
                    if (ext0) basename = `${basename}.${ext0}`;
                  }

                  basename = sanitizeWinSegment(String(basename || ''), settings?.naming);
                  if (!basename) basename = sanitizeWinSegment(String(h.basename(strip(url)) || ''), settings?.naming);
                }
              } catch (e) {}
            }

            // Filester: prefer the real filename (from view page / API hints). Only fall back to a safe slug-based name when needed.
            if (/(?:^|https?:\/\/)(?:cache\d+\.)?filester\.(me|sh|si|gg)\/(?:d|v)\//i.test(String(url || ''))) {
              try {
                let slug0 = '';
                const m = /https?:\/\/(?:www\.)?filester\.(me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(
                  String((resource && resource.original) || ''),
                );
                if (m && m[1]) slug0 = m[1];
                if (!slug0) slug0 = String(filesterSlugByUrl.get(String(url)) || '');
                const ct0 = headerValue(response.responseHeaders || '', 'content-type');
                let ext0 = 'bin';
                if (/video\/mp4/i.test(ct0)) ext0 = 'mp4';
                else if (/video\/webm/i.test(ct0)) ext0 = 'webm';
                else if (/image\/jpe?g/i.test(ct0)) ext0 = 'jpg';
                else if (/image\/png/i.test(ct0)) ext0 = 'png';
                else if (/image\/gif/i.test(ct0)) ext0 = 'gif';
                else if (/application\/zip/i.test(ct0)) ext0 = 'zip';
                else if (/application\/x-7z-compressed/i.test(ct0)) ext0 = '7z';
                else if (/application\/(x-rar|vnd\.rar)/i.test(ct0)) ext0 = 'rar';

                const hinted =
                  String((filename && filename.name) || '') ||
                  String(filesterNameByUrl.get(String(url)) || '') ||
                  (slug0 ? String(filesterNameBySlug.get(String(slug0)) || '') : '');

                if (hinted && hinted.trim()) {
                  basename = hinted.trim();
                  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(basename || ''));
                  if (!hasExt && ext0) basename = `${basename}.${ext0}`;
                } else if (slug0) {
                  basename = `Filester_${slug0}.${ext0}`;
                }

                basename = sanitizeWinSegment(String(basename || ''), settings?.naming);
              } catch (e) {}
            }

            let ext = h.ext(basename);

            const mimeType = mimeTypes.find(m => m.url === url);

            if (!ext && mimeType) {
              switch (mimeType.type) {
                case 'image/jpeg':
                case 'image/jpg':
                  ext = 'jpg';
                  break;
                case 'image/png':
                  ext = 'png';
                  break;
                default:
                  ext = 'unknown';
              }
            }

            const original = basename;

            if (filenames.find(f => f.original === basename)) {
              const count = filenames.filter(f => f.original === basename).length;
              const baseNoExt = ext && h.fnNoExt(basename) ? h.fnNoExt(basename) : basename;
              basename = ext ? `${baseNoExt} (${count + 1}).${ext}` : `${baseNoExt} (${count + 1})`;
            }

            if (!filename) {
              filenames.push({ url, name: basename, original });
            }

            const folder = folderName || '';

            let fn = basename;

            if (!postSettings.flatten && folder && folder.trim() !== '') {
              fn = `${folder}/${basename}`;
            }

            log.separator(postId);
            log.post.info(postId, `::Completed::: ${url}`, postNumber);

            if (folder && folder.trim() !== '') {
              log.post.info(postId, `::Saving as::: ${basename} ::to:: ${folder}`, postNumber);
            } else {
              log.post.info(postId, `::Saving as::: ${basename}`, postNumber);
            }

            const fileBlob = response.response;

            let title = sanitizeWinSegment(threadTitle, settings?.naming);

            // https://stackoverflow.com/a/53681022
            fn = sanitizeWinPath(fn, settings?.naming);

            fn = ensureUniquePath(fn, usedPaths, { ext: h.ext, fnNoExt: h.fnNoExt });
            basename = h.basename(fn);

            if (!isFF) {
              if (!postSettings.flatten && folder && folder.trim() !== '') {
                fn = `${folder}/${basename}`;
              }
            } else {
              fn = `${fn}`;
            }

            const saveAsFF = `${title} #${postNumber} - ${ensureUniqueFlatName(fn.replace(/\//g, ' - '), usedFlatNames, { ext: h.ext, fnNoExt: h.fnNoExt })}`;
            const saveAsPath = `${title}/${fn}`;

            const saveAsName = isFF && !zippedForThis ? saveAsFF : saveAsPath;

            if (!zippedForThis) {
              const blobUrl = URL.createObjectURL(fileBlob);
              GM_download({
                url: blobUrl,
                name: saveAsName,
                onload: () => {
                  try {
                    URL.revokeObjectURL(blobUrl);
                  } catch (e) {}
                },
                onerror: response => {
                  console.log(`Error writing file ${fn} to disk. There may be more details below.`);
                  console.log(response);
                  try {
                    URL.revokeObjectURL(blobUrl);
                  } catch (e) {}
                },
              });
            }

            if (zippedForThis) {
              zip.file(fn, fileBlob);
              zipFileCount++;
            }
          },

          onabort: () => {
            if (abortReason !== 'bunkr_maint' || bunkrMaintenanceHandled) return;
            bunkrMaintenanceHandled = true;

            const p = requestProgress.find(r => r.url === progressKey);
            if (p) clearInterval(p.intervalId);

            completed++;
            completedBatchedDownloads++;

            h.ui.setText(statusLabel, `${completed} / ${totalDownloadable} 🢒 ${ellipsedUrl}`);
            h.ui.setElProps(statusLabel, { color: '#b23b3b' });
            h.ui.setElProps(totalPB, {
              width: `${(completed / totalDownloadable) * 100}%`,
            });

            log.post.error(postId, `::Bunkr skipped (maintenance redirect: maint.mp4)::: ${url}`, postNumber);
          },

          onerror: () => {
            const p = requestProgress.find(r => r.url === progressKey);
            if (p) clearInterval(p.intervalId);

            if (switchedToDirect) return;

            if (isGoFile && pass === 1 && !gofileWarmupAttempted.has(url)) {
              gofileWarmupAttempted.add(url);
              log.post.info(postId, `::GoFile warm-up -> open tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
              gofileWarmupOpenTab(url);
              setTimeout(() => startDownload(resource, 2), GOFILE_WARMUP_MS);
              return;
            }

            completed++;
            completedBatchedDownloads++;
          },
        });

        requests.push({ url: progressKey, request });

        const stallMs = isTurbo ? TURBO_STALL_MS : 30000;

        const intervalId = setInterval(async () => {
          const p = requestProgress.find(r => r.url === progressKey);
          if (!p) return;

          if (p.old === p.new) {
            const rr = requests.find(r => r.url === progressKey);
            if (rr && rr.request) rr.request.abort();
            clearInterval(p.intervalId);

            // Turbo: fast re-sign + retry, then (optional) direct fallback.
            if (isTurbo) {
              const st = turboRetryState.get(turboKey) || { resign: 0, direct: 0 };

              if (st.resign < TURBO_RESIGN_RETRIES) {
                st.resign++;
                turboRetryState.set(turboKey, st);

                log.post.info(
                  postId,
                  `::Turbo stalled (no progress for ${Math.round(stallMs / 1000)}s) -> re-sign + retry [${st.resign}/${TURBO_RESIGN_RETRIES}]::: ${url}`,
                  postNumber,
                );

                try {
                  const newUrl = await turboResignSignedUrl(turboId, url);
                  if (newUrl) {
                    resource.url = newUrl;
                  }
                } catch (e) {}

                // Retry once (even if we couldn't re-sign, a plain retry sometimes works).
                setTimeout(() => startDownload(resource, pass + 1), st.resign >= 3 ? TURBO_RETRY_DELAY_MS * 2 : TURBO_RETRY_DELAY_MS);
                return;
              }

              if (st.direct < TURBO_DIRECT_FALLBACKS) {
                st.direct++;
                turboRetryState.set(turboKey, st);

                log.post.info(
                  postId,
                  `::Turbo stalled (no progress for ${Math.round(stallMs / 1000)}s) -> DIRECT fallback (outside ZIP) [${st.direct}/${TURBO_DIRECT_FALLBACKS}]::: ${url}`,
                  postNumber,
                );
                startDirectDownload();
                return;
              }

              log.post.error(postId, `::Turbo failed (stalled after retries)::: ${url}`, postNumber);

              if (completed < totalDownloadable) {
                completed++;
              }
              completedBatchedDownloads++;

              if (completedBatchedDownloads >= batch.length) {
                completedBatchedDownloads = 0;
              }
              return;
            }

            // Make stalls visible instead of silently counting a failed download as
            // complete (previously only GoFile logged this; every other host -- Bunkr
            // included -- fell through to completed++ with no indication of failure).
            log.post.error(postId, `::Stalled/Failed::: ${url}`, postNumber);

            if (isGoFile && pass === 1 && !gofileWarmupAttempted.has(url)) {
              gofileWarmupAttempted.add(url);
              log.post.info(postId, `::GoFile stalled -> warm-up tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
              // request.abort() above isn't always reliable once a blob response is
              // substantially buffered -- mark pass 2 as authoritative so a zombie
              // pass-1 onload (see the isGoFile guard at the top of onload) can't
              // also save the file.
              gofileActivePass.set(url, 2);
              gofileWarmupOpenTab(url);
              setTimeout(() => startDownload(resource, 2), GOFILE_WARMUP_MS);
              return;
            }

            if (completed < totalDownloadable) {
              completed++;
            }
            completedBatchedDownloads++;

            if (completedBatchedDownloads >= batch.length) {
              completedBatchedDownloads = 0;
            }
          } else {
            p.old = p.new;
          }
        }, stallMs);

        requestProgress.push({ url: progressKey, intervalId, old: 0, new: 0 });
      };

      for (const item of batch) {
        startDownload(item, 1);
      }

      while (completedBatchedDownloads < batch.length) {
        await h.delayedResolve(1000);
      }

      if (completedBatchedDownloads >= batch.length) {
        completedBatchedDownloads = 0;
      }

      batch = getNextBatch();
    }
  } else {
    log.post.info(postId, '::Skipping download::', postNumber);
  }

  h.hide(filePB);
  h.hide(totalPB);
  if (completed < totalResources) {
    h.ui.setElProps(statusLabel, { color: '#e8a838', fontWeight: 'bold' });
    h.ui.setText(statusLabel, `${completed} / ${totalResources} downloaded`);
    h.show(statusLabel);
  } else {
    h.hide(statusLabel);
  }

  if (totalDownloadable > 0) {
    let title = sanitizeZipTitleSegment(threadTitle, settings?.naming);

    const mainZipName = customFilename || `${title} #${postNumber}.zip`;
    const generatedZipName = `${title} #${postNumber} generated.zip`;
    // Original (single ZIP) behavior.
    const needZipBlob = postSettings.generateLog || postSettings.generateLinks || (postSettings.zipped && zipFileCount > 0);

    // If "Zipped" is enabled but nothing was added to the ZIP (e.g. everything was saved via DIRECT),
    // skip creating an empty ZIP file.
    if (postSettings.zipped && zipFileCount === 0 && !postSettings.generateLog && !postSettings.generateLinks) {
      log.post.info(postId, `::Zipped ON but nothing to zip (all DIRECT downloads) -> skipping ZIP::`, postNumber);
    }
    if (needZipBlob) {
      log.separator(postId);
      log.post.info(postId, postSettings.zipped ? `::Preparing zip::` : `::Preparing generated.zip::`, postNumber);

      if (postSettings.generateLog) {
        log.post.info(postId, `::Generating log file::`, postNumber);
        zip.file(
          isFF ? 'generated/log.txt' : 'log.txt',
          logs
            .filter(l => l.postId === postId)
            .map(l => l.message)
            .join('\n'),
        );
      }

      if (postSettings.generateLinks) {
        log.post.info(postId, `::Generating links::`, postNumber);
        zip.file(
          isFF ? 'generated/links.txt' : 'links.txt',
          resolved
            .filter(r => r.url)
            .map(r => r.url)
            .join('\n'),
        );
      }

      let blob = null;
      try {
        blob = await zip.generateAsync({ type: 'blob' });
      } catch (e) {
        console.log('JSZip failed to construct the Blob. For very large albums, try unzipped mode.');
        console.log(e);
        blob = null;
      }

      if (blob) {
        if (postSettings.zipped) {
          if (isFF) {
            saveAs(blob, mainZipName);
          } else {
            await new Promise(resolve => {
              const url = URL.createObjectURL(blob);
              GM_download({
                url,
                name: `${title}/#${postNumber}.zip`,
                onload: () => {
                  try {
                    URL.revokeObjectURL(url);
                  } catch (e) {}
                  blob = null;
                  resolve();
                },
                onerror: response => {
                  try {
                    URL.revokeObjectURL(url);
                  } catch (e) {}
                  console.log(`Error writing file to disk. There may be more details below.`);
                  console.log(response);
                  console.log('Trying to write using FileSaver...');
                  try {
                    saveAs(blob, mainZipName);
                  } catch (e) {}
                  console.log('Done!');
                  resolve();
                },
              });
            });
          }
        } else {
          if (postSettings.generateLog || postSettings.generateLinks) {
            if (isFF) {
              saveAs(blob, generatedZipName);
            } else {
              await new Promise(resolve => {
                const url = URL.createObjectURL(blob);
                GM_download({
                  url,
                  name: `${title}/#${postNumber}/generated.zip`,
                  onload: () => {
                    try {
                      URL.revokeObjectURL(url);
                    } catch (e) {}
                    blob = null;
                    resolve();
                  },
                  onerror: response => {
                    try {
                      URL.revokeObjectURL(url);
                    } catch (e) {}
                    console.log(`Error writing generated.zip to disk. There may be more details below.`);
                    console.log(response);
                    blob = null;
                    resolve();
                  },
                });
              });
            }
          }
        }
      }
    }
  }

  setProcessing(false, postId);

  if (!processing.some(p => p.processing)) {
    gofileRestoreCookie();
  }

  if (totalDownloadable > 0) {
    // For logging in console since post logs are already written.
    if (!postSettings.skipDownload) {
      log.post.info(postId, `::Download completed::`, postNumber);
    } else {
      log.post.info(postId, `::Links generation completed::`, postNumber);
    }

    callbacks && callbacks.onComplete && callbacks.onComplete(totalDownloadable, completed);
  }

  window.logs = window.logs.filter(l => l.postId !== postId);
};
