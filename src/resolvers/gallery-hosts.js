resolvers.push([
  [/(postimg|pixxxels).cc/],
  async (url, http) => {
    url = url.replace(/https?:\/\/(www.)?i\.?(postimg|pixxxels).cc\/(.{8})(.*)/, 'https://postimg.cc/$3');
    const { dom } = await http.get(url);
    return dom.querySelector('.controls > nobr > a').getAttribute('href');
  },
]);

resolvers.push([[/kemono.cr\/data/], url => url]);

resolvers.push([
  [/goonbox\.cr\/img\//],
  async (url, http) => {
    const id = url.split('/').pop().split('?')[0];
    const fallback = goonboxThumbByUrl.get(url.replace(/\?.*/, '').replace(/\/$/, '')) || null;

    const { source } = await http.get(`https://goonbox.cr/api/images/${id}`, {}, { Referer: url, Accept: 'application/json' }, 'text');

    let originalUrl = null;
    if (source) {
      try {
        originalUrl = JSON.parse(source)?.image?.original_url || null;
      } catch (e) {}
    }

    if (!originalUrl) return fallback;

    // Post-migration, some "original_url" targets 404 even though the medium-res thumbnail
    // on the same cuckcapital.cr host still exists. Verify before trusting it.
    try {
      const check = await http.base('HEAD', originalUrl, {}, { Referer: url }, null, 'text');
      if (!check.status || check.status >= 400) {
        return fallback || originalUrl;
      }
    } catch (e) {
      return fallback || originalUrl;
    }

    return originalUrl;
  },
]);

resolvers.push([
  [/goonbox\.cr\/a\//],
  async (url, http) => {
    const albumSlug = url.replace(/\?.*/, '').split('/').filter(Boolean).pop();

    const fetchPage = async page => {
      const { source } = await http.get(
        `https://goonbox.cr/api/albums/${albumSlug}/images?page=${page}`,
        {},
        { Referer: url, Accept: 'application/json' },
        'text',
      );
      if (!source) return null;
      try {
        return JSON.parse(source);
      } catch (e) {
        return null;
      }
    };

    const first = await fetchPage(1);
    if (!first || !h.isArray(first.images)) return null;

    const resolved = first.images.map(img => img.original_url).filter(Boolean);
    const lastPage = first.pagination?.last_page || 1;

    for (let page = 2; page <= lastPage; page++) {
      const data = await fetchPage(page);
      if (data && h.isArray(data.images)) {
        resolved.push(...data.images.map(img => img.original_url).filter(Boolean));
      }
    }

    return {
      folderName: `goonbox_${albumSlug}`,
      resolved,
    };
  },
]);

resolvers.push([
  [/(jpg\d\.(church|fish|fishing|pet|su|cr))|cuckcapital\.cr\//i, /:!jpe?g\d\.(church|fish|fishing|pet|su|cr)(\/a\/|\/album\/)/i],
  url => url.replace('.th.', '.').replace('.md.', '.'),
]);

resolvers.push([
  [/jpe?g\d\.(church|fish|fishing|pet|su|cr)(\/a\/|\/album\/)/i],
  async (url, http, spoilers, postId) => {
    url = url.replace(/\?.*/, '');

    let reFetch = false;

    let { source, dom } = await http.get(url, {
      onStateChange: response => {
        // If it's a redirect, we'll have to fetch the new url.
        if (response.readyState === 2 && response.finalUrl !== url) {
          url = response.finalUrl;
          reFetch = true;
        }
      },
    });

    if (reFetch) {
      const { source: src, dom: d } = await http.get(url);
      source = src;
      dom = d;
    }

    if (h.contains('Please enter your password to continue', source)) {
      const authTokenNode = dom.querySelector('input[name="auth_token"]');
      const authToken = !authTokenNode ? null : authTokenNode.getAttribute('value');

      if (!authToken || !spoilers || !spoilers.length) {
        return null;
      }

      const attemptWithPassword = async password => {
        const { source, dom } = await http.post(
          url,
          `auth_token=${authToken}&content-password=${password}`,
          {},
          {
            Referer: url,
            Origin: 'https://jpg6.su',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        );
        return { source, dom };
      };

      let authenticated = false;

      spoilers = ['ramona'];

      for (const spoiler of spoilers) {
        const { source: src, dom: d } = await attemptWithPassword(spoiler.trim());
        if (!h.contains('Please enter your password to continue', src)) {
          authenticated = true;
          source = src;
          dom = d;
          break;
        }
      }

      if (!authenticated) {
        log.host.error(postId, `::Could not resolve password protected album::: ${url}`, 'jpg6.su');
        return null;
      }
    }

    const resolvePageImages = async dom => {
      const images = [...dom.querySelectorAll('.list-item-image > a > img')]
        .map(img => img.getAttribute('src'))
        .map(url => url.replace('.md.', '.').replace('.th.', '.'));

      const nextPage = dom.querySelector('a[data-pagination="next"]');

      if (nextPage && nextPage.hasAttribute('href')) {
        const { dom } = await http.get(nextPage.getAttribute('href'));
        images.push(...(await resolvePageImages(dom)));
      }

      return images;
    };

    const resolved = await resolvePageImages(dom);

    return {
      dom,
      source,
      folderName: dom.querySelector('meta[property="og:title"]').content.trim(),
      resolved,
    };
  },
]);

resolvers.push([
  [/\/\/ibb.co\/[a-zA-Z0-9-_.]+/, /:!([a-z](\d+)?\.)?ibb.co\/album\/[a-zA-Z0-9_.-]+/],
  async (url, http) => {
    try {
      const { dom } = await http.get(url);
      return dom.querySelector('.header-content-right > a').getAttribute('href');
    } catch (err) {
      url => url;
    }
  },
]);

resolvers.push([[/i\.ibb\.co\/[a-zA-Z0-9-_.]+/, /:!([a-z](\d+)?\.)?ibb.co\/album\/[a-zA-Z0-9_.-]+/], url => url]);

resolvers.push([
  [/([a-z](\d+)?\.)?ibb.co\/album\/[a-zA-Z0-9_.-]+/],
  async (url, http) => {
    const albumId = url.replace(/\?.*/, '').split('/').reverse()[0];
    const { source, dom } = await http.get(url);
    const imageCount = Number(dom.querySelector('span[data-text="image-count"]').innerText);
    const pageCount = Math.ceil(imageCount / 32);
    const authToken = h.re.match(/(?<=auth_token=").*?(?=")/i, source);

    const fetchPageData = async (albumId, page, seekEnd, authToken) => {
      const seek = seekEnd || '';
      const data = `action=list&list=images&sort=date_desc&page=${page}&from=album&albumid=${albumId}&params_hidden%5Blist%5D=images&params_hidden%5Bfrom%5D=album&params_hidden%5Balbumid%5D=${albumId}&auth_token=${authToken}&seek=${seek}&items_per_page=32`;
      const { source: response } = await http.post(
        'https://ibb.co/json',
        data,
        {},
        {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      );

      try {
        const parsed = JSON.parse(response);

        if (parsed && parsed.status_code && parsed.status_code === 200) {
          const html = parsed.html.replace('"', '"');
          return {
            urls: h.re.matchAll(/(?<=data-object=').*?(?=')/gi, html).map(o => JSON.parse(decodeURIComponent(o)).url),
            parsed,
          };
        }

        return { urls: [], parsed };
      } catch (e) {
        return { urls: [], parsed };
      }
    };

    const resolved = [];

    let seekEnd = '';

    for (let i = 1; i <= pageCount; i++) {
      const data = await fetchPageData(albumId, i, seekEnd, authToken);
      seekEnd = data.parsed.seekEnd;
      resolved.push(...data.urls);
    }

    return {
      dom,
      source,
      folderName: dom.querySelector('meta[property="og:title"]').content.trim(),
      resolved,
    };
  },
]);

resolvers.push([
  [/(t|img)(\d+)?\.pixhost.to\//, /:!pixhost.to\/gallery\//],
  url => url.replace(/\/t(\d+)\./gi, 'img$1.').replace(/thumbs\//i, 'images/'),
]);

resolvers.push([
  [/pixhost.to\/gallery\//],
  async (url, http) => {
    const { source, dom } = await http.get(url);

    let imageLinksInput = dom?.querySelector('.share > div:nth-child(2) > input');

    if (h.isNullOrUndef(imageLinksInput)) {
      imageLinksInput = dom?.querySelector('.share > input:nth-child(2)');
    }

    const resolved = h.re
      .matchAll(/(?<=\[img])https:\/\/t\d+.*?(?=\[\/img])/gis, imageLinksInput.getAttribute('value'))
      .map(url => url.replace(/t(\d+)\./gi, 'img$1.').replace(/thumbs\//i, 'images/'));

    return {
      dom,
      source,
      folderName: dom?.querySelector('.link > h2').innerText.trim(),
      resolved,
    };
  },
]);
