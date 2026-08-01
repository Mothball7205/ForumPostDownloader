const hosts = [
  ['Simpcity:Attachments', [/(\/attachments\/|\/data\/video\/)/]],
  ['Coomer:Profiles', [/coomer.st\/[~an@._-]+\/user/]],
  ['Coomer:image', [/(\w+\.)?coomer.st\/(data|thumbnail)/]],
  [
    'JPGX:image',
    [
      /(simp\d+\.)?(cuckcapital\.cr|jpg\d?\.(church|fish|fishing|pet|su|cr))\/(?!(img\/|a\/|album\/))/,
      /jpe?g\d\.(church|fish|fishing|pet|su|cr)(\/a\/|\/album\/)[~an@-_.]+<no_qs>/,
    ],
  ],
  ['Goonbox:image', [/goonbox\.cr\/img\//, /goonbox\.cr\/a\//]],
  ['kemono:direct link', [/.{2,6}\.kemono.cr\/data\//]],
  ['Postimg:image', [/!!https?:\/\/(www.)?i\.?(postimg|pixxxels).cc\/(.{8})/]], //[/!!https?:\/\/(www.)?postimg.cc\/(.{8})/]],
  [
    'Ibb:image',
    [
      /!!(?<=href=")https?:\/\/(www.)?([a-z](\d+)?\.)?ibb\.co\/([a-zA-Z0-9_.-]){7}((?=")|\/)(([a-zA-Z0-9_.-])+(?="))?/,
      /ibb.co\/album\/[~an@_.-]+/,
    ],
  ],
  [
    'Ibb:direct link',
    [/!!(?<=data-src=")https?:\/\/(www.)?([a-z](\d+)?\.)?ibb\.co\/([a-zA-Z0-9_.-]){7}((?=")|\/)(([a-zA-Z0-9_.-])+(?="))?/],
  ],
  ['Imagevenue:image', [/!!https?:\/\/(www.)?imagevenue\.com\/(.{8})/]],
  ['Imgvb:image', [/imgvb.com\/images\//, /imgvb.com\/album/]],
  ['Imgbox:image', [/(thumbs|images)(\d+)?.imgbox.com\//, /imgbox.com\/g\//]],
  ['Onlyfans:image', [/public.onlyfans.com\/files/]],
  ['Reddit:image', [/(\w+)?.redd.it/]],
  ['Pomf2:File', [/pomf2.lain.la/]],
  ['Nitter:image', [/nitter\.(.{1,20})\/pic/]],
  ['Twitter:image', [/([~an@.]+)?twimg.com\//]],
  ['Pixhost:image', [/(t|img)(\d+)?\.pixhost.to\//, /pixhost.to\/gallery\//]],
  ['Imagebam:image', [/imagebam.com\/(view|gallery)/]],
  ['Imagebam:full embed', [/images\d.imagebam.com/]],
  ['turbo:video', [/([\w-]+\.)?turbo\.cr\/(embed|v|d)\//]],
  ['turbo:albums', [/([\w-]+\.)?turbo\.cr\/a\//]],
  ['Redgifs:video', [/!!redgifs.com(\/|\\\/)ifr.*?(?=["']|&quot;)/]],
  ['Redgifs:user', [/redgifs\.com\/users\//]],
  [
    'Bunkr:',
    [
      /!!(?<=href=")https:\/\/((stream|cdn(\d+)?)\.)?bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|ru|su|org)(?!(\/a\/)).*?(?=")|(?<=(href=")|(src="))https:\/\/((i|cdn|i-pizza|big-taco-1img)(\d+)?\.)?bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|ru|su|org)(?!(\/a\/))\/(v\/)?.*?(?=")/,
    ],
  ],
  ['Bunkr:Albums', [/bunkrr?r?\.(ac|ax|black|cat|ci|cr|fi|is|media|nu|pk|ph|ps|red|ru|se|si|site|sk|ws|ru|su|org)\/a\//]],
  ['Give.xxx:Profiles', [/give.xxx\/[~an@_-]+/]],
  ['Pixeldrain:', [/(focus\.)?(?:pixeldrain\.com|pixeldrain\.net|pixeldra\.in)\/[lu]\//]],
  ['Gofile:', [/gofile.io\/d/]],
  ['Filester:links', [/filester\.(me|sh|si|gg)\/d\//]],
  ['Filester:albums', [/filester\.(me|sh|si|gg)\/f\/[~an@-_.]+<no_qs>/]],
  ['Box.com:', [/m\.box\.com\//]],
  ['Yandex:', [/(disk\.)?yandex\.[a-z]+/]],
  ['Cyberfile:', [/!!https:\/\/cyberfile.(su|me)\/\w+(\/)?(?=")/, /cyberfile.(su|me)\/folder\//]],
  ['Cyberdrop:', [/fs-\d+\.cyberdrop\.[a-z]{2,}\/|cyberdrop\.[a-z]{2,}\/(f|e)\//, /cyberdrop\.[a-z]{2,}\/a\//]],
  ['Pornhub:video', [/([~an@]+\.)?pornhub.com\/view_video/]],
  ['Noodlemagazine:video', [/(adult.)?noodlemagazine.com\/watch\//]],
  ['Spankbang:video', [/spankbang.com\/.*?\/video/]],
];

/**
 * An array of url resolvers.
 *
 * @type {((RegExp[]|(function(*): *))[]|(RegExp[]|(function(*, *): Promise<{dom: *, source: *, folderName: *, resolved}>))[]|(RegExp[]|(function(*, *): Promise<string>))[]|(RegExp[]|(function(*, *): Promise<{dom: *, source: *, folderName: *, resolved}>))[]|(RegExp[]|(function(*): *))[])[]}
 */
/* -------------------------------------------------------------------------
 * Turbo sign hardening:
 * - timeout 5000ms
 * - retry 2x with jitter delay 700–1400ms
 * This avoids rare ~50s "waiting" stalls on https://turbo.cr/api/sign
 * ------------------------------------------------------------------------- */
