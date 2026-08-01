const init = {
  injectCustomStyles: () => {
    // Tippy transparent theme.
    const styleEl = document.createElement('style');
    styleEl.textContent = styles.tippy.theme;
    document.head.append(styleEl);

    const customStyles = document.createElement('style');
    // Margins classes
    const marginClasses = [];

    for (let i = 1; i <= 15; i++) {
      marginClasses.push(`.m-l-${i} {margin-left: ${i}px;}`);
      marginClasses.push(`.m-t-${i} {margin-top: ${i}px;}`);
    }

    customStyles.textContent = marginClasses.join('\n');
    document.head.append(customStyles);
  },
};
// Holds the posts that are processing downloads.
let processing = [];

/**
 * An array of arrays defining how to match hosts inside the posts.
 *
 * The first item in the array is the signature.
 * The second item is an array of matchers.
 *
 * A matcher is a regular expression matching a substring inside the post.
 *
 * The first matcher matches a single resource (e.g. an image or a video).
 * The second matcher matches a folder or an album (e.g. a set of related images)
 *
 * [0: signature(name+category), 1: [single_regex, album_regex]]
 *
 * When applied, every matcher is prefixed with https?:\/\/(www.)?
 *
 * Every matcher is matched against the following attributes:
 *
 * href, src, data-url
 *
 * You must not include the pattern to match attributes.
 * They are automatically handled when a matcher is run.
 *
 * For a completely custom pattern, put !! (two excl. characters) anywhere in it:
 *
 * [/!!https:\/\/cyberfile.su\/\w+(?=")/, /cyberfile.su\/folder\//]
 *
 * @signature string The name and categories of the host, separated by a colon.
 * @matchers array The name and categories of the host, separated by a colon.
 *
 * Matchers can include the following options anywhere
 * (preferably where it doesn't break the pattern) within a pattern.
 *
 * @option <no_qs> Removes query string
 * @option <keep_ts> Keeps the trailing slash
 *
 * The following placeholders can be used inside any matcher pattern:
 *
 * @placeholder ~an@ -> a-zA-Z0-9
 *
 */
