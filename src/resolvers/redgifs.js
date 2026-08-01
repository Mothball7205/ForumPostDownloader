resolvers.push([
  [/redgifs\.com\/users\//i],
  async (url, http, passwords, postId, postSettings, progressCB) => {
    const raw = String(url || '');
    const m = raw.match(/redgifs\.com\/users\/([^\/?#]+)/i);
    const username = m && m[1] ? decodeURIComponent(m[1]) : '';

    if (!username) {
      return null;
    }

    const baseUrl = `https://www.redgifs.com/users/${username}`;

    const fetchTempToken = async () => {
      try {
        const { source, status } = await http.get('https://api.redgifs.com/v2/auth/temporary', {}, {}, 'text');
        if (status === 200 && source && h.contains('token', source)) {
          const token = JSON.parse(source).token;
          if (token) {
            GM_setValue('redgifs_token', token);
          }
          return token || null;
        }
      } catch (e) {}
      return null;
    };

    let token = GM_getValue('redgifs_token', null);
    if (!token) {
      token = await fetchTempToken();
    }
    if (!token) {
      return null;
    }

    const preferredKeys = ['hd', 'hd1080', 'hd720', 'sd', 'mp4'];
    const resolved = [];

    const MAX_PAGES = 5000;
    const COUNT = 80;
    const ORDER = 'new';

    const fetchPage = async (page, t) => {
      const apiUrl = `https://api.redgifs.com/v2/users/${encodeURIComponent(username)}/search?order=${ORDER}&page=${page}&count=${COUNT}`;
      try {
        return await http.get(apiUrl, {}, { Authorization: `Bearer ${t}` }, 'text');
      } catch (e) {
        return { source: null, status: 0 };
      }
    };

    const tryFetchPage = async page => {
      let attempt = 0;
      let last = { source: null, status: 0 };

      while (attempt < 3) {
        attempt++;

        last = await fetchPage(page, token);

        if (last.status === 429) {
          await new Promise(r => setTimeout(r, 800 * attempt));
          continue;
        }

        if (last.status === 401 || last.status === 403 || (last.source && /unauthorized|forbidden/i.test(last.source))) {
          token = await fetchTempToken();
          if (!token) {
            return last;
          }
          last = await fetchPage(page, token);
        }

        return last;
      }

      return last;
    };

    let pages = 1;

    for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
      if (typeof progressCB === 'function') {
        progressCB(`Resolving: ${baseUrl} (page ${page}/${pages})`);
      }

      const { source, status } = await tryFetchPage(page);

      if (status !== 200 || !source) {
        break;
      }

      let j;
      try {
        j = JSON.parse(source);
      } catch (e) {
        break;
      }

      const gifs = Array.isArray(j?.gifs) ? j.gifs : Array.isArray(j?.results) ? j.results : [];
      pages = Number(j?.pages) || pages;

      for (const g of gifs) {
        const urls = g?.urls || g?.gif?.urls;
        if (!urls) {
          continue;
        }

        let best = null;

        for (const k of preferredKeys) {
          const v = urls[k];
          if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
            best = v;
            break;
          }
        }

        if (!best) {
          for (const v of Object.values(urls)) {
            if (typeof v === 'string' && /^https?:\/\//i.test(v) && /\.mp4(\?|$)/i.test(v)) {
              best = v;
              break;
            }
          }
        }

        if (best) {
          resolved.push(best);
        }
      }

      if (!gifs.length) {
        break;
      }

      await new Promise(r => setTimeout(r, 75));
    }

    if (!resolved.length) {
      return null;
    }

    return {
      folderName: username,
      resolved,
    };
  },
]);

resolvers.push([
  [/redgifs\.com(\/|\\\/)(ifr|watch|gifs\/detail|gifs\/watch)/i],
  async (url, http) => {
    const raw = String(url || '');
    const idMatch =
      raw.match(/redgifs\.com(?:\/|\\\/)(?:ifr(?:\/|\\\/)|watch(?:\/|\\\/)|gifs(?:\/|\\\/)detail(?:\/|\\\/))?([a-z0-9_-]+)/i) ||
      raw.match(/\/([a-z0-9_-]+)(?:\?.*)?$/i);
    const id = (idMatch && idMatch[1] ? String(idMatch[1]) : '').match(/[a-z0-9_-]+/i)?.[0];

    if (!id) {
      return null;
    }

    const fetchTempToken = async () => {
      try {
        const { source, status } = await http.get('https://api.redgifs.com/v2/auth/temporary', {}, {}, 'text');
        if (status === 200 && source && h.contains('token', source)) {
          const token = JSON.parse(source).token;
          if (token) {
            GM_setValue('redgifs_token', token);
          }
          return token || null;
        }
      } catch (e) {}
      return null;
    };

    let token = GM_getValue('redgifs_token', null);
    if (!token) {
      token = await fetchTempToken();
    }
    if (!token) {
      return null;
    }

    const apiUrl = `https://api.redgifs.com/v2/gifs/${id}`;

    const fetchGif = async t => {
      try {
        return await http.get(apiUrl, {}, { Authorization: `Bearer ${t}` }, 'text');
      } catch (e) {
        return { source: null, status: 0 };
      }
    };

    let { source, status } = await fetchGif(token);

    if (status === 401 || status === 403 || (source && /unauthorized|forbidden/i.test(source))) {
      token = await fetchTempToken();
      if (!token) {
        return null;
      }
      ({ source, status } = await fetchGif(token));
    }

    if (status !== 200 || !source) {
      return null;
    }

    let j;
    try {
      j = JSON.parse(source);
    } catch (e) {
      return null;
    }

    const urls = j?.gif?.urls || j?.urls;
    if (!urls) {
      return null;
    }

    const preferredKeys = ['hd', 'hd1080', 'hd720', 'sd', 'mp4'];
    for (const k of preferredKeys) {
      const v = urls[k];
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
        return v;
      }
    }

    for (const v of Object.values(urls)) {
      if (typeof v === 'string' && /\.mp4(\?|$)/i.test(v)) {
        return v;
      }
    }

    return null;
  },
]);
