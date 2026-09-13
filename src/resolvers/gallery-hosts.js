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
    const page = goonboxPageUrl(url);
    if (!page) return null;
    const id = page.pathname.split('/').pop();
    const data = await goonboxApiJson(http, `/api/images/${id}`, page.href);

    // Only inspect the image and known response wrappers, not related images elsewhere.
    // Preserve the original even if a CDN refuses HEAD/range probes; a failed download
    // is preferable to silently substituting a medium-resolution thumbnail.
    for (const image of [data?.image, data?.data?.image, data?.data, data]) {
      const original = goonboxOriginalUrl(image);
      if (original) return original;
    }
    return null;
  },
]);

resolvers.push([
  [/goonbox\.cr\/a\//],
  async (url, http) => {
    const pageUrl = goonboxPageUrl(url);
    if (!pageUrl) return null;
    const albumSlug = pageUrl.pathname.split('/').pop();
    const fetchPage = page => goonboxApiJson(http, `/api/albums/${albumSlug}/images?page=${page}`, pageUrl.href);

    const first = await fetchPage(1);
    if (!first || !h.isArray(first.images)) return null;

    const resolved = first.images.map(goonboxOriginalUrl).filter(Boolean);
    const lastPage = Number(first.pagination?.last_page || 1);
    if (!Number.isInteger(lastPage) || lastPage < 1 || lastPage > 9999) return null;

    for (let page = 2; page <= lastPage; page++) {
      const data = await fetchPage(page);
      if (data && h.isArray(data.images)) {
        resolved.push(...data.images.map(goonboxOriginalUrl).filter(Boolean));
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
    } catch (err) {}
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
        return null;
      }
    };

    const resolved = [];

    let seekEnd = '';

    for (let i = 1; i <= pageCount; i++) {
      const data = await fetchPageData(albumId, i, seekEnd, authToken);
      if (!data?.parsed) return null;
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
