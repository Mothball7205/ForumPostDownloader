const addDuplicateTabLink = post => {
  const span = document.createElement('span');
  span.innerHTML = '<i class="fa fa-copy"></i> Duplicate Tab';

  const dupTabLI = post.parentNode.querySelector('.u-concealed').cloneNode(true);
  dupTabLI.setAttribute('class', 'duplicate-tab');

  const anchor = dupTabLI.querySelector('a');
  anchor.style.color = 'rgb(138, 138, 138)';
  anchor.setAttribute('target', '_blank');
  anchor.querySelector('time').remove();
  anchor.parentNode.style.marginLeft = '10px';
  anchor.append(span);

  post.parentNode.querySelector('.message-attribution-main').append(dupTabLI);
};

const addShowDownloadPageBtnLink = post => {
  const span = document.createElement('span');
  span.innerHTML = '<i class="fa fa-arrow-up"></i> Download Page';

  const dupTabLI = post.parentNode.querySelector('.u-concealed').cloneNode(true);
  dupTabLI.setAttribute('class', 'show-download-page');

  const anchor = dupTabLI.querySelector('a');
  anchor.style.color = 'rgb(138, 138, 138)';
  anchor.setAttribute('href', '#download-page');
  anchor.querySelector('time').remove();
  anchor.parentNode.style.marginLeft = '10px';
  anchor.append(span);

  post.parentNode.querySelector('.message-attribution-main').append(dupTabLI);
};

const addDownloadPageButton = () => {
  const downloadAllButton = document.createElement('a');
  downloadAllButton.setAttribute('id', 'download-page');
  downloadAllButton.setAttribute('href', '#');
  downloadAllButton.setAttribute('class', 'button--link button rippleButton');

  const buttonTextSpan = document.createElement('span');
  buttonTextSpan.setAttribute('class', 'button-text download-page-btn');
  buttonTextSpan.innerText = `🡳 Download Page`;

  downloadAllButton.appendChild(buttonTextSpan);

  const buttonGroup = h.element('.buttonGroup');
  buttonGroup.prepend(downloadAllButton);

  return downloadAllButton;
};

const registerPostReaction = postFooter => {
  const hasReaction = postFooter.querySelector('.has-reaction');
  if (!hasReaction) {
    const reactionAnchor = postFooter.querySelector('.reaction--imageHidden');
    if (reactionAnchor) {
      reactionAnchor.setAttribute('href', reactionAnchor.getAttribute('href').replace('_id=1', '_id=33'));
      reactionAnchor.click();
    }
  }
};

const CYBERDROP_WARMUP_DEFAULT_MS = 2500;
let cyberdropWarmupChain = Promise.resolve();
const cyberdropWarmupAttempted = new Map();

// Let Cyberdrop set cookies in a background tab; serialize warmups so only one tab is open.
async function cyberdropWarmupOnce(key, warmUrl, ms = CYBERDROP_WARMUP_DEFAULT_MS) {
  // Also accepts a single warm-up URL.
  if (typeof warmUrl === 'undefined') {
    const maybeUrl = String(key || '').trim();
    if (/^https?:\/\//i.test(maybeUrl)) {
      warmUrl = maybeUrl;
      try {
        key = `cyberdrop:${new URL(maybeUrl).origin}`;
      } catch {
        key = `cyberdrop:${maybeUrl}`;
      }
    }
  }

  // Use origin-based keys to avoid warming up once per file.
  const _k0 = String(key || '').trim();
  if (_k0.indexOf('://') !== -1) {
    const m = _k0.match(/https?:\/\/[^\s]+/i);
    if (m) {
      try {
        key = `cyberdrop:${new URL(m[0]).origin}`;
      } catch {}
    }
  }

  const k = String(key || '').trim();
  const u = String(warmUrl || '').trim();
  if (!k || !u) return;

  if (cyberdropWarmupAttempted.has(k)) {
    try {
      await cyberdropWarmupAttempted.get(k);
    } catch (e) {}
    return;
  }

  cyberdropWarmupChain = cyberdropWarmupChain.then(() => {
    return new Promise(resolve => {
      try {
        const tab = GM_openInTab(u, { active: false, insert: true, setParent: true });
        setTimeout(
          () => {
            try {
              xfpdCloseTabHandle(tab);
            } catch (e) {}
            resolve();
          },
          Math.max(250, ms),
        );
      } catch (e) {
        resolve();
      }
    });
  });

  cyberdropWarmupAttempted.set(k, cyberdropWarmupChain);
  await cyberdropWarmupChain;
}
