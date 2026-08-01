resolvers.push([
  [/https?:\/\/nitter\.(.{1,20})\/pic\/(orig\/)?media%2F(.{1,15})/i],
  url => url.replace(/https?:\/\/nitter\.(.{1,20})\/pic\/(orig\/)?media%2F(.{1,15})/i, 'https://pbs.twimg.com/media/$3'),
]);

resolvers.push([
  [/imagevenue.com/],
  async (url, http) => {
    const { dom } = await http.get(url);
    return dom.querySelector('.col-md-12 > a > img').getAttribute('src');
  },
]);

resolvers.push([[/pomf2.lain.la/], url => url.replace(/pomf2.lain.la\/f\/(.*)\.(\w{3,4})(\?.*)?/, 'pomf2.lain.la/f/$1.$2')]);
