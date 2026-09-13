// Transfer loop: batching, blob downloads, stall handling, and terminal accounting.
// Per-batch state lives in a fresh batch object; nothing leaks into module scope.
const GOFILE_WARMUP_MS = 3000;
const CYBERDROP_WARMUP_MS = 1500;
const TURBO_STALL_MS = 5000;
const TURBO_RESIGN_RETRIES = 3; // number of re-sign + retry attempts
const TURBO_DIRECT_FALLBACKS = 1; // number of direct-download fallbacks after re-sign retries
const TURBO_RETRY_DELAY_MS = 600; // small pause before re-sign retry
const TURBO_DIRECT_DELAY_MS = 800; // small pause before DIRECT fallback

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

// Classify a resolved resource into the flags the transfer and direct paths branch
// on. Cyberdrop detection uses host.name (the parsed host entry, e.g. 'Cyberdrop').
const classifyDownloadAttempt = (resource, pass) => {
  const { url, host, original, folderName } = resource;

  const isGoFile = isGoFileUrl(url);
  const isPixeldrain = isPixeldrainUrl(url);
  const isTurbo = isTurboUrl(url);
  const isCyberdrop = String((host && host.name) || '').toLowerCase() === 'cyberdrop';
  const isBunkr =
    String((host && host.name) || '').toLowerCase() === 'bunkr' ||
    /bunkr/i.test(String(url || '')) ||
    /bunkr/i.test(String(original || ''));
  const isFilester = String((host && host.name) || '').toLowerCase() === 'filester' || isFilesterUrl(url);

  let reflink = original;
  if (url.includes('bunkr')) {
    reflink = 'https://bunkr.si';
  }
  if (url.includes('pomf2')) {
    reflink = 'https://pomf2.lain.la';
  }
  if (url.includes('turbocdn.st')) {
    reflink = 'https://turbo.cr/';
  }
  if (isFilester) {
    reflink = filesterRefByUrl.get(String(url)) || original || 'https://filester.me/';
  }

  // Cyberdrop: normalize referer/origin and build a /f/ page for optional warm-up.
  let cyberOrigin = '';
  let cyberSlug = '';
  let cyberFilePage = '';
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

  return {
    url,
    host,
    original,
    folderName,
    pass,
    isGoFile,
    isPixeldrain,
    isTurbo,
    isCyberdrop,
    isBunkr,
    isFilester,
    reflink,
    ellipsedUrl,
    cyberOrigin,
    cyberSlug,
    cyberFilePage,
    resource,
  };
};

// Callers own exactly-once settlement; UI/log updates are optional.
// Stall paths reset the batch counter when it reaches the batch length.
const settleDownloadAttempt = (run, batch, attempt, outcome = {}) => {
  const { statusColor, updateStatus, updateTotalProgress, log: logMsg, guardCompleted, resetBatchOnFull } = outcome;

  run.completed++;
  batch.completed++;

  if (guardCompleted && run.completed > run.totalDownloadable) {
    run.completed = run.totalDownloadable;
  }

  if (updateStatus) {
    h.ui.setText(run.statusUI.status, `${run.completed} / ${run.totalDownloadable} 🢒 ${attempt.ellipsedUrl}`);
  }
  if (statusColor) {
    h.ui.setElProps(run.statusUI.status, { color: statusColor });
  }
  if (updateTotalProgress) {
    h.ui.setElProps(run.statusUI.totalPB, {
      width: `${(run.completed / run.totalDownloadable) * 100}%`,
    });
  }

  if (logMsg) {
    if (logMsg.level === 'error') {
      log.post.error(run.postId, logMsg.message, run.postNumber);
    } else {
      log.post.info(run.postId, logMsg.message, run.postNumber);
    }
  }

  if (resetBatchOnFull && batch.completed >= batch.items.length) {
    batch.completed = 0;
  }
};

