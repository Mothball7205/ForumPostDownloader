resolvers.push([
  [/cyberfile.(su|me)\//, /:!cyberfile.(su|me)\/folder\//],
  async (url, http, spoilers) => {
    const { source } = await http.get(url);
    const u = h.re.matchAll(/(?<=showFileInformation\()\d+(?=\))/gis, source)[0];

    const getFileInfo = async () => {
      const { source } = await http.post(
        'https://cyberfile.me/account/ajax/file_details',
        `u=${u}`,
        {},
        {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      );
      return source;
    };

    let response = await getFileInfo();

    let requiredPassword = false;
    let unlocked = false;

    if ((h.contains('albumPasswordModel', response) || h.contains('This folder requires a password', response)) && spoilers.length) {
      const html = JSON.parse(response).html;

      const matches = /value="(\d+)"\sid="folderId"|value="(\d+)"\sname="folderId"/is.exec(html);

      const folderId = matches.length ? matches[1] : null;

      if (!folderId) {
        return null;
      }

      requiredPassword = true;
      for (const password of spoilers) {
        const { source } = await http.post(
          'https://cyberfile.me/ajax/folder_password_process',
          `submitme=1&folderId=${folderId}&folderPassword=${password}`,
          {},
          {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        );

        if (h.contains('success', source) && JSON.parse(source).success === true) {
          unlocked = true;
          break;
        }
      }
    }

    if (requiredPassword && unlocked) {
      response = await getFileInfo();
    }

    return h.re.matchAll(/(?<=openUrl\(').*?(?=')/gi, response)[0]?.replace(/\\\//gi, '/');
  },
]);

resolvers.push([
  [/cyberfile.(su|me)\/folder\//],
  async (url, http, spoilers) => {
    const { source, dom } = await http.get(url);

    const script = [...dom.querySelectorAll('script')].map(s => s.innerText).filter(s => h.contains('data-toggle="tab"', s))[0];

    const nodeId = h.re.matchAll(/(?<='folder',\s').*?(?=')/gis, script);

    const loadFiles = async () => {
      const { source } = await http.post(
        'https://cyberfile.me/account/ajax/load_files',
        `pageType=folder&nodeId=${nodeId}`,
        {},
        {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      );
      return source;
    };

    let response = await loadFiles();

    let requiredPassword = false;
    let unlocked = false;

    if ((h.contains('albumPasswordModel', response) || h.contains('This folder requires a password', response)) && spoilers.length) {
      requiredPassword = true;
      for (const password of spoilers) {
        const { source } = await http.post(
          'https://cyberfile.me/ajax/folder_password_process',
          `submitme=1&folderId=${nodeId}&folderPassword=${password}`,
          {},
          {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        );

        if (h.contains('success', source) && JSON.parse(source).success === true) {
          unlocked = true;
          break;
        }
      }
    }

    if (!unlocked) {
      return null;
    }

    if (requiredPassword && unlocked) {
      response = await loadFiles();
    }

    const resolved = [];

    let folderName = h.basename(url);

    const props = JSON.parse(response);

    if (props && props.html) {
      folderName = props.page_title || folderName;

      const urls = h.re.matchAll(/(?<=dtfullurl=").*?(?=")/gis, props.html);

      for (const fileUrl of urls) {
        const { source } = await http.get(fileUrl);
        const u = h.re.matchAll(/(?<=showFileInformation\()\d+(?=\))/gis, source)[0];
        const { source: response } = await http.post(
          'https://cyberfile.me/account/ajax/file_details',
          `u=${u}`,
          {},
          {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        );
        resolved.push(h.re.matchAll(/(?<=openUrl\(').*?(?=')/gi, response)[0]?.replace(/\\\//gi, '/'));
      }
    }

    return {
      dom,
      source,
      folderName,
      resolved,
    };
  },
]);
