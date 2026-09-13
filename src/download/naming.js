// Direct and blob downloads share per-run filename hints and uniqueness sets.
const createDownloadNamePlanner = ({ postSettings, threadTitle, postNumber, isFirefox }) => {
  const filenames = [];
  const mimeTypes = [];

  const usedPaths = new Set();
  const usedFlatNames = new Set();

  const naming = (postSettings && postSettings.naming) || settings?.naming;

  // Called on blob request readyState 2: remember attachment filename + content-type.
  const capture = (url, responseHeaders) => {
    let matches = h.re.matchAll(/(?<=attachment;filename=").*?(?=")/gis, responseHeaders);
    if (matches.length && !filenames.find(f => f.url === url)) {
      filenames.push({ url, name: matches[0] });
    }
    matches = h.re.matchAll(/(?<=content-type:\s).*$/gi, responseHeaders);
    if (matches.length && !mimeTypes.find(m => m.url === url)) {
      mimeTypes.push({ url, type: matches[0] });
    }
  };

  const bunkrHint = (url, original) => {
    try {
      return (
        bunkrNameByUrl.get(String(url)) ||
        bunkrNameByUrl.get(stripUrlQueryAndFragment(url)) ||
        bunkrNameByUrl.get(String(original || '')) ||
        bunkrNameByUrl.get(stripUrlQueryAndFragment(original || '')) ||
        ''
      );
    } catch (e) {
      return '';
    }
  };

  const resourceHostName = resource => String((resource && resource.host && resource.host.name) || '').toLowerCase();
  const isBunkrResource = (resource, url) =>
    resourceHostName(resource) === 'bunkr' ||
    /bunkr/i.test(String(url || '')) ||
    /bunkr/i.test(String((resource && resource.original) || ''));

  const gofileIdForName = url => {
    const match = String(url).match(/\/download\/(?:web|direct)\/([^\/?#]+)\//i);
    return match && match[1] ? match[1] : null;
  };

  const findCapturedFilename = (url, isGoFile) => {
    const captured = filenames.find(f => f.url === url);
    if (captured || !isGoFile) return captured;

    // Resolver hints and captured file IDs survive GoFile CDN host changes.
    const gid = gofileIdForName(url);
    if (!gid) return undefined;
    const previous = filenames.find(f => f && f.gofileId === gid);
    if (previous) return previous;
    const hinted = gofileNameById.get(String(gid)) || gofileNameByUrl.get(String(url));
    return hinted ? { url, name: String(hinted), gofileId: String(gid) } : undefined;
  };

  const findBlobFilename = (url, isGoFile) => {
    const filename = findCapturedFilename(url, isGoFile);
    if (filename) return filename;
    const filesterHint = filesterNameByUrl.get(String(url));
    if (filesterHint) return { url, name: String(filesterHint) };
    const cyberdropHint = cyberdropNameByUrl.get(String(url));
    if (cyberdropHint) return { url, name: String(cyberdropHint) };

    const match = String(url).match(/\/api\/file\/d\/([^\/\?#]+)\b/i) || String(url).match(/cyberdrop\.[^\/]+\/(?:f|e)\/([^\/\?#]+)/i);
    const slug = match && match[1] ? match[1] : null;
    if (!slug) return undefined;
    const hinted = cyberdropNameBySlug.get(String(slug));
    return hinted ? { url, name: String(hinted), cyberdropSlug: String(slug) } : undefined;
  };

  const metadataFilename = meta => String(meta.filename || '') || parseDispositionFilename(meta.headers || '') || '';
  const capturedFilename = filename => (filename && filename.name ? String(filename.name) : '');

  const directBasename = (url, meta, filename, isPixeldrain, isGoFile, isTurbo) => {
    let basename = '';
    if (isPixeldrain) basename = metadataFilename(meta);
    else if (isGoFile) basename = capturedFilename(filename) || metadataFilename(meta);
    if (!basename && isTurbo) basename = turboExtractFn(url) || '';
    return basename || capturedFilename(filename) || h.basename(url);
  };

  const namingContentType = (meta, responseHeaders) =>
    meta === undefined
      ? headerValue(responseHeaders || '', 'content-type')
      : String((meta && (meta.contentType || meta.content_type)) || '');

  const bunkrHintExtension = (url, meta, responseHeaders) => {
    const urlExt = h.ext(h.basename(stripUrlQueryAndFragment(url))) || '';
    const contentType = namingContentType(meta, responseHeaders);
    if (urlExt) return String(urlExt);
    const extension = downloadExtensionFromContentType(contentType, { pdf: 'pdf', octetStream: 'rar' });
    // Bunkr historically gives octet-stream precedence over PDF in mixed header values.
    return extension === 'pdf' && /application\/octet-stream/i.test(contentType) ? 'rar' : extension;
  };

  const bunkrBasename = (basename, url, resource, meta, responseHeaders) => {
    try {
      const hinted = bunkrHint(url, resource && resource.original);
      if (!hinted || !String(hinted).trim() || xfpdLooksLikeCfFilenameHint(hinted)) return basename;
      basename = String(hinted).trim();
      if (!/\.[A-Za-z0-9]{1,8}$/.test(basename)) {
        const extension = bunkrHintExtension(url, meta, responseHeaders);
        if (extension) basename = `${basename}.${extension}`;
      }
      basename = sanitizeWinSegment(String(basename || ''), naming);
      if (!basename) basename = sanitizeWinSegment(String(h.basename(stripUrlQueryAndFragment(url)) || ''), naming);
    } catch (e) {}
    return basename;
  };

  const filesterNamingSlug = (url, resource) => {
    const match = /https?:\/\/(?:www\.)?filester\.(me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(String((resource && resource.original) || ''));
    return match && match[1] ? match[1] : String(filesterSlugByUrl.get(String(url)) || '');
  };

  const filesterFilenameHint = (url, slug, meta, filename) => {
    const primary =
      meta === undefined ? String((filename && filename.name) || '') : String((meta && (meta.filename || meta.fileName)) || '');
    return primary || String(filesterNameByUrl.get(String(url)) || '') || (slug ? String(filesterNameBySlug.get(String(slug)) || '') : '');
  };

  const filesterBasename = (basename, url, resource, meta, responseHeaders, filename) => {
    try {
      const slug = filesterNamingSlug(url, resource);
      const contentType = namingContentType(meta, responseHeaders);
      const extension = downloadExtensionFromContentType(contentType, { fallback: 'bin', pdf: 'bin', octetStream: 'bin' });
      const hinted = filesterFilenameHint(url, slug, meta, filename);
      if (hinted && hinted.trim()) {
        basename = hinted.trim();
        if (!/\.[A-Za-z0-9]{1,8}$/.test(String(basename || '')) && extension) basename = `${basename}.${extension}`;
      } else if (slug) {
        basename = `Filester_${slug}.${extension}`;
      }
      if (meta === undefined) basename = sanitizeWinSegment(String(basename || ''), naming);
    } catch (e) {}
    return basename;
  };

  const reserveDirectBasename = (basename, url, filename, isGoFile) => {
    const original = basename;
    const same = filenames.filter(f => f && (f.original === basename || f.name === basename));
    if (same.length) {
      const extension = h.ext(basename);
      basename = extension ? `${h.fnNoExt(basename)} (${same.length + 1}).${extension}` : `${basename} (${same.length + 1})`;
    }
    if (!filename) {
      const extra = {};
      if (isGoFile) {
        const gid = gofileIdForName(url);
        if (gid) extra.gofileId = String(gid);
      }
      filenames.push({ url, name: basename, original, ...extra });
    }
    return basename;
  };

  const savePath = (basename, resource, zippedForThis) =>
    planDownloadSavePath(
      {
        basename,
        folderName: (resource && resource.folderName) || '',
        flatten: postSettings.flatten,
        threadTitle,
        postNumber,
        isFirefox,
        zippedForThis,
        naming,
      },
      { usedPaths, usedFlatNames },
      { ext: h.ext, fnNoExt: h.fnNoExt },
    );

  const planDirect = ({ resource, url, meta = {} }) => {
    const isGoFile = isGoFileUrl(url);
    const isPixeldrain = isPixeldrainUrl(url);
    const isTurbo = isTurboUrl(url);
    const isBunkr = isBunkrResource(resource, url);
    const isFilester = resourceHostName(resource) === 'filester' || isFilesterUrl(url);
    const filename = findCapturedFilename(url, isGoFile);
    let basename = directBasename(url, meta, filename, isPixeldrain, isGoFile, isTurbo);
    // Human resolver hints override transport filenames for these hosts.
    if (isBunkr) basename = bunkrBasename(basename, url, resource, meta);
    if (isFilester) basename = filesterBasename(basename, url, resource, meta);
    basename = reserveDirectBasename(basename, url, filename, isGoFile);
    return savePath(basename, resource, false);
  };

  const defaultBlobBasename = (url, filename) => (filename ? filename.name : h.basename(url).replace(/\?.*/, '').replace(/#.*/, ''));

  const cyberdropBlobBasename = (url, filename, responseHeaders) => {
    const headers = responseHeaders ? String(responseHeaders) : '';
    let basename = parseDispositionFilename(headers) || defaultBlobBasename(url, filename);
    try {
      basename = decodeURI(basename);
    } catch (e) {}
    const extMatch = basename.match(/\.\w{3,6}$/);
    const extension = extMatch ? extMatch[0] : '';
    if (extension) basename = basename.replace(extension, '').replace(/(\.\w{3,6}-\w{8}$)|(-\w{8}$)/, '') + extension;
    return basename;
  };

  const turboBlobBasename = url => {
    if (!url.includes('turbocdn.st')) return undefined;
    const match = url.match(/[?&]fn=([^&]+)/i);
    if (!match || !match[1]) return undefined;
    try {
      return decodeURIComponent(match[1].replace(/\+/g, '%20'));
    } catch (e) {
      return match[1];
    }
  };

  const blobBasename = (url, filename, responseHeaders) => {
    if (/(?:pixeldrain\.(?:com|net)|pixeldra\.in)/i.test(String(url || ''))) {
      const headers = responseHeaders ? String(responseHeaders) : '';
      return parseDispositionFilename(headers) || defaultBlobBasename(url, filename);
    }
    if (url.includes('https://simpcity.su/attachments/')) {
      return filename ? filename.name : h.basename(url).replace(/(.*)-(.{3,4})\.\d*$/i, '$1.$2');
    }
    if (url.includes('kemono.cr')) {
      return filename
        ? filename.name
        : h
            .basename(url)
            .replace(/(.*)\?f=(.*)/, '$2')
            .replace('%20', ' ');
    }
    if (url.includes('cyberdrop')) return cyberdropBlobBasename(url, filename, responseHeaders);
    // Turbo's fn= carries the original filename; the CDN path contains only an ID.
    return turboBlobBasename(url) || defaultBlobBasename(url, filename);
  };

  const blobNameExtension = (basename, url) => {
    const extension = h.ext(basename);
    const mimeType = mimeTypes.find(m => m.url === url);
    if (extension || !mimeType) return extension;
    switch (mimeType.type) {
      case 'image/jpeg':
      case 'image/jpg':
        return 'jpg';
      case 'image/png':
        return 'png';
      default:
        return 'unknown';
    }
  };

  const reserveBlobBasename = (basename, url, filename) => {
    const extension = blobNameExtension(basename, url);
    const original = basename;
    if (filenames.find(f => f.original === basename)) {
      const count = filenames.filter(f => f.original === basename).length;
      const baseNoExt = extension && h.fnNoExt(basename) ? h.fnNoExt(basename) : basename;
      basename = extension ? `${baseNoExt} (${count + 1}).${extension}` : `${baseNoExt} (${count + 1})`;
    }
    if (!filename) filenames.push({ url, name: basename, original });
    return basename;
  };

  const planBlob = ({ resource, url, responseHeaders = '', zippedForThis = false }) => {
    const isGoFile = isGoFileUrl(url);
    const isBunkr = isBunkrResource(resource, url);
    const filename = findBlobFilename(url, isGoFile);
    let basename = blobBasename(url, filename, responseHeaders);
    if (isBunkr) basename = bunkrBasename(basename, url, resource, undefined, responseHeaders);
    if (isFilesterUrl(url)) basename = filesterBasename(basename, url, resource, undefined, responseHeaders, filename);
    basename = reserveBlobBasename(basename, url, filename);
    return savePath(basename, resource, zippedForThis);
  };

  const plan = input => (input.mode === 'direct' ? planDirect(input) : planBlob(input));

  return { capture, plan };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createDownloadNamePlanner };
}
