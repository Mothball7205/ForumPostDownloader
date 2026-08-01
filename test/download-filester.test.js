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
