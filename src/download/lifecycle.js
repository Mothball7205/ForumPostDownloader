// Track active posts so shared GoFile credentials outlive concurrent downloads.
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
    // Restore only after the last active post, without masking the task's result or error.
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
