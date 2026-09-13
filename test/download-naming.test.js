import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const utilsSource = readFileSync(join('src', 'download-utils.js'), 'utf8');
const namingSource = readFileSync(join('src', 'download', 'naming.js'), 'utf8');
const cachesSource = readFileSync(join('src', 'host-caches.js'), 'utf8');

const h = {
  re: {
    matchAll: (pattern, str) => [...String(str || '').matchAll(new RegExp(pattern.source, pattern.flags))].map(m => m[0]),
  },
  basename: s =>
    String(s || '')
      .split('/')
      .pop(),
  ext: s => {
    const m = String(s || '').match(/\.([A-Za-z0-9]{1,8})$/);
    return m ? m[1] : '';
  },
  fnNoExt: s => {
    const m = String(s || '').match(/(.*)\.[A-Za-z0-9]{1,8}$/);
    return m ? m[1] : String(s || '');
  },
};

const sandbox = {
  h,
  URL,
  settings: { naming: { allowEmojis: false, invalidCharSubstitute: '-' } },
  xfpdLooksLikeCfFilenameHint: () => false,
};
vm.createContext(sandbox);
vm.runInContext(
  cachesSource +
    '\n' +
    utilsSource +
    '\n' +
    namingSource +
    '\nglobalThis.__planner = createDownloadNamePlanner; globalThis.bunkrNameByUrl = bunkrNameByUrl;',
  sandbox,
);
const createDownloadNamePlanner = sandbox.__planner;

const plannerFor = (overrides = {}) =>
  createDownloadNamePlanner({
    postSettings: { flatten: false },
    threadTitle: 'Thread',
    postNumber: 42,
    isFirefox: false,
    ...overrides,
  });

describe('createDownloadNamePlanner', () => {
  test('blob default: URL basename folded into the folder and titled path', () => {
    const names = plannerFor();
    const result = names.plan({
      mode: 'blob',
      resource: { folderName: 'Album', host: { name: 'X' } },
      url: 'https://example.com/clip.mp4',
      zippedForThis: false,
    });
    expect(result.basename).toBe('clip.mp4');
    expect(result.relativePath).toBe('Album/clip.mp4');
    expect(result.saveAsName).toBe('Thread/Album/clip.mp4');
  });

  test('capture records disposition and content-type for the blob branch', () => {
    const names = plannerFor();
    names.capture('https://example.com/raw', 'content-disposition: attachment;filename="real name.mp4"\r\ncontent-type: video/mp4\r\n');
    const result = names.plan({
      mode: 'blob',
      resource: { host: { name: 'X' } },
      url: 'https://example.com/raw',
      zippedForThis: false,
    });
    expect(result.basename).toBe('real name.mp4');
  });

  test('same basename twice appends (2) in the same run', () => {
    const names = plannerFor();
    const input = { mode: 'blob', resource: { host: { name: 'X' } }, url: 'https://example.com/clip.mp4', zippedForThis: false };
    const first = names.plan(input);
    expect(first.basename).toBe('clip.mp4');
    const second = names.plan(input);
    expect(second.basename).toBe('clip (2).mp4');
  });

  test('Turbo blob: signed fn= query param wins over the id basename', () => {
    const names = plannerFor();
    const result = names.plan({
      mode: 'blob',
      resource: { host: { name: 'X' } },
      url: 'https://turbocdn.st/uVOxoqFFlDGrZ.mp4?fn=Original%20Name.mp4',
      zippedForThis: false,
    });
    expect(result.basename).toBe('Original Name.mp4');
  });

  test('direct mode prefers the metadata filename for GoFile', () => {
    const names = plannerFor();
    const result = names.plan({
      mode: 'direct',
      resource: { folderName: 'Album', host: { name: 'GoFile' } },
      url: 'https://gofile.io/download/web/abc123/file.mp4',
      meta: { filename: 'meta.mp4', headers: '' },
      zippedForThis: false,
    });
    expect(result.basename).toBe('meta.mp4');
    expect(result.relativePath).toBe('Album/meta.mp4');
  });

  test('Bunkr override: hinted human name beats the CDN basename', () => {
    sandbox.bunkrNameByUrl.set('https://bunkr.si/v/abc123', 'interview.mp4');
    const names = plannerFor();
    const result = names.plan({
      mode: 'blob',
      resource: { host: { name: 'Bunkr' }, original: 'https://bunkr.si/v/abc123' },
      url: 'https://bunkr-cache.si/file/abc123.mp4',
      zippedForThis: false,
    });
    expect(result.basename).toBe('interview.mp4');
  });
});
