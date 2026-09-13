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

const turboTransferIdentity = (isTurbo, url, original) => {
  const turboId = isTurbo ? turboIdBySignedUrl.get(String(url)) || turboExtractId(original) || turboExtractId(url) || '' : '';
  const turboKey = isTurbo ? (turboId ? `turbo:${turboId}` : `turbo-url:${url}`) : '';
  return { turboId, turboKey };
};

const blobTransferHeaders = (isFilester, url, resource, reflink) => {
  const isTurboCdn = /turbocdn\.st/i.test(String(url || ''));
  const filesterRef = isFilester
    ? String(filesterRefByUrl.get(String(url)) || (resource && resource.original) || 'https://filester.me/')
    : '';
  return isTurboCdn ? { Referer: 'https://turbo.cr/' } : isFilester ? { Referer: filesterRef } : { Referer: reflink };
};

const runDownloadTransfers = async run => {
  const { postId, postNumber, postSettings, statusUI, resolved } = run;
  const statusLabel = statusUI.status;
  const filePB = statusUI.filePB;

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

      const { turboId, turboKey } = turboTransferIdentity(isTurbo, url, original);

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

      const transferState = { switchedToDirect: false, abortReason: '', bunkrMaintenanceHandled: false };

      const startDirectDownload = (metaHint = null) => {
        transferState.switchedToDirect = true;
        downloadResourceDirect(run, batchState, attempt, metaHint, actions);
      };

      const scheduleInitialDirectDownload = () => {
        if (resource && resource.forceDirect) {
          log.post.info(postId, `::Forced DIRECT (skip blob/ZIP)::: ${url}`, postNumber);
          setTimeout(() => startDirectDownload(), TURBO_DIRECT_DELAY_MS);
          return true;
        }

        const isPixeldrainList = attempt.isPixeldrain && /pixeldrain\.com\/l\//i.test(String(original || ''));
        if (isPixeldrainList) {
          log.post.info(postId, `::Pixeldrain list (/l/) -> DIRECT (skip blob)::: ${url}`, postNumber);
          setTimeout(() => startDirectDownload(), TURBO_DIRECT_DELAY_MS);
          return true;
        }
        return false;
      };
      if (scheduleInitialDirectDownload()) return;

      if (isGoFile || attempt.isPixeldrain || isFilester) {
        const meta0 = await batchState.metadata.readDownloadMetadata(url, { isGoFile, isPixeldrain: attempt.isPixeldrain });
        if (meta0 && meta0.size && meta0.size > DOWNLOAD_BLOB_MAX_BYTES) {
          log.post.info(postId, `::Large file (${meta0.size} bytes > ~1.6GB) -> DIRECT (skip blob)::: ${url}`, postNumber);
          startDirectDownload(meta0);
          return;
        }
      }

      const reqHeaders = blobTransferHeaders(isFilester, url, resource, reflink);

      const handleGoFileResponse = response => {
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
            return true;
          }

          actions.settle(attempt, {
            statusColor: '#b23b3b',
            updateStatus: true,
            updateTotalProgress: true,
            log: { level: 'error', message: `::GoFile failed (after retry)::: ${url}` },
          });
          return true;
        }
        return false;
      };

      const handleCyberdropResponse = response => {
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
            return true;
          }

          actions.settle(attempt, {
            statusColor: '#b23b3b',
            updateStatus: true,
            updateTotalProgress: true,
            log: { level: 'error', message: `::Cyberdrop failed (gate/tiny response)::: ${url}` },
          });
          return true;
        }
        return false;
      };

      const chooseFilesterCache = (token, preferLegacy = false) => {
        const candidates = filesterCandidatesByToken.get(token) || filesterBuildCandidates(token);
        let tried = filesterTriedByToken.get(token);
        if (!tried) {
          tried = new Set();
          filesterTriedByToken.set(token, tried);
        }
        tried.add(String(url));
        let preferredHost = null;
        if (preferLegacy) {
          if (/https?:\/\/cache6\.filester\.(me|sh|si|gg)\//i.test(String(url || ''))) {
            preferredHost = /https?:\/\/cache1\.filester\.(me|sh|si|gg)\//i;
          } else if (/https?:\/\/cache1\.filester\.(me|sh|si|gg)\//i.test(String(url || ''))) {
            preferredHost = /https?:\/\/cache6\.filester\.(me|sh|si|gg)\//i;
          }
        }
        const available = candidates || [];
        let nextUrl = '';
        if (preferredHost) {
          nextUrl = available.find(candidate => preferredHost.test(candidate) && !tried.has(candidate)) || '';
        }
        if (!nextUrl) nextUrl = available.find(candidate => !tried.has(candidate)) || '';
        if (nextUrl) tried.add(nextUrl);
        return { nextUrl, tried, candidates: available };
      };

      const switchFilesterCache = nextUrl => {
        try {
          filesterRefByUrl.set(String(nextUrl), 'https://filester.me/');
        } catch (e) {}
        try {
          resource.url = nextUrl;
        } catch (e) {}
        url = nextUrl;
      };

      const retryFilesterMissingCache = response => {
        if (Number(response.status || 0) !== 404) return false;
        const token = filesterTokenFromVUrl(String(url || ''));
        if (!token) return false;
        const { nextUrl, tried, candidates } = chooseFilesterCache(token);
        if (!nextUrl) return false;
        log.post.info(postId, `::Filester cache 404 -> try next cache [${tried.size}/${candidates.length}]::: ${nextUrl}`, postNumber);
        switchFilesterCache(nextUrl);
        startDownload(resource, pass);
        return true;
      };

      const filesterRetryDelay = (response, retryCount) => {
        let waitMs = 0;
        const retryAfter = headerValue(response.responseHeaders || '', 'retry-after');
        if (retryAfter) {
          const seconds = Number(String(retryAfter).trim());
          if (Number.isFinite(seconds) && seconds > 0) waitMs = Math.floor(seconds * 1000);
        }
        if (!waitMs) waitMs = 650 * retryCount + Math.floor(Math.random() * 250);
        return Math.min(2500, Math.max(0, waitMs));
      };

      const filesterCacheSwitchInfo = nextUrl => {
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
        return switchInfo;
      };

      const retryFilesterTransientResponse = response => {
        const status = Number(response.status || 0) || 0;
        const isRetryable =
          status === 429 ||
          status === 400 ||
          status === 403 ||
          status === 408 ||
          status === 409 ||
          status === 425 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504;
        if (!isRetryable) return false;
        const token = filesterTokenFromVUrl(String(url || ''));
        const key = token || String(url || '');
        const maxRetries = 3;
        const retryCount = (Number(filesterRetryAttemptsByKey.get(key) || 0) || 0) + 1;
        filesterRetryAttemptsByKey.set(key, retryCount);
        const waitMs = filesterRetryDelay(response, retryCount);
        // Selecting the candidate also records affinity, including on exhausted retries.
        const nextUrl = token ? chooseFilesterCache(token, true).nextUrl : '';
        if (retryCount > maxRetries) return false;
        const target = nextUrl || String(url || '');
        const switchInfo = filesterCacheSwitchInfo(nextUrl);
        log.post.info(
          postId,
          `::Filester HTTP ${status} -> retry [${retryCount}/${maxRetries}] after ${waitMs}ms${switchInfo}::: ${target}`,
          postNumber,
        );
        setTimeout(() => {
          try {
            if (nextUrl) switchFilesterCache(nextUrl);
          } catch (e) {}
          startDownload(resource, pass);
        }, waitMs);
        return true;
      };

      const inspectFilesterResponse = response => {
        const mCt = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '');
        const ct = mCt && mCt[1] ? mCt[1] : '';
        const isGate = /text\/html|application\/xhtml\+xml|application\/json/i.test(ct);
        const badStatus = !response.status || response.status >= 400;

        const blob = response.response;
        const size = blob && typeof blob.size === 'number' ? blob.size : 0;

        let hintSize;
        try {
          const s0 = String(filesterSlugByUrl.get(String(url)) || '');
          hintSize = Number(filesterSizeBySlug.get(s0) || filesterSizeByUrl.get(String(url)) || 0) || 0;
        } catch (e) {
          hintSize = 0;
        }

        // Only treat "tiny" as suspicious when we have a meaningful expected size.
        const suspiciousTiny = !!hintSize && size > 0 && size <= 16384 && hintSize >= 32768;
        return { badStatus, isGate, hintSize, suspiciousTiny };
      };

      const handleFilesterResponse = response => {
        const { badStatus, isGate, hintSize, suspiciousTiny } = inspectFilesterResponse(response);
        if (!badStatus && !isGate && !suspiciousTiny) return false;
        if (pass === 1) {
          // Try cache affinity and bounded transient retries before DIRECT.
          if (badStatus && retryFilesterMissingCache(response)) return true;
          if (badStatus && retryFilesterTransientResponse(response)) return true;
          const isView = /https?:\/\/(?:www\.)?filester\.(me|sh|si|gg)\/d\//i.test(String(url || ''));
          if (!isView) {
            log.post.info(postId, `::Filester blocked/tiny response -> switch to DIRECT [1/2]::: ${url}`, postNumber);
            startDirectDownload({ size: hintSize || 0 });
            return true;
          }

          // If we only have a /d/ view URL, DIRECT would just save HTML.
          actions.settle(attempt, {
            statusColor: '#b23b3b',
            updateStatus: true,
            updateTotalProgress: true,
            log: { level: 'error', message: `::Filester failed (resolved to /d/ HTML view)::: ${url}` },
          });
          return true;
        }

        const reason = badStatus ? `HTTP ${response.status || 0}` : isGate ? 'HTML/JSON gate' : 'tiny/blocked response';
        actions.settle(attempt, {
          statusColor: '#b23b3b',
          updateStatus: true,
          updateTotalProgress: true,
          log: { level: 'error', message: `::Filester failed (${reason})::: ${url}` },
        });
        return true;
      };

      const bunkrTextLooksLikeHtml = text => {
        const head = String(text || '')
          .slice(0, 2048)
          .toLowerCase();
        return (
          head.includes('<!doctype') ||
          head.includes('<html') ||
          head.includes('<head') ||
          head.includes('<body') ||
          head.includes('temporarily not available') ||
          head.includes('maintenance') ||
          head.includes('cloudflare')
        );
      };

      const bunkrSkipReason = (response, isMaint, badStatus, isHtml) => {
        return isMaint
          ? 'maintenance redirect (maint.mp4)'
          : badStatus
            ? `HTTP ${response.status || 0}`
            : isHtml
              ? 'HTML/maintenance response'
              : 'tiny HTML placeholder';
      };

      const inspectBunkrResponse = response => {
        const mCt = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '');
        const ct = mCt && mCt[1] ? mCt[1] : '';
        const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
        const badStatus = !response.status || response.status >= 400;

        const bunkrFinalUrl = String(response.finalUrl || '');
        const bunkrLoc = headerValue(response.responseHeaders || '', 'location');
        const isMaint =
          transferState.abortReason === 'bunkr_maint' || /\/maint\.mp4(\?|$)/i.test(bunkrFinalUrl) || /\/maint\.mp4(\?|$)/i.test(bunkrLoc);

        const blob = response.response;
        const size = blob && typeof blob.size === 'number' ? blob.size : 0;
        const tinyLimit = 32768;

        const inspectTiny = !isHtml && !badStatus && postSettings.verifyBunkrLinks && size > 0 && size <= tinyLimit;
        return { blob, badStatus, isHtml, isMaint, inspectTiny };
      };

      const handleBunkrResponse = (response, inspection, tinyLooksLikeHtml) => {
        const { badStatus, isHtml, isMaint } = inspection;
        if (badStatus || isHtml || tinyLooksLikeHtml || isMaint) {
          if (isMaint) transferState.bunkrMaintenanceHandled = true;

          const reason = bunkrSkipReason(response, isMaint, badStatus, isHtml);
          actions.settle(attempt, {
            statusColor: '#b23b3b',
            updateStatus: true,
            updateTotalProgress: true,
            log: { level: 'error', message: `::Bunkr skipped (${reason})::: ${url}` },
          });
          return true;
        }
        return false;
      };

      const saveCompletedBlob = response => {
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
      };

      const handleTurboStall = async stallMs => {
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
      };

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
            if (isBunkr && !transferState.abortReason) {
              const loc = headerValue(response.responseHeaders || '', 'location');
              const fu = String(response.finalUrl || '');
              if (/\/maint\.mp4(\?|$)/i.test(loc) || /\/maint\.mp4(\?|$)/i.test(fu)) {
                transferState.abortReason = 'bunkr_maint';
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
            !transferState.switchedToDirect &&
            (isGoFile || attempt.isPixeldrain || isFilester) &&
            response &&
            response.total &&
            response.total > DOWNLOAD_BLOB_MAX_BYTES
          ) {
            log.post.info(postId, `::Large file (${response.total} bytes > ~1.6GB) detected -> switch to DIRECT::: ${url}`, postNumber);
            transferState.switchedToDirect = true;
            try {
              request.abort();
            } catch (e) {}
            startDirectDownload({ size: response.total });
            return;
          }
          // Bunkr: large videos cause MV3 port disconnection via blob; switch to direct download above 500MB.
          if (!transferState.switchedToDirect && isBunkr && response && response.total && response.total > BUNKR_DIRECT_MIN_BYTES) {
            log.post.info(postId, `::Bunkr large file (${response.total} bytes > 500MB) -> switch to DIRECT::: ${url}`, postNumber);
            transferState.switchedToDirect = true;
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
          if (transferState.switchedToDirect) return;
          if (transferState.abortReason === 'bunkr_maint' && transferState.bunkrMaintenanceHandled) return;
          // Buffered responses can survive abort(); only the newest GoFile pass may save.
          if (isGoFile && (batchState.gofileActivePass.get(url) || pass) > pass) return;

          if (isGoFile && handleGoFileResponse(response)) return;
          if (isCyberdrop && handleCyberdropResponse(response)) return;
          if (isFilester && handleFilesterResponse(response)) return;
          if (isBunkr) {
            const inspection = inspectBunkrResponse(response);
            let tinyLooksLikeHtml = false;
            if (inspection.inspectTiny) {
              try {
                tinyLooksLikeHtml = bunkrTextLooksLikeHtml(await inspection.blob.text());
              } catch (e) {}
            }
            if (handleBunkrResponse(response, inspection, tinyLooksLikeHtml)) return;
          }
          saveCompletedBlob(response);
        },

        onabort: () => {
          if (transferState.abortReason !== 'bunkr_maint' || transferState.bunkrMaintenanceHandled) return;
          transferState.bunkrMaintenanceHandled = true;

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

          if (transferState.switchedToDirect) return;

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

      const checkTransferStall = async () => {
        const p = batchState.requestProgress.find(r => r.url === progressKey);
        if (!p) return;
        // The direct transfer owns completion after a large-file handoff.
        if (transferState.switchedToDirect) {
          clearInterval(p.intervalId);
          return;
        }
        if (p.old !== p.new) {
          p.old = p.new;
          return;
        }

        const rr = batchState.requests.find(r => r.url === progressKey);
        if (rr && rr.request) rr.request.abort();
        clearInterval(p.intervalId);
        if (isTurbo) return handleTurboStall(stallMs);

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
      };
      const intervalId = setInterval(checkTransferStall, stallMs);

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
