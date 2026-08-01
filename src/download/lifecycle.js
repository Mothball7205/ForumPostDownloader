// Per-post processing lifecycle: marks a post active while it downloads and
// guarantees GoFile cookie restoration even when the task throws. The state
// array and restore function are injectable for tests; in the built userscript
// they default to init.js's `processing` and host-caches.js's `gofileRestoreCookie`.
const setProcessing = (isProcessing, postId, state = processing) => {
  const p = state.find(p => p.postId === postId);
  if (p) {
    p.processing = isProcessing;
  } else {
    state.push({ postId, processing: isProcessing });
  }
};

const runWithPostProcessing = async (postId, task, state = processing, restoreCookie = gofileRestoreCookie) => {
  setProcessing(true, postId, state);
  try {
    return await task();
  } finally {
    setProcessing(false, postId, state);
    // Restore the GoFile accountToken cookie only when this was the last active post.
    // A restore failure is swallowed: a successful download stays successful and a
    // task failure is rethrown unchanged.
    if (!state.some(p => p.processing)) {
      try {
        await restoreCookie();
      } catch (e) {}
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { setProcessing, runWithPostProcessing };
}
