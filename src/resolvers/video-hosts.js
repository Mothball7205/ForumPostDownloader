resolvers.push([
  [/([\w-]+\.)?turbo\.cr\/a\//],
  async (url, http) => {
    const { dom, source } = await http.get(url);

    // Album folder naming (stable + readable): turbo_<albumId> - <title>
    const mAlbum = url.match(/\/a\/([^\/?#]+)/i);
    const albumId = mAlbum ? mAlbum[1] : null;
    const base = albumId ? `turbo_${albumId}` : 'turbo_album';

    const rawTitle = dom?.querySelector('h1')?.textContent?.trim() || '';
    const invalidSub = settings.naming.invalidCharSubstitute || '_';

    let safeTitle = rawTitle
      .replace(/[\\/:*?"<>|]/g, invalidSub)
      .replace(/\s+/g, ' ')
      .trim();

    // Cap title to avoid extremely long Windows paths
    if (safeTitle.length > 120) safeTitle = safeTitle.slice(0, 120).trim();

    let folderName = base;
    if (safeTitle && safeTitle.toLowerCase() !== base.toLowerCase()) {
      folderName = `${safeTitle} - ${base}`;
    }

    // Final sanitize (defensive)
    folderName = folderName
      .replace(/[\\/:*?"<>|]/g, invalidSub)
      .replace(/\s+/g, ' ')
      .trim();

    // Hard cap for safety
    if (folderName.length > 180) folderName = folderName.slice(0, 180).trim();

    // Map videoId -> original filename (from album HTML)
    const idToName = new Map();

    // Collect video ids (and names) from the table rows (server-rendered HTML)
    let ids = Array.from(dom?.querySelectorAll('tr.file-row') || [])
      .map(row => {
        const a = row.querySelector('a[href^="/v/"]');
        const id = (a?.getAttribute('href') || '').match(/\/v\/([^\/?#]+)/i)?.[1];
        if (id) {
          const nm = row.getAttribute('data-name') || row.dataset?.name;
          if (nm) idToName.set(id, nm);
        }
        return id;
      })
      .filter(Boolean)
      .unique();

    // Fallback: regex scan (if DOM parsing fails)
    if (!ids.length && source) {
      ids = (source.match(/href="\/v\/([^"?#]+)"/gi) || [])
        .map(s => (s.match(/\/v\/([^"?#]+)/i) || [null, null])[1])
        .filter(Boolean)
        .unique();
    }

    const resolved = [];

    for (const id of ids) {
      const embedUrl = `https://turbo.cr/embed/${id}`;
      let signed = null;
      try {
        signed = await xfpdTurboSignUrlWithTimeout(id, embedUrl, idToName.get(id));
      } catch (e) {}

      // Fallback: if signing fails, try to read media URL from the embed page
      if (!signed) {
        try {
          const { dom: edom } = await http.get(embedUrl, {}, { Referer: embedUrl });
          const src = edom?.querySelector('source[src]')?.getAttribute('src') || edom?.querySelector('video[src]')?.getAttribute('src');
          if (src) {
            signed = new URL(src, embedUrl).toString();
          }
        } catch (e) {}
      }

      // If we got a Turbo CDN URL and have an original name, attach fn=
      if (signed && /turbocdn\.st/i.test(signed)) {
        const originalName = idToName.get(id);
        if (originalName && !/[?&]fn=/.test(signed)) {
          const enc = encodeURIComponent(String(originalName)).replace(/%20/g, '+');
          signed += (signed.includes('?') ? '&' : '?') + 'fn=' + enc;
        }
      }

      // If sign fails, keep a workable fallback
      if (signed && id) {
        try {
          turboIdBySignedUrl.set(String(signed), String(id));
        } catch (e) {}
      }
      resolved.push(signed || `https://turbo.cr/d/${id}`);
    }

    return {
      dom,
      source,
      folderName,
      resolved,
    };
  },
]);

resolvers.push([
  [/([\w-]+\.)?turbo\.cr\/(v|d)\//],
  async (url, http) => {
    const mm = url.match(/\/(v|d)\/([^\/?#]+)/i);
    let id = mm ? mm[2] : null;
    if (!id) {
      return url;
    }

    const embedUrl = `https://turbo.cr/embed/${id}`;
    try {
      const signed = await xfpdTurboSignUrlWithTimeout(id, embedUrl, null);
      if (signed) return signed;
    } catch (e) {}

    // Fallback: try to read <source>/<video> directly from the embed page
    try {
      const { dom } = await http.get(embedUrl, {}, { Referer: embedUrl });
      const src = dom?.querySelector('source[src]')?.getAttribute('src') || dom?.querySelector('video[src]')?.getAttribute('src');
      if (src) {
        return new URL(src, embedUrl).toString();
      }
    } catch (e) {}

    // Last fallback: the site's direct download route
    return `https://turbo.cr/d/${id}`;
  },
]);

resolvers.push([[/public.onlyfans.com\/files/], async url => url]);

resolvers.push([
  [/([\w-]+\.)?turbo\.cr\/embed/],
  async (url, http) => {
    const m = url.match(/\/embed\/([^\/?#]+)/i);
    const id = m ? m[1] : null;
    if (!id) {
      return null;
    }

    const embedUrl = `https://turbo.cr/embed/${id}`;
    try {
      const signed = await xfpdTurboSignUrlWithTimeout(id, embedUrl, null);
      if (signed) return signed;
    } catch (e) {}

    // Fallback: try to read <source> / <video> directly if present
    try {
      const { dom } = await http.get(embedUrl, {}, { Referer: embedUrl });
      const src = dom?.querySelector('source[src]')?.getAttribute('src') || dom?.querySelector('video[src]')?.getAttribute('src');
      if (src) {
        return new URL(src, embedUrl).toString();
      }
    } catch (e) {}

    return null;
  },
]);
