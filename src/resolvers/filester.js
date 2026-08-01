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
      if (!mId || !mId[1]) return url;

      const albumId = mId[1];
      const baseUrl = `${origin}/f/${albumId}`;

      const resolved = [];
      const seen = new Set();

      let firstDom = null;
      let firstSource = '';
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

          // DOM: og:title first
          try {
            t = pickClean(dom?.querySelector('meta[property="og:title"]')?.getAttribute('content') || '');
          } catch (e) {}
          try {
            if (!t) t = pickClean(dom?.querySelector('meta[name="og:title"]')?.getAttribute('content') || '');
          } catch (e) {}
          try {
            if (!t) t = pickClean(dom?.querySelector('title')?.textContent || '');
          } catch (e) {}

          // HTML fallback (order-independent meta parsing)
          if (isBad(t)) {
            const s = String(html || '');
            if (s) {
              try {
                const mTag =
                  /<meta\b[^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(s) ||
                  /<meta\b[^>]*\bcontent=["'][^"']+["'][^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(s);
                if (mTag && mTag[0]) {
                  const mC = /\bcontent=["']([^"']+)["']/i.exec(mTag[0]);
                  if (mC && mC[1]) t = pickClean(mC[1]);
                }
              } catch (e) {}

              try {
                if (isBad(t)) {
                  const mT = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(s);
                  if (mT && mT[1]) t = pickClean(mT[1]);
                }
              } catch (e) {}
            }
          }

          if (isBad(t)) return albumId;
          return t;
        } catch (e) {}
        return albumId;
      };

      const addHint = (slug, name, sizeBytes) => {
        try {
          const dUrl = `${origin}/d/${slug}`;
          if (name) {
            try {
              filesterNameBySlug.set(String(slug), String(name));
            } catch (e) {}
            try {
              filesterNameByUrl.set(String(dUrl), String(name));
            } catch (e) {}
          }
          if (sizeBytes) {
            try {
              filesterSizeBySlug.set(String(slug), Number(sizeBytes));
            } catch (e) {}
            try {
              filesterSizeByUrl.set(String(dUrl), Number(sizeBytes));
            } catch (e) {}
          }
          try {
            filesterSlugByUrl.set(String(dUrl), String(slug));
          } catch (e) {}
        } catch (e) {}
      };

      const parsePage = (dom, html) => {
        const out = [];
        try {
          const items = dom ? [...dom.querySelectorAll('div.file-item')] : [];
          for (const el of items) {
            let slug = '';
            try {
              const oc = String(el.getAttribute('onclick') || '');
              const m = /\/d\/([^'"?\s]+)/i.exec(oc);
              if (m && m[1]) slug = m[1];
            } catch (e) {}

            if (!slug) {
              try {
                const btn = el.querySelector('button.download-btn');
                const oc2 = String(btn?.getAttribute?.('onclick') || '');
                const m2 = /downloadFile\(\s*'([^']+)'/i.exec(oc2);
                if (m2 && m2[1]) slug = m2[1];
              } catch (e) {}
            }

            if (!slug) {
              try {
                const a = el.querySelector('a[href*="/d/"]');
                const href = String(a?.getAttribute?.('href') || '');
                const m3 = /\/d\/([^\/?#]+)/i.exec(href);
                if (m3 && m3[1]) slug = m3[1];
              } catch (e) {}
            }

            if (!slug) continue;

            let name = '';
            let size = 0;

            try {
              name = String(el.getAttribute('data-name') || '').trim();
            } catch (e) {}
            if (!name) {
              try {
                name = String(el.querySelector('.file-name')?.textContent || '').trim();
              } catch (e) {}
            }

            try {
              size = Number(el.getAttribute('data-size') || 0) || 0;
            } catch (e) {}

            out.push({ slug, name, size });
          }
        } catch (e) {}

        // Regex fallback if DOM parsing is incomplete
        try {
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
        } catch (e) {}

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
          );
          dom = r?.dom;
          source = r?.source || '';
        } catch (e) {
          break;
        }

        if (page === 1) {
          firstDom = dom;
          firstSource = source;
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

      if (!folderName) folderName = albumId;

      if (!resolved.length) return url;

      return { dom: firstDom, source: firstSource, folderName, resolved };
    } catch (e) {
      return url;
    }
  },
]);

