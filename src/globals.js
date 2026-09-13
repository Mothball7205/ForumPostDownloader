const JSZip = window.JSZip;
const tippy = window.tippy;
const http = window.GM_xmlhttpRequest;
window.isFF = typeof InstallTrigger !== 'undefined';
window.logs = [];

const log = {
  separator: postId => window.logs.push({ postId, message: '-'.repeat(175) }),
  write: (postId, str, type, toConsole = true) => {
    const date = new Date();
    const message = `[${date.toDateString()} ${date.toLocaleTimeString()}] [${type}] ${str}`
      .replace(/(::.*?::)/gi, (match, g) => g.toUpperCase())
      .replace(/::/g, '');
    window.logs.push({ postId, message });
    if (toConsole) {
      if (type.toLowerCase() === 'info') {
        console.info(message);
      } else if (type.toLowerCase() === 'warn') {
        console.warn(message);
      } else {
        console.error(message);
      }
    }
  },
  info: (postId, str, scope) => log.write(postId, `[${scope}] ${str}`, 'INFO'),
  warn: (postId, str, scope) => log.write(postId, `[${scope}] ${str}`, 'WARNING'),
  error: (postId, str, scope) => log.write(postId, `[${scope}] ${str}`, 'ERROR'),
  post: {
    info: (postId, str, postNumber) => log.info(postId, str, `POST #${postNumber}`),
    error: (postId, str, postNumber) => log.error(postId, str, `POST #${postNumber}`),
  },
  host: {
    info: (postId, str, host) => log.info(postId, str, host),
    error: (postId, str, host) => log.error(postId, str, host),
  },
};

const settings = {
  naming: {
    allowEmojis: false,
    invalidCharSubstitute: '-',
  },
  hosts: {
    goFile: {
      token: '',
    },
  },
  ui: {
    checkboxes: {
      toggleAllCheckboxLabel: '',
    },
  },
  extensions: {
    documents: ['.txt', '.doc', '.docx', '.pdf'],
    compressed: ['.zip', '.rar', '.7z', '.tar', '.bz2', '.gzip'],
    image: ['.jpg', '.jpeg', '.png', '.gif', '.gif', '.webp', '.jpe', '.svg', '.tif', '.tiff', '.jif'],
    video: [
      '.mpeg',
      '.avchd',
      '.webm',
      '.mpv',
      '.swf',
      '.avi',
      '.m4p',
      '.wmv',
      '.mp2',
      '.m4v',
      '.qt',
      '.mpe',
      '.mp4',
      '.flv',
      '.mov',
      '.mpg',
      '.ogg',
    ],
  },
};
