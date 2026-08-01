import { describe, expect, test } from 'bun:test';
import {
  sanitizeWinSegment,
  sanitizeWinPath,
  sanitizeZipTitleSegment,
  ensureUniquePath,
  ensureUniqueFlatName,
  isGoFileUrl,
  isPixeldrainUrl,
  isTurboUrl,
  isImagebamCdnUrl,
  imagebamRefererForCdn,
  turboExtractId,
  turboExtractFn,
  extractNum,
  headerValue,
  parseDispositionFilename,
  computeBatchLength,
  buildBatches,
} from '../src/download-utils.js';

// Mirrors h.ext / h.fnNoExt from src/helpers.js so the tests pin real behavior.
const ext = p => (!p || p.indexOf('.') < 0 ? null : p.split('.').reverse()[0]);
const fnNoExt = p => p.trim().split('.').reverse().slice(1).reverse().join('.');
const helpers = { ext, fnNoExt };

describe('sanitizeWinSegment (strict per-file variant)', () => {
  test('replaces windows-illegal chars with default _', () => {
    expect(sanitizeWinSegment('a<b>c:d"e/f\\g|h?i*j', undefined)).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  test('uses invalidCharSubstitute when provided', () => {
    expect(sanitizeWinSegment('a<b', { invalidCharSubstitute: '-' })).toBe('a-b');
  });

  test('falls back to _ when substitute is falsy', () => {
    expect(sanitizeWinSegment('a<b', { invalidCharSubstitute: '' })).toBe('a_b');
    expect(sanitizeWinSegment('a<b', { invalidCharSubstitute: undefined })).toBe('a_b');
  });

  test('strips leading and trailing dots/spaces', () => {
    expect(sanitizeWinSegment('  ..name..  ', undefined)).toBe('name');
  });

  test('control chars are replaced like other illegal chars', () => {
    // \x00-\x1F are part of WIN_ILLEGAL_RE, so they become the substitute first.
    expect(sanitizeWinSegment('a\x00b\x1Fc', undefined)).toBe('a_b_c');
  });

  test('defaults empty input to _', () => {
    expect(sanitizeWinSegment('', undefined)).toBe('_');
    expect(sanitizeWinSegment(null, undefined)).toBe('_');
    expect(sanitizeWinSegment('...', undefined)).toBe('_');
  });

  test('prefixes reserved device names', () => {
    expect(sanitizeWinSegment('con', undefined)).toBe('_con');
    expect(sanitizeWinSegment('COM1', undefined)).toBe('_COM1');
    expect(sanitizeWinSegment('lpt9', undefined)).toBe('_lpt9');
    expect(sanitizeWinSegment('console', undefined)).toBe('console');
  });

  test('strips emoji when allowEmojis is false', () => {
    expect(sanitizeWinSegment('a😀b', { allowEmojis: false })).toBe('ab');
  });

  test('keeps emoji when allowEmojis is not false', () => {
    expect(sanitizeWinSegment('a😀b', undefined)).toBe('a😀b');
    expect(sanitizeWinSegment('a😀b', { allowEmojis: true })).toBe('a😀b');
  });
});

describe('sanitizeWinPath (strict per-file variant)', () => {
  test('sanitizes each path segment', () => {
    expect(sanitizeWinPath('a<b/c>d', undefined)).toBe('a_b/c_d');
  });

  test('handles trailing slash (empty segment becomes _)', () => {
    expect(sanitizeWinPath('a/b/', undefined)).toBe('a/b/_');
  });
});

describe('sanitizeZipTitleSegment (lenient ZIP-title variant)', () => {
  test('defaults substitute to -', () => {
    expect(sanitizeZipTitleSegment('a<b', undefined)).toBe('a-b');
  });

  test('collapses whitespace runs to a single space', () => {
    expect(sanitizeZipTitleSegment('  a    b  ', undefined)).toBe('a b');
  });

  test('trims trailing dots/spaces only', () => {
    expect(sanitizeZipTitleSegment('..a.. ', undefined)).toBe('..a');
  });

  test('falls back to file for empty input', () => {
    expect(sanitizeZipTitleSegment('', undefined)).toBe('file');
    expect(sanitizeZipTitleSegment('   ', undefined)).toBe('file');
  });

  test('caps length at 180', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeZipTitleSegment(long, undefined).length).toBe(180);
  });

  test('uses invalidCharSubstitute when provided', () => {
    expect(sanitizeZipTitleSegment('a<b', { invalidCharSubstitute: '_' })).toBe('a_b');
  });

  test('strips emoji when allowEmojis is false', () => {
    expect(sanitizeZipTitleSegment('a😀b', { allowEmojis: false })).toBe('ab');
  });
});

