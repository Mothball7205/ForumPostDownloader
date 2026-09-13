const captureDownloadHints = parsedPost => {
  try {
    const cc = parsedPost && parsedPost.contentContainer;
    if (cc && cc.querySelectorAll) {
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
        bunkrNameByUrl.set(stripUrlQueryAndFragment(href0), nm);
      });
    }
  } catch (e) {}
};

const matchesDownloadResolver = (patterns, resource) => {
  for (const pattern of patterns) {
    let strPattern = pattern.toString();
    const shouldMatch = !h.contains(':!', strPattern);
    strPattern = strPattern.replace(':!', '');
    const regex = h.re.toRegExp(h.re.toString(strPattern), 'is');
    if (shouldMatch !== regex.test(resource)) return false;
  }
  return true;
};

const appendResolvedDownload = async (resolved, url, folderName, host, resource, { postId, postNumber }, onResource) => {
  if (url && h.isObject(url)) {
    folderName = url.folderName;
    url = url.url;
  }
  if (typeof url !== 'string' || !url.trim()) return;
  if (!resolved.length) log.separator(postId);
  const normalized = {
    url,
    host,
    original: resource,
    folderName,
    forceUnzipped: false, // Filester can be zipped when using blob; DIRECT always saves outside ZIP
    forceDirect: false,
  };
  resolved.push(normalized);
  log.post.info(postId, `::Resolved::: ${url}`, postNumber);
  if (typeof onResource === 'function') await onResource(normalized);
};

const updateDownloadResolutionProgress = (statusLabel, text, color, onProgress) => {
  if (typeof onProgress === 'function') {
    onProgress(text);
    return;
  }
  h.ui.setElProps(statusLabel, { color, fontWeight: 'bold' });
  h.ui.setText(statusLabel, text);
};

const appendDownloadResolution = async (result, resolved, host, resource, parsedPost, statusLabel, onResource, onProgress) => {
  updateDownloadResolutionProgress(statusLabel, `Resolved: ${resolved.length}`, '#47ba24', onProgress);
  if (h.isArray(result.resolved)) {
    for (const url of result.resolved) {
      await appendResolvedDownload(resolved, url, result.folderName, host, resource, parsedPost, onResource);
    }
  } else {
    await appendResolvedDownload(resolved, result, null, host, resource, parsedPost, onResource);
  }
};

const resolveHostDownloadResource = async (
  resource,
  host,
  resolved,
  { parsedPost, resolvers, postSettings, statusLabel, onResource, onProgress },
) => {
  const { postId, postNumber } = parsedPost;
  for (const [patterns, resolverCB] of resolvers) {
    if (!matchesDownloadResolver(patterns, resource)) continue;
    const passwords = parsedPost.spoilers.concat(parsedPost.spoilers.map(s => s.toLowerCase()));
    let result;
    let callbackFailed = false;
    let callbackError;
    const onResolved =
      typeof onResource === 'function'
        ? async result => {
            try {
              await appendResolvedDownload(resolved, result, null, host, resource, parsedPost, onResource);
            } catch (error) {
              callbackFailed = true;
              callbackError = error;
              throw error;
            }
          }
        : undefined;
    try {
      const progressCB = text => {
        if (typeof onProgress === 'function') return onProgress(text);
        try {
          updateDownloadResolutionProgress(statusLabel, text, '#469cf3');
        } catch (e) {}
      };
      result = await h.promise(resolve => resolve(resolverCB(resource, h.http, passwords, postId, postSettings, progressCB, onResolved)));
    } catch (e) {
      if (callbackFailed) throw callbackError;
      if (host.name !== 'Cyberdrop' || !/cyberdrop\.[a-z]{2,}\/a\//i.test(String(resource))) {
        log.post.error(postId, `::Error resolving::: ${resource}`, postNumber);
      }
      continue;
    }
    if (callbackFailed) throw callbackError;
    if (h.isNullOrUndef(result)) {
      log.post.error(postId, `::Could not resolve::: ${resource}`, postNumber);
      continue;
    }
    await appendDownloadResolution(result, resolved, host, resource, parsedPost, statusLabel, onResource, onProgress);
  }
};

const resolveDownloadResources = async ({ parsedPost, enabledHosts, resolvers, postSettings, statusLabel, onResource, onProgress }) => {
  const { postId, postNumber } = parsedPost;
  const resolved = [];
  let resolvingIndex = 0;

  log.post.info(postId, '::Url resolution started::', postNumber);

  const totalResourcesToResolve = enabledHosts.reduce((acc, host) => acc + host.resources.length, 0);

  for (const host of enabledHosts.filter(host => host.resources.length)) {
    const resources = host.resources;

    for (const resource of resources) {
      resolvingIndex++;
      updateDownloadResolutionProgress(
        statusLabel,
        `Resolving: ${resolvingIndex} / ${totalResourcesToResolve} 🢒 ${h.limit(resource, 80)}`,
        '#469cf3',
        onProgress,
      );

      await resolveHostDownloadResource(resource, host, resolved, {
        parsedPost,
        resolvers,
        postSettings,
        statusLabel,
        onResource,
        onProgress,
      });
    }
  }

  if (resolved.length) {
    log.separator(postId);
  }

  log.post.info(postId, '::Url resolution completed::', postNumber);

  const totalDownloadable = resolved.filter(r => r.url).length;
  const totalResources = enabledHosts.reduce((acc, h) => h.resources.length + acc, 0);

  updateDownloadResolutionProgress(
    statusLabel,
    `Resolved: ${resolved.length} / ${totalDownloadable} 🢒 ${totalResources} Total Links`,
    '#47ba24',
    onProgress,
  );

  return resolved;
};

// Keep the first case-insensitive basename in host-sorted order.
// Preserve array identity when nothing is removed; never mutate input objects.
const removeDuplicateDownloadResources = (resources, { postId, postNumber, statusLabel }) => {
  const unique = [];
  const seen = new Set();

  for (const r of resources.filter(r => r.url).sort((a, b) => (a.host.type !== 'folder' || b.host.type !== 'folder' ? -1 : 1))) {
    const filename = h.basename(r.url);
    if (seen.has(filename.toLowerCase())) {
      log.post.info(postId, `::Skipped duplicate::: ${filename} ::from:: ${r.url}`, postNumber);
      continue;
    }
    seen.add(filename.toLowerCase());
    unique.push(r);
  }

  if (unique.length !== resources.length) {
    h.ui.setText(statusLabel, `Removed ${resources.length - unique.length} duplicates...`);
    return unique;
  }

  return resources;
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { captureDownloadHints, resolveDownloadResources, removeDuplicateDownloadResources };
}
