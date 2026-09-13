// One post owns this queue. Closing drains accepted items; failure wakes both stages.
const createDownloadQueue = (capacity = 8) => {
  const items = [];
  const readers = [];
  const writers = [];
  let closed = false;
  let failure = null;

  const push = async item => {
    while (!closed && !failure && items.length >= capacity) {
      await new Promise((resolve, reject) => writers.push({ resolve, reject }));
    }
    if (failure) throw failure;
    if (closed) throw new Error('Download queue is closed');
    const reader = readers.shift();
    if (reader) reader.resolve({ value: item, done: false });
    else items.push(item);
  };

  const next = () => {
    if (failure) return Promise.reject(failure);
    if (items.length) {
      const value = items.shift();
      writers.shift()?.resolve();
      return Promise.resolve({ value, done: false });
    }
    if (closed) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => readers.push({ resolve, reject }));
  };

  const close = () => {
    closed = true;
    for (const reader of readers.splice(0)) reader.resolve({ done: true });
    for (const writer of writers.splice(0)) writer.reject(new Error('Download queue is closed'));
  };

  const fail = error => {
    failure = error;
    closed = true;
    items.length = 0;
    for (const reader of readers.splice(0)) reader.reject(error);
    for (const writer of writers.splice(0)) writer.reject(error);
  };

  return {
    push,
    next,
    close,
    fail,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createDownloadQueue };
}
