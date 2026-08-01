const JSZip = window.JSZip;
const tippy = window.tippy;
const http = window.GM_xmlhttpRequest;
window.isFF = typeof InstallTrigger !== 'undefined';
window.logs = [];

const log = {
  /**
   * @returns {number}
   */
  separator: postId => window.logs.push({ postId, message: '-'.repeat(175) }),
  /**
   * @param postId
   * @param str
   * @param type
   * @param toConsole
   */
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
  /**
   * @param postId
   * @param str
   * @param scope
   */
  info: (postId, str, scope) => log.write(postId, `[${scope}] ${str}`, 'INFO'),
  /**
   * @param postId
   * @param str
   * @param scope
   */
  warn: (postId, str, scope) => log.write(postId, `[${scope}] ${str}`, 'WARNING'),
  /**
   * @param postId
   * @param str
   * @param scope
   */
  error: (postId, str, scope) => log.write(postId, `[${scope}] ${str}`, 'ERROR'),
  // TODO: Fix param orders for the methods: -.-
  post: {
    /**
     * @param postId
     * @param str
     * @param postNumber
     * @returns {*}
     */
    info: (postId, str, postNumber) => log.info(postId, str, `POST #${postNumber}`),
    /**
     * @param postId
     * @param str
     * @param postNumber
     * @returns {*}
     */
    error: (postId, str, postNumber) => log.error(postId, str, `POST #${postNumber}`),
  },
  host: {
    /**
     * @param postId
     * @param str
     * @param host
     * @returns {*}
     */
    info: (postId, str, host) => log.info(postId, str, host),
    /**
     * @param postId
     * @param str
     * @param host
     * @returns {*}
     */
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
