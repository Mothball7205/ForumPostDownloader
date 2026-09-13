resolvers.push([
  [/filester\.(me|sh|si|gg)\/f\//],
  async (url, http, spoilers, postId, postSettings, progressCB) => {
    try {
      url = String(url || '').trim();
      if (!url) return null;

      if (url.startsWith('//')) url = 'https:' + url;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');

      const u0 = new URL(url);
      const origin = `${u0.protocol}//${u0.hostname}`;

      const mId = (u0.pathname || '').match(/\/f\/([^\/?#]+)/i);
      if (!mId || !mId[1]) return null;

      const albumId = mId[1];
      const baseUrl = `${origin}/f/${albumId}`;

      const resolved = [];
      const seen = new Set();

      let folderName = '';

      const MAX_PAGES = 500;

      const getFolderName = (dom, html) => {
        try {
          const pickClean = s => {
            s = String(s || '').trim();
            if (!s) return '';

            // Strip common suffixes.
            s = s.replace(/\s*\|\s*filester\.(me|sh|si|gg)\s*$/i, '').trim();
            s = s.replace(/\s*-\s*filester\.(me|sh|si|gg)\s*$/i, '').trim();

            // Replace remaining pipes with a Windows-safe separator.
            if (s.includes('|')) s = s.replace(/\s*\|\s*/g, ' - ').trim();

            // Final cleanup
            s = s.replace(/\s+/g, ' ').trim();

            return s;
          };

          const isBad = t => {
            const x = String(t || '').trim();
            if (!x) return true;
            if (/^filester\.(me|sh|si|gg)\b/i.test(x)) return true;
            if (/BETA\s*\d/i.test(x)) return true;
            return false;
          };

          let t = '';
          for (const sel of ['meta[property="og:title"]', 'meta[name="og:title"]']) {
            t = pickClean(dom?.querySelector(sel)?.getAttribute('content') || '');
            if (t) break;
          }
          if (!t) t = pickClean(dom?.querySelector('title')?.textContent || '');

          // HTML fallback (order-independent meta parsing)
          if (isBad(t)) {
            const s = String(html || '');
            if (s) {
              const mTag =
                /<meta\b[^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(s) ||
                /<meta\b[^>]*\bcontent=["'][^"']+["'][^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(s);
              if (mTag && mTag[0]) {
                const mC = /\bcontent=["']([^"']+)["']/i.exec(mTag[0]);
                if (mC && mC[1]) t = pickClean(mC[1]);
              }

              if (isBad(t)) {
                const mT = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(s);
                if (mT && mT[1]) t = pickClean(mT[1]);
              }
            }
          }

          if (isBad(t)) return albumId;
          return t;
        } catch (e) {}
        return albumId;
      };

      const addHint = (slug, name, sizeBytes) => {
        const dUrl = `${origin}/d/${slug}`;
        if (name) {
          filesterNameBySlug.set(String(slug), String(name));
          filesterNameByUrl.set(String(dUrl), String(name));
        }
        if (sizeBytes) {
          filesterSizeBySlug.set(String(slug), Number(sizeBytes));
          filesterSizeByUrl.set(String(dUrl), Number(sizeBytes));
        }
        filesterSlugByUrl.set(String(dUrl), String(slug));
      };

      const parsePage = (dom, html) => {
        const out = [];
        const items = dom ? [...dom.querySelectorAll('div.file-item')] : [];
        for (const el of items) {
          let slug = '';
          const oc = String(el.getAttribute('onclick') || '');
          const m = /\/d\/([^'"?\s]+)/i.exec(oc);
          if (m && m[1]) slug = m[1];

          if (!slug) {
            const btn = el.querySelector('button.download-btn');
            const oc2 = String(btn?.getAttribute?.('onclick') || '');
            const m2 = /downloadFile\(\s*'([^']+)'/i.exec(oc2);
            if (m2 && m2[1]) slug = m2[1];
          }

          if (!slug) {
            const a = el.querySelector('a[href*="/d/"]');
            const href = String(a?.getAttribute?.('href') || '');
            const m3 = /\/d\/([^\/?#]+)/i.exec(href);
            if (m3 && m3[1]) slug = m3[1];
          }

          if (!slug) continue;

          let name = '';
          let size = 0;

          name = String(el.getAttribute('data-name') || '').trim();
          if (!name) {
            name = String(el.querySelector('.file-name')?.textContent || '').trim();
          }

          size = Number(el.getAttribute('data-size') || 0) || 0;

          out.push({ slug, name, size });
        }

        // Regex fallback if DOM parsing is incomplete
        const s = String(html || '');
        if (s) {
          const rx = /data-name="([^"]+)"[^>]*\bonclick="window\.location\.href='\/d\/([^']+)'/gi;
          let m;
          while ((m = rx.exec(s)) !== null) {
            const name = String(m[1] || '').trim();
            const slug = String(m[2] || '').trim();
            if (!slug) continue;
            out.push({ slug, name, size: 0 });
          }
        }

        return out;
      };

      for (let page = 1; page <= MAX_PAGES; page++) {
        const u = new URL(baseUrl);
        u.searchParams.set('page', String(page));
        const pageUrl = u.toString();

        if (typeof progressCB === 'function') {
          progressCB(`[Filester] Resolving album page ${page}`);
        }

        let dom = null;
        let source = '';
        try {
          const r = await http.get(
            pageUrl,
            {},
            {
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              Referer: baseUrl,
              __xfpd_withCredentials: true,
            },
            'document',
            FILESTER_API_TIMEOUT_MS,
          );
          if (!(r?.status >= 200 && r.status < 300)) break;
          dom = r?.dom;
          source = r?.source || '';
        } catch (e) {
          break;
        }

        if (page === 1) {
          folderName = getFolderName(dom, source);
        }

        const before = seen.size;

        const entries = parsePage(dom, source);
        for (const it of entries) {
          const slug = String(it.slug || '').trim();
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);

          const name = String(it.name || '').trim();
          const size = Number(it.size || 0) || 0;
          addHint(slug, name, size);

          resolved.push(`${origin}/d/${slug}`);
        }

        const added = seen.size - before;
        if (added <= 0) break;
      }

      if (!resolved.length) return null;

      return { folderName, resolved };
    } catch (e) {
      return null;
    }
  },
]);

resolvers.push([
  [/filester\.(me|sh|si|gg)\/d\//],
  async (url, http, spoilers, postId, postSettings, progressCB) => {
    const file = filesterParseFileUrl(url);
    if (!file) return null;
    const stream = await filesterResolveV2(http, file.apiBase, file.slug, progressCB);
    if (!stream) return null;
    filesterNameByUrl.set(String(url), stream.name);
    filesterRefByUrl.set(String(url), stream.ref);
    filesterSlugByUrl.set(String(url), file.slug);
    return stream.url;
  },
]);
