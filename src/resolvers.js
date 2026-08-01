const resolvers = [
    [
        [/https?:\/\/nitter\.(.{1,20})\/pic\/(orig\/)?media%2F(.{1,15})/i],
        url => url.replace(/https?:\/\/nitter\.(.{1,20})\/pic\/(orig\/)?media%2F(.{1,15})/i, 'https://pbs.twimg.com/media/$3'),
    ],
    [
        [/imagevenue.com/],
        async (url, http) => {
            const { dom } = await http.get(url);
            return dom.querySelector('.col-md-12 > a > img').getAttribute('src');
        },
    ],
    [[/pomf2.lain.la/], url => url.replace(/pomf2.lain.la\/f\/(.*)\.(\w{3,4})(\?.*)?/, 'pomf2.lain.la/f/$1.$2')],
    [[/coomer.st\/(data|thumbnail)/], url => url],
    [
        [/coomer.st/, /:!coomer.st\/(data|thumbnail)/],
        async (url, http) => {
            const host = `https://coomer.st`;

            const profileId = url.replace(/\?.*/, '').split('/').reverse()[0];

            let finalURL = url.replace(/\?.*/, '');

            let nextPage = null;

            const posts = [];

            console.log(`[coomer.st] Resolving profile: ${profileId}`);

            let page = 1;

            do {
                const { dom } = await http.get(finalURL);

                const links = [...dom.querySelectorAll('.card-list__items > article')]
                .map(a => a.querySelector('.post-card__heading > a'))
                .map(a => {
                    return {
                        link: `${host}${a.getAttribute('href')}`,
                        id: a.getAttribute('href').split('/').reverse()[0],
                    };
                });

                posts.push(...links);
                nextPage = dom.querySelector('a[title="Next page"]');

                if (nextPage) {
                    finalURL = `${host}${nextPage.getAttribute('href')}`;
                }

                console.log(`[coomer.st] Resolved page: ${page}`);

                page++;
            } while (nextPage);

            const resolved = [];

            let index = 1;

            for (const post of posts) {
                const { dom } = await http.get(post.link);
                const filesContainer = dom.querySelector('.post__files');

                if (filesContainer) {
                    const images = filesContainer.querySelectorAll('.post__thumbnail > .fileThumb');

                    if (images.length) {
                        resolved.push(
                            ...[...images].map(a => {
                                return {
                                    url: `${host}${a.getAttribute('href')}`,
                                    folderName: post.id,
                                };
                            }),
                        );
                    }
                }

                const attachments = dom.querySelectorAll('.post__attachments > .post__attachment > .post__attachment-link');

                if (attachments.length) {
                    resolved.push(
                        ...[...attachments].map(a => {
                            const url = `${host}${a.getAttribute('href')}`;

                            let folder = 'Images';

                            const ext = h.ext(url.replace(/\?.*/, ''));

                            if (settings.extensions.video.includes(`.${ext.toLowerCase()}`)) {
                                folder = 'Videos';
                            }

                            {
                                return {
                                    url,
                                    folderName: `${post.id}/${folder}`,
                                };
                            }
                        }),
                    );
                }

                console.log(`[coomer.st] Resolved post ${index} / ${posts.length}`);

                index++;
            }

            return {
                folderName: profileId,
                resolved,
            };
        },
    ],
    [
        [/(postimg|pixxxels).cc/],
        async (url, http) => {
            url = url.replace(/https?:\/\/(www.)?i\.?(postimg|pixxxels).cc\/(.{8})(.*)/, 'https://postimg.cc/$3');
            const { dom } = await http.get(url);
            return dom.querySelector('.controls > nobr > a').getAttribute('href');
        },
    ],
    [[/kemono.cr\/data/], url => url],
    [
        [/goonbox\.cr\/img\//],
        async (url, http) => {
            const id = url.split('/').pop().split('?')[0];
            const fallback = goonboxThumbByUrl.get(url.replace(/\?.*/, '').replace(/\/$/, '')) || null;

            const { source } = await http.get(
                `https://goonbox.cr/api/images/${id}`,
                {},
                { Referer: url, Accept: 'application/json' },
                'text',
            );

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
    ],
    [
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
    ],
    [
        [/(jpg\d\.(church|fish|fishing|pet|su|cr))|cuckcapital\.cr\//i, /:!jpe?g\d\.(church|fish|fishing|pet|su|cr)(\/a\/|\/album\/)/i],
        url =>
        url
        .replace('.th.', '.')
        .replace('.md.', '.')
    ],
    [
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
                .map(url =>
                     url
                     .replace('.md.', '.')
                     .replace('.th.', '.')
                    );

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
    ],
    [
        [/\/\/ibb.co\/[a-zA-Z0-9-_.]+/, /:!([a-z](\d+)?\.)?ibb.co\/album\/[a-zA-Z0-9_.-]+/],
        async (url, http) => {
            try{
                const { dom } = await http.get(url);
                return dom.querySelector('.header-content-right > a').getAttribute('href');
            } catch (err){
                url => url;
            }
        },
    ],

    [[/i\.ibb\.co\/[a-zA-Z0-9-_.]+/, /:!([a-z](\d+)?\.)?ibb.co\/album\/[a-zA-Z0-9_.-]+/], url => url],
    [
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
    ],
    [[/(t|img)(\d+)?\.pixhost.to\//, /:!pixhost.to\/gallery\//], url => url.replace(/\/t(\d+)\./gi, 'img$1.').replace(/thumbs\//i, 'images/')],
    [
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
    ],
    [
        [/((stream|cdn(\d+)?)\.)?bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org).*?\.|((i|cdn)(\d+)?\.)?bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org)\/(v\/)?/i, /:!bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org)\/a\//],
        async (url, http) => {
            try {
                const cleanUrl = String(url || '').split('#')[0];

                // If this already looks like a direct media file URL, keep it (don't call /api/vs).
                // (CDN links usually include the real filename already.)
                if (
                    /\.(?:mp4|m4v|webm|mov|mkv|jpg|jpeg|png|gif|webp|zip|rar|7z|pdf)(?:$|\?)/i.test(cleanUrl) &&
                    !/\/(?:v|f|d)\//i.test(cleanUrl)
                ) {
                    return cleanUrl;
                }

                const u = new URL(cleanUrl);
                const origin = u.origin;
                const pathname = u.pathname || '';

                const segments = pathname.split('/').filter(Boolean);
                const index = segments.findIndex(s => ['f', 'v', 'd'].includes(s));
                const id = index > -1 ? segments.slice(index + 1).join('/') : segments.pop();
                let bunkrDataId = null;

// Best-effort: read the human filename from the view page (og:title / h1 / <title>).
// This lets us rename CDN GUID links back to the original filename.
try {
    const strip = (s) => String(s || '').split('#')[0].split('?')[0];
    const bases = xfpdBunkrFilterBases([origin, 'https://bunkr.pk', 'https://bunkr.cr']);

    for (const base of bases) {
        const base0 = String(base || '').replace(/\/$/, '');
        const candidates = [];
        if (/\/v\//i.test(pathname) && base0 === origin) candidates.push(cleanUrl);
        candidates.push(`${base0}/v/${id}`);
        candidates.push(`${base0}/f/${id}`);

        const uniq = candidates.filter((v, i, a) => a.indexOf(v) === i);
        let found = false;

        for (const viewUrl of uniq) {
            const viewRes = await xfpdBunkrGetWithCfRetry(http, viewUrl, base0, base0 === 'https://bunkr.cr');
            const dom = viewRes?.dom;
            const viewSource = viewRes?.source || '';

            // If Cloudflare interstitial is active, don't capture a bogus "Just a moment..." title as a filename hint.
            if (xfpdLooksLikeCfChallenge(viewSource, dom)) continue;

            if (!bunkrDataId) {
                bunkrDataId = dom?.querySelector?.('[data-file-id]')?.getAttribute?.('data-file-id') || null;
            }

            let title =
                dom?.querySelector?.('meta[property="og:title"]')?.getAttribute?.('content') ||
                dom?.querySelector?.('h1')?.textContent ||
                dom?.querySelector?.('title')?.textContent ||
                '';
            title = String(title || '').replace(/\s+/g, ' ').trim();
            title = title.replace(/\s*\|\s*Bunkr\s*$/i, '').trim();

            if (title && !xfpdLooksLikeCfFilenameHint(title)) {
                bunkrNameByUrl.set(cleanUrl, title);
                bunkrNameByUrl.set(strip(cleanUrl), title);
                bunkrNameByUrl.set(viewUrl, title);
                bunkrNameByUrl.set(strip(viewUrl), title);
                found = true;
                break;
            }
        }

        if (found) break;
    }
} catch (e) {}

                const decodeFinalUrl = data => {
                    try {
                        if (!data || !data.url) return null;
                        if (!data.encrypted) return data.url;

                        const binaryString = atob(data.url);
                        const keyBytes = new TextEncoder().encode(`SECRET_KEY_${Math.floor(data.timestamp / 3600)}`);

                        return Array.from(binaryString)
                            .map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ keyBytes[i % keyBytes.length]))
                            .join('');
                    } catch (e) {
                        return null;
                    }
                };

                const tryNewApi = async () => {
                    if (!bunkrDataId) return null;
                    try {
                        const refererUrl = `https://get.bunkrr.su/file/${bunkrDataId}`;
                        const response = await http.post(
                            'https://apidl.bunkr.ru/api/_001_v2',
                            JSON.stringify({ id: bunkrDataId }),
                            {},
                            {
                                'Content-Type': 'application/json',
                                Referer: refererUrl,
                                Origin: 'https://get.bunkrr.su',
                            }
                        );
                        const text = String(response?.source || '');
                        if (!text) return null;
                        const data = JSON.parse(text);
                        if (!data) return null;

                        let finalUrl = decodeFinalUrl(data);
                        if (!finalUrl || typeof finalUrl !== 'string') return null;
                        finalUrl = finalUrl.trim();
                        if (finalUrl.startsWith('//')) finalUrl = 'https:' + finalUrl;

                        finalUrl = await xfpdBunkrSignCdnUrl(http, finalUrl);

                        try {
                            const strip = (s) => String(s || '').split('#')[0].split('?')[0];
                            const hint =
                                xfpdBunkrExtractNameFromVsData(data) ||
                                bunkrNameByUrl.get(cleanUrl) ||
                                bunkrNameByUrl.get(strip(cleanUrl)) ||
                                '';
                            if (hint && String(hint).trim()) {
                                const h0 = String(hint).trim();
                                bunkrNameByUrl.set(cleanUrl, h0);
                                bunkrNameByUrl.set(strip(cleanUrl), h0);
                                bunkrNameByUrl.set(finalUrl, h0);
                                bunkrNameByUrl.set(strip(finalUrl), h0);
                            }
                        } catch (e) {}

                        return finalUrl;
                    } catch (e) {
                        return null;
                    }
                };

                const finalURL = await tryNewApi();
                return finalURL || cleanUrl;
            } catch (error) {
                console.error(error?.message || error);
                return url;
            }
        },
    ],
[
    [/bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|su|org)\/a\//],
    async (url, http, _, __, ___, progressCB) => {
        const cleanUrl = String(url || '').split('#')[0];
        const baseUrl = cleanUrl.split('?')[0].replace(/\/+$/, '');

        const resolved = [];
        const seen = new Set();

        // Bunkr album: keep the human filename from the album grid (title / .theName) and attach it to resolved CDN URLs.
        const nameHintBySlug = new Map();

        let firstDom = null;
        let firstSource = null;

        const sanitizeName = s => String(s || '')
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/\s+/g, ' ')
            .trim();

        const decodeFinalUrl = data => {
            try {
                if (!data || !data.url) return null;
                if (!data.encrypted) return data.url;

                const binaryString = atob(data.url);
                const keyBytes = new TextEncoder().encode(`SECRET_KEY_${Math.floor(data.timestamp / 3600)}`);

                return Array.from(binaryString)
                    .map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ keyBytes[i % keyBytes.length]))
                    .join('');
            } catch (e) {
                return null;
            }
        };

        const extractSlugsFromDom = dom => {
            const containers = dom?.querySelectorAll?.('.grid-images > div') || [];
            const slugs = [];

            for (const c of containers) {
                const a =
                    c.querySelector('a[class="after:absolute after:z-10 after:inset-0"]') ||
                    c.querySelector('a[href*="/f/"]') ||
                    c.querySelector('a[href*="/v/"]') ||
                    c.querySelector('a[href*="/d/"]');

                const href = a?.getAttribute?.('href') || '';
                const m = href.match(/\/(f|v|d)\/([^\/?#]+)/i);
                if (m && m[2]) {
                    const slug = m[2];
                    slugs.push(slug);

                    // Name hint is visible on /a/ pages (e.g. <div title="...mp4"> or .theName). Use it later when we only have a CDN GUID URL.
                    try {
                        let hint = c?.getAttribute?.('title') || '';
                        if (!hint) hint = c?.querySelector?.('.theName')?.textContent || '';
                        if (!hint) hint = c?.querySelector?.('p.truncate')?.textContent || '';
                        if (!hint) hint = c?.querySelector?.('.grid-images_box-txt p')?.textContent || '';
                        hint = String(hint || '').replace(/\s+/g, ' ').trim();
                        if (hint) nameHintBySlug.set(slug, hint);
                    } catch (e) {}
                }
            }

            return slugs;
        };

        const asyncPool = async (limit, items, worker) => {
            const results = new Array(items.length);
            let i = 0;

            const runners = Array.from({ length: Math.max(1, limit) }, async () => {
                while (true) {
                    const idx = i++;
                    if (idx >= items.length) break;
                    try {
                        results[idx] = await worker(items[idx], idx);
                    } catch (e) {
                        results[idx] = null;
                    }
                }
            });

            await Promise.all(runners);
            return results;
        };

        const origin = (() => {
            try { return new URL(baseUrl).origin; } catch (e) { return 'https://bunkr.cr'; }
        })();

        const vsBasesAll = [origin, 'https://bunkr.pk', 'https://bunkr.cr'].filter((v, i, a) => a.indexOf(v) === i);

        let folderName = null;

        const MAX_PAGES = 500;
        const CONCURRENCY = 8;

        const albumUrlObj = (() => {
            try { return new URL(baseUrl); } catch (e) { return null; }
        })();
        const albumPath = (albumUrlObj && albumUrlObj.pathname) ? albumUrlObj.pathname : (() => {
            try { return new URL(cleanUrl).pathname; } catch (e) { return '/'; }
        })();
        const albumBasesAll = [origin, 'https://bunkr.pk', 'https://bunkr.cr'].filter((v, i, a) => a.indexOf(v) === i);
        let albumBaseChosen = null;

        for (let page = 1; page <= MAX_PAGES; page++) {
            const requestedPageUrl = `${baseUrl}?page=${page}`;

            if (typeof progressCB === 'function') {
                progressCB(`Resolving: ${requestedPageUrl}`);
            }

            const pageBases = albumBaseChosen
                ? [albumBaseChosen, ...xfpdBunkrFilterBases(albumBasesAll).filter(b => b !== albumBaseChosen)]
                : xfpdBunkrFilterBases(albumBasesAll);

            let dom = null, source = '';
            let pageUrl = requestedPageUrl;
            let slugs = [];

            for (const base of pageBases) {
                const base0 = String(base || '').replace(/\/$/, '');
                const candidate = `${base0}${albumPath}?page=${page}`;
                pageUrl = candidate;

                try {
                    ({ dom, source } = await xfpdBunkrGetWithCfRetry(http, candidate, base0, base0 === 'https://bunkr.cr'));
                } catch (e) {
                    dom = null;
                    source = '';
                }

                if (xfpdLooksLikeCfChallenge(source, dom)) continue;

                slugs = extractSlugsFromDom(dom);
                if (page === 1 && !slugs.length) {
                    continue;
                }

                if (!albumBaseChosen) albumBaseChosen = base0;
                break;
            }

            if (!dom) break;
            if (!slugs.length) break;
if (page === 1) {
                firstDom = dom;
                firstSource = source;

                const h1 = dom?.querySelector?.('h1');
                const title = (h1?.innerText || h1?.textContent || '').split('\n')[0]?.trim();
                if (title) folderName = sanitizeName(title);
            }

            const fresh = [];
            for (const s of slugs) {
                if (!s || seen.has(s)) continue;
                seen.add(s);
                fresh.push(s);
            }

            if (!fresh.length) break;

            const urls = await asyncPool(CONCURRENCY, fresh, async (slug) => {
                // Fetch /f/{slug} to get the numeric file ID required by the new API.
                const fileBase = String(albumBaseChosen || origin || 'https://bunkr.cr').replace(/\/$/, '');
                const filePageUrl = `${fileBase}/f/${slug}`;
                let dataId = null;
                try {
                    const fileRes = await xfpdBunkrGetWithCfRetry(http, filePageUrl, fileBase, fileBase === 'https://bunkr.cr');
                    const fileDom = fileRes?.dom;
                    if (fileDom && !xfpdLooksLikeCfChallenge(fileRes?.source || '', fileDom)) {
                        dataId = fileDom?.querySelector?.('[data-file-id]')?.getAttribute?.('data-file-id') || null;
                    }
                } catch (e) {}
                if (!dataId) return null;

                let data = null;
                try {
                    const refererUrl = `https://get.bunkrr.su/file/${dataId}`;
                    const response = await http.post(
                        'https://apidl.bunkr.ru/api/_001_v2',
                        JSON.stringify({ id: dataId }),
                        {},
                        {
                            'Content-Type': 'application/json',
                            Referer: refererUrl,
                            Origin: 'https://get.bunkrr.su',
                        }
                    );
                    const text = String(response?.source || '');
                    data = text ? JSON.parse(text) : null;
                } catch (e) {}
                if (!data) return null;

                let finalUrl = decodeFinalUrl(data);
                if (!finalUrl || typeof finalUrl !== 'string') return null;
                finalUrl = finalUrl.trim();
                if (finalUrl.startsWith('//')) finalUrl = 'https:' + finalUrl;

                finalUrl = await xfpdBunkrSignCdnUrl(http, finalUrl);

                try {
                    const strip = (s) => String(s || '').split('#')[0].split('?')[0];
                    const hint = nameHintBySlug.get(slug) || xfpdBunkrExtractNameFromVsData(data) || '';
                    if (hint && String(hint).trim()) {
                        const h0 = String(hint).trim();
                        bunkrNameByUrl.set(finalUrl, h0);
                        bunkrNameByUrl.set(strip(finalUrl), h0);
                    }
                } catch (e) {}

                return finalUrl;
            });

            for (const u of urls) if (u) resolved.push(u);
        }

        if (!folderName) folderName = h.basename(baseUrl);

        return {
            dom: firstDom,
            source: firstSource,
            folderName,
            resolved,
        };
    }
],

    [
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
    ],
    [
        [/(?:focus\.)?(?:pixeldrain\.com|pixeldrain\.net|pixeldra\.in)\/[ul]/],
        url => {
            let resolved = url.replace('/u/', '/api/file/').replace('/l/', '/api/list/');
            resolved = h.contains('/api/list', resolved) ? `${resolved}/zip` : resolved;
            resolved = h.contains('/api/file', resolved) ? `${resolved}?download` : resolved;
            return resolved;
        },
    ],
    [
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

            // Scumbag pornhub won't send the right json link the first time.
            // Still, there are ocassional 403s / redirects.
            // TODO: Fix me
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
    ],
    [
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

        // GoFile no longer uses the static appdata.wt from config.js for /contents.
        // The website now derives a per-request X-Website-Token from the account token
        // via generateWT() in https://gofile.io/dist/js/wt.obf.js, i.e.:
        //   WT = sha256(navigator.userAgent + "::" + navigator.language + "::" + token + "::<time>::<salt>")
        // <time> is NOT a static value -- it's Math.floor(Date.now() / 1000 / 14400) (a
        // 4-hour bucket), recomputed live inside generateWT() itself. <salt> is the one
        // actual fixed constant, which can still change whenever GoFile updates the file.
        // We fetch the script live, eval it in a scoped Function (it only reads navigator,
        // and the function declaration stays local, not leaked to global), and cache the
        // source for a day -- safe because we call the eval'd generateWT() fresh on every
        // request, so Date.now() is always evaluated at call time, not baked in when the
        // source was cached. WT must be computed with the same UA/language the request is
        // sent with; the language is also echoed back to the server via the X-BL header.
        let cachedGenerateWT = null;

        const getGenerateWT = async (force = false) => {
            if (!force && cachedGenerateWT) return cachedGenerateWT;

            const now = Date.now();
            const cached = gmGet(WT_KEY, null);
            let src =
                !force && cached && cached.src && cached.ts && now - cached.ts < WT_MAX_AGE_MS
                    ? cached.src
                    : null;

            if (!src) {
                const { source } = await gmReq('GET', 'https://gofile.io/dist/js/wt.obf.js', null, {}, 'text');
                src = source || '';
                if (!src || !/generateWT/.test(src)) {
                    throw new Error('Could not fetch GoFile wt.obf.js (generateWT).');
                }
                gmSet(WT_KEY, { src, ts: now });
            }

            try {
                const factory = new Function(
                    'navigator',
                    `${src}\nreturn (typeof generateWT === 'function') ? generateWT : null;`,
                );
                const fn = factory(navigator);
                if (typeof fn !== 'function') throw new Error('no generateWT');
                cachedGenerateWT = fn;
                return fn;
            } catch (e) {
                throw new Error('Could not evaluate GoFile generateWT().');
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

            // Sync/activate the fresh guest token server-side. The website does this via
            // GET /accounts/website before it will resolve /contents for that token.
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
            // If the user provided a personal Bearer token, always use it.
            // (This is optional; leaving it empty keeps the anonymous account-token flow.)
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
            const params = [
                'contentFilter=',
                'page=1',
                'pageSize=1000',
                'sortField=createTime',
                'sortDirection=-1',
            ];
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

            const getChildAlbums = async (props, spoilers) => {
                if (!props || props.status !== 'ok' || !props.data || !props.data.children) {
                    return [];
                }

                const resolved = [];

            folderName = props.data.name || folderName;

                const files = props.data.children;

                for (const file in files) {
                    const obj = files[file];

                if (!obj) continue;

                    if (obj.type === 'file') {
                    const fileId = obj.id || obj.code;
                    const fileName = encodeURIComponent(obj.name || fileId || 'file');

                    // Prefer direct/CDN links when available. Do NOT force /download/web/
                    // (web flow can return album HTML).
                    const candidates = [obj.directLink, obj.link, obj.downloadLink].filter(Boolean);
                    let link =
                        candidates.find(u => /\/download\/direct\//i.test(String(u))) ||
                        candidates[0] ||
                        (fileId ? `https://gofile.io/download/web/${fileId}/${fileName}` : null);

                    if (link) {
                        // Preserve original GoFile filename (from API) so we don't rely on URL-encoded path segment.
                        try {
                            if (obj.name) {
                                if (fileId) gofileNameById.set(String(fileId), String(obj.name));
                                if (link) gofileNameByUrl.set(String(link), String(obj.name));
                            }
                        } catch (e) {}resolved.push(link);
                    }
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
    ],
    [
        [/cyberfile.(su|me)\//, /:!cyberfile.(su|me)\/folder\//],
        async (url, http, spoilers) => {
            const { source } = await http.get(url);
            const u = h.re.matchAll(/(?<=showFileInformation\()\d+(?=\))/gis, source)[0];

            const getFileInfo = async () => {
                const { source } = await http.post(
                    'https://cyberfile.me/account/ajax/file_details',
                    `u=${u}`,
                    {},
                    {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                );
                return source;
            };

            let response = await getFileInfo();

            let requiredPassword = false;
            let unlocked = false;

            if ((h.contains('albumPasswordModel', response) || h.contains('This folder requires a password', response)) && spoilers.length) {
                const html = JSON.parse(response).html;

                const matches = /value="(\d+)"\sid="folderId"|value="(\d+)"\sname="folderId"/is.exec(html);

                const folderId = matches.length ? matches[1] : null;

                if (!folderId) {
                    return null;
                }

                requiredPassword = true;
                for (const password of spoilers) {
                    const { source } = await http.post(
                        'https://cyberfile.me/ajax/folder_password_process',
                        `submitme=1&folderId=${folderId}&folderPassword=${password}`,
                        {},
                        {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                    );

                    if (h.contains('success', source) && JSON.parse(source).success === true) {
                        unlocked = true;
                        break;
                    }
                }
            }

            if (requiredPassword && unlocked) {
                response = await getFileInfo();
            }

            return h.re.matchAll(/(?<=openUrl\(').*?(?=')/gi, response)[0]?.replace(/\\\//gi, '/');
        },
    ],
    [
        [/cyberfile.(su|me)\/folder\//],
        async (url, http, spoilers) => {
            const { source, dom } = await http.get(url);

            const script = [...dom.querySelectorAll('script')].map(s => s.innerText).filter(s => h.contains('data-toggle="tab"', s))[0];

            const nodeId = h.re.matchAll(/(?<='folder',\s').*?(?=')/gis, script);

            const loadFiles = async () => {
                const { source } = await http.post(
                    'https://cyberfile.me/account/ajax/load_files',
                    `pageType=folder&nodeId=${nodeId}`,
                    {},
                    {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                );
                return source;
            };

            let response = await loadFiles();

            let requiredPassword = false;
            let unlocked = false;

            if ((h.contains('albumPasswordModel', response) || h.contains('This folder requires a password', response)) && spoilers.length) {
                requiredPassword = true;
                for (const password of spoilers) {
                    const { source } = await http.post(
                        'https://cyberfile.me/ajax/folder_password_process',
                        `submitme=1&folderId=${nodeId}&folderPassword=${password}`,
                        {},
                        {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                    );

                    if (h.contains('success', source) && JSON.parse(source).success === true) {
                        unlocked = true;
                        break;
                    }
                }
            }

            if (!unlocked) {
                return null;
            }

            if (requiredPassword && unlocked) {
                response = await loadFiles();
            }

            const resolved = [];

            let folderName = h.basename(url);

            const props = JSON.parse(response);

            if (props && props.html) {
                folderName = props.page_title || folderName;

                const urls = h.re.matchAll(/(?<=dtfullurl=").*?(?=")/gis, props.html);

                for (const fileUrl of urls) {
                    const { source } = await http.get(fileUrl);
                    const u = h.re.matchAll(/(?<=showFileInformation\()\d+(?=\))/gis, source)[0];
                    const { source: response } = await http.post(
                        'https://cyberfile.me/account/ajax/file_details',
                        `u=${u}`,
                        {},
                        {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                    );
                    resolved.push(h.re.matchAll(/(?<=openUrl\(').*?(?=')/gi, response)[0]?.replace(/\\\//gi, '/'));
                }
            }

            return {
                dom,
                source,
                folderName,
                resolved,
            };
        },
    ],
    [
        [/([\w-]+\.)?turbo\.cr\/a\//],
        async (url, http) => {
            const { dom, source } = await http.get(url);

            // Album folder naming (stable + readable): turbo_<albumId> - <title>
            const mAlbum = url.match(/\/a\/([^\/?#]+)/i);
            const albumId = mAlbum ? mAlbum[1] : null;
            const base = albumId ? `turbo_${albumId}` : 'turbo_album';

            const rawTitle = dom?.querySelector('h1')?.textContent?.trim() || '';
            const invalidSub = settings.naming.invalidCharSubstitute || '_';

            let safeTitle = rawTitle
            .replace(/[\\/:*?"<>|]/g, invalidSub)
            .replace(/\s+/g, ' ')
            .trim();

            // Cap title to avoid extremely long Windows paths
            if (safeTitle.length > 120) safeTitle = safeTitle.slice(0, 120).trim();

            let folderName = base;
            if (safeTitle && safeTitle.toLowerCase() !== base.toLowerCase()) {
                folderName = `${safeTitle} - ${base}`;
            }

            // Final sanitize (defensive)
            folderName = folderName
                .replace(/[\\/:*?"<>|]/g, invalidSub)
                .replace(/\s+/g, ' ')
                .trim();

            // Hard cap for safety
            if (folderName.length > 180) folderName = folderName.slice(0, 180).trim();

            // Map videoId -> original filename (from album HTML)
            const idToName = new Map();

            // Collect video ids (and names) from the table rows (server-rendered HTML)
            let ids = Array.from(dom?.querySelectorAll('tr.file-row') || [])
            .map(row => {
                const a = row.querySelector('a[href^="/v/"]');
                const id = (a?.getAttribute('href') || '').match(/\/v\/([^\/?#]+)/i)?.[1];
                if (id) {
                    const nm = row.getAttribute('data-name') || row.dataset?.name;
                    if (nm) idToName.set(id, nm);
                }
                return id;
            })
            .filter(Boolean)
            .unique();

            // Fallback: regex scan (if DOM parsing fails)
            if (!ids.length && source) {
                ids = (source.match(/href="\/v\/([^"?#]+)"/gi) || [])
                    .map(s => (s.match(/\/v\/([^"?#]+)/i) || [null, null])[1])
                    .filter(Boolean)
                    .unique();
            }

            const resolved = [];

            for (const id of ids) {
                const embedUrl = `https://turbo.cr/embed/${id}`;
                let signed = null;
                try {
                    signed = await xfpdTurboSignUrlWithTimeout(id, embedUrl, idToName.get(id));
                } catch (e) {}

// Fallback: if signing fails, try to read media URL from the embed page
                if (!signed) {
                    try {
                        const { dom: edom } = await http.get(embedUrl, {}, { Referer: embedUrl });
                        const src =
                              edom?.querySelector('source[src]')?.getAttribute('src') ||
                              edom?.querySelector('video[src]')?.getAttribute('src');
                        if (src) {
                            signed = new URL(src, embedUrl).toString();
                        }
                    } catch (e) {}
                }

                // If we got a Turbo CDN URL and have an original name, attach fn=
                if (signed && /turbocdn\.st/i.test(signed)) {
                    const originalName = idToName.get(id);
                    if (originalName && !/[?&]fn=/.test(signed)) {
                        const enc = encodeURIComponent(String(originalName)).replace(/%20/g, '+');
                        signed += (signed.includes('?') ? '&' : '?') + 'fn=' + enc;
                    }
                }

                // If sign fails, keep a workable fallback
                if (signed && id) {
                    try { turboIdBySignedUrl.set(String(signed), String(id)); } catch (e) {}
                }
                resolved.push(signed || `https://turbo.cr/d/${id}`);
            }

            return {
                dom,
                source,
                folderName,
                resolved,
            };
        },
    ],
    [
        [/([\w-]+\.)?turbo\.cr\/(v|d)\//],
        async (url, http) => {
            const mm = url.match(/\/(v|d)\/([^\/?#]+)/i);
            let id = mm ? mm[2] : null;
            if (!id) {
                return url;
            }

            const embedUrl = `https://turbo.cr/embed/${id}`;
            try {
                const signed = await xfpdTurboSignUrlWithTimeout(id, embedUrl, null);
                if (signed) return signed;
            } catch (e) {}

// Fallback: try to read <source>/<video> directly from the embed page
            try {
                const { dom } = await http.get(embedUrl, {}, { Referer: embedUrl });
                const src =
                      dom?.querySelector('source[src]')?.getAttribute('src') ||
                      dom?.querySelector('video[src]')?.getAttribute('src');
                if (src) {
                    return new URL(src, embedUrl).toString();
                }
            } catch (e) {}

            // Last fallback: the site's direct download route
            return `https://turbo.cr/d/${id}`;
        },
    ],
    [[/public.onlyfans.com\/files/], async url => url],
    [
        [/([\w-]+\.)?turbo\.cr\/embed/],
        async (url, http) => {
            const m = url.match(/\/embed\/([^\/?#]+)/i);
            const id = m ? m[1] : null;
            if (!id) {
                return null;
            }

            const embedUrl = `https://turbo.cr/embed/${id}`;
            try {
                const signed = await xfpdTurboSignUrlWithTimeout(id, embedUrl, null);
                if (signed) return signed;
            } catch (e) {}

// Fallback: try to read <source> / <video> directly if present
            try {
                const { dom } = await http.get(embedUrl, {}, { Referer: embedUrl });
                const src =
                      dom?.querySelector('source[src]')?.getAttribute('src') ||
                      dom?.querySelector('video[src]')?.getAttribute('src');
                if (src) {
                    return new URL(src, embedUrl).toString();
                }
            } catch (e) {}

            return null;

        },
    ],

    [
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

            const tryFetchPage = async (page) => {
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

                const gifs = Array.isArray(j?.gifs) ? j.gifs : (Array.isArray(j?.results) ? j.results : []);
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
    ],
[
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
    ],

    [
        [/fs-\d+\.cyberdrop\.[a-z]{2,}\/|cyberdrop\.[a-z]{2,}\/a\//],
        async (url, http, passwords, postId, postSettings, progressCB) => {
            // Cyberdrop albums (/a/<id>) are HTML pages listing many /f/<id> file links.
            // Resolve the album to a list of signed CDN URLs via the file auth API (no per-file warm-up tabs).
            try {
                url = String(url || '').trim();
                if (url.startsWith('//')) url = 'https:' + url;
                if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');

                const albumIdMatch = url.match(/\/a\/([^\/?#]+)/i);
                const albumId = albumIdMatch ? albumIdMatch[1] : '';

                const pageUrl = url;
                let pageOrigin = 'https://cyberdrop.cr';
                try { pageOrigin = new URL(pageUrl).origin; } catch (e) {}

                const decodeHtml = (s) => {
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
                    const r = await http.get(pageUrl, {}, {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Referer': pageOrigin + '/',
                        'Origin': pageOrigin,
                    }, 'text');
                    return r && r.source ? r.source : '';
                };

                let html = await getAlbumHtml();

                const extractSlugs = (src) => {
                    const slugs = [];
                    const seen = new Set();
                    const re = /href\s*=\s*["'](?:https?:\/\/(?:[\w-]+\.)*cyberdrop\.[a-z.]+)?\/f\/([A-Za-z0-9_-]+)(?:[\/?#"'])/ig;
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

                const pickTitle = (src) => {
                    const m1 = src.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                               src.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
                    const m2 = src.match(/<h1[^>]*>([^<]+)<\/h1>/i);
                    const m3 = src.match(/<title[^>]*>([^<]+)<\/title>/i);
                    let t = (m1 && (m1[1] || m1[2])) || (m2 && m2[1]) || (m3 && m3[1]) || '';
                    t = decodeHtml(t).trim();
                    // Strip common site suffixes
                    t = t.replace(/\s*\|\s*CyberDrop.*$/i, '').replace(/\s*-\s*CyberDrop.*$/i, '').trim();
                    if (!t) t = albumId ? `cyberdrop_${albumId}` : 'cyberdrop_album';
                    return t;
                };

                const folderName = pickTitle(html);

                // Capture per-file names from the album page so downloads keep extensions.
                try {
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const nodes = doc.querySelectorAll('a#file[href^="/f/"], a[id="file"][href^="/f/"], a[href^="/f/"][title][href^="/f/"]');
                    nodes.forEach((a) => {
                        const href = a.getAttribute('href') || '';
                        const m = href.match(/\/f\/([A-Za-z0-9]+)/);
                        if (!m) return;
                        const slug = m[1];
                        const nm = (a.getAttribute('title') || a.textContent || '').trim();
                        if (nm) cyberdropNameBySlug.set(slug, nm);
                    });
                } catch (e) { /* ignore */ }

                // Regex fallback (in case DOMParser is blocked).
                try {
                    const rxName = /href=["']\/f\/([A-Za-z0-9]+)["'][^>]*\btitle=["']([^"']+)["']/gi;
                    let m;
                    while ((m = rxName.exec(html)) !== null) {
                        const slug = m[1];
                        const nm = decodeHtml(m[2]).trim();
                        if (nm) cyberdropNameBySlug.set(slug, nm);
                    }
                } catch (e) { /* ignore */ }

                const host = (() => { try { return new URL(pageUrl).hostname; } catch (e) { return ''; } })();
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

                        const r = await http.get(apiUrl, {}, {
                            'Accept': 'application/json, text/plain, */*',
                            'Origin': pageOrigin,
                            'Referer': pageOrigin + '/',
                        }, 'text');

                        if (!r || !r.source) continue;

                        try { j = JSON.parse(r.source); } catch (e) { j = null; }
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
    ],
    [
        [/fs-\d+\.cyberdrop\.[a-z]{2,}\/|cyberdrop\.[a-z]{2,}\/(f|e)\//, /:!cyberdrop\.[a-z]{2,}\/a\//],
        async (url, http) => {
            // Cyberdrop embeds (/e/) expose the real file URL only after loading the /f/ page.
            // Preferred approach:
            //  1) Call the info API to get the signed CDN URL
            //  2) If blocked, briefly warm up /f/ in an inactive tab and retry once
            try {
                // Ensure absolute URL (some posts omit the scheme, e.g. "cyberdrop.cr/e/<slug>")
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
                    // Not a /f/ or /e/ URL; return as-is.
                    return url;
                }

                const slug = slugMatch[2];
                const pageUrl = `${origin}/f/${slug}`;

                const apiCandidates = [];

                // New API style (observed on cyberdrop.cr): https://api.cyberdrop.cr/api/file/info/<slug>
                const root = (u.hostname.match(/cyberdrop\.[a-z]+$/i) || [null])[0];
                const apiBaseDefault = root ? `https://api.${root}` : 'https://api.cyberdrop.cr';
                if (root) {
                    apiCandidates.push(`https://api.${root}/api/file/info/${slug}`);
                    apiCandidates.push(`https://api.${root}/api/file/auth/${slug}`);
                }
                // Known working for cyberdrop.cr even if the embed is on /e/
                apiCandidates.push(`https://api.cyberdrop.cr/api/file/info/${slug}`);
                apiCandidates.push(`https://api.cyberdrop.cr/api/file/auth/${slug}`);
                // Additional API variants seen in the wild
                if (root) {
                    apiCandidates.push(`https://api.${root}/api/file/url/${slug}`);
                    apiCandidates.push(`https://api.${root}/api/file/${slug}`);
                    apiCandidates.push(`https://api.${root}/api/file/auth/${slug}`);
                }
                apiCandidates.push(`https://api.cyberdrop.cr/api/file/url/${slug}`);
                apiCandidates.push(`https://api.cyberdrop.cr/api/file/auth/${slug}`);
                apiCandidates.push(`https://api.cyberdrop.cr/api/file/${slug}`);

                // Legacy API style (older Cyberdrop): https://cyberdrop.me/api/f/<slug>
                apiCandidates.push(`${origin}/api/f/${slug}`);

                const headers = {
                    Accept: 'application/json, text/plain, */*',
                    Referer: `${origin}/`,
                    Origin: origin,
                };

                const cyberdropGmGetText = (reqUrl, hdrs) => new Promise(resolve => {
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
                    if ((r.status === 0) && (headers.Origin || headers.Referer)) {
                        r = await cyberdropGmGetText(reqUrl, { Accept: headers.Accept });
                    }
                    return r;
                };

                const fetchInfo = async () => {
                    const parseInfoText = (txt, baseHint) => {
                        const out = { direct: null, name: null, token: null, base: null, auth: null };
                        const s = String(txt || '');
                        const apiBase = (typeof baseHint === 'string' && /^https?:\/\//i.test(baseHint))
                            ? baseHint.replace(/\/$/, '')
                            : apiBaseDefault;
                        if (!s) return out;

                        // 1) Quick regex for absolute token URL (unescaped or JSON-escaped)
                        const rePlain = new RegExp(`https?:\/\/[^"'\\s]+\/api\/file\/d\/${slug}\?[^"'\\s]*token=[^"'\\s]+`, 'i');
                        let m = s.match(rePlain);
                        if (m && m[0]) out.direct = m[0];

                        if (!out.direct) {
                            const reEsc = new RegExp(`https?:\\/\\/[^"\\s]+\\/api\\/file\\/d\\/${slug}\\?[^"\\s]*token=[^"\\s]+`, 'i');
                            m = s.match(reEsc);
                            if (m && m[0]) out.direct = m[0].replace(/\\\//g, '/');
                        }

                        // 2) Relative token URL (e.g. "/api/file/d/<slug>?token=...")
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

                        // 3) JSON parse + deep scan for filename and/or token/host components
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
                                // Typical JWT: header.payload.sig (base64url)
                                if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return true;
                                return false;
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
                                    // plain hostname
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

                                    // token can be stored separately (e.g. "token": "eyJ...")
                                    if (!out.token) {
                                        if (/(^|[^a-z])token([^a-z]|$)/i.test(String(key)) && looksLikeJwt(v)) {
                                            out.token = v;
                                        } else if (looksLikeJwt(v)) {
                                            // last resort: any JWT-looking string
                                            out.token = v;
                                        }
                                    }

                                    // auth URL can be provided separately (new API flow: info -> auth -> direct)
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

                            // Common auth URL fields (new Cyberdrop API flow: info -> auth -> direct)
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
                                            (j.data && j.data.file && (j.data.file.name || j.data.file.filename || j.data.file.fileName || j.data.file.originalName)))) ||
                                    null;
                                if (n && typeof n === 'string' && looksLikeName(n)) out.name = n.split(/[\\/]/).pop();
                            }

                            // If we got token but not direct, try to build a direct URL
                            if (!out.direct && out.token) {
                                const tok = out.token.includes('%') ? out.token : encodeURIComponent(out.token);
                                const base = out.base || apiBase;
                                out.direct = `${base.replace(/\/$/, '')}/api/file/d/${slug}?token=${tok}`;
                            }
                        } catch (e) {}

                        // Normalize escaped slashes if needed
                        if (out.direct && typeof out.direct === 'string' && out.direct.includes('\\/')) {
                            out.direct = out.direct.replace(/\\\//g, '/');
                        }

                        // If out.direct is relative, make it absolute
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
                            try { baseHint = new URL(apiUrl).origin; } catch (e) {}
                            const { direct, name, auth } = parseInfoText(source, baseHint);

                            let resolvedName = name || null;
                            let resolvedDirect = direct || null;

                            // New flow: info returns auth_url; auth returns tokenized direct URL
                            if (!resolvedDirect && auth && typeof auth === 'string') {
                                const authUrl = auth;
                                try {
                                    const { source: authSource, status: authStatus } = await cyberdropFetchText(authUrl);
                                    if (authStatus === 200 && authSource) {
                                        let authBase = baseHint;
                                        try { authBase = new URL(authUrl).origin; } catch (e) {}
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
                try { warmKey = `cyberdrop:${new URL(pageUrl).origin}`; } catch (e) { }
                await cyberdropWarmupOnce(warmKey, pageUrl, CYBERDROP_WARMUP_DEFAULT_MS);

                directUrl = await fetchInfo();
                if (!directUrl) directUrl = await fetchInfo();
                return directUrl || url;
            } catch (e) {
                return url;
            }
        },
    ],
[
        [/noodlemagazine.com\/watch\//],
        async (url, http) => {
            const { dom } = await http.get(url);
            let playerIFrameUrl = dom.querySelector('#iplayer')?.getAttribute('src');

            if (!playerIFrameUrl) {
                return null;
            }

            playerIFrameUrl = playerIFrameUrl.replace('/player/', 'https://noodlemagazine.com/playlist/');

            const { source } = await http.get(playerIFrameUrl);

            // noinspection JSCheckFunctionSignatures
            const props = JSON.parse(source || JSON.stringify([]));

            if (props.sources && props.sources.length) {
                return props.sources[0].file;
            }

            return null;
        },
    ],
    [
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
    ],

    [
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
    ],

[[/images\d.imagebam.com/], url => url],
    [[/imgvb.com\/images\//, /:!imgvb.com\/album\//], url => url.replace('.th.', '.').replace('.md.', '.')],
    [
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
    ],
    [
        [/(\/attachments\/|\/data\/video\/)/],
        async (url) => {
            // Normalize broken "https:///..." and accidental double-scheme cases.
            url = String(url || '').trim();
            url = url.replace(/^https?:\/\/https?:\/\//i, 'https://');
            url = url.replace(/^https?:\/\/\//i, '/');

            // If it's already absolute, keep it (don't rewrite hosts).
            if (/^https?:\/\//i.test(url)) return url;

            // Otherwise it's a path; prefix with Simpcity origin.
            if (!url.startsWith('/')) url = '/' + url;

            if (url.startsWith('/attachments/') || url.startsWith('/data/video/')) {
                return `https://simpcity.su${url}`;
            }

            return `https://simpcity.su${url}`;
        },
    ],
    [[/(thumbs|images)(\d+)?.imgbox.com\//, /:!imgbox.com\/g\//], url => url.replace(/_t\./gi, '_o.').replace(/thumbs/i, 'images')],
    [
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
    ],

[
    [/filester\.(me|sh|si|gg)\/f\//],
    async (url, http, spoilers, postId, postSettings, progressCB) => {
        try {
            url = String(url || '').trim();
            if (!url) return null;

            if (url.startsWith('//')) url = 'https:' + url;
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');

            const u0 = new URL(url);
            const origin = `${u0.protocol}//${u0.hostname}`;

            const mId = (u0.pathname || '').match(/\/f\/([^\/?#]+)/i);
            if (!mId || !mId[1]) return url;

            const albumId = mId[1];
            const baseUrl = `${origin}/f/${albumId}`;

            const resolved = [];
            const seen = new Set();

            let firstDom = null;
            let firstSource = '';
            let folderName = '';

            const MAX_PAGES = 500;

            const getFolderName = (dom, html) => {
                try {
                    const pickClean = (s) => {
                        s = String(s || '').trim();
                        if (!s) return '';

                        // Strip common suffixes.
                        s = s.replace(/\s*\|\s*filester\.(me|sh|si|gg)\s*$/i, '').trim();
                        s = s.replace(/\s*-\s*filester\.(me|sh|si|gg)\s*$/i, '').trim();

                        // Replace remaining pipes with a Windows-safe separator.
                        if (s.includes('|')) s = s.replace(/\s*\|\s*/g, ' - ').trim();

                        // Final cleanup
                        s = s.replace(/\s+/g, ' ').trim();

                        return s;
                    };

                    const isBad = (t) => {
                        const x = String(t || '').trim();
                        if (!x) return true;
                        if (/^filester\.(me|sh|si|gg)\b/i.test(x)) return true;
                        if (/BETA\s*\d/i.test(x)) return true;
                        return false;
                    };

                    let t = '';

                    // DOM: og:title first
                    try {
                        t = pickClean(dom?.querySelector('meta[property="og:title"]')?.getAttribute('content') || '');
                    } catch (e) {}
                    try {
                        if (!t) t = pickClean(dom?.querySelector('meta[name="og:title"]')?.getAttribute('content') || '');
                    } catch (e) {}
                    try {
                        if (!t) t = pickClean(dom?.querySelector('title')?.textContent || '');
                    } catch (e) {}

                    // HTML fallback (order-independent meta parsing)
                    if (isBad(t)) {
                        const s = String(html || '');
                        if (s) {
                            try {
                                const mTag =
                                    /<meta\b[^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(s) ||
                                    /<meta\b[^>]*\bcontent=["'][^"']+["'][^>]*\b(?:property|name)=["']og:title["'][^>]*>/i.exec(s);
                                if (mTag && mTag[0]) {
                                    const mC = /\bcontent=["']([^"']+)["']/i.exec(mTag[0]);
                                    if (mC && mC[1]) t = pickClean(mC[1]);
                                }
                            } catch (e) {}

                            try {
                                if (isBad(t)) {
                                    const mT = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(s);
                                    if (mT && mT[1]) t = pickClean(mT[1]);
                                }
                            } catch (e) {}
                        }
                    }

                    if (isBad(t)) return albumId;
                    return t;
                } catch (e) {}
                return albumId;
            };

            const addHint = (slug, name, sizeBytes) => {
                try {
                    const dUrl = `${origin}/d/${slug}`;
                    if (name) {
                        try { filesterNameBySlug.set(String(slug), String(name)); } catch (e) {}
                        try { filesterNameByUrl.set(String(dUrl), String(name)); } catch (e) {}
                    }
                    if (sizeBytes) {
                        try { filesterSizeBySlug.set(String(slug), Number(sizeBytes)); } catch (e) {}
                        try { filesterSizeByUrl.set(String(dUrl), Number(sizeBytes)); } catch (e) {}
                    }
                    try { filesterSlugByUrl.set(String(dUrl), String(slug)); } catch (e) {}
                } catch (e) {}
            };

            const parsePage = (dom, html) => {
                const out = [];
                try {
                    const items = dom ? [...dom.querySelectorAll('div.file-item')] : [];
                    for (const el of items) {
                        let slug = '';
                        try {
                            const oc = String(el.getAttribute('onclick') || '');
                            const m = /\/d\/([^'"?\s]+)/i.exec(oc);
                            if (m && m[1]) slug = m[1];
                        } catch (e) {}

                        if (!slug) {
                            try {
                                const btn = el.querySelector('button.download-btn');
                                const oc2 = String(btn?.getAttribute?.('onclick') || '');
                                const m2 = /downloadFile\(\s*'([^']+)'/i.exec(oc2);
                                if (m2 && m2[1]) slug = m2[1];
                            } catch (e) {}
                        }

                        if (!slug) {
                            try {
                                const a = el.querySelector('a[href*="/d/"]');
                                const href = String(a?.getAttribute?.('href') || '');
                                const m3 = /\/d\/([^\/?#]+)/i.exec(href);
                                if (m3 && m3[1]) slug = m3[1];
                            } catch (e) {}
                        }

                        if (!slug) continue;

                        let name = '';
                        let size = 0;

                        try { name = String(el.getAttribute('data-name') || '').trim(); } catch (e) {}
                        if (!name) {
                            try { name = String(el.querySelector('.file-name')?.textContent || '').trim(); } catch (e) {}
                        }

                        try { size = Number(el.getAttribute('data-size') || 0) || 0; } catch (e) {}

                        out.push({ slug, name, size });
                    }
                } catch (e) {}

                // Regex fallback if DOM parsing is incomplete
                try {
                    const s = String(html || '');
                    if (s) {
                        const rx = /data-name="([^"]+)"[^>]*\bonclick="window\.location\.href='\/d\/([^']+)'/gi;
                        let m;
                        while ((m = rx.exec(s)) !== null) {
                            const name = String(m[1] || '').trim();
                            const slug = String(m[2] || '').trim();
                            if (!slug) continue;
                            out.push({ slug, name, size: 0 });
                        }
                    }
                } catch (e) {}

                return out;
            };

            for (let page = 1; page <= MAX_PAGES; page++) {
                const u = new URL(baseUrl);
                u.searchParams.set('page', String(page));
                const pageUrl = u.toString();

                if (typeof progressCB === 'function') {
                    progressCB(`[Filester] Resolving album page ${page}`);
                }

                let dom = null;
                let source = '';
                try {
                    const r = await http.get(pageUrl, {}, {
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    Referer: baseUrl,
                    __xfpd_withCredentials: true,
                });
                    dom = r?.dom;
                    source = r?.source || '';
                } catch (e) {
                    break;
                }

                if (page === 1) {
                    firstDom = dom;
                    firstSource = source;
                    folderName = getFolderName(dom, source);
                }

                const before = seen.size;

                const entries = parsePage(dom, source);
                for (const it of entries) {
                    const slug = String(it.slug || '').trim();
                    if (!slug || seen.has(slug)) continue;
                    seen.add(slug);

                    const name = String(it.name || '').trim();
                    const size = Number(it.size || 0) || 0;
                    addHint(slug, name, size);

                    resolved.push(`${origin}/d/${slug}`);
                }

                const added = seen.size - before;
                if (added <= 0) break;
            }

            if (!folderName) folderName = albumId;

            if (!resolved.length) return url;

            return { dom: firstDom, source: firstSource, folderName, resolved };
        } catch (e) {
            return url;
        }
    },
],
[
    [/filester\.(me|sh|si|gg)\/d\//],
    async (url, http, spoilers, postId, postSettings, progressCB) => {
        const slug = (() => {
            try {
                const u = new URL(url);
                const parts = String(u.pathname || '').split('/').filter(Boolean);
                return parts.length ? parts[parts.length - 1] : '';
            } catch (e) {
                const m = /filester\.(me|sh|si|gg)\/d\/([^\/?#]+)/i.exec(String(url || ''));
                return m && m[1] ? m[1] : '';
            }
        })();

        if (!slug) return null;

        const apiBase = 'https://filester.me';

        const mkHeaders = () => ({
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json;charset=UTF-8',
            Origin: apiBase,
            Referer: url,
            __xfpd_withCredentials: true,
        });

        const safeJson = (txt) => {
            try { return JSON.parse(String(txt || '')); } catch (e) { return null; }
        };

        const walk = (obj, cb, maxNodes = 5000) => {
            const seen = new Set();
            const q = [obj];
            let nodes = 0;
            while (q.length && nodes++ < maxNodes) {
                const cur = q.shift();
                if (!cur || typeof cur !== 'object') continue;
                if (seen.has(cur)) continue;
                seen.add(cur);
                try {
                    if (cb(cur) === true) return true;
                } catch (e) {}
                if (Array.isArray(cur)) {
                    for (const it of cur) q.push(it);
                } else {
                    for (const k of Object.keys(cur)) q.push(cur[k]);
                }
            }
            return false;
        };

        const deepFindValueByKeys = (obj, keys) => {
            const keySet = new Set((keys || []).map(k => String(k).toLowerCase()));
            let out = null;
            walk(obj, (o) => {
                if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
                for (const k of Object.keys(o)) {
                    if (keySet.has(String(k).toLowerCase())) {
                        const v = o[k];
                        if (v !== null && v !== undefined) {
                            out = v;
                            return true;
                        }
                    }
                }
                return false;
            });
            return out;
        };

        const normalizeUrl = (s) => {
            if (!s || typeof s !== 'string') return null;
            const t = s.trim();
            if (/^https?:\/\//i.test(t)) return t;
            if (t.startsWith('/')) {
                try { return new URL(t, apiBase).href; } catch (e) { return null; }
            }
            if (/^[dv]\//i.test(t)) {
                try { return new URL('/' + t.replace(/^\/+/, ''), apiBase).href; } catch (e) { return null; }
            }
            return null;
        };

        const pickBestUrl = (obj) => {
            const candidates = [];
            const push = (v) => {
                const u = normalizeUrl(v);
                if (u) candidates.push(u);
            };

            const prefer = deepFindValueByKeys(obj, ['download_url', 'downloadUrl', 'url', 'link', 'href', 'direct', 'download', 'view_url', 'viewUrl']);
            if (prefer) push(prefer);

            walk(obj, (o) => {
                for (const k of Object.keys(o || {})) {
                    const v = o[k];
                    if (typeof v === 'string') push(v);
                }
                if (Array.isArray(o)) {
                    for (const it of o) if (typeof it === 'string') push(it);
                }
                return false;
            });

            const clean = candidates
                .map(s => String(s))
                .filter(s => !/filester\.(me|sh|si|gg)\/api\//i.test(s))
                .filter(s => !/filester\.(me|sh|si|gg)\/(css|js)\//i.test(s));

            if (!clean.length) return null;

            const score = (s) => {
                let sc = 0;
                // Strongly prefer CDN /v/ stream URLs.
                if (/https?:\/\/cache\d+\.filester\.(me|sh|si|gg)\/v\//i.test(s)) sc += 200;
                else if (/cache\d+\.filester\.(me|sh|si|gg)/i.test(s)) sc += 160;
                if (/\/v\//i.test(s)) sc += 80;
                if (/\.filester\.(me|sh|si|gg)\//i.test(s)) sc += 10;
                // De-prioritize HTML view tokens (/d/).
                if (/\/d\//i.test(s)) sc -= 25;
                if (/\.mp4(\?|$)/i.test(s)) sc += 2;
                return sc;
            };

            clean.sort((a, b) => score(b) - score(a));
            return clean[0];
        };

        const pickName = (obj) => {
            const v = deepFindValueByKeys(obj, ['filename', 'file_name', 'name', 'original_name', 'originalName', 'title']);
            if (typeof v === 'string' && v.trim()) return v.trim();
            return null;
        };

        const pickSize = (obj) => {
            const v = deepFindValueByKeys(obj, ['size', 'bytes', 'file_size', 'fileSize', 'length']);
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };

        let nameHint = null;
        let sizeHint = 0;
        let relViewPath = null;
        let streamUrlImmediate = null;

        const filesterExtFromCt = (ct) => {
            const t = String(ct || '').toLowerCase();
            if (t.includes('video/mp4')) return 'mp4';
            if (t.includes('video/webm')) return 'webm';
            if (t.includes('image/jpeg') || t.includes('image/jpg')) return 'jpg';
            if (t.includes('image/png')) return 'png';
            if (t.includes('image/gif')) return 'gif';
            if (t.includes('application/zip')) return 'zip';
            if (t.includes('application/x-7z-compressed')) return '7z';
            if (t.includes('application/x-rar') || t.includes('application/vnd.rar')) return 'rar';
            return 'bin';
        };

        const filesterParseViewMeta = (html) => {
            const out = { fileName: '', fileType: '' };
            const s = String(html || '');
            try {
                // Prefer JSON-style double-quoted assignment: window.fileName = "..."
                const m1 = /window\.fileName\s*=\s*("([^"\\]|\\.)*")\s*;?/m.exec(s);
                if (m1 && m1[1]) out.fileName = JSON.parse(m1[1]);
            } catch (e) {}
            try {
                // Fallback: single-quoted assignment: window.fileName = '...'
                if (!out.fileName) {
                    const m1b = /window\.fileName\s*=\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*;?/m.exec(s);
                    if (m1b && m1b[1]) out.fileName = String(m1b[1]).replace(/\\'/g, "'").replace(/\\n/g, "\n");
                }
            } catch (e) {}
            try {
                const m2 = /window\.fileType\s*=\s*("([^"\\]|\\.)*")\s*;?/m.exec(s);
                if (m2 && m2[1]) out.fileType = JSON.parse(m2[1]);
            } catch (e) {}
            try {
                if (!out.fileType) {
                    const m2b = /window\.fileType\s*=\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*;?/m.exec(s);
                    if (m2b && m2b[1]) out.fileType = String(m2b[1]).replace(/\\'/g, "'").replace(/\\n/g, "\n");
                }
            } catch (e) {}
            return out;
        };



        const filesterNormalizeFilename = (s) => {
            let name = String(s || '').trim();
            if (!name) return '';

            // If UTF-8 bytes were interpreted as Latin-1 (common in Chrome/Tampermonkey),
            // decode it back to proper UTF-8.
            try {
                let hasHigh = false;
                let allByte = true;
                for (let i = 0; i < name.length; i++) {
                    const c = name.charCodeAt(i);
                    if (c > 255) { allByte = false; break; }
                    if (c >= 128) hasHigh = true;
                }
                if (allByte && hasHigh && typeof TextDecoder !== 'undefined') {
                    const bytes = new Uint8Array(name.length);
                    for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i) & 0xFF;
                    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                    if (decoded && decoded !== name) name = decoded;
                }
            } catch (e) {}

            // Strip control chars (Windows will refuse these in filenames; mojibake often introduces them)
            name = name.replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, '').trim();
            return name;
        };

const filesterParseDispositionFilename = (headersRaw) => {
            try {
                const h = String(headersRaw || '');
                const mLine = /content-disposition:\s*([^\r\n]+)/i.exec(h);
                if (!mLine || !mLine[1]) return '';
                const v = String(mLine[1] || '');

                // RFC5987: filename*=UTF-8''...
                let m = /filename\*\s*=\s*([^;]+)/i.exec(v);
                if (m && m[1]) {
                    let val = String(m[1]).trim();
                    val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

                    const mEnc = /^([^']*)''(.*)$/.exec(val);
                    if (mEnc) {
                        let data = String(mEnc[2] || '').trim();
                        try {
                            data = decodeURIComponent(data.replace(/\+/g, '%20'));
                        } catch (e) {
                            // best-effort
                        }
                        if (data) return filesterNormalizeFilename(data);
                    } else {
                        try {
                            const decoded = decodeURIComponent(val.replace(/\+/g, '%20'));
                            if (decoded) return filesterNormalizeFilename(decoded);
                        } catch (e) {}
                        if (val) return filesterNormalizeFilename(val);
                    }
                }

                // Basic: filename="..."
                m = /filename\s*=\s*([^;]+)/i.exec(v);
                if (m && m[1]) {
                    let val = String(m[1]).trim();
                    val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
                    val = val.replace(/\\(.)/g, '$1');
                    return filesterNormalizeFilename(val);
                }
            } catch (e) {}
            return '';
        };



        const filesterProbe = async (probeUrl) => {
            try {
                const r = await http.base(
                    'GET',
                    probeUrl,
                    { onResponseHeadersReceieved: () => {} },
                    { Range: 'bytes=0-0', Referer: `${apiBase}/`, __xfpd_withCredentials: true },
                    null,
                    'text',
                );
                const status = Number(r && r.status) || 0;
                const headers = String((r && r.responseHeaders) || '');
                const dispName = filesterParseDispositionFilename(headers);
                const mCt = /content-type:\s*([^\r\n]+)/i.exec(headers);
                const ct = (mCt && mCt[1]) ? mCt[1].trim() : '';
                const mCr = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headers);
                const mCl = /content-length:\s*(\d+)/i.exec(headers);
                const size = mCr && mCr[1] ? Number(mCr[1]) : (mCl && mCl[1] ? Number(mCl[1]) : 0);
                const isHtmlOrJson = /text\/html|application\/xhtml\+xml|application\/json/i.test(ct);
                const ok = status >= 200 && status < 400 && !isHtmlOrJson;
                return { ok, status, headers, contentType: ct, size: Number.isFinite(size) ? size : 0, fileName: dispName || '' };
            } catch (e) {
                return { ok: false, status: 0, headers: '', contentType: '', size: 0 };
            }
        };

        const filesterResolveDownloadToken = async (tokenUrl) => {
            try {
                const ref = `${apiBase}/d/${slug}`;

                const normalizeMaybeUrl = (v) => {
                    try {
                        if (!v) return '';
                        const s = String(v).trim();
                        if (!s) return '';
                        if (s.startsWith('/')) return new URL(s, apiBase).href;
                        if (/^https?:\/\//i.test(s)) return s;
                        return '';
                    } catch (e) {
                        return '';
                    }
                };

                // Phase 1: range request (follows redirects) to capture finalUrl without downloading the whole file.
                const r1 = await http.base(
                    'GET',
                    tokenUrl,
                    {},
                    { Range: 'bytes=0-0', Referer: ref, __xfpd_withCredentials: true },
                    null,
                    'text',
                );

                const headers1 = String((r1 && r1.responseHeaders) || '');
                const fu1 = String((r1 && r1.finalUrl) || '');

                const mLoc1 = /(?:^|\r?\n)location:\s*([^\r\n]+)/i.exec(headers1);
                const loc1Abs = normalizeMaybeUrl(mLoc1 && mLoc1[1] ? mLoc1[1] : '');
                if (loc1Abs && /\/v\//i.test(loc1Abs)) return loc1Abs;
                if (fu1 && /\/v\//i.test(fu1)) return fu1;

                // If this looks like HTML, fetch the full HTML page (small) and extract the /v/ link.
                const mCt1 = /content-type:\s*([^\r\n]+)/i.exec(headers1);
                const ct1 = (mCt1 && mCt1[1]) ? String(mCt1[1]).trim() : '';
                const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct1);

                if (isHtml) {
                    const r2 = await http.base(
                        'GET',
                        tokenUrl,
                        {},
                        { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: ref, __xfpd_withCredentials: true },
                        null,
                        'text',
                    );

                    const headers2 = String((r2 && r2.responseHeaders) || '');
                    const fu2 = String((r2 && r2.finalUrl) || '');

                    const mLoc2 = /(?:^|\r?\n)location:\s*([^\r\n]+)/i.exec(headers2);
                    const loc2Abs = normalizeMaybeUrl(mLoc2 && mLoc2[1] ? mLoc2[1] : '');
                    if (loc2Abs && /\/v\//i.test(loc2Abs)) return loc2Abs;
                    if (fu2 && /\/v\//i.test(fu2)) return fu2;

                    const body = String((r2 && r2.source) || '');

                    const mFull = /(https?:\/\/cache\d+\.filester\.(me|sh|si|gg)\/v\/[^\"'<>\s]+)/i.exec(body);
                    if (mFull && mFull[1]) return String(mFull[1]).trim();

                    const mRel = /[\"'](\/v\/[^\"'<>\s]+)[\"']/i.exec(body);
                    if (mRel && mRel[1]) return new URL(String(mRel[1]), apiBase).href;
                }

                return null;
            } catch (e) {
                return null;
            }
        };

        try {
            if (progressCB) progressCB('[Filester] Fetching metadata...');
            const viewRes = await http.base(
                'POST',
                `${apiBase}/api/public/view`,
                {},
                mkHeaders(),
                JSON.stringify({ file_slug: slug }),
                'text',
            );
            const viewJson = safeJson(viewRes && viewRes.source);
            if (viewJson) {
                nameHint = pickName(viewJson) || nameHint;
                sizeHint = pickSize(viewJson) || sizeHint;
                try {
                    const relView = deepFindValueByKeys(viewJson, ['view_url', 'viewUrl', 'view']);
                    if (typeof relView === 'string' && relView.trim()) {
                        const s = String(relView).trim();
                        if (s.startsWith('/v/')) {
                            relViewPath = s;
                        } else if (s.startsWith('v/')) {
                            relViewPath = '/' + s;
                        } else if (/^https?:\/\//i.test(s)) {
                            try {
                                const u0 = new URL(s);
                                if (/^\/v\//i.test(String(u0.pathname || ''))) {
                                    relViewPath = String(u0.pathname || '') + String(u0.search || '');
                                }
                                // If the API already gave us a cache /v/ URL, keep it as an immediate candidate.
                                if (!streamUrlImmediate && /https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(s)) {
                                    streamUrlImmediate = s;
                                }
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {}

        // Try to extract the real filename (window.fileName = "...") from the HTML view.
// Some Filester API responses don't include the filename, but the HTML view does.
try {
    // First try the slug page (it may redirect to /v/... or even directly to a cacheX /v/ stream).
    // We use it for both filename hints and to discover the real /v/ path when the public API is blocked.
    if (!nameHint || (!relViewPath && !streamUrlImmediate)) {
        const slugPageUrl = `${apiBase}/d/${slug}`;
        const htmlRes0 = await http.base(
            'GET',
            slugPageUrl,
            {},
            { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', __xfpd_withCredentials: true },
            {},
            'text',
        );
        const html0 = String((htmlRes0 && htmlRes0.source) || '');
        const meta0 = filesterParseViewMeta(html0);
        if (meta0 && meta0.fileName) nameHint = String(meta0.fileName);

        // If this request ended up at a /v/ URL, capture it.
        try {
            const fu0 = String((htmlRes0 && htmlRes0.finalUrl) || '');
            if (fu0 && /\/v\//i.test(fu0)) {
                if (!streamUrlImmediate && /https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(fu0)) {
                    streamUrlImmediate = fu0;
                }
                if (!relViewPath) {
                    try {
                        const u1 = new URL(fu0);
                        if (/^\/v\//i.test(String(u1.pathname || ''))) {
                            relViewPath = String(u1.pathname || '') + String(u1.search || '');
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}

        // Fallback: extract a /v/... token from the HTML itself.
        if (!streamUrlImmediate) {
            try {
                const mFull = /(https?:\/\/cache\d+\.filester\.(me|sh|si|gg)\/v\/[^\s"'<>]+)/i.exec(html0);
                if (mFull && mFull[1] && /https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(mFull[1])) streamUrlImmediate = mFull[1];
            } catch (e) {}
        }
        if (!relViewPath) {
            try {
                const mRel = /["'](\/v\/[^"'<>\s]+)["']/i.exec(html0) || /(\/v\/[0-9a-f]{16,}[^"'<>\s]*)/i.exec(html0);
                if (mRel && mRel[1] && String(mRel[1]).startsWith('/v/')) relViewPath = mRel[1];
            } catch (e) {}
        }
    }

    // If still missing, try the explicit view_url returned by the API.
    if (!nameHint && relViewPath && /^\/v\//i.test(String(relViewPath))) {
        const viewPageUrl = `${apiBase}${relViewPath}`;
        const htmlRes = await http.base(
            'GET',
            viewPageUrl,
            {},
            { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', __xfpd_withCredentials: true },
            {},
            'text',
        );
        const html = String((htmlRes && htmlRes.source) || '');
        const meta = filesterParseViewMeta(html);
        if (meta && meta.fileName) nameHint = filesterNormalizeFilename(String(meta.fileName));
    }
} catch (e) {}

                // Download API can return a /d/<token> which then redirects to the real /v/... stream URL.
        // Use it as a fallback to discover the stream path when /api/public/view doesn't provide it.
        try {
            if (!streamUrlImmediate && !relViewPath) {
                if (progressCB) progressCB('[Filester] Resolving download token...');
                const dlRes0 = await http.base(
                    'POST',
                    `${apiBase}/api/public/download`,
                    {},
                    mkHeaders(),
                    JSON.stringify({ file_slug: slug }),
                    'text',
                );

                const src0 = String((dlRes0 && dlRes0.source) || '');
                const dlJson0 = safeJson(src0);

                let tokenUrl = null;
                try {
                    const rel = dlJson0 ? deepFindValueByKeys(dlJson0, ['download_url', 'downloadUrl', 'url']) : null;
                    if (typeof rel === 'string' && rel.trim()) tokenUrl = normalizeUrl(rel);
                } catch (e) {}

                if (!tokenUrl) {
                    const m0 = /"download_url"\s*:\s*"([^"]+)"/i.exec(src0);
                    if (m0 && m0[1]) tokenUrl = normalizeUrl(m0[1]);
                }

                if (tokenUrl) {
                    // If the API returned a token (or /d/<token>), the actual stream is usually /v/<token> on cacheX.
                    // Build relViewPath early so the probe loop can find a working cache host (cache6 preferred).
                    try {
                        let tokenStr = '';
                        try {
                            const tk = dlJson0 ? deepFindValueByKeys(dlJson0, ['token']) : null;
                            if (typeof tk === 'string') tokenStr = String(tk).trim();
                        } catch (e) {}
                        if (!tokenStr) {
                            const mTok = /\/d\/([^\/\?#]+)/i.exec(String(tokenUrl || ''));
                            if (mTok && mTok[1]) tokenStr = String(mTok[1]).trim();
                        }
                        if (tokenStr && !relViewPath) {
                            if (tokenStr.startsWith('/v/')) relViewPath = tokenStr;
                            else if (tokenStr.startsWith('v/')) relViewPath = '/' + tokenStr;
                            else if (tokenStr.startsWith('/d/')) relViewPath = tokenStr.replace(/^\/d\//i, '/v/');
                            else if (tokenStr.startsWith('d/')) relViewPath = '/' + tokenStr.replace(/^d\//i, 'v/');
                            else relViewPath = `/v/${tokenStr}`;
                        }
                    } catch (e) {}

                    const sUrl = await filesterResolveDownloadToken(tokenUrl);
                    if (sUrl) {
                        try {
                            const u2 = new URL(sUrl);
                            if (/^\/v\//i.test(String(u2.pathname || ''))) {
                                relViewPath = String(u2.pathname || '') + String(u2.search || '');
                                if (/https?:\/\/cache6\.filester\.(me|sh|si|gg)\/v\//i.test(sUrl)) streamUrlImmediate = String(sUrl);
                            }
                        } catch (e) {
                            if (String(sUrl).startsWith('/v/')) relViewPath = String(sUrl);
                        }
                    }
                }
            }
        } catch (e) {}

// If we already discovered a cache /v/ stream URL from redirects or HTML, prefer it.
        try {
            if (streamUrlImmediate) {
                if (progressCB) progressCB('[Filester] Probing discovered stream URL...');
                const p0 = await filesterProbe(streamUrlImmediate);
                if (p0 && p0.ok) {
                    const streamUrl = String(streamUrlImmediate);
                    const streamCt = String(p0.contentType || '');
                    const streamSize = Number(p0.size || 0) || 0;
                    const streamHdrName = String((p0 && p0.fileName) || '');

                    try { filesterSlugByUrl.set(String(streamUrl), String(slug)); } catch (e) {}
                    try {
                        const ref0 = (relViewPath ? `${apiBase}${relViewPath}` : `${apiBase}/d/${slug}`);
                        if (ref0 && String(ref0).startsWith('http')) {
                            filesterRefByUrl.set(String(streamUrl), String(ref0));
                            filesterRefByUrl.set(String(url), String(ref0));
                            filesterRefByUrl.set(`${apiBase}/d/${slug}`, String(ref0));
                        }
                    } catch (e) {}
                    try { if (!nameHint && streamHdrName) nameHint = String(streamHdrName); } catch (e) {}

                    const ext = filesterExtFromCt(streamCt);
                    let finalName = '';
                    try { if (nameHint) finalName = String(nameHint); } catch (e) {}
                    if (!finalName) finalName = `Filester_${slug}.${ext || 'bin'}`;
                    try {
                        const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(finalName || ''));
                        if (!hasExt && ext) finalName = `${finalName}.${ext}`;
                    } catch (e) {}

                    try {
                        filesterNameBySlug.set(String(slug), String(finalName));
                        filesterNameByUrl.set(String(streamUrl), String(finalName));
                        try { filesterNameByUrl.set(String(url), String(finalName)); } catch (e) {}
                        try { filesterNameByUrl.set(`${apiBase}/d/${slug}`, String(finalName)); } catch (e) {}
                        try { if (relViewPath) filesterNameByUrl.set(`${apiBase}${relViewPath}`, String(finalName)); } catch (e) {}
                    } catch (e) {}
                    if (streamSize) {
                        try {
                            filesterSizeBySlug.set(String(slug), Number(streamSize));
                            filesterSizeByUrl.set(String(streamUrl), Number(streamSize));
                        } catch (e) {}
                    }

                    return streamUrl;
                }
            }
        } catch (e) {}

// Prefer the cache /v/ stream URL. The /d/ token often requires a Filester referer (otherwise it returns not_whitelisted).
        try {
            if (relViewPath && /^\/v\//i.test(String(relViewPath))) {
                if (progressCB) progressCB('[Filester] Probing cache stream URL...');
                const bases = [];
                // Chrome Tampermonkey downloads are more reliable when starting from filester.me (redirects preserve a Filester referrer).
                if (!isFF) bases.push(apiBase);
                bases.push('https://cache6.filester.me');
                for (let i = 1; i <= 8; i++) if (i !== 6) bases.push(`https://cache${i}.filester.me`);
                if (isFF) bases.push(apiBase);

                let streamUrl = null;
                let streamCt = '';
                let streamSize = 0;
                let streamHdrName = '';

                for (const base of bases) {
                    const cand = String(base).replace(/\/$/, '') + String(relViewPath);
                    const p = await filesterProbe(cand);
                    if (p && p.ok) {
                        streamUrl = cand;
                        streamCt = String(p.contentType || '');
                        streamSize = Number(p.size || 0) || 0;
                        streamHdrName = String((p && p.fileName) || '');
                        break;
                    }
                }

                if (streamUrl) {
                    try { filesterSlugByUrl.set(String(streamUrl), String(slug)); } catch (e) {}
                    try {
                        const ref0 = (relViewPath ? `${apiBase}${relViewPath}` : `${apiBase}/d/${slug}`);
                        if (ref0 && String(ref0).startsWith('http')) {
                            filesterRefByUrl.set(String(streamUrl), String(ref0));
                            filesterRefByUrl.set(String(url), String(ref0));
                            filesterRefByUrl.set(`${apiBase}/d/${slug}`, String(ref0));
                        }
                    } catch (e) {}
                    try { if (!nameHint && streamHdrName) nameHint = String(streamHdrName); } catch (e) {}
                    const ext = filesterExtFromCt(streamCt);
                    let finalName = '';
                    try { if (nameHint) finalName = String(nameHint); } catch (e) {}
                    if (!finalName) finalName = `Filester_${slug}.${ext || 'bin'}`;
                    try {
                        const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(String(finalName || ''));
                        if (!hasExt && ext) finalName = `${finalName}.${ext}`;
                    } catch (e) {}

                    try {
                        filesterNameBySlug.set(String(slug), String(finalName));
                        filesterNameByUrl.set(String(streamUrl), String(finalName));
                    try { filesterNameByUrl.set(String(url), String(finalName)); } catch (e) {}
                    try { filesterNameByUrl.set(`${apiBase}/d/${slug}`, String(finalName)); } catch (e) {}
                    try { if (relViewPath) filesterNameByUrl.set(`${apiBase}${relViewPath}`, String(finalName)); } catch (e) {}

                    } catch (e) {}
                    if (streamSize) {
                        try {
                            filesterSizeBySlug.set(String(slug), Number(streamSize));
                            filesterSizeByUrl.set(String(streamUrl), Number(streamSize));
                        } catch (e) {}
                    }

                    return streamUrl;
                }
            }
        } catch (e) {}

        try {
            if (progressCB) progressCB('[Filester] Resolving download URL...');
            const dlRes = await http.base(
                'POST',
                `${apiBase}/api/public/download`,
                {},
                mkHeaders(),
                JSON.stringify({ file_slug: slug }),
                'text',
            );

            const src = String((dlRes && dlRes.source) || '');
            const dlJson = safeJson(src);
            let dlUrl = null;

            if (dlJson) {
                dlUrl = pickBestUrl(dlJson);
            }
            if (dlJson && !dlUrl) {
                try {
                    const rel = deepFindValueByKeys(dlJson, ['download_url', 'downloadUrl', 'url']);
                    if (typeof rel === 'string' && rel.startsWith('/')) dlUrl = `${apiBase}${rel}`;
                } catch (e) {}
            }

            if (dlJson && !dlUrl) {
                const waitRaw = deepFindValueByKeys(dlJson, ['wait', 'wait_time', 'waitSeconds', 'wait_seconds', 'seconds']);
                const waitSec = Number(waitRaw);
                if (Number.isFinite(waitSec) && waitSec > 0 && waitSec <= 300) {
                    try {
                        if (progressCB) progressCB(`[Filester] Waiting ${Math.ceil(waitSec)}s...`);
                    } catch (e) {}
                    await new Promise(r => setTimeout(r, Math.ceil(waitSec) * 1000));
                    const dlRes2 = await http.base(
                        'POST',
                        `${apiBase}/api/public/download`,
                        {},
                        mkHeaders(),
                        JSON.stringify({ file_slug: slug }),
                        'text',
                    );
                    const src2 = String((dlRes2 && dlRes2.source) || '');
                    const dlJson2 = safeJson(src2);
                    if (dlJson2) dlUrl = pickBestUrl(dlJson2);
                    if (!dlUrl) {
                        const m2 = /(https?:\/\/[^\s"'<>]+)/i.exec(src2);
                        if (m2 && m2[1]) dlUrl = m2[1];
                    }
                }
            }

            if (!dlUrl) {
                const m = /(https?:\/\/[^\s"'<>]+)/i.exec(src);
                if (m && m[1]) dlUrl = m[1];
            }

            if (dlUrl) {
                try { filesterSlugByUrl.set(String(dlUrl), String(slug)); } catch (e) {}

                if (nameHint) {
                    filesterNameBySlug.set(String(slug), String(nameHint));
                    filesterNameByUrl.set(String(dlUrl), String(nameHint));
                }
                if (sizeHint) {
                    filesterSizeBySlug.set(String(slug), Number(sizeHint));
                    filesterSizeByUrl.set(String(dlUrl), Number(sizeHint));
                }
                return dlUrl;
            }
        } catch (e) {}

        return null;
    },
],
    [
        [/m\.box\.com\//],
        async (url, http) => {
            const { source, dom } = await http.get(url);
            const files = [...dom.querySelectorAll('.files-item-anchor')].map(el => `https://m.box.com${el.getAttribute('href')}`);

            const resolved = [];

            for (const fileUrl of files) {
                const { source, dom } = await http.get(fileUrl);
                if (h.contains('image-preview', source)) {
                    resolved.push(dom.querySelector('.image-preview').getAttribute('src'));
                } else {
                    resolved.push(dom.querySelector('.mtl > a').getAttribute('href'));
                }
            }

            return {
                source,
                dom,
                folderName: dom.querySelector('.folder-nav-title')?.innerText.trim(),
                resolved: resolved.map(u => `https://m.box.com${u}`),
            };
        },
    ],
    [
        [/twimg.com\//],
        url => url.replace(/https?:\/\/pbs.twimg\.com\/media\/(.{1,15})(\?format=)?(.*)&amp;name=(.*)/, 'https://pbs.twimg.com/media/$1.$3'),
    ],
    [
        [/(disk\.)?yandex\.[a-z]+/],
        async (url, http) => {
            const { dom } = await http.get(url);

            const script = dom.querySelector('script[id="store-prefetch"]');

            if (!script) {
                return null;
            }

            const json = JSON.parse(script.innerText);

            let sk,
                hash = null;

            if (json && json.environment && json.resources) {
                sk = json.environment.sk;
                const resourcesKeys = Object.keys(json.resources);
                hash = json.resources[resourcesKeys[0]]?.hash;
            }

            const data = JSON.stringify({ hash, sk });

            const { source } = await http.post(
                'https://disk.yandex.ru/public/api/download-url',
                data,
                {},
                {
                    'Content-Type': 'text/plain',
                },
            );

            const response = JSON.parse(source);

            if (response && response.error !== 'true' && response.data) {
                return response.data.url;
            }

            return null;
        },
    ],
    [[/(\w+)?.redd.it/], url => url.replace(/&amp;/g, '&')],
];
