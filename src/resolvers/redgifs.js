const redgifsFetchTempToken = async http => {
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

const redgifsPreferredMediaKeys = ['hd', 'hd1080', 'hd720', 'sd', 'mp4'];

const redgifsSelectMediaUrl = (urls, requireHttpFallback) => {
  if (!urls) return null;
  for (const key of redgifsPreferredMediaKeys) {
    const value = urls[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  for (const value of Object.values(urls)) {
    if (typeof value !== 'string') continue;
    if (requireHttpFallback && !/^https?:\/\//i.test(value)) continue;
    if (/\.mp4(\?|$)/i.test(value)) return value;
  }
  return null;
};

const redgifsProfilePageGifs = page => {
  if (Array.isArray(page?.gifs)) return page.gifs;
  return Array.isArray(page?.results) ? page.results : [];
};

const redgifsAppendProfileMedia = (gifs, resolved) => {
  for (const gif of gifs) {
    const best = redgifsSelectMediaUrl(gif?.urls || gif?.gif?.urls, true);
    if (best) resolved.push(best);
  }
};

const redgifsResolveProfilePages = async (fetchPage, baseUrl, progressCB) => {
  const resolved = [];
  const MAX_PAGES = 5000;
  let pages = 1;
  for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
    if (typeof progressCB === 'function') {
      progressCB(`Resolving: ${baseUrl} (page ${page}/${pages})`);
    }

    const { source, status } = await fetchPage(page);
    if (status !== 200 || !source) break;

    let result;
    try {
      result = JSON.parse(source);
    } catch (e) {
      break;
    }

    const gifs = redgifsProfilePageGifs(result);
    pages = Number(result?.pages) || pages;
    redgifsAppendProfileMedia(gifs, resolved);
    if (!gifs.length) break;
    await new Promise(r => setTimeout(r, 75));
  }
  return resolved;
};

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

    let token = GM_getValue('redgifs_token', null);
    if (!token) {
      token = await redgifsFetchTempToken(http);
    }
    if (!token) {
      return null;
    }

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
          token = await redgifsFetchTempToken(http);
          if (!token) {
            return last;
          }
          last = await fetchPage(page, token);
        }

        return last;
      }

      return last;
    };

    const resolved = await redgifsResolveProfilePages(tryFetchPage, baseUrl, progressCB);

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

    let token = GM_getValue('redgifs_token', null);
    if (!token) {
      token = await redgifsFetchTempToken(http);
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
      token = await redgifsFetchTempToken(http);
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

    return redgifsSelectMediaUrl(j?.gif?.urls || j?.urls, false);
  },
]);
