import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { classifyFilesterDownload, planFilesterAlbum, isFilesterAlbumOriginal } from '../src/download/filester.js';

const MAX = Math.floor(1.6 * 1024 * 1024 * 1024);

describe('classifyFilesterDownload', () => {
  test('hint extension drives the kind', () => {
    expect(classifyFilesterDownload('https://filester.me/v/abc', 'video.mp4')).toBe('video');
    expect(classifyFilesterDownload('https://filester.me/v/abc', 'photo.jpg')).toBe('image');
    expect(classifyFilesterDownload('https://filester.me/v/abc', 'archive.bin')).toBe('other');
  });

  test('no hint and no known map entries falls back to other', () => {
    expect(classifyFilesterDownload('https://filester.me/v/abc')).toBe('other');
    expect(classifyFilesterDownload('https://cache6.filester.me/v/abc?token=x')).toBe('other');
  });
});

describe('planFilesterAlbum', () => {
  test('zipped mixed below the limit ZIPs everything', () => {
    const dec = planFilesterAlbum(
      [
        { index: 0, kind: 'image', size: 1 * 1024 * 1024 },
        { index: 1, kind: 'video', size: 2 * 1024 * 1024 },
      ],
      true,
      MAX,
    );
    expect(dec.forceDirectIndexes).toEqual([]);
    expect(dec.totalSize).toBe(3 * 1024 * 1024);
    expect(dec.unknownSize).toBe(0);
  });

  test('zipped mixed above the limit directs only the non-images', () => {
    const dec = planFilesterAlbum(
      [
        { index: 0, kind: 'image', size: 2 * 1024 * 1024 * 1024 },
        { index: 1, kind: 'video', size: 3 * 1024 * 1024 * 1024 },
      ],
      true,
      MAX,
    );
    expect(dec.forceDirectIndexes).toEqual([1]);
  });

  test('unknown sizes in a mixed album direct the non-images', () => {
    const dec = planFilesterAlbum(
      [
        { index: 0, kind: 'image', size: 0 },
        { index: 1, kind: 'video', size: 0 },
      ],
      true,
      MAX,
    );
    expect(dec.forceDirectIndexes).toEqual([1]);
    expect(dec.unknownSize).toBe(2);
  });

  test('non-image-only with unknown sizes directs everything', () => {
    const dec = planFilesterAlbum(
      [
        { index: 0, kind: 'video', size: 0 },
        { index: 1, kind: 'other', size: 0 },
      ],
      true,
      MAX,
    );
    expect(dec.forceDirectIndexes).toEqual([0, 1]);
  });

  test('images-only album keeps the ZIP even with unknown sizes', () => {
    const dec = planFilesterAlbum([{ index: 0, kind: 'image', size: 0 }], true, MAX);
    expect(dec.forceDirectIndexes).toEqual([]);
  });

  test('unzipped mixed album directs everything', () => {
    const dec = planFilesterAlbum(
      [
        { index: 0, kind: 'image', size: 1024 },
        { index: 1, kind: 'video', size: 2048 },
      ],
      false,
      MAX,
    );
    expect(dec.forceDirectIndexes).toEqual([0, 1]);
  });
});

describe('isFilesterAlbumOriginal', () => {
  test('album /f/ URLs match, direct /d/ URLs do not', () => {
    expect(isFilesterAlbumOriginal('https://filester.me/f/abc123')).toBe(true);
    expect(isFilesterAlbumOriginal('https://www.filester.sh/f/abc123')).toBe(true);
    expect(isFilesterAlbumOriginal('https://filester.me/d/abc123')).toBe(false);
    expect(isFilesterAlbumOriginal('https://other.example/f/abc123')).toBe(false);
  });
});

const filesterSource = ['src/host-caches.js', 'src/resolvers/filester.js', 'src/download/filester.js']
  .map(path => readFileSync(path, 'utf8'))
  .join('\n');

