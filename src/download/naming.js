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
      const strip = u =>
        String(u || '')
          .split('#')[0]
          .split('?')[0];
      return (
        bunkrNameByUrl.get(String(url)) ||
        bunkrNameByUrl.get(strip(url)) ||
        bunkrNameByUrl.get(String(original || '')) ||
        bunkrNameByUrl.get(strip(original || '')) ||
        ''
      );
    } catch (e) {
      return '';
    }
  };

  const planDirect = ({ resource, url, meta = {} }) => {
    const isGoFile = isGoFileUrl(url);
    const isPixeldrain = isPixeldrainUrl(url);
    const isTurbo = isTurboUrl(url);
    const isBunkr =
      String((resource && resource.host && resource.host.name) || '').toLowerCase() === 'bunkr' ||
      /bunkr/i.test(String(url || '')) ||
      /bunkr/i.test(String((resource && resource.original) || ''));
    const isFilester = String((resource && resource.host && resource.host.name) || '').toLowerCase() === 'filester' || isFilesterUrl(url);

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
        const hinted = bunkrHint(url, resource && resource.original);
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

          basename = sanitizeWinSegment(String(basename || ''), naming);
          if (!basename) basename = sanitizeWinSegment(String(h.basename(strip(url)) || ''), naming);
        }
      } catch (e) {}
    }

    // Filester: prefer the real filename (from view page / API hints); fallback to a safe slug-based name.
    if (isFilester) {
      try {
        let slug0 = '';
        const m = /https?:\/\/(?:www\.)?filester\.(me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(String((resource && resource.original) || ''));
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
      const ext2 = h.ext(basename);
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

    return planDownloadSavePath(
      {
        basename,
        folderName: (resource && resource.folderName) || '',
        flatten: postSettings.flatten,
        threadTitle,
        postNumber,
        isFirefox,
        zippedForThis: false,
        naming,
      },
      { usedPaths, usedFlatNames },
      { ext: h.ext, fnNoExt: h.fnNoExt },
    );
  };

  const planBlob = ({ resource, url, responseHeaders = '', zippedForThis = false }) => {
    const isGoFile = isGoFileUrl(url);
    const isBunkr =
      String((resource && resource.host && resource.host.name) || '').toLowerCase() === 'bunkr' ||
      /bunkr/i.test(String(url || '')) ||
      /bunkr/i.test(String((resource && resource.original) || ''));

    let filename = filenames.find(f => f.url === url);
    if (!filename && isGoFile) {
      // GoFile URLs may be re-resolved to a file-*.gofile.io host, so match by GoFile fileId.
      const mGf = String(url).match(/\/download\/(?:web|direct)\/([^\/?#]+)\//i);
      const gid = mGf && mGf[1] ? mGf[1] : null;
      if (gid) {
        filename = filenames.find(f => f && f.gofileId === gid);

        // Resolver hints survive CDN host changes.
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
        const mCd = String(url).match(/\/api\/file\/d\/([^\/\?#]+)\b/i) || String(url).match(/cyberdrop\.[^\/]+\/(?:f|e)\/([^\/\?#]+)/i);
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
      const rh = responseHeaders ? String(responseHeaders) : '';
      basename = parseDispositionFilename(rh) || (filename ? filename.name : h.basename(url).replace(/\?.*/, '').replace(/#.*/, ''));
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
      const rh = responseHeaders ? String(responseHeaders) : '';
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
      // Turbo's fn= carries the original filename; the CDN path contains only an ID.
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
        const hinted = bunkrHint(url, resource && resource.original);
        if (hinted && String(hinted).trim() && !xfpdLooksLikeCfFilenameHint(hinted)) {
          basename = String(hinted).trim();

          // If hinted has no extension, derive it from URL first, then content-type.
          const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(basename);
          if (!hasExt) {
            const urlExt = h.ext(h.basename(strip(url))) || '';
            const ct0 = headerValue(responseHeaders || '', 'content-type');
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

          basename = sanitizeWinSegment(String(basename || ''), naming);
          if (!basename) basename = sanitizeWinSegment(String(h.basename(strip(url)) || ''), naming);
        }
      } catch (e) {}
    }

    // Filester: prefer the real filename (from view page / API hints). Only fall back to a safe slug-based name when needed.
    if (isFilesterUrl(url)) {
      try {
        let slug0 = '';
        const m = /https?:\/\/(?:www\.)?filester\.(me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(String((resource && resource.original) || ''));
        if (m && m[1]) slug0 = m[1];
        if (!slug0) slug0 = String(filesterSlugByUrl.get(String(url)) || '');
        const ct0 = headerValue(responseHeaders || '', 'content-type');
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

        basename = sanitizeWinSegment(String(basename || ''), naming);
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

    return planDownloadSavePath(
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
  };

  const plan = input => (input.mode === 'direct' ? planDirect(input) : planBlob(input));

  return { capture, plan };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createDownloadNamePlanner };
}
