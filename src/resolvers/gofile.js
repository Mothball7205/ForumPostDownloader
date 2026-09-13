resolvers.push([
  [/gofile.io\/d/],
  async (url, http, spoilers, postId) => {
    const WT_KEY = 'xfpd_gofile_wt';
    const AT_KEY = 'xfpd_gofile_at';
    const WT_MAX_AGE_MS = 24 * 3600 * 1000;
    const AT_MAX_AGE_MS = 24 * 3600 * 1000;

    const gmGet = (key, fallback) => {
      try {
        return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
      } catch (e) {
        return fallback;
      }
    };

    const gmSet = (key, val) => {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, val);
      } catch (e) {}
    };

    const gmReq = async (method, url, data = null, headers = {}, responseType = 'text') => {
      return await http.base(method, url, {}, headers, data, responseType);
    };

    // GoFile's generateWT() uses the account token, UA/language, a live 4-hour
    // bucket and a rotating salt. Cache its source, never the time-dependent token.
    // Function is not a sandbox: load only GoFile's own script.
    // Requests must use the same UA/language; X-BL echoes the language.
    let cachedGenerateWT = null;

    const getGenerateWT = async (force = false) => {
      if (!force && cachedGenerateWT) return cachedGenerateWT;

      const now = Date.now();
      const cached = gmGet(WT_KEY, null);
      let src = !force && cached && cached.src && cached.ts && now - cached.ts < WT_MAX_AGE_MS ? cached.src : null;

      if (!src) {
        const { source } = await gmReq('GET', 'https://gofile.io/js/wt.obf.js', null, {}, 'text');
        src = source || '';
        if (!src || !/generateWT/.test(src)) {
          throw new Error('Could not fetch GoFile wt.obf.js (generateWT).');
        }
        gmSet(WT_KEY, { src, ts: now });
      }

      try {
        const factory = new Function('navigator', `${src}\nreturn (typeof generateWT === 'function') ? generateWT : null;`);
        const fn = factory(navigator);
        if (typeof fn !== 'function') throw new Error('no generateWT');
        cachedGenerateWT = fn;
        return fn;
      } catch (e) {
        throw new Error('Could not evaluate GoFile generateWT().', { cause: e });
      }
    };

    const computeWebsiteToken = async (token, force = false) => {
      const gen = await getGenerateWT(force);
      return gen(token);
    };

    const createAccountToken = async () => {
      // Live site creates the guest account with a plain POST (no website-token).
      const { source } = await gmReq(
        'POST',
        'https://api.gofile.io/accounts',
        JSON.stringify({}),
        {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        'text',
      );

      const json = JSON.parse(source || '{}');

      if (!json || json.status !== 'ok' || !json.data || !json.data.token) {
        throw new Error(`createAccount failed: ${json?.message || json?.status || 'unknown'}`);
      }

      const token = json.data.token;

      // Activate the guest token before requesting /contents.
      try {
        await gmReq(
          'GET',
          'https://api.gofile.io/accounts/website',
          null,
          { accept: 'application/json', authorization: `Bearer ${token}` },
          'text',
        );
      } catch (e) {}

      try {
        settings.hosts.goFile.token = token;
      } catch (e) {}

      gmSet(AT_KEY, { token, ts: Date.now() });
      await gofileSyncCookie(token);
      return token;
    };

    const getAccountToken = async (force = false) => {
      // A personal Bearer token takes precedence over guest credentials.
      let token = null;
      try {
        const override = settings?.hosts?.goFile?.bearerOverride;
        if (override && String(override).trim() !== '') {
          token = String(override).trim();
        }
      } catch (e) {}

      if (!token) {
        const now = Date.now();
        const cached = gmGet(AT_KEY, null);
        if (!force && cached && cached.token && cached.ts && now - cached.ts < AT_MAX_AGE_MS) {
          token = cached.token;
          try {
            settings.hosts.goFile.token = token;
          } catch (e) {}
        }
      }

      if (!token) {
        try {
          if (!force && settings && settings.hosts && settings.hosts.goFile && settings.hosts.goFile.token) {
            token = settings.hosts.goFile.token;
          }
        } catch (e) {}
      }

      if (!token) {
        // createAccountToken() already syncs the cookie for this token; avoid a double sync below.
        return await createAccountToken();
      }

      await gofileSyncCookie(token);
      return token;
    };

    const apiContentsRaw = async (contentId, passwordHash, token) => {
      const wt = await computeWebsiteToken(token);

      // Match the website's getContent() query shape (pagination + sort) exactly.
      const params = ['contentFilter=', 'page=1', 'pageSize=1000', 'sortField=createTime', 'sortDirection=-1'];
      if (passwordHash) params.push(`password=${encodeURIComponent(passwordHash)}`);
      const apiUrl = `https://api.gofile.io/contents/${encodeURIComponent(contentId)}?${params.join('&')}`;

      const { source } = await gmReq(
        'GET',
        apiUrl,
        null,
        {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'x-website-token': wt,
          'x-bl': (typeof navigator !== 'undefined' && navigator.language) || '',
        },
        'text',
      );

      return JSON.parse(source || '{}');
    };

    const apiContents = async (contentId, passwordHash) => {
      let token = await getAccountToken(false);

      let json = await apiContentsRaw(contentId, passwordHash, token);
      if (json && json.status === 'ok') return json;

      const s = String(json?.status || json?.message || '').toLowerCase();

      if (s.includes('unauthorized') || s.includes('token') || s.includes('invalid')) {
        // Refresh both the salts (wt.obf.js may have rotated) and the guest token.
        await getGenerateWT(true);
        token = await getAccountToken(true);
        json = await apiContentsRaw(contentId, passwordHash, token);
        return json;
      }

      return json;
    };

    const resolveAlbum = async (urlOrId, spoilers) => {
      const id = String(urlOrId).includes('gofile.io/d/') ? String(urlOrId).split('/').reverse()[0] : String(urlOrId);

      let props = await apiContents(id, null);

      if (props && props.status === 'error-notFound') {
        log.host.error(postId, `::Album not found::: ${urlOrId}`, 'gofile.io');
        return null;
      }

      if (props && props.status === 'error-notPublic') {
        log.host.error(postId, `::Album not public::: ${urlOrId}`, 'gofile.io');
        return null;
      }

      if (props && props.status === 'error-passwordRequired') {
        log.host.info(postId, `::Album requires password::: ${urlOrId}`, 'gofile.io');

        if (!spoilers || !spoilers.length) {
          return props;
        }

        log.host.info(postId, `::Trying with ${spoilers.length} available password(s)::`, 'gofile.io');

        for (const spoiler of spoilers) {
          const hash = sha256(spoiler);
          const attempt = await apiContents(id, hash);

          if (attempt && attempt.status === 'ok') {
            log.host.info(postId, `::Successfully authenticated with:: ${spoiler}`, 'gofile.io');
            props = attempt;
            break;
          }
        }
      }

      return props;
    };

    const props = await resolveAlbum(url, spoilers);

    let folderName = h.basename(url);

    if (!props || props.status !== 'ok' || !props.data) {
      if (props && props.status === 'error-passwordRequired') {
        log.host.error(postId, `::Password required (no valid password found)::: ${url}`, 'gofile.io');
      } else {
        log.host.error(postId, `::Unable to resolve album::: ${url}`, 'gofile.io');
      }

      return {
        dom: null,
        source: null,
        folderName,
        resolved: [],
      };
    }

    const resolved = [];

    const resolveFileLink = obj => {
      const fileId = obj.id || obj.code;
      const fileName = encodeURIComponent(obj.name || fileId || 'file');

      // Prefer direct/CDN links; /download/web/ may return album HTML.
      const candidates = [obj.directLink, obj.link, obj.downloadLink].filter(Boolean);
      const link =
        candidates.find(u => /\/download\/direct\//i.test(String(u))) ||
        candidates[0] ||
        (fileId ? `https://gofile.io/download/web/${fileId}/${fileName}` : null);

      if (link && obj.name) {
        // Preserve API filenames rather than URL-encoded path segments.
        try {
          if (fileId) gofileNameById.set(String(fileId), String(obj.name));
          gofileNameByUrl.set(String(link), String(obj.name));
        } catch (e) {}
      }
      return link;
    };

    const getChildAlbums = async (props, spoilers) => {
      if (!props || props.status !== 'ok' || !props.data) {
        return [];
      }

      const resolved = [];

      // A /d/ link can name a file, whose response has no children.
      if (props.data.type === 'file') {
        const link = resolveFileLink(props.data);
        if (link) resolved.push(link);
        return resolved;
      }

      if (!props.data.children) return [];

      folderName = props.data.name || folderName;

      const files = props.data.children;

      for (const file in files) {
        const obj = files[file];

        if (!obj) continue;

        if (obj.type === 'file') {
          const link = resolveFileLink(obj);
          if (link) resolved.push(link);
        } else if (obj.type === 'folder') {
          const folderId = obj.id || obj.code;
          if (!folderId) continue;

          const folderProps = await resolveAlbum(folderId, spoilers);
          resolved.push(...(await getChildAlbums(folderProps, spoilers)));
        }
      }

      return resolved;
    };

    resolved.push(...(await getChildAlbums(props, spoilers)));

    if (!resolved.length) {
      log.host.error(postId, `::Empty album::: ${url}`, 'gofile.io');
    }

    return {
      dom: null,
      source: null,
      folderName,
      resolved,
    };
  },
]);
