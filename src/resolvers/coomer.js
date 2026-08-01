resolvers.push([[/coomer.st\/(data|thumbnail)/], url => url]);

resolvers.push([
  [/coomer.st/, /:!coomer.st\/(data|thumbnail)/],
  async (url, http) => {
    const host = `https://coomer.st`;

    const profileId = url.replace(/\?.*/, '').split('/').reverse()[0];

    let finalURL = url.replace(/\?.*/, '');

    let nextPage = null;

    const posts = [];

    console.log(`[coomer.st] Resolving profile: ${profileId}`);

    let page = 1;

    do {
      const { dom } = await http.get(finalURL);

      const links = [...dom.querySelectorAll('.card-list__items > article')]
        .map(a => a.querySelector('.post-card__heading > a'))
        .map(a => {
          return {
            link: `${host}${a.getAttribute('href')}`,
            id: a.getAttribute('href').split('/').reverse()[0],
          };
        });

      posts.push(...links);
      nextPage = dom.querySelector('a[title="Next page"]');

      if (nextPage) {
        finalURL = `${host}${nextPage.getAttribute('href')}`;
      }

      console.log(`[coomer.st] Resolved page: ${page}`);

      page++;
    } while (nextPage);

    const resolved = [];

    let index = 1;

    for (const post of posts) {
      const { dom } = await http.get(post.link);
      const filesContainer = dom.querySelector('.post__files');

      if (filesContainer) {
        const images = filesContainer.querySelectorAll('.post__thumbnail > .fileThumb');

        if (images.length) {
          resolved.push(
            ...[...images].map(a => {
              return {
                url: `${host}${a.getAttribute('href')}`,
                folderName: post.id,
              };
            }),
          );
        }
      }

      const attachments = dom.querySelectorAll('.post__attachments > .post__attachment > .post__attachment-link');

      if (attachments.length) {
        resolved.push(
          ...[...attachments].map(a => {
            const url = `${host}${a.getAttribute('href')}`;

            let folder = 'Images';

            const ext = h.ext(url.replace(/\?.*/, ''));

            if (settings.extensions.video.includes(`.${ext.toLowerCase()}`)) {
              folder = 'Videos';
            }

            {
              return {
                url,
                folderName: `${post.id}/${folder}`,
              };
            }
          }),
        );
      }

      console.log(`[coomer.st] Resolved post ${index} / ${posts.length}`);

      index++;
    }

    return {
      folderName: profileId,
      resolved,
    };
  },
]);
