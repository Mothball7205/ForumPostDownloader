const xfpdBunkrStripUrl = value =>
  String(value || '')
    .split('#')[0]
    .split('?')[0];

const xfpdBunkrBuildMediaUrl = data => {
  if (!data || typeof data.mediafiles !== 'string' || typeof data.path !== 'string') return null;
  try {
    const url = new URL(data.mediafiles + data.path);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (data.original) url.searchParams.set('n', data.original);
    return url.toString();
  } catch (e) {
    return null;
  }
};

const xfpdBunkrFetchMetadata = async (http, id) => {
  const response = await http.post(
    'https://dl.bunkr.cr/api/_001_v2',
    JSON.stringify({ id }),
    {},
    {
      'Content-Type': 'application/json',
      Referer: `https://dl.bunkr.cr/file/${id}`,
      Origin: 'https://dl.bunkr.cr',
    },
    'text',
    BUNKR_RESOLVE_TIMEOUT_MS,
  );
  return JSON.parse(response.source);
};

resolvers.push([
  [
    /((stream|cdn(\d+)?)\.)?bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org).*?\.|((i|cdn)(\d+)?\.)?bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org)\/(v\/)?/i,
    /:!bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org)\/a\//,
  ],
  async (url, http) => {
    try {
      const cleanUrl = String(url || '').split('#')[0];
      const isLegacyCdn = /^https?:\/\/(?:cdn\d*|stream)\.bunkrr?r?\./i.test(cleanUrl);

      // Legacy CDN URLs redirect to view pages and still need metadata/signing.
      if (
        !isLegacyCdn &&
        /\.(?:mp4|m4v|webm|mov|mkv|jpg|jpeg|png|gif|webp|zip|rar|7z|pdf)(?:$|\?)/i.test(cleanUrl) &&
        !/\/(?:v|f|d)\//i.test(cleanUrl)
      ) {
        return cleanUrl;
      }

      const u = new URL(cleanUrl);
      const origin = u.origin;
      const pathname = u.pathname || '';

      const segments = pathname.split('/').filter(Boolean);
      const index = segments.findIndex(s => ['f', 'v', 'd'].includes(s));
      const id = index > -1 ? segments.slice(index + 1).join('/') : segments.pop();
      let bunkrDataId = null;

      // Recover the original filename before resolution replaces it with a CDN GUID.
      try {
        const bases = xfpdBunkrFilterBases(
          isLegacyCdn ? ['https://bunkr.cr', 'https://bunkr.pk'] : [origin, 'https://bunkr.pk', 'https://bunkr.cr'],
        );

        for (const base of bases) {
          const base0 = String(base || '').replace(/\/$/, '');
          const candidates = [];
          if (/\/v\//i.test(pathname) && base0 === origin) candidates.push(cleanUrl);
          candidates.push(`${base0}/v/${id}`);
          candidates.push(`${base0}/f/${id}`);

          const uniq = candidates.filter((v, i, a) => a.indexOf(v) === i);
          let found = false;

          for (const viewUrl of uniq) {
            const viewRes = await xfpdBunkrGetWithCfRetry(http, viewUrl, base0, base0 === 'https://bunkr.cr');
            const dom = viewRes?.dom;
            const viewSource = viewRes?.source || '';

            // A Cloudflare page title is not a filename.
            if (xfpdLooksLikeCfChallenge(viewSource, dom)) continue;

            if (!bunkrDataId) {
              bunkrDataId = dom?.querySelector?.('[data-file-id]')?.getAttribute?.('data-file-id') || null;
            }

            let title =
              dom?.querySelector?.('meta[property="og:title"]')?.getAttribute?.('content') ||
              dom?.querySelector?.('h1')?.textContent ||
              dom?.querySelector?.('title')?.textContent ||
              '';
            title = String(title || '')
              .replace(/\s+/g, ' ')
              .trim();
            title = title.replace(/\s*\|\s*Bunkr\s*$/i, '').trim();

            if (title && !xfpdLooksLikeCfFilenameHint(title)) {
              bunkrNameByUrl.set(cleanUrl, title);
              bunkrNameByUrl.set(xfpdBunkrStripUrl(cleanUrl), title);
              bunkrNameByUrl.set(viewUrl, title);
              bunkrNameByUrl.set(xfpdBunkrStripUrl(viewUrl), title);
              found = true;
              break;
            }
          }

          if (found) break;
        }
      } catch (e) {}

      const tryNewApi = async () => {
        if (!bunkrDataId) return null;
        try {
          const data = await xfpdBunkrFetchMetadata(http, bunkrDataId);

          let finalUrl = xfpdBunkrBuildMediaUrl(data);
          if (!finalUrl) return null;

          finalUrl = await xfpdBunkrSignCdnUrl(http, finalUrl);

          try {
            const hint =
              xfpdBunkrExtractNameFromVsData(data) || bunkrNameByUrl.get(cleanUrl) || bunkrNameByUrl.get(xfpdBunkrStripUrl(cleanUrl)) || '';
            if (hint && String(hint).trim()) {
              const h0 = String(hint).trim();
              bunkrNameByUrl.set(cleanUrl, h0);
              bunkrNameByUrl.set(xfpdBunkrStripUrl(cleanUrl), h0);
              bunkrNameByUrl.set(finalUrl, h0);
              bunkrNameByUrl.set(xfpdBunkrStripUrl(finalUrl), h0);
            }
          } catch (e) {}

          return finalUrl;
        } catch (e) {
          return null;
        }
      };

      const finalURL = await tryNewApi();
      return finalURL;
    } catch (error) {
      console.error(error?.message || error);
      return null;
    }
  },
]);