describe('ensureUniquePath', () => {
  test('returns the path unchanged on first use', () => {
    const used = new Set();
    expect(ensureUniquePath('dir/file.jpg', used, helpers)).toBe('dir/file.jpg');
  });

  test('appends (2), (3) on collisions, preserving dir and ext', () => {
    const used = new Set();
    ensureUniquePath('dir/file.jpg', used, helpers);
    expect(ensureUniquePath('dir/file.jpg', used, helpers)).toBe('dir/file (2).jpg');
    expect(ensureUniquePath('dir/file.jpg', used, helpers)).toBe('dir/file (3).jpg');
  });

  test('handles multi-dot names', () => {
    const used = new Set();
    ensureUniquePath('a.b.c.tar.gz', used, helpers);
    expect(ensureUniquePath('a.b.c.tar.gz', used, helpers)).toBe('a.b.c.tar (2).gz');
  });

  test('handles extensionless names', () => {
    const used = new Set();
    ensureUniquePath('dir/readme', used, helpers);
    expect(ensureUniquePath('dir/readme', used, helpers)).toBe('dir/readme (2)');
  });

  test('defaults empty path to file (subject to dedupe)', () => {
    const used = new Set();
    expect(ensureUniquePath('', used, helpers)).toBe('file');
    expect(ensureUniquePath('  ', used, helpers)).toBe('file (2)');
  });
});

describe('ensureUniqueFlatName', () => {
  test('appends (2) preserving ext', () => {
    const used = new Set();
    ensureUniqueFlatName('file.jpg', used, helpers);
    expect(ensureUniqueFlatName('file.jpg', used, helpers)).toBe('file (2).jpg');
  });

  test('handles extensionless names', () => {
    const used = new Set();
    ensureUniqueFlatName('readme', used, helpers);
    expect(ensureUniqueFlatName('readme', used, helpers)).toBe('readme (2)');
  });
});

describe('URL predicates', () => {
  test('isGoFileUrl', () => {
    expect(isGoFileUrl('https://gofile.io/d/abc')).toBe(true);
    expect(isGoFileUrl('https://GOFILE.IO/d/abc')).toBe(true);
    expect(isGoFileUrl('https://example.com/gofile.io')).toBe(true);
    expect(isGoFileUrl('https://example.com/file')).toBe(false);
    expect(isGoFileUrl('')).toBe(false);
    expect(isGoFileUrl(null)).toBe(false);
  });

  test('isPixeldrainUrl', () => {
    expect(isPixeldrainUrl('https://pixeldrain.com/u/abc')).toBe(true);
    expect(isPixeldrainUrl('https://pixeldrain.net/u/abc')).toBe(true);
    expect(isPixeldrainUrl('https://pixeldra.in/u/abc')).toBe(true);
    expect(isPixeldrainUrl('https://example.com')).toBe(false);
  });

  test('isTurboUrl', () => {
    expect(isTurboUrl('https://turbocdn.st/x')).toBe(true);
    expect(isTurboUrl('https://turbo.cr/v/abc')).toBe(true);
    expect(isTurboUrl('https://turbovid.cr/v/abc')).toBe(true);
    expect(isTurboUrl('https://example.com')).toBe(false);
  });

  test('isImagebamCdnUrl', () => {
    expect(isImagebamCdnUrl('https://images1.imagebam.com/abc.jpg')).toBe(true);
    expect(isImagebamCdnUrl('https://thumbs5.imagebam.com/abc.jpg')).toBe(true);
    expect(isImagebamCdnUrl('https://www.imagebam.com/view/abc')).toBe(false);
  });

  test('imagebamRefererForCdn', () => {
    expect(imagebamRefererForCdn('https://images1.imagebam.com/abc123.jpg')).toBe('https://www.imagebam.com/view/abc123');
    expect(imagebamRefererForCdn('https://images1.imagebam.com/abc')).toBe('https://www.imagebam.com/view/abc');
    expect(imagebamRefererForCdn('not a url')).toBe('https://www.imagebam.com/');
    expect(imagebamRefererForCdn('https://example.com/')).toBe('https://www.imagebam.com/');
  });
});

