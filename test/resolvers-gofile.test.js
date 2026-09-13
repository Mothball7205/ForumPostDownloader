import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/resolvers/gofile.js', 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');

const createResolver = contents => {
  const namesById = new Map();
  const namesByUrl = new Map();
  const sandbox = {
    resolvers: [],
    navigator: { userAgent: 'test', language: 'en-US' },
    settings: { hosts: { goFile: { token: 'account-token' } } },
    gofileSyncCookie: async () => {},
    gofileNameById: namesById,
    gofileNameByUrl: namesByUrl,
    h: { basename: value => value.split('/').pop() },
    log: { host: { info() {}, error() {} } },
    sha256: hash,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const http = {
    async base(method, url, callbacks, headers) {
      if (url === 'https://gofile.io/js/wt.obf.js') {
        return { source: 'function generateWT(token) { return "website:" + token; }' };
      }
      const parsed = new URL(url);
      if (method === 'GET' && parsed.origin === 'https://api.gofile.io' && parsed.pathname.startsWith('/contents/')) {
        if (headers.authorization !== 'Bearer account-token' || headers['x-website-token'] !== 'website:account-token') {
          return { source: JSON.stringify({ status: 'error-unauthorized' }) };
        }
        const id = decodeURIComponent(parsed.pathname.slice('/contents/'.length));
        return { source: JSON.stringify(contents(id, parsed.searchParams)) };
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  };
  return {
    resolve: (url, spoilers = []) => sandbox.resolvers[0][1](url, http, spoilers, 'post'),
  };
};

test('GoFile resolves a single-file /d link using the current website-token asset without making a file-named folder', async () => {
  const direct = 'https://store1.gofile.io/download/direct/file-id/encoded-name.mp4';
  const { resolve } = createResolver(id => {
    if (id !== 'share-code') throw new Error(`Unexpected content: ${id}`);
    return {
      status: 'ok',
      data: {
        type: 'file',
        id: 'file-id',
        name: 'Original name.mp4',
        directLink: 'https://gofile.io/download/web/file-id/Original%20name.mp4',
        link: direct,
      },
    };
  });

  const result = await resolve('https://gofile.io/d/share-code');

  expect(result.resolved).toEqual([direct]);
  expect(result.folderName).toBe('share-code');
});

test('GoFile still recurses into password-protected folders and resolves a protected single-file response', async () => {
  const rootLink = 'https://store1.gofile.io/download/direct/root-file/root.jpg';
  const protectedLink = 'https://store1.gofile.io/download/direct/protected-file/private.jpg';
  const fallbackLink = 'https://gofile.io/download/web/fallback-file/Space%20name.jpg';
  const { resolve } = createResolver((id, params) => {
    if (id === 'root') {
      return {
        status: 'ok',
        data: {
          type: 'folder',
          name: 'Root album',
          children: {
            first: { type: 'file', id: 'root-file', name: 'root.jpg', link: rootLink },
            folder: { type: 'folder', id: 'locked-folder' },
            fileShare: { type: 'folder', code: 'locked-file' },
          },
        },
      };
    }
    if (id !== 'locked-folder' && id !== 'locked-file') throw new Error(`Unexpected content: ${id}`);
    if (params.get('password') !== hash('correct password')) return { status: 'error-passwordRequired' };
    if (id === 'locked-file') {
      return {
        status: 'ok',
        data: { type: 'file', id: 'protected-file', name: 'private.jpg', downloadLink: protectedLink },
      };
    }
    return {
      status: 'ok',
      data: {
        type: 'folder',
        name: 'Protected folder',
        children: { fallback: { type: 'file', code: 'fallback-file', name: 'Space name.jpg' } },
      },
    };
  });

  const result = await resolve('https://gofile.io/d/root', ['wrong password', 'correct password']);

  expect(result.resolved).toEqual([rootLink, fallbackLink, protectedLink]);
});
