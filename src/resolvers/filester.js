const filesterCleanAlbumTitle = value => {
  let title = String(value || '').trim();
  if (!title) return '';

  title = title.replace(/\s*\|\s*filester\.(me|sh|si|gg)\s*$/i, '').trim();
  title = title.replace(/\s*-\s*filester\.(me|sh|si|gg)\s*$/i, '').trim();

  // Replace remaining pipes with a Windows-safe separator.
  if (title.includes('|')) title = title.replace(/\s*\|\s*/g, ' - ').trim();
  return title.replace(/\s+/g, ' ').trim();
};

const filesterIsBadAlbumTitle = title => {
  const value = String(title || '').trim();
  return !value || /^filester\.(me|sh|si|gg)\b/i.test(value) || /BETA\s*\d/i.test(value);
};

const filesterAlbumTitleFromDom = dom => {
  for (const selector of ['meta[property="og:title"]', 'meta[name="og:title"]']) {
    const title = filesterCleanAlbumTitle(dom?.querySelector(selector)?.getAttribute('content') || '');
    if (title) return title;
  }
  return filesterCleanAlbumTitle(dom?.querySelector('title')?.textContent || '');
};

const filesterAlbumTitleFromHtml = (html, title) => {
  const source = String(html || '');
  if (!source) return title;

  // HTML fallback (order-independent meta parsing)
  const metaTag =
    /<meta\b[^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(source) ||
    /<meta\b[^>]*\bcontent=["'][^"']+["'][^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(source);
  if (metaTag && metaTag[0]) {
    const content = /\bcontent=["']([^"']+)["']/i.exec(metaTag[0]);
    if (content && content[1]) title = filesterCleanAlbumTitle(content[1]);
  }

  if (filesterIsBadAlbumTitle(title)) {
    const titleTag = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(source);
    if (titleTag && titleTag[1]) title = filesterCleanAlbumTitle(titleTag[1]);
  }
  return title;
};

const filesterAlbumFolderName = (dom, html, albumId) => {
  try {
    let title = filesterAlbumTitleFromDom(dom);
    if (filesterIsBadAlbumTitle(title)) title = filesterAlbumTitleFromHtml(html, title);
    return filesterIsBadAlbumTitle(title) ? albumId : title;
  } catch (e) {}
  return albumId;
};

const filesterAlbumItemSlug = el => {
  const onclick = String(el.getAttribute('onclick') || '');
  const direct = /\/d\/([^'"?\s]+)/i.exec(onclick);
  if (direct && direct[1]) return direct[1];

  const button = el.querySelector('button.download-btn');
  const buttonOnclick = String(button?.getAttribute?.('onclick') || '');
  const download = /downloadFile\(\s*'([^']+)'/i.exec(buttonOnclick);
  if (download && download[1]) return download[1];

  const anchor = el.querySelector('a[href*="/d/"]');
  const href = String(anchor?.getAttribute?.('href') || '');
  const link = /\/d\/([^\/?#]+)/i.exec(href);
  return link && link[1] ? link[1] : '';
};

const filesterAppendAlbumHtmlEntries = (html, entries) => {
  const source = String(html || '');
  if (!source) return;
  const pattern = /data-name="([^"]+)"[^>]*\bonclick="window\.location\.href='\/d\/([^']+)'/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = String(match[1] || '').trim();
    const slug = String(match[2] || '').trim();
    if (slug) entries.push({ slug, name, size: 0 });
  }
};

const filesterParseAlbumPage = (dom, html) => {
  const entries = [];
  const items = dom ? [...dom.querySelectorAll('div.file-item')] : [];
  for (const el of items) {
    const slug = filesterAlbumItemSlug(el);
    if (!slug) continue;

    let name = String(el.getAttribute('data-name') || '').trim();
    if (!name) name = String(el.querySelector('.file-name')?.textContent || '').trim();
    const size = Number(el.getAttribute('data-size') || 0) || 0;
    entries.push({ slug, name, size });
  }

  // Regex fallback if DOM parsing is incomplete; DOM entries retain precedence.
  filesterAppendAlbumHtmlEntries(html, entries);
  return entries;
};

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
          folderName = filesterAlbumFolderName(dom, source, albumId);
        }

        const before = seen.size;

        const entries = filesterParseAlbumPage(dom, source);
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