describe('turbo extractors', () => {
  test('turboExtractId', () => {
    expect(turboExtractId('https://turbo.cr/v/AbC123/')).toBe('AbC123');
    expect(turboExtractId('https://turbo.cr/embed/AbC123')).toBe('AbC123');
    expect(turboExtractId('https://www.turbovid.cr/d/AbC123?x=1')).toBe('AbC123');
    expect(turboExtractId('https://turbo.cr/')).toBe('');
    expect(turboExtractId('https://example.com')).toBe('');
  });

  test('turboExtractFn', () => {
    expect(turboExtractFn('https://turbocdn.st/x?fn=my%20file.mp4')).toBe('my file.mp4');
    expect(turboExtractFn('https://turbocdn.st/x?fn=a+b.mp4')).toBe('a b.mp4');
    expect(turboExtractFn('https://turbocdn.st/x?other=1')).toBe('');
  });
});

describe('extractNum', () => {
  test('parses numbers and defaults to 0', () => {
    expect(extractNum(42)).toBe(42);
    expect(extractNum('42')).toBe(42);
    expect(extractNum('12.5')).toBe(12.5);
    expect(extractNum('abc')).toBe(0);
    expect(extractNum(null)).toBe(0);
    expect(extractNum(undefined)).toBe(0);
  });
});

describe('headerValue', () => {
  const headers = 'HTTP/2 200\r\ncontent-type: video/mp4\r\nContent-Length: 1234\r\nX-Custom: a; b\r\n';

  test('extracts header case-insensitively', () => {
    expect(headerValue(headers, 'content-type')).toBe('video/mp4');
    expect(headerValue(headers, 'CONTENT-TYPE')).toBe('video/mp4');
    expect(headerValue(headers, 'content-length')).toBe('1234');
  });

  test('returns empty for missing header', () => {
    expect(headerValue(headers, 'missing')).toBe('');
    expect(headerValue('', 'content-type')).toBe('');
  });
});

describe('parseDispositionFilename', () => {
  test('RFC 5987 filename*', () => {
    const h = "attachment; filename*=UTF-8''caf%C3%A9.mp4";
    expect(parseDispositionFilename(h)).toBe('café.mp4');
  });

  test('quoted filename', () => {
    expect(parseDispositionFilename('attachment; filename="file one.mp4"')).toBe('file one.mp4');
  });

  test('bare filename', () => {
    expect(parseDispositionFilename('attachment; filename=file.mp4')).toBe('file.mp4');
  });

  test('prefers filename* over filename', () => {
    expect(parseDispositionFilename("attachment; filename=plain.mp4; filename*=UTF-8''caf%C3%A9.mp4")).toBe('café.mp4');
  });

  test('returns empty when absent', () => {
    expect(parseDispositionFilename('content-type: video/mp4')).toBe('');
    expect(parseDispositionFilename('')).toBe('');
  });
});

describe('computeBatchLength', () => {
  test('turbo links force 1', () => {
    expect(computeBatchLength([{ url: 'https://turbo.cr/v/x' }, { url: 'https://example.com/a.jpg' }])).toBe(1);
  });

  test('bunkr links force 1', () => {
    expect(computeBatchLength([{ url: 'https://bunkr.sk/x' }, { url: 'https://example.com/a.jpg' }])).toBe(1);
  });

  test('everything else defaults to 2', () => {
    expect(computeBatchLength([{ url: 'https://example.com/a.jpg' }, { url: 'https://example.com/b.jpg' }])).toBe(2);
    expect(computeBatchLength([])).toBe(2);
  });
});

describe('buildBatches', () => {
  const res = n => ({ url: `https://example.com/${n}.jpg` });
  const go = n => ({ url: `https://gofile.io/d/${n}` });

  test('splits into fixed-size batches', () => {
    const batches = buildBatches([res(1), res(2), res(3), res(4), res(5)], 2);
    expect(batches.map(b => b.length)).toEqual([2, 2, 1]);
  });

  test('never puts two gofile items in one batch', () => {
    const batches = buildBatches([go(1), go(2), go(3)], 2);
    expect(batches.map(b => b.filter(i => isGoFileUrl(i.url)).length)).toEqual([1, 1, 1]);
  });

  test('gofile item can share a batch with non-gofile items', () => {
    const batches = buildBatches([res(1), go(1), res(2), go(2)], 2);
    expect(batches.map(b => b.filter(i => isGoFileUrl(i.url)).length)).toEqual([1, 1]);
  });

  test('empty input yields no batches', () => {
    expect(buildBatches([], 2)).toEqual([]);
  });

  test('respects custom predicate', () => {
    const always = () => true;
    const batches = buildBatches([res(1), res(2)], 2, always);
    expect(batches.map(b => b.length)).toEqual([1, 1]);
  });
});
