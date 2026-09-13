// DIRECT callbacks settle once; warm-up retries leave settlement to the next pass.
const downloadResourceDirect = async (run, batch, attempt, metaHint, actions) => {
  const { postId, postNumber, postSettings, statusUI, threadTitle, isFirefox, names } = run;
  const { url, host, original, folderName, pass, isGoFile, isPixeldrain, isTurbo, isFilester, reflink, ellipsedUrl, resource } = attempt;
  const statusLabel = statusUI.status;
  const filePB = statusUI.filePB;
  const totalPB = statusUI.totalPB;

  try {
    const baseMeta = isTurbo ? {} : (await batch.metadata.readDownloadMetadata(url, { isGoFile, isPixeldrain })) || {};
    const meta = { ...baseMeta, ...(metaHint || {}) };
    const sizeBytes = Number(meta.size || 0) || 0;

    // GoFile: if HEAD already shows an HTML gate / bad status, do the same warm-up + one retry.
    if (isGoFile) {
      const ct = String(meta.contentType || '');
      const badStatus = meta.status && meta.status >= 400;
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
      if ((badStatus || isHtml) && pass === 1 && !batch.gofileWarmupAttempted.has(url)) {
        batch.gofileWarmupAttempted.add(url);
        log.post.info(postId, `::GoFile warm-up -> open tab (${GOFILE_WARMUP_MS}ms) then retry [1/2]::: ${url}`, postNumber);
        gofileWarmupOpenTab(url);
        setTimeout(() => actions.retry(attempt.resource, 2), GOFILE_WARMUP_MS);
        return;
      }
    }

    if (postSettings.zipped) {
      log.post.info(postId, `::Zipped ON -> saving standalone (not in ZIP)::: ${url}`, postNumber);
    }

    const planned = names.plan({ mode: 'direct', resource, url, meta, zippedForThis: false });
    const basename = planned.basename;
    const saveAsName = planned.saveAsName;
    const folder = (resource && resource.folderName) || '';

    log.separator(postId);
    log.post.info(postId, `::Handed off (direct)::: ${url}`, postNumber);

    if (folder && folder.trim() !== '') {
      log.post.info(postId, `::Saving as (direct)::: ${basename} ::to:: ${folder}`, postNumber);
    } else {
      log.post.info(postId, `::Saving as (direct)::: ${basename}`, postNumber);
    }

    h.ui.setElProps(statusLabel, { color: '#469cf3' });
    h.show(filePB);

    let directUrl = String(url);
    let filesterDirectPreflightDone = false;

    // Preflight with bounded retries; rotate only legacy cache-host tokens.
    if (isFilester) {
      const sel = await selectFilesterDirectUrl(url, resource, { postId, postNumber });
      directUrl = sel.directUrl;
      filesterDirectPreflightDone = sel.preflightDone;
    }

    const imagebamHeaders = isImagebamCdnUrl(url) ? { Referer: imagebamRefererForCdn(url) } : null;
    const settle = (statusColor, updateStatus, updateTotalProgress, logMsg, err) => {
      if (err) console.log(err);
      actions.settle(attempt, {
        statusColor,
        updateStatus,
        updateTotalProgress,
        log: logMsg,
      });
    };
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
            `${run.completed} / ${run.totalDownloadable} 🢒 ${host.name} 🢒 DIRECT 🢒 ${loadedMB} MB 🢒 ${ellipsedUrl}`,
          );
        } else {
          h.ui.setText(
            statusLabel,
            `${run.completed} / ${run.totalDownloadable} 🢒 ${host.name} 🢒 DIRECT 🢒 ${loadedMB} MB / ${totalMB} MB  🢒 ${ellipsedUrl}`,
          );
          h.ui.setElProps(filePB, {
            width: `${(e.loaded / totalBytes) * 100}%`,
          });
        }
      },
      onload: () => {
        settle('#2d9053', true, true);
      },
      onerror: err => {
        settle('#b23b3b', true, true, { level: 'error', message: `::DIRECT download failed::: ${url}` }, err);
      },
      ontimeout: err => {
        settle(null, false, false, { level: 'error', message: `::DIRECT download timed out::: ${url}` }, err);
      },
    };
    if (imagebamHeaders && isFirefox) {
      // Firefox GM_download may drop Imagebam's required Referer; fetch a blob first.
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

      // Chrome may drop cookies: a one-byte preflight captures the signed redirect URL.
      if (isFilester && !isFirefox && !filesterDirectPreflightDone) {
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
    actions.settle(attempt, { log: { level: 'error', message: `::DIRECT download error::: ${url}` } });
    console.log(e);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { downloadResourceDirect };
}
