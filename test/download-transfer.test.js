import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const utilsSource = readFileSync(join('src', 'download-utils.js'), 'utf8');
const transferSource = readFileSync(join('src', 'download', 'transfer.js'), 'utf8');
const cachesSource = readFileSync(join('src', 'host-caches.js'), 'utf8');

const h = {
  limit: (s, maxLength = 80) => {
    const str = String(s || '');
    return str.length > maxLength ? str.substring(0, maxLength - 1) + '...' : str;
  },
};

const sandbox = { h, URL };
vm.createContext(sandbox);
vm.runInContext(cachesSource + '\n' + utilsSource + '\n' + transferSource + '\nglobalThis.__classify = classifyDownloadAttempt;', sandbox);
const classifyDownloadAttempt = sandbox.__classify;

describe('classifyDownloadAttempt', () => {
  test('Cyberdrop resource derives origin, file page, and root referer', () => {
    const attempt = classifyDownloadAttempt(
      {
        url: 'https://fs-01.cyberdrop.cr/api/file/d/abc123',
        host: { name: 'Cyberdrop' },
        original: 'https://cyberdrop.cr/f/abc123',
        folderName: null,
      },
      1,
    );

    expect(attempt.isCyberdrop).toBe(true);
    expect(attempt.cyberOrigin).toBe('https://cyberdrop.cr');
    expect(attempt.cyberFilePage).toBe('https://cyberdrop.cr/f/abc123');
    expect(attempt.reflink).toBe('https://cyberdrop.cr/');
    expect(attempt.ellipsedUrl).toBe('https://fs-01.cyberdrop.cr/api/file/d/abc123');
    expect(attempt.isGoFile).toBe(false);
    expect(attempt.isPixeldrain).toBe(false);
    expect(attempt.isTurbo).toBe(false);
    expect(attempt.isBunkr).toBe(false);
    expect(attempt.isFilester).toBe(false);
    expect(attempt.pass).toBe(1);
  });

  test('unrelated host leaves all host flags false and uses original as referer', () => {
    const attempt = classifyDownloadAttempt(
      {
        url: 'https://cdn.example.com/files/clip.mp4',
        host: { name: 'Example' },
        original: 'https://example.com/files/clip.mp4',
        folderName: null,
      },
      2,
    );

    expect(attempt.isCyberdrop).toBe(false);
    expect(attempt.isGoFile).toBe(false);
    expect(attempt.isPixeldrain).toBe(false);
    expect(attempt.isTurbo).toBe(false);
    expect(attempt.isBunkr).toBe(false);
    expect(attempt.isFilester).toBe(false);
    expect(attempt.cyberOrigin).toBe('');
    expect(attempt.cyberSlug).toBe('');
    expect(attempt.cyberFilePage).toBe('');
    expect(attempt.reflink).toBe('https://example.com/files/clip.mp4');
    expect(attempt.pass).toBe(2);
  });

  test('GoFile detection and pass 2 retry flag', () => {
    const attempt = classifyDownloadAttempt(
      {
        url: 'https://gofile.io/download/web/abc123/file.mp4',
        host: { name: 'GoFile' },
        original: 'https://gofile.io/d/abc123',
        folderName: 'Album',
      },
      2,
    );
    expect(attempt.isGoFile).toBe(true);
    expect(attempt.folderName).toBe('Album');
    expect(attempt.pass).toBe(2);
  });

  test('malformed Cyberdrop original does not throw and leaves strings empty', () => {
    const attempt = classifyDownloadAttempt(
      {
        url: 'https://fs-01.cyberdrop.cr/api/file/d/abc123',
        host: { name: 'Cyberdrop' },
        original: '',
        folderName: null,
      },
      1,
    );
    expect(attempt.isCyberdrop).toBe(true);
    expect(attempt.cyberOrigin).toBe('');
    expect(attempt.cyberFilePage).toBe('');
  });
});