resolvers.push([
  [/bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org)\/a\//],
  async (url, http, _, __, ___, progressCB) => {
    const cleanUrl = String(url || '').split('#')[0];
    const baseUrl = cleanUrl.split('?')[0].replace(/\/+$/, '');

    const resolved = [];
    const seen = new Set();

    // Album-grid names survive resolution to CDN GUID URLs.
    const nameHintBySlug = new Map();

    let firstDom = null;
    let firstSource = null;

    const getAlbumFolderName = dom => {
      const h1 = dom?.querySelector?.('h1');
      const title = (h1?.innerText || h1?.textContent || '').split('\n')[0]?.trim();
      if (!title) return null;
      return String(title)
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const extractSlugsFromDom = dom => {
      const containers = dom?.querySelectorAll?.('.grid-images > div') || [];
      const slugs = [];

      for (const c of containers) {
        const a =
          c.querySelector('a[class="after:absolute after:z-10 after:inset-0"]') ||
          c.querySelector('a[href*="/f/"]') ||
          c.querySelector('a[href*="/v/"]') ||
          c.querySelector('a[href*="/d/"]');

        const href = a?.getAttribute?.('href') || '';
        const m = href.match(/\/(f|v|d)\/([^\/?#]+)/i);
        if (m && m[2]) {
          const slug = m[2];
          slugs.push(slug);

          try {
            let hint = c?.getAttribute?.('title') || '';
            if (!hint) hint = c?.querySelector?.('.theName')?.textContent || '';
            if (!hint) hint = c?.querySelector?.('p.truncate')?.textContent || '';
            if (!hint) hint = c?.querySelector?.('.grid-images_box-txt p')?.textContent || '';
            hint = String(hint || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (hint) nameHintBySlug.set(slug, hint);
          } catch (e) {}
        }
      }

      return slugs;
    };

    const asyncPool = async (limit, items, worker) => {
      const results = new Array(items.length);
      let i = 0;

      const runners = Array.from({ length: Math.max(1, limit) }, async () => {
        while (true) {
          const idx = i++;
          if (idx >= items.length) break;
          try {
            results[idx] = await worker(items[idx], idx);
          } catch (e) {
            results[idx] = null;
          }
        }
      });

      await Promise.all(runners);
      return results;
    };

    const origin = (() => {
      try {
        return new URL(baseUrl).origin;
      } catch (e) {
        return 'https://bunkr.cr';
      }
    })();

    let folderName = null;

    const MAX_PAGES = 500;
    const CONCURRENCY = 8;

    const albumUrlObj = (() => {
      try {
        return new URL(baseUrl);
      } catch (e) {
        return null;
      }
    })();
    const albumPath =
      albumUrlObj && albumUrlObj.pathname
        ? albumUrlObj.pathname
        : (() => {
            try {
              return new URL(cleanUrl).pathname;
            } catch (e) {
              return '/';
            }
          })();
    const albumBasesAll = [origin, 'https://bunkr.pk', 'https://bunkr.cr'].filter((v, i, a) => a.indexOf(v) === i);
    let albumBaseChosen = null;

    const fetchAlbumPage = async page => {
      const pageBases = albumBaseChosen
        ? [albumBaseChosen, ...xfpdBunkrFilterBases(albumBasesAll).filter(b => b !== albumBaseChosen)]
        : xfpdBunkrFilterBases(albumBasesAll);
      let dom = null,
        source = '';
      let slugs = [];

      for (const base of pageBases) {
        const base0 = String(base || '').replace(/\/$/, '');
        const candidate = `${base0}${albumPath}?page=${page}`;
        try {
          ({ dom, source } = await xfpdBunkrGetWithCfRetry(http, candidate, base0, base0 === 'https://bunkr.cr'));
        } catch (e) {
          dom = null;
          source = '';
        }

        if (xfpdLooksLikeCfChallenge(source, dom)) continue;
        slugs = extractSlugsFromDom(dom);
        if (page === 1 && !slugs.length) continue;
        if (!albumBaseChosen) albumBaseChosen = base0;
        break;
      }

      return { dom, source, slugs };
    };

    const collectFreshSlugs = slugs => {
      const fresh = [];
      for (const slug of slugs) {
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        fresh.push(slug);
      }
      return fresh;
    };

    const resolveAlbumSlug = async slug => {
      // The API requires the numeric file ID from /f/{slug}.
      const fileBase = String(albumBaseChosen || origin || 'https://bunkr.cr').replace(/\/$/, '');
      const filePageUrl = `${fileBase}/f/${slug}`;
      let dataId = null;
      try {
        const fileRes = await xfpdBunkrGetWithCfRetry(http, filePageUrl, fileBase, fileBase === 'https://bunkr.cr');
        const fileDom = fileRes?.dom;
        if (fileDom && !xfpdLooksLikeCfChallenge(fileRes?.source || '', fileDom)) {
          dataId = fileDom?.querySelector?.('[data-file-id]')?.getAttribute?.('data-file-id') || null;
        }
      } catch (e) {}
      if (!dataId) return null;

      let data = null;
      try {
        data = await xfpdBunkrFetchMetadata(http, dataId);
      } catch (e) {}
      if (!data) return null;

      let finalUrl = xfpdBunkrBuildMediaUrl(data);
      if (!finalUrl) return null;

      finalUrl = await xfpdBunkrSignCdnUrl(http, finalUrl);

      try {
        const hint = nameHintBySlug.get(slug) || xfpdBunkrExtractNameFromVsData(data) || '';
        if (hint && String(hint).trim()) {
          const h0 = String(hint).trim();
          bunkrNameByUrl.set(finalUrl, h0);
          bunkrNameByUrl.set(xfpdBunkrStripUrl(finalUrl), h0);
        }
      } catch (e) {}

      return finalUrl;
    };

    for (let page = 1; page <= MAX_PAGES; page++) {
      const requestedPageUrl = `${baseUrl}?page=${page}`;

      if (typeof progressCB === 'function') {
        progressCB(`Resolving: ${requestedPageUrl}`);
      }

      const { dom, source, slugs } = await fetchAlbumPage(page);

      if (!dom) break;
      if (!slugs.length) break;
      if (page === 1) {
        firstDom = dom;
        firstSource = source;

        folderName = getAlbumFolderName(dom);
      }

      const fresh = collectFreshSlugs(slugs);

      if (!fresh.length) break;

      let completed = 0;
      if (typeof progressCB === 'function') progressCB(`Resolving Bunkr page ${page}: 0 / ${fresh.length} files`);
      const urls = await asyncPool(CONCURRENCY, fresh, async slug => {
        try {
          return await resolveAlbumSlug(slug);
        } finally {
          completed++;
          if (typeof progressCB === 'function') progressCB(`Resolving Bunkr page ${page}: ${completed} / ${fresh.length} files`);
        }
      });

      for (const u of urls) if (u) resolved.push(u);
    }

    if (!folderName) folderName = h.basename(baseUrl);

    return {
      dom: firstDom,
      source: firstSource,
      folderName,
      resolved,
    };
  },
]);
