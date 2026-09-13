const h = {
  isArray: v => Array.isArray(v),
  isObject: v => typeof v === 'object',
  isNullOrUndef: v => v === null || v === undefined || typeof v === 'undefined',
  basename: path =>
    path
      .replace(/\/(\s+)?$/, '')
      .split('/')
      .reverse()[0],
  fnNoExt: path => path.trim().split('.').reverse().slice(1).reverse().join('.'),
  ext: path => {
    return !path || path.indexOf('.') < 0 ? null : path.split('.').reverse()[0];
  },
  show: element => (element.style.display = 'block'),
  hide: element => (element.style.display = 'none'),
  promise: executor => new Promise(executor),
  delayedResolve: async ms => await h.promise(resolve => setTimeout(resolve, ms)),
  stripTag: (tag, content) => content.replace(new RegExp(`<${tag}.*?<\/${tag}>`, 'igs'), ''),
  stripTags: (tags, content) => tags.reduce((stripped, tag) => h.stripTag(tag, stripped), content),
  limit: (string, maxLength = 20) => (string.length > maxLength ? `${string.substring(0, maxLength - 1)}...` : string),
  element: (selector, container = document) => container.querySelector(selector),
  elements: (selector, container = document) => container.querySelectorAll(selector),
  contains: (needle, haystack, ignoreCase = true) =>
    (ignoreCase ? haystack.toLowerCase().indexOf(needle.toLowerCase()) : haystack.indexOf(needle)) > -1,
  ucFirst: str => (!str ? str : `${str[0].toUpperCase()}${str.substring(1)}`),
  unique: items => {
    return items.reduce((acc, item) => (acc.indexOf(item) < 0 ? acc.concat(item) : acc), []);
  },
  // Adapted from https://github.com/sindresorhus/pretty-bytes.
  prettyBytes: (number, options = {}) => {
    const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const BIBYTE_UNITS = ['B', 'kiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];

    const BIT_UNITS = ['b', 'kbit', 'Mbit', 'Gbit', 'Tbit', 'Pbit', 'Ebit', 'Zbit', 'Ybit'];

    const BIBIT_UNITS = ['b', 'kibit', 'Mibit', 'Gibit', 'Tibit', 'Pibit', 'Eibit', 'Zibit', 'Yibit'];

    // A locale string/array selects locales; true or formatting options use the system locale.
    const toLocaleString = (number, locale, options) => {
      let result = number;
      if (typeof locale === 'string' || Array.isArray(locale)) {
        result = number.toLocaleString(locale, options);
      } else if (locale === true || options !== undefined) {
        result = number.toLocaleString(undefined, options);
      }

      return result;
    };

    if (!Number.isFinite(number)) {
      throw new TypeError(`Expected a finite number, got ${typeof number}: ${number}`);
    }

    options = {
      bits: false,
      binary: false,
      space: true,
      ...options,
    };

    const UNITS = options.bits ? (options.binary ? BIBIT_UNITS : BIT_UNITS) : options.binary ? BIBYTE_UNITS : BYTE_UNITS;

    const separator = options.space ? ' ' : '';

    if (options.signed && number === 0) {
      return ` 0${separator}${UNITS[0]}`;
    }

    const isNegative = number < 0;
    const prefix = isNegative ? '-' : options.signed ? '+' : '';

    if (isNegative) {
      number = -number;
    }

    let localeOptions;

    if (options.minimumFractionDigits !== undefined) {
      localeOptions = { minimumFractionDigits: options.minimumFractionDigits };
    }

    if (options.maximumFractionDigits !== undefined) {
      localeOptions = { maximumFractionDigits: options.maximumFractionDigits, ...localeOptions };
    }

    if (number < 1) {
      const numberString = toLocaleString(number, options.locale, localeOptions);
      return prefix + numberString + separator + UNITS[0];
    }

    const exponent = Math.min(Math.floor(options.binary ? Math.log(number) / Math.log(1024) : Math.log10(number) / 3), UNITS.length - 1);
    number /= (options.binary ? 1024 : 1000) ** exponent;

    if (!localeOptions) {
      number = number.toPrecision(3);
    }

    const numberString = toLocaleString(Number(number), options.locale, localeOptions);

    const unit = UNITS[exponent];

    return prefix + numberString + separator + unit;
  },
  ui: {
    setText: (element, text) => {
      element.textContent = text;
    },
    setElProps: (element, props) => {
      for (const prop in props) {
        element.style[prop] = props[prop];
      }
    },
  },
  http: {
    base: (method, url, callbacks = {}, headers = {}, data = {}, responseType = 'document', timeoutMs = 0) => {
      return h.promise((resolve, reject) => {
        let responseHeaders = null;
        let request = null;
        // __xfpd_withCredentials is a request option carried in headers, not an HTTP header.
        const hdrs = {
          Referer: url,
          ...(headers || {}),
        };
        const withCredentials = !!(
          hdrs &&
          Object.prototype.hasOwnProperty.call(hdrs, '__xfpd_withCredentials') &&
          hdrs.__xfpd_withCredentials
        );
        try {
          if (hdrs && Object.prototype.hasOwnProperty.call(hdrs, '__xfpd_withCredentials')) delete hdrs.__xfpd_withCredentials;
        } catch (e) {}

        request = http({
          url,
          method,
          responseType,
          data,
          headers: hdrs,
          ...(withCredentials ? { withCredentials: true, anonymous: false } : {}),
          timeout: timeoutMs,
          onreadystatechange: response => {
            if (response.readyState === 2) {
              responseHeaders = response.responseHeaders;
              const finalUrl = response.finalUrl || response.responseURL || '';

              if (callbacks && callbacks.onResponseHeadersReceieved) {
                callbacks.onResponseHeadersReceieved({ request, response, status: response.status, responseHeaders });

                if (request) {
                  request.abort();
                  resolve({ request, response, status: response.status, responseHeaders, finalUrl });
                }
              }
            }

            callbacks && callbacks.onStateChange && callbacks.onStateChange({ request, response });
          },
          onprogress: response => {
            callbacks && callbacks.onProgress && callbacks.onProgress({ request, response });
          },
          onload: response => {
            const { responseText, status } = response;
            const dom = response?.response;
            const finalUrl = response.finalUrl || response.responseURL || '';
            callbacks && callbacks.onLoad && callbacks.onLoad(response);
            resolve({ source: responseText, request, status, dom, responseHeaders, finalUrl });
          },
          onerror: error => {
            callbacks && callbacks.onError && callbacks.onError(error);
            reject(error);
          },
          ontimeout: () => {
            const error = new Error(`Request timed out: ${method} ${url}`);
            callbacks?.onError?.(error);
            reject(error);
          },
        });
      });
    },
    get: (url, callbacks = {}, headers = {}, responseType = 'document', timeoutMs = 0) => {
      return h.http.base('GET', url, callbacks, headers, null, responseType, timeoutMs);
    },
    post: (url, data = {}, callbacks = {}, headers = {}, responseType = 'document', timeoutMs = 0) => {
      return h.http.base('POST', url, callbacks, headers, data, responseType, timeoutMs);
    },
  },
  re: {
    stripFlags: pattern => {
      if (!h.contains('/', pattern)) {
        return pattern;
      }

      const s = pattern.split('').reverse().join('');

      const index = s.indexOf('/');

      return s.substring(index).split('').reverse().join('');
    },
    toString: pattern => {
      let stringified = h.re.stripFlags(pattern.toString());

      if (stringified[0] === '/') {
        stringified = stringified.substring(1);
      }

      if (stringified[stringified.length - 1] === '/') {
        stringified = stringified.substring(0, stringified.length - 1);
      }

      return stringified;
    },
    toRegExp: (pattern, flags) => {
      return new RegExp(pattern, flags);
    },
    match: (pattern, subject) => {
      const matches = pattern.exec(subject);
      return matches && matches.length ? matches[0] : null;
    },
    // Adapted from regex101.com; requires a global or sticky pattern.
    matchAll: (pattern, subject) => {
      const matches = [];

      let m;

      while ((m = pattern.exec(subject)) !== null) {
        // Advance past zero-width matches to avoid an infinite loop.
        if (m.index === pattern.lastIndex) {
          pattern.lastIndex++;
        }

        matches.push(m[0]);
      }

      return matches;
    },
  },
};
