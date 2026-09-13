function cyberdropFirstInfoField(info, fields, fileBeforeData = false) {
  if (!info) return null;
  const containers = fileBeforeData ? [info, info.file, info.data, info.data?.file] : [info, info.data, info.file, info.data?.file];
  for (const container of containers) {
    if (!container) continue;
    for (const field of fields) {
      if (container[field]) return container[field];
    }
  }
  return null;
}

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

      const captureAlbumNames = src => {
        // Capture per-file names from the album page so downloads keep extensions.
        try {
          const doc = new DOMParser().parseFromString(src, 'text/html');
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
          while ((m = rxName.exec(src)) !== null) {
            const slug = m[1];
            const nm = decodeHtml(m[2]).trim();
            if (nm) cyberdropNameBySlug.set(slug, nm);
          }
        } catch (e) {}
      };
      captureAlbumNames(html);

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
      const requestAlbumFile = async slug => {
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

          let parsed = null;
          try {
            parsed = JSON.parse(r.source);
          } catch (e) {}
          if (parsed) return parsed;
        }
        return null;
      };

      const pickAlbumDirect = parsed => {
        if (!parsed) return null;
        let direct = null;
        if (typeof parsed.url === 'string') direct = parsed.url;
        else if (parsed.data && typeof parsed.data.url === 'string') direct = parsed.data.url;
        else if (typeof parsed.file === 'string') direct = parsed.file;
        else if (parsed.data && typeof parsed.data.file === 'string') direct = parsed.data.file;

        if (typeof direct !== 'string' || !direct.trim()) return null;
        direct = direct.trim();
        if (direct.startsWith('//')) direct = 'https:' + direct;
        return /^https?:\/\//i.test(direct) ? direct : null;
      };

      for (let i = 0; i < slugs.length; i++) {
        const slug = slugs[i];
        progressCB?.(`Cyberdrop: resolving ${i + 1}/${slugs.length}`);
        const direct = pickAlbumDirect(await requestAlbumFile(slug));
        if (direct) resolved.push(direct);
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

      const captureTokenUrl = (s, out, apiBase) => {
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
      };
      const captureJsonInfo = (s, out, apiBase) => {
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

          const captureName = (v, key) => {
            if (out.name) return;
            if (!looksLikeName(v) && !/(file)?name/i.test(String(key))) return;
            const base = v.split(/[\\/]/).pop();
            if (looksLikeName(base)) out.name = base;
          };

          const captureLocation = (v, key) => {
            // Some info responses require a second request to an auth URL.
            const isAuth = /\/api\/file\/auth\//i.test(v) && (/(^|[^a-z])auth([^a-z]|$)/i.test(String(key)) || /cyberdrop/i.test(v));
            if (!out.auth && isAuth) out.auth = v;

            if (!out.base && (/(cdn|host|domain|server|origin)/i.test(String(key)) || looksLikeBase(v))) {
              const base = normalizeBase(v);
              if (base) out.base = base;
            }
          };

          const captureString = (v, key) => {
            if (isTokenUrl(v) && (!out.direct || v.length > out.direct.length)) out.direct = v;
            captureName(v, key);
            // Tokens may be separate from the URL, under arbitrary keys.
            if (!out.token && looksLikeJwt(v)) out.token = v;
            captureLocation(v, key);
          };

          const walk = (val, key = '') => {
            if (val === null || val === undefined) return;
            if (typeof val === 'string') {
              captureString(val, key);
              return;
            }
            if (typeof val !== 'object' || seen.has(val)) return;
            seen.add(val);

            if (Array.isArray(val)) {
              for (const v of val) walk(v, key);
            } else {
              for (const [k, v] of Object.entries(val)) walk(v, k);
            }
          };

          walk(j, '');

          const captureCommonFields = () => {
            // Preserve first-truthy field precedence, even for non-string values.
            if (!out.direct) {
              const direct = cyberdropFirstInfoField(j, ['url', 'downloadUrl', 'download_url']);
              if (direct && typeof direct === 'string') out.direct = direct;
            }
            if (!out.auth) {
              const auth = cyberdropFirstInfoField(j, ['auth_url', 'authUrl']);
              if (auth && typeof auth === 'string') out.auth = auth;
            }
            if (!out.name) {
              const name = cyberdropFirstInfoField(j, ['name', 'filename', 'fileName', 'originalName'], true);
              if (name && typeof name === 'string' && looksLikeName(name)) out.name = name.split(/[\\/]/).pop();
            }
          };
          captureCommonFields();

          if (!out.direct && out.token) {
            const tok = out.token.includes('%') ? out.token : encodeURIComponent(out.token);
            const base = out.base || apiBase;
            out.direct = `${base.replace(/\/$/, '')}/api/file/d/${slug}?token=${tok}`;
          }
        } catch (e) {}
      };
      const normalizeInfoUrls = (out, apiBase) => {
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
      };
      const parseInfoText = (txt, baseHint) => {
        const out = { direct: null, name: null, token: null, base: null, auth: null };
        const s = String(txt || '');
        const apiBase = typeof baseHint === 'string' && /^https?:\/\//i.test(baseHint) ? baseHint.replace(/\/$/, '') : apiBaseDefault;
        if (!s) return out;

        captureTokenUrl(s, out, apiBase);

        captureJsonInfo(s, out, apiBase);

        normalizeInfoUrls(out, apiBase);

        return out;
      };

      const apiOrigin = (apiUrl, fallback) => {
        try {
          return new URL(apiUrl).origin;
        } catch (e) {
          return fallback;
        }
      };

      const requestInfo = async (apiUrl, fallbackBase) => {
        const { source, status } = await cyberdropFetchText(apiUrl);
        if (status !== 200 || !source) return null;
        const baseHint = apiOrigin(apiUrl, fallbackBase);
        const info = parseInfoText(source, baseHint);
        info.requestOrigin = baseHint;
        return info;
      };

      const resolveAuthInfo = async info => {
        if (info.direct || !info.auth || typeof info.auth !== 'string') return;
        // info -> auth -> tokenized direct URL; auth failure still keeps the info filename.
        try {
          const parsedAuth = await requestInfo(info.auth, info.requestOrigin);
          if (!parsedAuth) return;
          if (!info.name && parsedAuth.name) info.name = parsedAuth.name;
          if (!info.direct && parsedAuth.direct) info.direct = parsedAuth.direct;
        } catch (e) {}
      };

      const fetchInfo = async () => {
        for (const apiUrl of apiCandidates) {
          try {
            const info = await requestInfo(apiUrl, apiBaseDefault);
            if (!info) continue;
            await resolveAuthInfo(info);

            const resolvedName = info.name || null;
            const resolvedDirect = info.direct || null;
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
