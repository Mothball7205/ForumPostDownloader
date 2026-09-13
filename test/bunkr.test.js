import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/resolvers/bunkr.js', 'utf8');

const resolve = async (url, apiData = { url: 'https://media.cdn.cr/clip.mp4' }) => {
  const sandbox = {
    URL,
    resolvers: [],
    bunkrNameByUrl: new Map(),
    xfpdBunkrFilterBases: bases => bases,
    xfpdLooksLikeCfChallenge: () => false,
    xfpdLooksLikeCfFilenameHint: () => false,
    xfpdBunkrGetWithCfRetry: async (_, viewUrl) => {
      if (!viewUrl.startsWith('https://bunkr.cr/')) throw new Error('Not a view host');
      return { dom: { querySelector: selector => (selector === '[data-file-id]' ? { getAttribute: () => '42' } : null) } };
    },
    xfpdBunkrSignCdnUrl: async (_, url) => `${url}?signed=1`,
    xfpdBunkrExtractNameFromVsData: () => '',
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.resolvers[0][1](url, {
    post: async () => ({ source: JSON.stringify(apiData) }),
  });
};

test('legacy Bunkr CDN media goes through view metadata and signing', async () => {
  expect(await resolve('https://cdn12.bunkr.cr/clip.mp4')).toBe('https://media.cdn.cr/clip.mp4?signed=1');
});

test('non-legacy direct media remains directly downloadable', async () => {
  expect(await resolve('https://i.bunkr.cr/photo.jpg')).toBe('https://i.bunkr.cr/photo.jpg');
});

test('failed Bunkr resolution does not download an HTML view page', async () => {
  expect(await resolve('https://bunkr.cr/f/clip', {})).toBeNull();
});