const runDownloadTransfers = async run => {
  const { postId, postNumber, postSettings, statusUI, resolved } = run;
  const statusLabel = statusUI.status;
  const filePB = statusUI.filePB;
  const totalPB = statusUI.totalPB;

  if (postSettings.skipDownload) {
    log.post.info(postId, '::Skipping download::', postNumber);
    return;
  }

  const resources = resolved.filter(r => r.url);
  run.totalDownloadable = resources.length;

  const batchLength = computeBatchLength(resolved);

  let currentBatch = 0;

  const batches = buildBatches(resources, batchLength);

  const getNextBatch = () => {
    const batch = currentBatch < batches.length ? batches[currentBatch] : [];
    currentBatch++;
    return batch;
  };

  let batch = getNextBatch();

  while (batch.length) {
    const batchState = {
      items: batch,
      completed: 0,
      requests: [],
      requestProgress: [],
      turboRetryState: new Map(),
      gofileWarmupAttempted: new Set(),
      gofileActivePass: new Map(),
      filesterNoTabTokenLogged: false,
      metadata: createDownloadMetadataReader(),
    };

    const actions = {
      retry: (resource, pass) => startDownload(resource, pass),
      settle: (attempt, outcome) => settleDownloadAttempt(run, batchState, attempt, outcome),
    };

    const startDownload = async (resource, pass = 1) => {
      let attempt = classifyDownloadAttempt(resource, pass);
      const { isGoFile, isFilester, isTurbo, isCyberdrop, isBunkr, original, reflink } = attempt;
      let url = attempt.url;
      const zippedForThis = !!(postSettings.zipped && !(resource && (resource.forceDirect || resource.forceUnzipped)));

      // Both blob and DIRECT requests need the GoFile cookie used during resolution.
      if (isGoFile) {
        try {
          const gfToken = settings?.hosts?.goFile?.token;
          if (gfToken) await gofileSyncCookie(gfToken);
        } catch (e) {}
      }

      // Albums yield /d/ pages; resolve them through the same v2 API as single files.
      if (isFilester) {
        const preppedUrl = String(resource.url || '');
        const streamUrl = await prepareFilesterDownloadResource(resource, { postId, postNumber, tokenLogState: batchState });
        if (!streamUrl) {
          actions.settle(attempt, {
            statusColor: '#b23b3b',
            updateStatus: true,
            updateTotalProgress: true,
            log: { level: 'error', message: `::Filester resolution failed::: ${preppedUrl}` },
          });
          return;
        }
        if (streamUrl !== preppedUrl) {
          url = streamUrl;
          attempt.url = streamUrl;
        }
      }

      const turboId = isTurbo ? turboIdBySignedUrl.get(String(url)) || turboExtractId(original) || turboExtractId(url) || '' : '';
      const turboKey = isTurbo ? (turboId ? `turbo:${turboId}` : `turbo-url:${url}`) : '';

      const progressKey = isGoFile ? `${url}@@gofilepass${pass}` : url;

      h.ui.setElProps(statusLabel, { fontWeight: 'normal' });

      log.post.info(postId, `::Downloading${isGoFile && pass > 1 ? ' (retry)' : ''}::: ${url}`, postNumber);

      if (
        isCyberdrop &&
        pass === 1 &&
        attempt.cyberOrigin &&
        attempt.cyberFilePage &&
        /gigachad-cdn\.ru|cuckcapital\.cr/i.test(String(url || '')) &&
        !run.cyberdropDirectWarmupDone
      ) {
        run.cyberdropDirectWarmupDone = true;
        log.post.info(
          postId,
          `::Cyberdrop warm-up -> open tab (${CYBERDROP_WARMUP_MS}ms) then continue::: ${attempt.cyberFilePage}`,
          postNumber,
        );
        await cyberdropWarmupOnce(attempt.cyberOrigin, attempt.cyberFilePage, CYBERDROP_WARMUP_MS);
      }

      let switchedToDirect = false;

      const startDirectDownload = (metaHint = null) => {
        switchedToDirect = true;
        downloadResourceDirect(run, batchState, attempt, metaHint, actions);
      };

      if (resource && resource.forceDirect) {
        log.post.info(postId, `::Forced DIRECT (skip blob/ZIP)::: ${url}`, postNumber);
        setTimeout(() => startDirectDownload(), TURBO_DIRECT_DELAY_MS);
        return;
      }

      const isPixeldrainList = attempt.isPixeldrain && /pixeldrain\.com\/l\//i.test(String(original || ''));
      if (isPixeldrainList) {
        log.post.info(postId, `::Pixeldrain list (/l/) -> DIRECT (skip blob)::: ${url}`, postNumber);
        setTimeout(() => startDirectDownload(), TURBO_DIRECT_DELAY_MS);
        return;
      }

      if (isGoFile || attempt.isPixeldrain || isFilester) {
        const meta0 = await batchState.metadata.readDownloadMetadata(url, { isGoFile, isPixeldrain: attempt.isPixeldrain });
        if (meta0 && meta0.size && meta0.size > DOWNLOAD_BLOB_MAX_BYTES) {
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
            run.names.capture(url, response.responseHeaders || '');

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

          // A late size report can exceed the blob limit; hand completion to DIRECT.
          if (
            !switchedToDirect &&
            (isGoFile || attempt.isPixeldrain || isFilester) &&
            response &&
            response.total &&
            response.total > DOWNLOAD_BLOB_MAX_BYTES
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
            h.ui.setText(
              statusLabel,
              `${run.completed} / ${run.totalDownloadable} 🢒 ${attempt.host.name} 🢒 ${downloadedSizeInMB} MB 🢒 ${attempt.ellipsedUrl}`,
            );
          } else {
            h.show(filePB);
            h.ui.setText(
              statusLabel,
              `${run.completed} / ${run.totalDownloadable} 🢒 ${attempt.host.name} 🢒 ${downloadedSizeInMB} MB / ${totalSizeInMB} MB  🢒 ${attempt.ellipsedUrl}`,
            );
            h.ui.setElProps(filePB, {
              width: `${(response.loaded / response.total) * 100}%`,
            });
          }
          const p = batchState.requestProgress.find(r => r.url === progressKey);
          if (p) p.new = response.loaded;
        },
        onload: async response => {
          const p = batchState.requestProgress.find(r => r.url === progressKey);
          if (p) clearInterval(p.intervalId);
          if (switchedToDirect) return;

          if (abortReason === 'bunkr_maint' && bunkrMaintenanceHandled) return;
          // Buffered responses can survive abort(); only the newest GoFile pass may save.
          if (isGoFile && (batchState.gofileActivePass.get(url) || pass) > pass) return;

          // GoFile: detect soft-block / HTML gate
          if (isGoFile) {
            const mCt = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '');
            const ct = mCt && mCt[1] ? mCt[1] : '';
            const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
            const badStatus = !response.status || response.status >= 400;

            if (badStatus || isHtml) {
              if (pass === 1 && !batchState.gofileWarmupAttempted.has(url)) {
                batchState.gofileWarmupAttempted.add(url);
                log.post.info(postId, `::GoFile warm-up -> open tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
                gofileWarmupOpenTab(url);
                setTimeout(() => startDownload(resource, 2), GOFILE_WARMUP_MS);
                return;
              }

              actions.settle(attempt, {
                statusColor: '#b23b3b',
                updateStatus: true,
                updateTotalProgress: true,
                log: { level: 'error', message: `::GoFile failed (after retry)::: ${url}` },
              });
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
              if (pass === 1 && attempt.cyberOrigin && attempt.cyberFilePage) {
                log.post.info(
                  postId,
                  `::Cyberdrop warm-up -> open tab (${CYBERDROP_WARMUP_MS}ms) then retry [1/2]::: ${attempt.cyberFilePage}`,
                  postNumber,
                );
                cyberdropWarmupOnce(attempt.cyberOrigin, attempt.cyberFilePage, CYBERDROP_WARMUP_MS)
                  .then(() => startDownload(resource, 2))
                  .catch(() => startDownload(resource, 2));
                return;
              }

              actions.settle(attempt, {
                statusColor: '#b23b3b',
                updateStatus: true,
                updateTotalProgress: true,
                log: { level: 'error', message: `::Cyberdrop failed (gate/tiny response)::: ${url}` },
              });
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
                      url = nextUrl;
                      startDownload(resource, pass);
                      return;
                    }
                  }
                }

                // Retry transient errors with bounded delays and alternate legacy cache hosts.
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
                            url = nextUrl;
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
                actions.settle(attempt, {
                  statusColor: '#b23b3b',
                  updateStatus: true,
                  updateTotalProgress: true,
                  log: { level: 'error', message: `::Filester failed (resolved to /d/ HTML view)::: ${url}` },
                });
                return;
              }

              const reason = badStatus ? `HTTP ${response.status || 0}` : isGate ? 'HTML/JSON gate' : 'tiny/blocked response';
              actions.settle(attempt, {
                statusColor: '#b23b3b',
                updateStatus: true,
                updateTotalProgress: true,
                log: { level: 'error', message: `::Filester failed (${reason})::: ${url}` },
              });
              return;
            }
          }

          // Bunkr: skip maintenance/dead placeholder responses (often tiny HTML) instead of saving a tiny file.
          if (isBunkr) {
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

              const reason = isMaint
                ? 'maintenance redirect (maint.mp4)'
                : badStatus
                  ? `HTTP ${response.status || 0}`
                  : isHtml
                    ? 'HTML/maintenance response'
                    : 'tiny HTML placeholder';
              actions.settle(attempt, {
                statusColor: '#b23b3b',
                updateStatus: true,
                updateTotalProgress: true,
                log: { level: 'error', message: `::Bunkr skipped (${reason})::: ${url}` },
              });
              return;
            }
          }

          actions.settle(attempt, { statusColor: '#2d9053', updateStatus: true, updateTotalProgress: true });

          const planned = run.names.plan({
            mode: 'blob',
            resource,
            url,
            responseHeaders: response.responseHeaders || '',
            zippedForThis,
          });

          const folder = (resource && resource.folderName) || '';

          log.separator(postId);
          log.post.info(postId, `::Completed::: ${url}`, postNumber);

          if (folder && folder.trim() !== '') {
            log.post.info(postId, `::Saving as::: ${planned.basename} ::to:: ${folder}`, postNumber);
          } else {
            log.post.info(postId, `::Saving as::: ${planned.basename}`, postNumber);
          }

          const fileBlob = response.response;

          if (!zippedForThis) {
            const blobUrl = URL.createObjectURL(fileBlob);
            GM_download({
              url: blobUrl,
              name: planned.saveAsName,
              onload: () => {
                try {
                  URL.revokeObjectURL(blobUrl);
                } catch (e) {}
              },
              onerror: response => {
                console.log(`Error writing file ${planned.relativePath} to disk. There may be more details below.`);
                console.log(response);
                try {
                  URL.revokeObjectURL(blobUrl);
                } catch (e) {}
              },
            });
          }

          if (zippedForThis) {
            run.zip.file(planned.relativePath, fileBlob);
            run.zipFileCount++;
          }
        },

        onabort: () => {
          if (abortReason !== 'bunkr_maint' || bunkrMaintenanceHandled) return;
          bunkrMaintenanceHandled = true;

          const p = batchState.requestProgress.find(r => r.url === progressKey);
          if (p) clearInterval(p.intervalId);

          actions.settle(attempt, {
            statusColor: '#b23b3b',
            updateStatus: true,
            updateTotalProgress: true,
            log: { level: 'error', message: `::Bunkr skipped (maintenance redirect: maint.mp4)::: ${url}` },
          });
        },

        onerror: () => {
          const p = batchState.requestProgress.find(r => r.url === progressKey);
          if (p) clearInterval(p.intervalId);

          if (switchedToDirect) return;

          if (isGoFile && pass === 1 && !batchState.gofileWarmupAttempted.has(url)) {
            batchState.gofileWarmupAttempted.add(url);
            log.post.info(postId, `::GoFile warm-up -> open tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
            gofileWarmupOpenTab(url);
            setTimeout(() => startDownload(resource, 2), GOFILE_WARMUP_MS);
            return;
          }

          actions.settle(attempt);
        },
      });

      batchState.requests.push({ url: progressKey, request });

      const stallMs = isTurbo ? TURBO_STALL_MS : 30000;

      const intervalId = setInterval(async () => {
        const p = batchState.requestProgress.find(r => r.url === progressKey);
        if (!p) return;
        // The direct transfer owns completion after a large-file handoff.
        if (switchedToDirect) {
          clearInterval(p.intervalId);
          return;
        }

        if (p.old === p.new) {
          const rr = batchState.requests.find(r => r.url === progressKey);
          if (rr && rr.request) rr.request.abort();
          clearInterval(p.intervalId);

          // Turbo: fast re-sign + retry, then (optional) direct fallback.
          if (isTurbo) {
            const st = batchState.turboRetryState.get(turboKey) || { resign: 0, direct: 0 };

            if (st.resign < TURBO_RESIGN_RETRIES) {
              st.resign++;
              batchState.turboRetryState.set(turboKey, st);

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

              // Retry even if re-signing failed; the current URL may still work.
              setTimeout(() => startDownload(resource, pass + 1), st.resign >= 3 ? TURBO_RETRY_DELAY_MS * 2 : TURBO_RETRY_DELAY_MS);
              return;
            }

            if (st.direct < TURBO_DIRECT_FALLBACKS) {
              st.direct++;
              batchState.turboRetryState.set(turboKey, st);

              log.post.info(
                postId,
                `::Turbo stalled (no progress for ${Math.round(stallMs / 1000)}s) -> DIRECT fallback (outside ZIP) [${st.direct}/${TURBO_DIRECT_FALLBACKS}]::: ${url}`,
                postNumber,
              );
              startDirectDownload();
              return;
            }

            log.post.error(postId, `::Turbo failed (stalled after retries)::: ${url}`, postNumber);
            actions.settle(attempt, { guardCompleted: true, resetBatchOnFull: true });
            return;
          }

          log.post.error(postId, `::Stalled/Failed::: ${url}`, postNumber);

          if (isGoFile && pass === 1 && !batchState.gofileWarmupAttempted.has(url)) {
            batchState.gofileWarmupAttempted.add(url);
            log.post.info(postId, `::GoFile stalled -> warm-up tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
            // abort() may leave a buffered onload; pass 2 alone owns saving the file.
            batchState.gofileActivePass.set(url, 2);
            gofileWarmupOpenTab(url);
            setTimeout(() => startDownload(resource, 2), GOFILE_WARMUP_MS);
            return;
          }

          actions.settle(attempt, { guardCompleted: true, resetBatchOnFull: true });
        } else {
          p.old = p.new;
        }
      }, stallMs);

      batchState.requestProgress.push({ url: progressKey, intervalId, old: 0, new: 0 });
    };

    for (const item of batch) {
      startDownload(item, 1);
    }

    while (batchState.completed < batchState.items.length) {
      await h.delayedResolve(1000);
    }

    batch = getNextBatch();
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyDownloadAttempt, runDownloadTransfers, settleDownloadAttempt };
}