const loadFilester = (http, clock = { now: 0 }) => {
  const sandbox = {
    URL,
    resolvers: [],
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    h: {
      http,
      delayedResolve: async ms => {
        clock.now += ms;
      },
    },
    log: { post: { info() {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    filesterSource +
      '\nglobalThis.filester = { resolvers, prepareFilesterDownloadResource, selectFilesterDirectUrl, filesterHintName, classifyFilesterDownload, isFilesterUrl, filesterTokenFromVUrl };',
    sandbox,
  );
  return sandbox.filester;
};

const downloadContext = () => ({ postId: 'post', postNumber: 1, tokenLogState: {} });

describe('Filester v2 resolution', () => {
  test('scheme-less aliases retain the slug and encode server-bound paths and tokens', async () => {
    const slug = 'file_slug-0123456789';
    const http = {
      async post(url, body) {
        if (url !== 'https://filester.si/v2/api/public/download' || JSON.parse(body).file_slug !== slug) {
          return { status: 404, source: '{}' };
        }
        return {
          status: 200,
          source: JSON.stringify({
            server: 'https://media.future-cdn.example/',
            file: 'folder/v/name #1.mp4',
            token: 'signed+value&expires=1',
            name: 'Original #1.mp4',
          }),
        };
      },
    };
    const filester = loadFilester(http);
    const stream = await filester.resolvers[1][1](`filester.si/d/${slug}?shared=1`, http);
    const parsed = new URL(stream);
    expect(parsed.hostname).toBe('media.future-cdn.example');
    expect(parsed.pathname).toBe('/v2/folder/v/name%20%231.mp4');
    expect(parsed.searchParams.get('token')).toBe('signed+value&expires=1');
    expect(parsed.searchParams.get('n')).toBe('Original #1.mp4');
    expect(parsed.searchParams.get('download')).toBe('true');
    expect(parsed.hash).toBe('');
    expect(filester.filesterHintName(stream)).toBe('Original #1.mp4');
    expect(filester.classifyFilesterDownload(stream)).toBe('video');
    expect(filester.isFilesterUrl(stream)).toBe(true);
    expect(filester.isFilesterUrl('https://media.future-cdn.example/unrelated')).toBe(false);
    expect(filester.filesterTokenFromVUrl(stream)).toBe('');
  });

  test('album items obtain v2 tokens at download time and retain album filenames when the API omits them', async () => {
    const slug = 'long_album-slug_0123456789';
    let issuedTokens = 0;
    const http = {
      async get() {
        return {
          status: 200,
          source: `<title>Holiday | Filester.sh</title><div data-name="Holiday.mp4" onclick="window.location.href='/d/${slug}'"></div>`,
        };
      },
      async post(url, body) {
        if (url !== 'https://filester.sh/v2/api/public/download' || JSON.parse(body).file_slug !== slug) {
          return { status: 404, source: '{}' };
        }
        issuedTokens++;
        return { status: 200, source: JSON.stringify({ server: 'https://fsc3.cdn.cr', file: 'video.mp4', token: 'album-token' }) };
      },
    };
    const filester = loadFilester(http);
    const album = await filester.resolvers[0][1]('https://filester.sh/f/album', http);
    expect(album.folderName).toBe('Holiday');
    expect(album.resolved).toEqual([`https://filester.sh/d/${slug}`]);
    expect(issuedTokens).toBe(0);
    const resource = { original: 'https://filester.sh/f/album', url: album.resolved[0] };
    const stream = await filester.prepareFilesterDownloadResource(resource, downloadContext());
    expect(new URL(stream).hostname).toBe('fsc3.cdn.cr');
    expect(new URL(stream).pathname).toBe('/v2/video.mp4');
    expect(new URL(stream).searchParams.get('token')).toBe('album-token');
    expect(filester.filesterHintName(stream)).toBe('Holiday.mp4');
    expect(filester.classifyFilesterDownload(resource.url)).toBe('video');
  });

  test('retired API payloads fail closed instead of returning view HTML or fabricated legacy streams', async () => {
    const http = {
      async post() {
        return { status: 200, source: JSON.stringify({ token: 'dead-token', download_url: '/d/dead-token' }) };
      },
    };
    const filester = loadFilester(http);
    const originalUrl = 'https://filester.me/d/file-slug';
    expect(await filester.resolvers[1][1](originalUrl, http)).toBeNull();
    const resource = { url: originalUrl };
    expect(await filester.prepareFilesterDownloadResource(resource, downloadContext())).toBeNull();
    expect(resource.url).toBe(originalUrl);
  });

  test('redirected v2 streams retain server affinity even on legacy-looking paths', async () => {
    const requests = [];
    const redirected = 'https://media.future-cdn.example/v/server-bound';
    const http = {
      async post() {
        return { status: 200, source: JSON.stringify({ server: 'https://fsc3.cdn.cr', file: 'clip.mp4', token: 'server-bound' }) };
      },
      async get(url) {
        requests.push(url);
        if (requests.length === 1) {
          return { status: 206, responseHeaders: 'content-type: video/mp4', finalUrl: redirected };
        }
        return { status: 404, responseHeaders: 'content-type: application/json' };
      },
    };
    const filester = loadFilester(http);
    const stream = await filester.resolvers[1][1]('https://filester.me/d/file-slug', http);
    const selected = await filester.selectFilesterDirectUrl(stream, {}, downloadContext());
    expect(selected.directUrl).toBe(redirected);
    expect(filester.filesterTokenFromVUrl(redirected)).toBe('');
    const retry = await filester.selectFilesterDirectUrl(redirected, {}, downloadContext());
    expect(retry.directUrl).toBe(redirected);
    expect(requests).toEqual([stream, redirected]);
  });

  test('black-holed legacy hosts exhaust a fixed probe budget, including retry delays', async () => {
    const clock = { now: 0 };
    const requests = [];
    const http = {
      async get(url, callbacks, headers, responseType, timeoutMs) {
        requests.push(url);
        clock.now += timeoutMs > 0 ? timeoutMs : 60000;
        throw new Error('Network deadline exceeded');
      },
    };
    const filester = loadFilester(http, clock);
    const originalUrl = 'https://fsc1.cdn.cr/v/legacy-token';
    const selected = await filester.selectFilesterDirectUrl(originalUrl, {}, downloadContext());
    expect(selected.directUrl).toBe(originalUrl);
    expect(requests).toContain('https://fsc3.cdn.cr/v/legacy-token');
    expect(clock.now).toBeLessThanOrEqual(25000);
  });
});
