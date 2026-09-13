const parsers = {
  thread: {
    parseTitle: () => {
      const emojisPattern =
        /[\u{1f300}-\u{1f5ff}\u{1f900}-\u{1f9ff}\u{1f600}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\u{1f191}-\u{1f251}\u{1f004}\u{1f0cf}\u{1f170}-\u{1f171}\u{1f17e}-\u{1f17f}\u{1f18e}\u{3030}\u{2b50}\u{2b55}\u{2934}-\u{2935}\u{2b05}-\u{2b07}\u{2b1b}-\u{2b1c}\u{3297}\u{3299}\u{303d}\u{00a9}\u{00ae}\u{2122}\u{23f3}\u{24c2}\u{23e9}-\u{23ef}\u{25b6}\u{23f8}-\u{23fa}]/gu;
      let parsed = h.stripTags(['a', 'span'], h.element('.p-title-value').innerHTML).replace('/\n/g', '');
      return !settings.naming.allowEmojis ? parsed.replace(emojisPattern, settings.naming.invalidCharSubstitute).trim() : parsed.trim();
    },
    parsePost: post => {
      const messageContent = post.parentNode.parentNode.querySelector('.message-content > .message-userContent');
      const footer = post.parentNode.parentNode.querySelector('footer');
      const messageContentClone = messageContent.cloneNode(true);

      const postIdAnchor = post.querySelector('li:last-of-type > a');
      const postId = /(?<=\/post-).*/i.exec(postIdAnchor.getAttribute('href'))[0];
      const postNumber = postIdAnchor.textContent.replace('#', '').trim();

      // Exclude quoted posts and decorative markup that could produce spurious URL matches.
      ['.contentRow-figure', '.js-unfurl-favicon', 'blockquote', '.button-text > span']
        .flatMap(i => [...messageContentClone.querySelectorAll(i)])
        .forEach(i => {
          if (i.tagName === 'BLOCKQUOTE') {
            // Preserve blockquotes that aren't quoting another post.
            if (i.querySelector('.bbCodeBlock-title')) {
              i.remove();
            }
          } else {
            i.remove();
          }
        });

      [...messageContentClone.querySelectorAll('.contentRow-header > a[href^="https://simpcity.su/threads"]')]
        .map(a => a.parentNode.parentNode.parentNode.parentNode)
        .forEach(i => i.remove());

      // Attachment links wrap JPGX previews; exclude the previews to avoid duplicate downloads.
      try {
        messageContentClone.querySelectorAll('a[href*="/attachments/"] img').forEach(img => img.remove());
      } catch (e) {}

      // Exclude Goonbox thumbnails so its API resolves the originals.
      try {
        messageContentClone.querySelectorAll('a[href*="goonbox.cr"] img').forEach(img => img.remove());
      } catch (e) {}

      // Decode forum redirect/proxy links on the clone so host detection sees the original domains.
      try {
        const __decodeB64Url = s => {
          if (!s) return null;
          let b = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
          while (b.length % 4) b += '=';
          try {
            return atob(b);
          } catch (e) {
            return null;
          }
        };

        const __decodeForumRedirect = href => {
          if (!href) return null;
          try {
            const u = new URL(href, location.origin);
            const p = (u.pathname || '').toLowerCase();

            const looksRedirect = p === '/redirect' || p === '/redirect/' || p.startsWith('/redirect/');
            const looksLinkProxy = p.includes('link-proxy');
            if (!looksRedirect && !looksLinkProxy) return null;

            const to =
              u.searchParams.get('to') ||
              u.searchParams.get('url') ||
              u.searchParams.get('u') ||
              u.searchParams.get('link') ||
              u.searchParams.get('target');
            if (!to) return null;

            const mode = (u.searchParams.get('m') || '').toLowerCase();
            let decoded = null;

            if (mode === 'b64' || mode === 'base64') {
              decoded = __decodeB64Url(to);
            }

            // Some installs omit the mode flag even though `to` is base64.
            if (!decoded) {
              const looksB64 = /^[A-Za-z0-9+/_-]+={0,2}$/.test(to) && to.length >= 16 && to.length % 4 !== 1;
              if (looksB64) decoded = __decodeB64Url(to);
            }

            if (!decoded) {
              try {
                decoded = decodeURIComponent(to);
              } catch (e) {
                decoded = to;
              }
            }

            decoded = String(decoded || '').trim();

            // Some protectors double-encode.
            if (decoded && !/^https?:\/\//i.test(decoded) && /%3a%2f%2f/i.test(decoded)) {
              try {
                const d2 = decodeURIComponent(decoded);
                if (/^https?:\/\//i.test(d2)) decoded = d2;
              } catch (e) {}
            }

            if (!/^https?:\/\//i.test(decoded)) return null;
            return decoded;
          } catch (e) {
            return null;
          }
        };

        const sel = ['a[href*="/redirect/"]', 'a[href^="/redirect"]', 'a[href*="redirect?"]', 'a[href*="link-proxy"]'].join(', ');

        messageContentClone.querySelectorAll(sel).forEach(a => {
          // Some XenForo installs store the redirect/protected URL in different attrs.
          const candidates = [a.getAttribute('href'), a.getAttribute('data-href'), a.getAttribute('data-url')].filter(Boolean);

          for (const c of candidates) {
            const decoded = __decodeForumRedirect(c);
            if (decoded) {
              let finalUrl = decoded;
              a.setAttribute('data-url', finalUrl);
              a.setAttribute('href', finalUrl);
              a.setAttribute('data-xfpd-decoded', '1');
              break;
            }
          }
        });

        // Exclude thumbnails inside decoded links without changing the displayed post.
        try {
          messageContentClone.querySelectorAll('a[data-xfpd-decoded="1"] img').forEach(img => {
            const u = (img.getAttribute('data-url') || img.getAttribute('src') || '').trim();
            if (!u) return;

            let host = '';
            let path = '';
            try {
              const uu = new URL(u, location.origin);
              host = (uu.hostname || '').toLowerCase();
              path = (uu.pathname || '').toLowerCase();
            } catch (e) {}

            const isThumb = host.includes('thumb') || /_t\.(?:jpe?g|png|webp|gif)$/i.test(u) || /\/thumbs?\//i.test(path);

            if (isThumb) img.remove();
          });
        } catch (e) {}
      } catch (e) {}

      const spoilers = [...messageContentClone.querySelectorAll('.bbCodeBlock--spoiler > .bbCodeBlock-content')]
        .filter(s => !s.querySelector('.bbCodeBlock--unfurl'))
        .concat([...messageContentClone.querySelectorAll('.bbCodeInlineSpoiler')].filter(s => !s.querySelector('.bbCodeBlock--unfurl')))
        .map(s => s.innerText)
        .concat(
          h.re
            .matchAll(/(?<=pw|pass|passwd|password)(\s:|:)?\s+?[a-zA-Z0-9~!@#$%^&*()_+{}|:'"<>?\/,;.]+/gis, messageContentClone.innerText)
            .map(s => s.trim()),
        )
        .map(s =>
          s
            .trim()
            .replace(/^:/, '')
            .replace(/\bp:\b/i, '')
            .replace(/\bpw:\b/i, '')
            .replace(/\bkey:\b/i, '')
            .trim(),
        )
        .filter(s => s !== '')
        .unique();

      const postContent = messageContentClone.innerHTML;
      const postTextContent = messageContentClone.innerText;

      const matches = /(?<=\/page-)\d+/is.exec(document.location.pathname);

      const pageNumber = matches && matches.length ? Number(matches[0]) : 1;

      return {
        post,
        postId,
        postNumber,
        pageNumber,
        spoilers,
        footer,
        content: postContent,
        textContent: postTextContent,
        contentContainer: messageContent,
      };
    },
  },
  hosts: {
    parseHosts: postContent => {
      let parsed = [];

      for (const host of hosts) {
        if (host.length < 2) {
          continue;
        }

        const signature = host[0].split(':');
        const matchers = host[1];

        if (!h.isArray(matchers) || !matchers.length) {
          continue;
        }

        const name = signature[0];
        let category = signature.length > 1 ? signature[1] : 'misc';

        let singleMatcherPattern = matchers[0];
        let albumMatcherPattern = matchers.length > 1 ? matchers[1] : null;

        const execMatcher = matcher => {
          let pattern = matcher.toString().replace(/~an@/g, 'a-zA-Z0-9');

          const stripQueryString = h.contains('<no_qs>', pattern.toString());
          const stripTrailingSlash = !h.contains('<keep_ts>', pattern.toString());
          pattern = pattern.replace('<no_qs>', '').replace('<keep_ts>', '');

          if (h.contains('!!', pattern)) {
            pattern = pattern.replace('!!', '');
            pattern = h.re.toRegExp(h.re.toString(pattern), 'igs');
          } else {
            const pat = `(?<=data-url="|src="|href=")${h.re.toString(pattern)}.*?(?=")|https?:\/\/(www.)?${h.re.toString(pattern)}.*?(?=("|<|$|\]|'))`;
            pattern = h.re.toRegExp(pat, 'igs');
          }

          let matches = h.re.matchAll(pattern, postContent).unique();

          matches = matches.map(url => {
            // Trim leaked HTML from URL matches to avoid ghost resources and broken filenames.
            url = String(url || '');
            url = url.replace(/&amp;/g, '&');
            url = url.split(/[\s"'<>]/)[0].trim();
            // Normalize scheme so the same link in different representations dedupes cleanly.
            if (url && !/^https?:\/\//i.test(url)) {
              url = `https://${url}`;
            }

            if (stripQueryString && h.contains('?', url)) {
              url = url.substring(0, url.indexOf('?'));
            }

            if (stripTrailingSlash && url[url.length - 1]) {
              url = url[url.length - 1] === '/' ? url.substring(0, url.length - 1) : url;
            }

            return url.trim();
          });

          return h.unique(matches);
        };

        const categories = category.split(',');

        if (singleMatcherPattern) {
          let singleCategory = [categories[0]].map(c => {
            if (c === 'image' || c === 'video') {
              return `${h.ucFirst(c)}s`;
            }

            if (c.trim() !== '') {
              return h.ucFirst(c);
            }

            return 'Links';
          })[0];

          parsed.push({
            name,
            type: 'single',
            category: singleCategory,
            resources: execMatcher(singleMatcherPattern),
          });
        }

        if (albumMatcherPattern) {
          let albumCategory = categories.length > 1 ? categories[1] : categories[0];

          albumCategory = `${h.ucFirst(albumCategory)} Albums`;

          parsed.push({
            name,
            type: 'album',
            category: albumCategory,
            resources: execMatcher(albumMatcherPattern),
          });
        }
      }

      return parsed
        .map(p => ({
          ...p,
          enabled: true,
          id: Math.round(Math.random() * Number.MAX_SAFE_INTEGER),
        }))
        .filter(p => p.resources.length);
    },
  },
};
