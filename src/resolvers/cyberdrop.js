resolvers.push([
  [/fs-\d+\.cyberdrop\.[a-z]{2,}\/|cyberdrop\.[a-z]{2,}\/a\//],
  async (url, http, passwords, postId, postSettings, progressCB) => {
    // Resolve album file links through the auth API without per-file warm-up tabs.
    try {
      url = String(url || '').trim();
      if (url.startsWith('//')) url = 'https:' + url;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');

      const albumIdMatch = url.match(/\/a\/([^\/?#]+)/i);
      const albumId = albumIdMatch ? albumIdMatch[1] : '';

      const pageUrl = url;
      let pageOrigin = 'https://cyberdrop.cr';
      try {
        pageOrigin = new URL(pageUrl).origin;
      } catch (e) {}

      const decodeHtml = s => {
        try {
          const t = document.createElement('textarea');
          t.innerHTML = String(s || '');
          return t.value;
        } catch (e) {
          return String(s || '');
        }
      };

      const getAlbumHtml = async () => {
        progressCB?.('Cyberdrop: loading album page');
        const r = await http.get(
          pageUrl,
          {},
          {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: pageOrigin + '/',
            Origin: pageOrigin,
          },
          'text',
        );
        return r && r.source ? r.source : '';
      };

      let html = await getAlbumHtml();

      const extractSlugs = src => {
        const slugs = [];
        const seen = new Set();
        const re = /href\s*=\s*["'](?:https?:\/\/(?:[\w-]+\.)*cyberdrop\.[a-z.]+)?\/f\/([A-Za-z0-9_-]+)(?:[\/?#"'])/gi;
        let m;
        while ((m = re.exec(src || '')) !== null) {
          const s = m[1];
          if (s && !seen.has(s)) {
            seen.add(s);
            slugs.push(s);
          }
        }
        return slugs;
      };

      let slugs = extractSlugs(html);

      // If the HTML is gated/empty, do a single warm-up of the album page and retry once.
      if (!slugs.length && typeof cyberdropWarmupOnce === 'function') {
        await cyberdropWarmupOnce(pageUrl);
        html = await getAlbumHtml();
        slugs = extractSlugs(html);
      }

      if (!slugs.length) return url;

      const pickTitle = src => {
        const m1 =
          src.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
          src.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
        const m2 = src.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        const m3 = src.match(/<title[^>]*>([^<]+)<\/title>/i);
        let t = (m1 && (m1[1] || m1[2])) || (m2 && m2[1]) || (m3 && m3[1]) || '';
        t = decodeHtml(t).trim();
        t = t
          .replace(/\s*\|\s*CyberDrop.*$/i, '')
          .replace(/\s*-\s*CyberDrop.*$/i, '')
          .trim();
        if (!t) t = albumId ? `cyberdrop_${albumId}` : 'cyberdrop_album';
        return t;
      };

      const folderName = pickTitle(html);

      // Capture per-file names from the album page so downloads keep extensions.
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const nodes = doc.querySelectorAll('a#file[href^="/f/"], a[id="file"][href^="/f/"], a[href^="/f/"][title][href^="/f/"]');
        nodes.forEach(a => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/f\/([A-Za-z0-9]+)/);
          if (!m) return;
          const slug = m[1];
          const nm = (a.getAttribute('title') || a.textContent || '').trim();
          if (nm) cyberdropNameBySlug.set(slug, nm);
        });
      } catch (e) {}

      // Regex fallback (in case DOMParser is blocked).
      try {
        const rxName = /href=["']\/f\/([A-Za-z0-9]+)["'][^>]*\btitle=["']([^"']+)["']/gi;
        let m;
        while ((m = rxName.exec(html)) !== null) {
          const slug = m[1];
          const nm = decodeHtml(m[2]).trim();
          if (nm) cyberdropNameBySlug.set(slug, nm);
        }
      } catch (e) {}

      const host = (() => {
        try {
          return new URL(pageUrl).hostname;
        } catch (e) {
          return '';
        }
      })();
      const root = (String(host || '').match(/cyberdrop\.[a-z]+$/i) || [null])[0];
      const apiBases = [];
      if (root) apiBases.push(`https://api.${root}`);
      apiBases.push('https://api.cyberdrop.cr');
      const apiBaseList = [...new Set(apiBases)];

      const resolved = [];
      for (let i = 0; i < slugs.length; i++) {
        const slug = slugs[i];
        progressCB?.(`Cyberdrop: resolving ${i + 1}/${slugs.length}`);

        let j = null;

        for (const base of apiBaseList) {
          const apiUrl = `${base}/api/file/auth/${slug}`;

          const r = await http.get(
            apiUrl,
            {},
            {
              Accept: 'application/json, text/plain, */*',
              Origin: pageOrigin,
              Referer: pageOrigin + '/',
            },
            'text',
          );

          if (!r || !r.source) continue;

          try {
            j = JSON.parse(r.source);
          } catch (e) {
            j = null;
          }
          if (j) break;
        }

        if (!j) continue;

        let direct = null;
        if (typeof j.url === 'string') direct = j.url;
        else if (j.data && typeof j.data.url === 'string') direct = j.data.url;
        else if (typeof j.file === 'string') direct = j.file;
        else if (j.data && typeof j.data.file === 'string') direct = j.data.file;

        if (typeof direct !== 'string' || !direct.trim()) continue;
        direct = direct.trim();
        if (direct.startsWith('//')) direct = 'https:' + direct;

        if (!/^https?:\/\//i.test(direct)) continue;
        resolved.push(direct);
      }

      if (!resolved.length) return url;

      return { folderName, resolved };
    } catch (e) {
      return url;
    }
  },
]);

resolvers.push([
  [/fs-\d+\.cyberdrop\.[a-z]{2,}\/|cyberdrop\.[a-z]{2,}\/(f|e)\//, /:!cyberdrop\.[a-z]{2,}\/a\//],
  async (url, http) => {
    // Resolve via the API first; if blocked, warm up /f/ and retry once.
    try {
      url = String(url || '').trim();
      if (url.startsWith('//')) url = 'https:' + url;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');

      // Normalize legacy fs-*/img-* hosts (old Cyberdrop mirrors)
      if (url.includes('fs-') || url.includes('img-')) {
        url = url.replace(/(fs|img)-\d+/i, '').replace(/(to|cc|nl)-\d+/i, 'me');
      }

      const u = new URL(url);
      const origin = `${u.protocol}//${u.hostname}`;
      const slugMatch = String(url).match(/\/([ef])\/([^\/?#]+)/i);
      if (!slugMatch || !slugMatch[2]) {
        return url;
      }

      const slug = slugMatch[2];
      const pageUrl = `${origin}/f/${slug}`;

      const apiCandidates = [];

      // Prefer this mirror's info/auth endpoints, then known and legacy variants.
      const root = (u.hostname.match(/cyberdrop\.[a-z]+$/i) || [null])[0];
      const apiBaseDefault = root ? `https://api.${root}` : 'https://api.cyberdrop.cr';
      if (root) {
        apiCandidates.push(`https://api.${root}/api/file/info/${slug}`);
        apiCandidates.push(`https://api.${root}/api/file/auth/${slug}`);
      }
      apiCandidates.push(`https://api.cyberdrop.cr/api/file/info/${slug}`);
      apiCandidates.push(`https://api.cyberdrop.cr/api/file/auth/${slug}`);
      if (root) {
        apiCandidates.push(`https://api.${root}/api/file/url/${slug}`);
        apiCandidates.push(`https://api.${root}/api/file/${slug}`);
        apiCandidates.push(`https://api.${root}/api/file/auth/${slug}`);
      }
      apiCandidates.push(`https://api.cyberdrop.cr/api/file/url/${slug}`);
      apiCandidates.push(`https://api.cyberdrop.cr/api/file/auth/${slug}`);
      apiCandidates.push(`https://api.cyberdrop.cr/api/file/${slug}`);

      // Legacy mirrors expose /api/f/ on the page origin.
      apiCandidates.push(`${origin}/api/f/${slug}`);

      const headers = {
        Accept: 'application/json, text/plain, */*',
        Referer: `${origin}/`,
        Origin: origin,
      };

      const cyberdropGmGetText = (reqUrl, hdrs) =>
        new Promise(resolve => {
          try {
            GM_xmlhttpRequest({
              method: 'GET',
              url: String(reqUrl),
              headers: hdrs || {},
              responseType: 'text',
              anonymous: false,
              timeout: 6000,
              onload: r => resolve({ status: r.status || 0, source: String(r.responseText || r.response || '') }),
              onerror: () => resolve({ status: 0, source: '' }),
              ontimeout: () => resolve({ status: 0, source: '' }),
            });
          } catch (e) {
            resolve({ status: 0, source: '' });
          }
        });

      const cyberdropFetchText = async reqUrl => {
        let r = await cyberdropGmGetText(reqUrl, headers);
        if (r.status === 0 && (headers.Origin || headers.Referer)) {
          r = await cyberdropGmGetText(reqUrl, { Accept: headers.Accept });
        }
        return r;
      };

      const fetchInfo = async () => {
        const parseInfoText = (txt, baseHint) => {
          const out = { direct: null, name: null, token: null, base: null, auth: null };
          const s = String(txt || '');
          const apiBase = typeof baseHint === 'string' && /^https?:\/\//i.test(baseHint) ? baseHint.replace(/\/$/, '') : apiBaseDefault;
          if (!s) return out;

          // Prefer absolute token URLs, including JSON-escaped forms.
          const rePlain = new RegExp(`https?:\/\/[^"'\\s]+\/api\/file\/d\/${slug}\?[^"'\\s]*token=[^"'\\s]+`, 'i');
          let m = s.match(rePlain);
          if (m && m[0]) out.direct = m[0];

          if (!out.direct) {
            const reEsc = new RegExp(`https?:\\/\\/[^"\\s]+\\/api\\/file\\/d\\/${slug}\\?[^"\\s]*token=[^"\\s]+`, 'i');
            m = s.match(reEsc);
            if (m && m[0]) out.direct = m[0].replace(/\\\//g, '/');
          }

          // Relative token URLs belong to the API origin that returned them.
          if (!out.direct) {
            const reRel1 = new RegExp(`\/api\/file\/d\/${slug}\?[^"'\\s]*token=[^"'\\s]+`, 'i');
            m = s.match(reRel1);
            if (m && m[0]) out.direct = `${apiBase}${m[0]}`;
          }

          if (!out.direct) {
            const reRel2 = new RegExp(`api\/file\/d\/${slug}\?[^"'\\s]*token=[^"'\\s]+`, 'i');
            m = s.match(reRel2);
            if (m && m[0]) out.direct = `${apiBase}/${m[0].replace(/^\//, '')}`;
          }

          // Some responses separate filename, token, host and auth URL.
          try {
            const j = JSON.parse(s);
            const seen = new Set();

            const looksLikeName = v => {
              if (!v || typeof v !== 'string') return false;
              if (v.length > 260) return false;
              if (/^https?:\/\//i.test(v)) return false;
              const base = v.split(/[\\/]/).pop();
              return /^[^<>:"|?*\x00-\x1F]+\.[a-z0-9]{2,8}$/i.test(base);
            };

            const looksLikeJwt = v => {
              if (!v || typeof v !== 'string') return false;
              return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v);
            };

            const isTokenUrl = v => {
              if (!v || typeof v !== 'string') return false;
              return v.includes(`/api/file/d/${slug}`) && /token=/i.test(v);
            };

            const looksLikeBase = v => {
              if (!v || typeof v !== 'string') return false;
              // Accept origins or hostnames that look like Cyberdrop CDN
              if (/gigachad-cdn\.ru/i.test(v) || /cyberdrop\./i.test(v)) return true;
              if (/^k\d+-cd\./i.test(v)) return true;
              return false;
            };

            const normalizeBase = v => {
              try {
                const t = String(v || '').trim();
                if (!t) return null;
                if (/^https?:\/\//i.test(t)) {
                  const uu = new URL(t);
                  return `${uu.protocol}//${uu.hostname}`;
                }
                if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) return `https://${t}`;
              } catch (e) {}
              return null;
            };

            const walk = (val, key = '') => {
              if (val === null || val === undefined) return;

              if (typeof val === 'string') {
                const v = val;

                if (isTokenUrl(v) && (!out.direct || v.length > out.direct.length)) out.direct = v;

                if (!out.name) {
                  if (looksLikeName(v) || /(file)?name/i.test(String(key))) {
                    const base = v.split(/[\\/]/).pop();
                    if (looksLikeName(base)) out.name = base;
                  }
                }

                // Tokens may be separate from the URL, under arbitrary keys.
                if (!out.token && looksLikeJwt(v)) out.token = v;

                // Some info responses require a second request to an auth URL.
                if (!out.auth) {
                  if (/(^|[^a-z])auth([^a-z]|$)/i.test(String(key)) && /\/api\/file\/auth\//i.test(v)) {
                    out.auth = v;
                  } else if (/\/api\/file\/auth\//i.test(v) && /cyberdrop/i.test(v)) {
                    out.auth = v;
                  }
                }

                if (!out.base && (/(cdn|host|domain|server|origin)/i.test(String(key)) || looksLikeBase(v))) {
                  const b = normalizeBase(v);
                  if (b) out.base = b;
                }

                return;
              }

              if (typeof val !== 'object') return;
              if (seen.has(val)) return;
              seen.add(val);

              if (Array.isArray(val)) {
                for (const v of val) walk(v, key);
              } else {
                for (const [k, v] of Object.entries(val)) walk(v, k);
              }
            };

            walk(j, '');

            // Common direct URL fields
            if (!out.direct) {
              const direct =
                (j &&
                  (j.url ||
                    j.downloadUrl ||
                    j.download_url ||
                    (j.data && (j.data.url || j.data.downloadUrl || j.data.download_url)) ||
                    (j.file && (j.file.url || j.file.downloadUrl || j.file.download_url)) ||
                    (j.data && j.data.file && (j.data.file.url || j.data.file.downloadUrl || j.data.file.download_url)))) ||
                null;
              if (direct && typeof direct === 'string') out.direct = direct;
            }

            // Explicit auth fields can supply URLs missed by the scan.
            if (!out.auth) {
              const a =
                (j &&
                  (j.auth_url ||
                    j.authUrl ||
                    (j.data && (j.data.auth_url || j.data.authUrl)) ||
                    (j.file && (j.file.auth_url || j.file.authUrl)) ||
                    (j.data && j.data.file && (j.data.file.auth_url || j.data.file.authUrl)))) ||
                null;
              if (a && typeof a === 'string') out.auth = a;
            }

            // Common filename fields
            if (!out.name) {
              const n =
                (j &&
                  (j.name ||
                    j.filename ||
                    j.fileName ||
                    j.originalName ||
                    (j.file && (j.file.name || j.file.filename || j.file.fileName || j.file.originalName)) ||
                    (j.data && (j.data.name || j.data.filename || j.data.fileName || j.data.originalName)) ||
                    (j.data &&
                      j.data.file &&
                      (j.data.file.name || j.data.file.filename || j.data.file.fileName || j.data.file.originalName)))) ||
                null;
              if (n && typeof n === 'string' && looksLikeName(n)) out.name = n.split(/[\\/]/).pop();
            }

            if (!out.direct && out.token) {
              const tok = out.token.includes('%') ? out.token : encodeURIComponent(out.token);
              const base = out.base || apiBase;
              out.direct = `${base.replace(/\/$/, '')}/api/file/d/${slug}?token=${tok}`;
            }
          } catch (e) {}

          if (out.direct && typeof out.direct === 'string' && out.direct.includes('\\/')) {
            out.direct = out.direct.replace(/\\\//g, '/');
          }

          if (out.direct && typeof out.direct === 'string' && out.direct.startsWith('/')) {
            out.direct = `${apiBase}${out.direct}`;
          }

          // Normalize escaped slashes and relative auth URLs
          if (out.auth && typeof out.auth === 'string' && out.auth.includes('\\/')) {
            out.auth = out.auth.replace(/\\\//g, '/');
          }
          if (out.auth && typeof out.auth === 'string') {
            if (out.auth.startsWith('/')) {
              out.auth = `${apiBase}${out.auth}`;
            } else if (!/^https?:\/\//i.test(out.auth) && /api\/file\/auth\//i.test(out.auth)) {
              out.auth = `${apiBase}/${out.auth.replace(/^\/+/, '')}`;
            }
          }

          return out;
        };

        for (const apiUrl of apiCandidates) {
          try {
            const { source, status } = await cyberdropFetchText(apiUrl);
            if (status !== 200 || !source) continue;

            let baseHint = apiBaseDefault;
            try {
              baseHint = new URL(apiUrl).origin;
            } catch (e) {}
            const { direct, name, auth } = parseInfoText(source, baseHint);

            let resolvedName = name || null;
            let resolvedDirect = direct || null;

            // info -> auth -> tokenized direct URL.
            if (!resolvedDirect && auth && typeof auth === 'string') {
              const authUrl = auth;
              try {
                const { source: authSource, status: authStatus } = await cyberdropFetchText(authUrl);
                if (authStatus === 200 && authSource) {
                  let authBase = baseHint;
                  try {
                    authBase = new URL(authUrl).origin;
                  } catch (e) {}
                  const parsedAuth = parseInfoText(authSource, authBase);
                  if (!resolvedName && parsedAuth && parsedAuth.name) resolvedName = parsedAuth.name;
                  if (!resolvedDirect && parsedAuth && parsedAuth.direct) resolvedDirect = parsedAuth.direct;
                }
              } catch (e) {}
            }

            if (resolvedName) cyberdropNameBySlug.set(String(slug), String(resolvedName));

            if (resolvedDirect && typeof resolvedDirect === 'string') {
              if (resolvedName) cyberdropNameByUrl.set(String(resolvedDirect), String(resolvedName));
              return resolvedDirect;
            }
          } catch (e) {}
        }
        return null;
      };

      // 1st attempt: API directly (some setups need two requests for ddos-guard cookies)
      let directUrl = await fetchInfo();
      if (!directUrl) directUrl = await fetchInfo();
      if (directUrl) return directUrl;

      // Warm-up (only one tab at a time) then retry
      let warmKey = 'cyberdrop';
      try {
        warmKey = `cyberdrop:${new URL(pageUrl).origin}`;
      } catch (e) {}
      await cyberdropWarmupOnce(warmKey, pageUrl, CYBERDROP_WARMUP_DEFAULT_MS);

      directUrl = await fetchInfo();
      if (!directUrl) directUrl = await fetchInfo();
      return directUrl || url;
    } catch (e) {
      return url;
    }
  },
]);
