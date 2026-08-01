resolvers.push([
  [/m\.box\.com\//],
  async (url, http) => {
    const { source, dom } = await http.get(url);
    const files = [...dom.querySelectorAll('.files-item-anchor')].map(el => `https://m.box.com${el.getAttribute('href')}`);

    const resolved = [];

    for (const fileUrl of files) {
      const { source, dom } = await http.get(fileUrl);
      if (h.contains('image-preview', source)) {
        resolved.push(dom.querySelector('.image-preview').getAttribute('src'));
      } else {
        resolved.push(dom.querySelector('.mtl > a').getAttribute('href'));
      }
    }

    return {
      source,
      dom,
      folderName: dom.querySelector('.folder-nav-title')?.innerText.trim(),
      resolved: resolved.map(u => `https://m.box.com${u}`),
    };
  },
]);

resolvers.push([
  [/twimg.com\//],
  url => url.replace(/https?:\/\/pbs.twimg\.com\/media\/(.{1,15})(\?format=)?(.*)&amp;name=(.*)/, 'https://pbs.twimg.com/media/$1.$3'),
]);

resolvers.push([
  [/(disk\.)?yandex\.[a-z]+/],
  async (url, http) => {
    const { dom } = await http.get(url);

    const script = dom.querySelector('script[id="store-prefetch"]');

    if (!script) {
      return null;
    }

    const json = JSON.parse(script.innerText);

    let sk,
      hash = null;

    if (json && json.environment && json.resources) {
      sk = json.environment.sk;
      const resourcesKeys = Object.keys(json.resources);
      hash = json.resources[resourcesKeys[0]]?.hash;
    }

    const data = JSON.stringify({ hash, sk });

    const { source } = await http.post(
      'https://disk.yandex.ru/public/api/download-url',
      data,
      {},
      {
        'Content-Type': 'text/plain',
      },
    );

    const response = JSON.parse(source);

    if (response && response.error !== 'true' && response.data) {
      return response.data.url;
    }

    return null;
  },
]);

resolvers.push([[/(\w+)?.redd.it/], url => url.replace(/&amp;/g, '&')]);
