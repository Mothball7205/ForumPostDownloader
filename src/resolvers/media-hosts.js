resolvers.push([
  [/noodlemagazine.com\/watch\//],
  async (url, http) => {
    const { dom } = await http.get(url);
    let playerIFrameUrl = dom.querySelector('#iplayer')?.getAttribute('src');

    if (!playerIFrameUrl) {
      return null;
    }

    playerIFrameUrl = playerIFrameUrl.replace('/player/', 'https://noodlemagazine.com/playlist/');

    const { source } = await http.get(playerIFrameUrl);

    const props = JSON.parse(source || '[]');

    if (props.sources && props.sources.length) {
      return props.sources[0].file;
    }

    return null;
  },
]);

resolvers.push([
  [/spankbang.com\/.*?\/video/],
  async (url, http) => {
    const { source } = await http.get(url);

    let streamData = h.re.matchAll(/(?<=stream_data\s=\s){.*?}.*?(?=;)/gis, source)[0].replace(/'/g, '"');

    streamData = JSON.parse(streamData);

    const qualities = ['240p', '320p', '480p', '720p', '1080p', '4k'].reverse();

    for (const quality of qualities) {
      if (streamData[quality].length) {
        return streamData[quality][0];
      }
    }

    return null;
  },
]);

resolvers.push([
  [/imagebam.com\/(view|gallery)/],
  async (url, http) => {
    const date = new Date();
    date.setTime(date.getTime() + 6 * 60 * 60 * 1000);
    const expires = '; expires=' + date.toUTCString();
    const { source, dom } = await http.get(
      url,
      {},
      {
        cookie: 'nsfw_inter=1' + expires + '; path=/',
      },
    );

    if (h.contains('gallery-name', source)) {
      const resolved = [];

      const imageLinksInput = dom.querySelector('.links.gallery > div:nth-child(2) > div > input');

      const rawImageLinks = h.re.matchAll(/(?<=\[URL=).*?(?=])/gis, imageLinksInput.getAttribute('value'));

      for (const link of rawImageLinks) {
        const { dom } = await http.get(link);
        resolved.push(dom?.querySelector('.main-image')?.getAttribute('src'));
      }

      return {
        dom,
        source,
        folderName: dom?.querySelector('#gallery-name').innerText.trim(),
        resolved,
      };
    } else {
      return dom?.querySelector('.main-image')?.getAttribute('src');
    }
  },
]);

resolvers.push([[/images\d.imagebam.com/], url => url]);

resolvers.push([[/imgvb.com\/images\//, /:!imgvb.com\/album\//], url => url.replace('.th.', '.').replace('.md.', '.')]);

resolvers.push([
  [/imgvb.com\/album\//],
  async (url, http) => {
    const { source, dom } = await http.get(url);
    const resolved = [...dom.querySelectorAll('.image-container > img')]
      .map(i => i.getAttribute('src'))
      .map(url => url.replace('.th.', '.').replace('.md.', '.'));

    return {
      dom,
      source,
      folderName: dom?.querySelector('meta[property="og:title"]').content.trim(),
      resolved,
    };
  },
]);

resolvers.push([
  [/(\/attachments\/|\/data\/video\/)/],
  async url => {
    // Normalize broken "https:///..." and accidental double-scheme cases.
    url = String(url || '').trim();
    url = url.replace(/^https?:\/\/https?:\/\//i, 'https://');
    url = url.replace(/^https?:\/\/\//i, '/');

    // If it's already absolute, keep it (don't rewrite hosts).
    if (/^https?:\/\//i.test(url)) return url;

    if (!url.startsWith('/')) url = '/' + url;

    return `https://simpcity.su${url}`;
  },
]);

resolvers.push([
  [/(thumbs|images)(\d+)?.imgbox.com\//, /:!imgbox.com\/g\//],
  url => url.replace(/_t\./gi, '_o.').replace(/thumbs/i, 'images'),
]);

resolvers.push([
  [/imgbox.com\/g\//],
  async (url, http) => {
    const { source, dom } = await http.get(url);

    const resolved = [...dom?.querySelectorAll('#gallery-view-content > a > img')]
      .map(img => img.getAttribute('src'))
      .map(url => url.replace(/(thumbs|t)(\d+)\./gis, 'images$2.').replace('_b.', '_o.'));

    return {
      dom,
      source,
      folderName: dom?.querySelector('#gallery-view > h1').innerText.trim(),
      resolved,
    };
  },
]);