resolvers.push([
  [/filester\.(me|sh|si|gg)\/d\//],
  async (url, http, spoilers, postId, postSettings, progressCB) => {
    const slug = (() => {
      try {
        const u = new URL(url);
        const parts = String(u.pathname || '')
          .split('/')
          .filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '';
      } catch (e) {
        const m = /filester\.(me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(String(url || ''));
        return m && m[1] ? m[1] : '';
      }
    })();

    if (!slug) return null;

    const apiBase = 'https://filester.me';

    const mkHeaders = () => ({
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: apiBase,
      Referer: url,
      __xfpd_withCredentials: true,
    });

    const safeJson = txt => {
      try {
        return JSON.parse(String(txt || ''));
      } catch (e) {
        return null;
      }
    };

    const walk = (obj, cb, maxNodes = 5000) => {
      const seen = new Set();
      const q = [obj];
      let nodes = 0;
      while (q.length && nodes++ < maxNodes) {
        const cur = q.shift();
        if (!cur || typeof cur !== 'object') continue;
        if (seen.has(cur)) continue;
        seen.add(cur);
        try {
          if (cb(cur) === true) return true;
        } catch (e) {}
        if (Array.isArray(cur)) {
          for (const it of cur) q.push(it);
        } else {
          for (const k of Object.keys(cur)) q.push(cur[k]);
        }
      }
      return false;
    };

    const deepFindValueByKeys = (obj, keys) => {
      const keySet = new Set((keys || []).map(k => String(k).toLowerCase()));
      let out = null;
      walk(obj, o => {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
        for (const k of Object.keys(o)) {
          if (keySet.has(String(k).toLowerCase())) {
            const v = o[k];
            if (v !== null && v !== undefined) {
              out = v;
              return true;
            }
          }
        }
        return false;
      });
      return out;
    };

    const normalizeUrl = s => {
      if (!s || typeof s !== 'string') return null;
      const t = s.trim();
      if (/^https?:\/\//i.test(t)) return t;
      if (t.startsWith('/')) {
        try {
          return new URL(t, apiBase).href;
        } catch (e) {
          return null;
        }
      }
      if (/^[dv]\//i.test(t)) {
        try {
          return new URL('/' + t.replace(/^\/+/, ''), apiBase).href;
        } catch (e) {
          return null;
        }
      }
      return null;
    };

    const pickBestUrl = obj => {
      const candidates = [];
      const push = v => {
        const u = normalizeUrl(v);
        if (u) candidates.push(u);
      };

      const prefer = deepFindValueByKeys(obj, [
        'download_url',
        'downloadUrl',
        'url',
        'link',
        'href',
        'direct',
        'download',
        'view_url',
        'viewUrl',
      ]);
      if (prefer) push(prefer);

      walk(obj, o => {
        for (const k of Object.keys(o || {})) {
          const v = o[k];
          if (typeof v === 'string') push(v);
        }
        if (Array.isArray(o)) {
          for (const it of o) if (typeof it === 'string') push(it);
        }
        return false;
      });

      const clean = candidates
        .map(s => String(s))
        .filter(s => !/filester\.(me|sh|si|gg)\/api\//i.test(s))
        .filter(s => !/filester\.(me|sh|si|gg)\/(css|js)\//i.test(s));

      if (!clean.length) return null;

      const score = s => {
        let sc = 0;
        // Strongly prefer CDN /v/ stream URLs.
        if (/https?:\/\/cache\d+\.filester\.(me|sh|si|gg)\/v\//i.test(s)) sc += 200;
        else if (/cache\d+\.filester\.(me|sh|si|gg)/i.test(s)) sc += 160;
        if (/\/v\//i.test(s)) sc += 80;
        if (/\.filester\.(me|sh|si|gg)\//i.test(s)) sc += 10;
        // De-prioritize HTML view tokens (/d/).
        if (/\/d\//i.test(s)) sc -= 25;
        if (/\.mp4(\?|$)/i.test(s)) sc += 2;
        return sc;
      };

      clean.sort((a, b) => score(b) - score(a));
      return clean[0];
    };

    const pickName = obj => {
      const v = deepFindValueByKeys(obj, ['filename', 'file_name', 'name', 'original_name', 'originalName', 'title']);
      if (typeof v === 'string' && v.trim()) return v.trim();
      return null;
    };

    const pickSize = obj => {
      const v = deepFindValueByKeys(obj, ['size', 'bytes', 'file_size', 'fileSize', 'length']);
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    let nameHint = null;
    let sizeHint = 0;
    let relViewPath = null;
    let streamUrlImmediate = null;

    const filesterExtFromCt = ct => {
      const t = String(ct || '').toLowerCase();
      if (t.includes('video/mp4')) return 'mp4';
      if (t.includes('video/webm')) return 'webm';
      if (t.includes('image/jpeg') || t.includes('image/jpg')) return 'jpg';
      if (t.includes('image/png')) return 'png';
      if (t.includes('image/gif')) return 'gif';
      if (t.includes('application/zip')) return 'zip';
      if (t.includes('application/x-7z-compressed')) return '7z';
      if (t.includes('application/x-rar') || t.includes('application/vnd.rar')) return 'rar';
      return 'bin';
    };

    const filesterParseViewMeta = html => {
      const out = { fileName: '', fileType: '' };
      const s = String(html || '');
      try {
        // Prefer JSON-style double-quoted assignment: window.fileName = "..."
        const m1 = /window\.fileName\s*=\s*("([^"\\]|\\.)*")\s*;?/m.exec(s);
        if (m1 && m1[1]) out.fileName = JSON.parse(m1[1]);
      } catch (e) {}
      try {
        // Fallback: single-quoted assignment: window.fileName = '...'
        if (!out.fileName) {
          const m1b = /window\.fileName\s*=\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*;?/m.exec(s);
          if (m1b && m1b[1]) out.fileName = String(m1b[1]).replace(/\\'/g, "'").replace(/\\n/g, '\n');
        }
      } catch (e) {}
      try {
        const m2 = /window\.fileType\s*=\s*("([^"\\]|\\.)*")\s*;?/m.exec(s);
        if (m2 && m2[1]) out.fileType = JSON.parse(m2[1]);
      } catch (e) {}
      try {
        if (!out.fileType) {
          const m2b = /window\.fileType\s*=\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*;?/m.exec(s);
          if (m2b && m2b[1]) out.fileType = String(m2b[1]).replace(/\\'/g, "'").replace(/\\n/g, '\n');
        }
      } catch (e) {}
      return out;
    };

    const filesterNormalizeFilename = s => {
      let name = String(s || '').trim();
      if (!name) return '';

      // If UTF-8 bytes were interpreted as Latin-1 (common in Chrome/Tampermonkey),
      // decode it back to proper UTF-8.
      try {
        let hasHigh = false;
        let allByte = true;
        for (let i = 0; i < name.length; i++) {
          const c = name.charCodeAt(i);
          if (c > 255) {
            allByte = false;
            break;
          }
          if (c >= 128) hasHigh = true;
        }
        if (allByte && hasHigh && typeof TextDecoder !== 'undefined') {
          const bytes = new Uint8Array(name.length);
          for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i) & 0xff;
          const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          if (decoded && decoded !== name) name = decoded;
        }
      } catch (e) {}

      // Strip control chars (Windows will refuse these in filenames; mojibake often introduces them)
      name = name.replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, '').trim();
      return name;
    };

    const filesterParseDispositionFilename = headersRaw => {
      try {
        const h = String(headersRaw || '');
        const mLine = /content-disposition:\s*([^\r\n]+)/i.exec(h);
        if (!mLine || !mLine[1]) return '';
        const v = String(mLine[1] || '');

        // RFC5987: filename*=UTF-8''...
        let m = /filename\*\s*=\s*([^;]+)/i.exec(v);
        if (m && m[1]) {
          let val = String(m[1]).trim();
          val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

          const mEnc = /^([^']*)''(.*)$/.exec(val);
          if (mEnc) {
            let data = String(mEnc[2] || '').trim();
            try {
              data = decodeURIComponent(data.replace(/\+/g, '%20'));
            } catch (e) {
              // best-effort
            }
            if (data) return filesterNormalizeFilename(data);
          } else {
            try {
              const decoded = decodeURIComponent(val.replace(/\+/g, '%20'));
              if (decoded) return filesterNormalizeFilename(decoded);
            } catch (e) {}
            if (val) return filesterNormalizeFilename(val);
          }
        }

        // Basic: filename="..."
        m = /filename\s*=\s*([^;]+)/i.exec(v);
        if (m && m[1]) {
          let val = String(m[1]).trim();
          val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
          val = val.replace(/\\(.)/g, '$1');
          return filesterNormalizeFilename(val);
        }
      } catch (e) {}
      return '';
    };

    const filesterProbe = async probeUrl => {
      try {
        const r = await http.base(
          'GET',
          probeUrl,
          { onResponseHeadersReceieved: () => {} },
          { Range: 'bytes=0-0', Referer: `${apiBase}/`, __xfpd_withCredentials: true },
          null,
          'text',
        );
        const status = Number(r && r.status) || 0;
        const headers = String((r && r.responseHeaders) || '');
        const dispName = filesterParseDispositionFilename(headers);
        const mCt = /content-type:\s*([^\r\n]+)/i.exec(headers);
        const ct = mCt && mCt[1] ? mCt[1].trim() : '';
        const mCr = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headers);
        const mCl = /content-length:\s*(\d+)/i.exec(headers);
        const size = mCr && mCr[1] ? Number(mCr[1]) : mCl && mCl[1] ? Number(mCl[1]) : 0;
        const isHtmlOrJson = /text\/html|application\/xhtml\+xml|application\/json/i.test(ct);
        const ok = status >= 200 && status < 400 && !isHtmlOrJson;
        return { ok, status, headers, contentType: ct, size: Number.isFinite(size) ? size : 0, fileName: dispName || '' };
      } catch (e) {
        return { ok: false, status: 0, headers: '', contentType: '', size: 0 };
      }
    };

    const filesterResolveDownloadToken = async tokenUrl => {
      try {
        const ref = `${apiBase}/d/${slug}`;

        const normalizeMaybeUrl = v => {
          try {
            if (!v) return '';
            const s = String(v).trim();
            if (!s) return '';
            if (s.startsWith('/')) return new URL(s, apiBase).href;
            if (/^https?:\/\//i.test(s)) return s;
            return '';
          } catch (e) {
            return '';
          }
        };

        // Phase 1: range request (follows redirects) to capture finalUrl without downloading the whole file.
        const r1 = await http.base('GET', tokenUrl, {}, { Range: 'bytes=0-0', Referer: ref, __xfpd_withCredentials: true }, null, 'text');

        const headers1 = String((r1 && r1.responseHeaders) || '');
        const fu1 = String((r1 && r1.finalUrl) || '');

        const mLoc1 = /(?:^|\r?\n)location:\s*([^\r\n]+)/i.exec(headers1);
        const loc1Abs = normalizeMaybeUrl(mLoc1 && mLoc1[1] ? mLoc1[1] : '');
        if (loc1Abs && /\/v\//i.test(loc1Abs)) return loc1Abs;
        if (fu1 && /\/v\//i.test(fu1)) return fu1;

        // If this looks like HTML, fetch the full HTML page (small) and extract the /v/ link.
        const mCt1 = /content-type:\s*([^\r\n]+)/i.exec(headers1);
        const ct1 = mCt1 && mCt1[1] ? String(mCt1[1]).trim() : '';
        const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct1);

        if (isHtml) {
          const r2 = await http.base(
            'GET',
            tokenUrl,
            {},
            { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: ref, __xfpd_withCredentials: true },
            null,
            'text',
          );

          const headers2 = String((r2 && r2.responseHeaders) || '');
          const fu2 = String((r2 && r2.finalUrl) || '');

          const mLoc2 = /(?:^|\r?\n)location:\s*([^\r\n]+)/i.exec(headers2);
          const loc2Abs = normalizeMaybeUrl(mLoc2 && mLoc2[1] ? mLoc2[1] : '');
          if (loc2Abs && /\/v\//i.test(loc2Abs)) return loc2Abs;
          if (fu2 && /\/v\//i.test(fu2)) return fu2;

          const body = String((r2 && r2.source) || '');

          const mFull = /(https?:\/\/cache\d+\.filester\.(me|sh|si|gg)\/v\/[^\"'<>\s]+)/i.exec(body);
          if (mFull && mFull[1]) return String(mFull[1]).trim();

          const mRel = /[\"'](\/v\/[^\"'<>\s]+)[\"']/i.exec(body);
          if (mRel && mRel[1]) return new URL(String(mRel[1]), apiBase).href;
        }

        return null;
      } catch (e) {
        return null;
      }
    };

    try {
      if (progressCB) progressCB('[Filester] Fetching metadata...');
      const viewRes = await http.base('POST', `${apiBase}/api/public/view`, {}, mkHeaders(), JSON.stringify({ file_slug: slug }), 'text');
      const viewJson = safeJson(viewRes && viewRes.source);
      if (viewJson) {
        nameHint = pickName(viewJson) || nameHint;
        sizeHint = pickSize(viewJson) || sizeHint;
        try {
          const relView = deepFindValueByKeys(viewJson, ['view_url', 'viewUrl', 'view']);
          if (typeof relView === 'string' && relView.trim()) {
            const s = String(relView).trim();
            if (s.startsWith('/v/')) {
              relViewPath = s;
            } else if (s.startsWith('v/')) {
              relViewPath = '/' + s;
            } else if (/^https?:\/\//i.test(s)) {
              try {
                const u0 = new URL(s);
                if (/^\/v\//i.test(String(u0.pathname || ''))) {
                  relViewPath = String(u0.pathname || '') + String(u0.search || '');
                }
                // If the API already gave us a cache /v/ URL, keep it as an immediate candidate.
                if (!streamUrlImmediate && /https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(s)) {
                  streamUrlImmediate = s;
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    // Try to extract the real filename (window.fileName = "...") from the HTML view.
    // Some Filester API responses don't include the filename, but the HTML view does.
    try {
      // First try the slug page (it may redirect to /v/... or even directly to a cacheX /v/ stream).
      // We use it for both filename hints and to discover the real /v/ path when the public API is blocked.
      if (!nameHint || (!relViewPath && !streamUrlImmediate)) {
        const slugPageUrl = `${apiBase}/d/${slug}`;
        const htmlRes0 = await http.base(
          'GET',
          slugPageUrl,
          {},
          { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', __xfpd_withCredentials: true },
          {},
          'text',
        );
        const html0 = String((htmlRes0 && htmlRes0.source) || '');
        const meta0 = filesterParseViewMeta(html0);
        if (meta0 && meta0.fileName) nameHint = String(meta0.fileName);

        // If this request ended up at a /v/ URL, capture it.
        try {
          const fu0 = String((htmlRes0 && htmlRes0.finalUrl) || '');
          if (fu0 && /\/v\//i.test(fu0)) {
            if (!streamUrlImmediate && /https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(fu0)) {
              streamUrlImmediate = fu0;
            }
            if (!relViewPath) {
              try {
                const u1 = new URL(fu0);
                if (/^\/v\//i.test(String(u1.pathname || ''))) {
                  relViewPath = String(u1.pathname || '') + String(u1.search || '');
                }
              } catch (e) {}
            }
          }
        } catch (e) {}

        // Fallback: extract a /v/... token from the HTML itself.
        if (!streamUrlImmediate) {
          try {
            const mFull = /(https?:\/\/cache\d+\.filester\.(me|sh|si|gg)\/v\/[^\s"'<>]+)/i.exec(html0);
            if (mFull && mFull[1] && /https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(mFull[1])) streamUrlImmediate = mFull[1];
          } catch (e) {}
        }
        if (!relViewPath) {
          try {
            const mRel = /["'](\/v\/[^"'<>\s]+)["']/i.exec(html0) || /(\/v\/[0-9a-f]{16,}[^"'<>\s]*)/i.exec(html0);
            if (mRel && mRel[1] && String(mRel[1]).startsWith('/v/')) relViewPath = mRel[1];
          } catch (e) {}
        }
      }

      // If still missing, try the explicit view_url returned by the API.
      if (!nameHint && relViewPath && /^\/v\//i.test(String(relViewPath))) {
        const viewPageUrl = `${apiBase}${relViewPath}`;
        const htmlRes = await http.base(
          'GET',
          viewPageUrl,
          {},
          { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', __xfpd_withCredentials: true },
          {},
          'text',
        );
        const html = String((htmlRes && htmlRes.source) || '');
        const meta = filesterParseViewMeta(html);
        if (meta && meta.fileName) nameHint = filesterNormalizeFilename(String(meta.fileName));
      }
    } catch (e) {}

    // Download API can return a /d/<token> which then redirects to the real /v/... stream URL.
    // Use it as a fallback to discover the stream path when /api/public/view doesn't provide it.
    try {
      if (!streamUrlImmediate && !relViewPath) {
        if (progressCB) progressCB('[Filester] Resolving download token...');
        const dlRes0 = await http.base(
          'POST',
          `${apiBase}/api/public/download`,
          {},
          mkHeaders(),
          JSON.stringify({ file_slug: slug }),
          'text',
        );

        const src0 = String((dlRes0 && dlRes0.source) || '');
        const dlJson0 = safeJson(src0);

        let tokenUrl = null;
        try {
          const rel = dlJson0 ? deepFindValueByKeys(dlJson0, ['download_url', 'downloadUrl', 'url']) : null;
          if (typeof rel === 'string' && rel.trim()) tokenUrl = normalizeUrl(rel);
        } catch (e) {}

        if (!tokenUrl) {
          const m0 = /"download_url"\s*:\s*"([^"]+)"/i.exec(src0);
          if (m0 && m0[1]) tokenUrl = normalizeUrl(m0[1]);
        }

        if (tokenUrl) {
          // If the API returned a token (or /d/<token>), the actual stream is usually /v/<token> on cacheX.
          // Build relViewPath early so the probe loop can find a working cache host (cache6 preferred).
          try {
            let tokenStr = '';
            try {
              const tk = dlJson0 ? deepFindValueByKeys(dlJson0, ['token']) : null;
              if (typeof tk === 'string') tokenStr = String(tk).trim();
            } catch (e) {}
            if (!tokenStr) {
              const mTok = /\/d\/([^\/\?#]+)/i.exec(String(tokenUrl || ''));
              if (mTok && mTok[1]) tokenStr = String(mTok[1]).trim();
            }
            if (tokenStr && !relViewPath) {
              if (tokenStr.startsWith('/v/')) relViewPath = tokenStr;
              else if (tokenStr.startsWith('v/')) relViewPath = '/' + tokenStr;
              else if (tokenStr.startsWith('/d/')) relViewPath = tokenStr.replace(/^\/d\//i, '/v/');
              else if (tokenStr.startsWith('d/')) relViewPath = '/' + tokenStr.replace(/^d\//i, 'v/');
              else relViewPath = `/v/${tokenStr}`;
            }
          } catch (e) {}

          const sUrl = await filesterResolveDownloadToken(tokenUrl);
          if (sUrl) {
            try {
              const u2 = new URL(sUrl);
              if (/^\/v\//i.test(String(u2.pathname || ''))) {
                relViewPath = String(u2.pathname || '') + String(u2.search || '');
                if (/https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(sUrl)) streamUrlImmediate = String(sUrl);
              }
            } catch (e) {
              if (String(sUrl).startsWith('/v/')) relViewPath = String(sUrl);
            }
          }
        }
      }
    } catch (e) {}

    // If we already discovered a cache /v/ stream URL from redirects or HTML, prefer it.
    try {
      if (streamUrlImmediate) {
        if (progressCB) progressCB('[Filester] Probing discovered stream URL...');
        const p0 = await filesterProbe(streamUrlImmediate);
        if (p0 && p0.ok) {
          const streamUrl = String(streamUrlImmediate);
          const streamCt = String(p0.contentType || '');
          const streamSize = Number(p0.size || 0) || 0;
          const streamHdrName = String((p0 && p0.fileName) || '');

          try {
            filesterSlugByUrl.set(String(streamUrl), String(slug));
          } catch (e) {}
          try {
            const ref0 = relViewPath ? `${apiBase}${relViewPath}` : `${apiBase}/d/${slug}`;
            if (ref0 && String(ref0).startsWith('http')) {
              filesterRefByUrl.set(String(streamUrl), String(ref0));
              filesterRefByUrl.set(String(url), String(ref0));
              filesterRefByUrl.set(`${apiBase}/d/${slug}`, String(ref0));
            }
          } catch (e) {}
          try {
            if (!nameHint && streamHdrName) nameHint = String(streamHdrName);
          } catch (e) {}

          const ext = filesterExtFromCt(streamCt);
          let finalName = '';
          try {
            if (nameHint) finalName = String(nameHint);
          } catch (e) {}
          if (!finalName) finalName = `Filester_${slug}.${ext || 'bin'}`;
          try {
            const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(finalName || ''));
            if (!hasExt && ext) finalName = `${finalName}.${ext}`;
          } catch (e) {}

          try {
            filesterNameBySlug.set(String(slug), String(finalName));
            filesterNameByUrl.set(String(streamUrl), String(finalName));
            try {
              filesterNameByUrl.set(String(url), String(finalName));
            } catch (e) {}
            try {
              filesterNameByUrl.set(`${apiBase}/d/${slug}`, String(finalName));
            } catch (e) {}
            try {
              if (relViewPath) filesterNameByUrl.set(`${apiBase}${relViewPath}`, String(finalName));
            } catch (e) {}
          } catch (e) {}
          if (streamSize) {
            try {
              filesterSizeBySlug.set(String(slug), Number(streamSize));
              filesterSizeByUrl.set(String(streamUrl), Number(streamSize));
            } catch (e) {}
          }

          return streamUrl;
        }
      }
    } catch (e) {}

    // Prefer the cache /v/ stream URL. The /d/ token often requires a Filester referer (otherwise it returns not_whitelisted).
    try {
      if (relViewPath && /^\/v\//i.test(String(relViewPath))) {
        if (progressCB) progressCB('[Filester] Probing cache stream URL...');
        const bases = [];
        // Chrome Tampermonkey downloads are more reliable when starting from filester.me (redirects preserve a Filester referrer).
        if (!isFF) bases.push(apiBase);
        bases.push('https://cache6.filester.me');
        for (let i = 1; i <= 8; i++) if (i !== 6) bases.push(`https://cache${i}.filester.me`);
        if (isFF) bases.push(apiBase);

        let streamUrl = null;
        let streamCt = '';
        let streamSize = 0;
        let streamHdrName = '';

        for (const base of bases) {
          const cand = String(base).replace(/\/$/, '') + String(relViewPath);
          const p = await filesterProbe(cand);
          if (p && p.ok) {
            streamUrl = cand;
            streamCt = String(p.contentType || '');
            streamSize = Number(p.size || 0) || 0;
            streamHdrName = String((p && p.fileName) || '');
            break;
          }
        }

        if (streamUrl) {
          try {
            filesterSlugByUrl.set(String(streamUrl), String(slug));
          } catch (e) {}
          try {
            const ref0 = relViewPath ? `${apiBase}${relViewPath}` : `${apiBase}/d/${slug}`;
            if (ref0 && String(ref0).startsWith('http')) {
              filesterRefByUrl.set(String(streamUrl), String(ref0));
              filesterRefByUrl.set(String(url), String(ref0));
              filesterRefByUrl.set(`${apiBase}/d/${slug}`, String(ref0));
            }
          } catch (e) {}
          try {
            if (!nameHint && streamHdrName) nameHint = String(streamHdrName);
          } catch (e) {}
          const ext = filesterExtFromCt(streamCt);
          let finalName = '';
          try {
            if (nameHint) finalName = String(nameHint);
          } catch (e) {}
          if (!finalName) finalName = `Filester_${slug}.${ext || 'bin'}`;
          try {
            const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(finalName || ''));
            if (!hasExt && ext) finalName = `${finalName}.${ext}`;
          } catch (e) {}

          try {
            filesterNameBySlug.set(String(slug), String(finalName));
            filesterNameByUrl.set(String(streamUrl), String(finalName));
            try {
              filesterNameByUrl.set(String(url), String(finalName));
            } catch (e) {}
            try {
              filesterNameByUrl.set(`${apiBase}/d/${slug}`, String(finalName));
            } catch (e) {}
            try {
              if (relViewPath) filesterNameByUrl.set(`${apiBase}${relViewPath}`, String(finalName));
            } catch (e) {}
          } catch (e) {}
          if (streamSize) {
            try {
              filesterSizeBySlug.set(String(slug), Number(streamSize));
              filesterSizeByUrl.set(String(streamUrl), Number(streamSize));
            } catch (e) {}
          }

          return streamUrl;
        }
      }
    } catch (e) {}

    try {
      if (progressCB) progressCB('[Filester] Resolving download URL...');
      const dlRes = await http.base('POST', `${apiBase}/api/public/download`, {}, mkHeaders(), JSON.stringify({ file_slug: slug }), 'text');

      const src = String((dlRes && dlRes.source) || '');
      const dlJson = safeJson(src);
      let dlUrl = null;

      if (dlJson) {
        dlUrl = pickBestUrl(dlJson);
      }
      if (dlJson && !dlUrl) {
        try {
          const rel = deepFindValueByKeys(dlJson, ['download_url', 'downloadUrl', 'url']);
          if (typeof rel === 'string' && rel.startsWith('/')) dlUrl = `${apiBase}${rel}`;
        } catch (e) {}
      }

      if (dlJson && !dlUrl) {
        const waitRaw = deepFindValueByKeys(dlJson, ['wait', 'wait_time', 'waitSeconds', 'wait_seconds', 'seconds']);
        const waitSec = Number(waitRaw);
        if (Number.isFinite(waitSec) && waitSec > 0 && waitSec <= 300) {
          try {
            if (progressCB) progressCB(`[Filester] Waiting ${Math.ceil(waitSec)}s...`);
          } catch (e) {}
          await new Promise(r => setTimeout(r, Math.ceil(waitSec) * 1000));
          const dlRes2 = await http.base(
            'POST',
            `${apiBase}/api/public/download`,
            {},
            mkHeaders(),
            JSON.stringify({ file_slug: slug }),
            'text',
          );
          const src2 = String((dlRes2 && dlRes2.source) || '');
          const dlJson2 = safeJson(src2);
          if (dlJson2) dlUrl = pickBestUrl(dlJson2);
          if (!dlUrl) {
            const m2 = /(https?:\/\/[^\s"'<>]+)/i.exec(src2);
            if (m2 && m2[1]) dlUrl = m2[1];
          }
        }
      }

      if (!dlUrl) {
        const m = /(https?:\/\/[^\s"'<>]+)/i.exec(src);
        if (m && m[1]) dlUrl = m[1];
      }

      if (dlUrl) {
        try {
          filesterSlugByUrl.set(String(dlUrl), String(slug));
        } catch (e) {}

        if (nameHint) {
          filesterNameBySlug.set(String(slug), String(nameHint));
          filesterNameByUrl.set(String(dlUrl), String(nameHint));
        }
        if (sizeHint) {
          filesterSizeBySlug.set(String(slug), Number(sizeHint));
          filesterSizeByUrl.set(String(dlUrl), Number(sizeHint));
        }
        return dlUrl;
      }
    } catch (e) {}

    return null;
  },
]);
