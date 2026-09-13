resolvers.push([
  [/give.xxx\//],
  async (url, http) => {
    const { source, dom } = await http.get(url);
    const profileId = h.re.match(/(?<=profile-id=")\d+/, source);

    const resolved = [];

    let username = null;

    let firstMediaId = null;

    let mediaId = 1;

    let iteration = 1;

    while (true) {
      let endpoint = `https://give.xxx/api/web/v1/accounts/${profileId}/statuses?only_media=true`;
      endpoint += iteration === 1 ? '&min_id=1' : `&max_id=${mediaId}`;
      const { source } = await http.get(endpoint);
      if (h.contains('_v', source)) {
        const parsed = JSON.parse(source);

        if (username === null) {
          username = parsed[0].account.username;
        }

        if (firstMediaId === null) {
          firstMediaId = parsed[0].id;
        } else {
          if (firstMediaId === parsed[0].id) {
            break;
          }
        }
        resolved.push(
          ...parsed.flatMap(i => {
            return i.media_attachments
              .map(a => {
                return a.sizes;
              })
              .map(s => s.large || s.normal || s.small);
          }),
        );
        mediaId = parsed[parsed.length - 1].id;
      } else {
        break;
      }

      iteration++;
    }

    return {
      dom,
      source,
      folderName: username,
      resolved,
    };
  },
]);

resolvers.push([
  [/(?:focus\.)?(?:pixeldrain\.com|pixeldrain\.net|pixeldra\.in)\/[ul]/],
  url => {
    let resolved = url.replace('/u/', '/api/file/').replace('/l/', '/api/list/');
    resolved = h.contains('/api/list', resolved) ? `${resolved}/zip` : resolved;
    resolved = h.contains('/api/file', resolved) ? `${resolved}?download` : resolved;
    return resolved;
  },
]);

resolvers.push([
  [/([~an@]+\.)?pornhub.com\/view_video/],
  async (url, http) => {
    url = url.replace(/([a-zA-Z0-9]+\.)?pornhub/, 'pornhub');

    const resolvePH = async url => {
      const { dom } = await http.get(
        url,
        {},
        {
          referer: url,
          cookie: 'age-verified: 1; platform=tv; cookiesBannerSeen=1; hasVisited=1',
        },
      );
      const script = [...dom.querySelectorAll('script')]
        .map(s => s.innerText)
        .filter(s => /var\smedia_\d+/gis.test(s))
        .map(s => {
          return {
            mediaVars: h.re.matchAll(/var\smedia_\d+=.*?;/gis, s),
            flashVars: s,
          };
        })[0];

      const { mediaVars, flashVars } = script;

      return mediaVars
        .map(m => {
          const cleaned = m
            .replace(/\/\*.*?\*\//gis, '')
            .replace(/var\smedia_\d+=/i, '')
            .replace(';', '');

          return cleaned
            .split('+')
            .map(s => s.trim())
            .map(s => {
              let value = new RegExp(`var ${s}=".*?"`, 'isg').exec(flashVars)[0];
              value = value.replace(/.*?"/i, '').replace(/"/i, '');
              return value;
            })
            .join('');
        })
        .find(url => url.indexOf('pornhub.com/video/get_media?s=') > -1);
    };

    let parsed = null;

    let tries = 0;

    // The media endpoint can initially return invalid JSON, 403s or redirects.
    do {
      const infoURL = await resolvePH(url);

      if (!infoURL) {
        continue;
      }

      try {
        const { source } = await h.http.get(infoURL);
        const json = JSON.parse(source);
        const fetchedFormats = json.reverse();
        const qualities = ['1080', '720', '480', '320', '240'];
        for (const q of qualities) {
          const f = fetchedFormats.find(f => f.quality === q);
          if (f && f.videoUrl) {
            parsed = f.videoUrl;
            break;
          }
        }
      } catch (e) {}
      await h.delayedResolve(1000);
      tries++;
    } while (!parsed && tries < 20);

    return parsed;
  },
]);
