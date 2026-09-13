import { createDownloadQueue } from '../src/download/queue.js';

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('a full ready queue pauses production until a consumer takes an item', async () => {
  const queue = createDownloadQueue(2);
  await queue.push('first');
  await queue.push('second');
  let accepted = false;
  const pending = queue.push('third').then(() => {
    accepted = true;
  });
  await tick();
  expect(accepted).toBe(false);
  expect((await queue.next()).value).toBe('first');
  await pending;
  queue.close();
  const remaining = [];
  for await (const value of queue) remaining.push(value);
  expect(remaining).toEqual(['second', 'third']);
});

test('an empty queue waits for production rather than ending downloads', async () => {
  const queue = createDownloadQueue();
  let ended = false;
  const next = queue.next().then(value => {
    ended = true;
    return value;
  });
  await tick();
  expect(ended).toBe(false);
  await queue.push('ready');
  expect(await next).toEqual({ value: 'ready', done: false });
  const last = queue.next();
  queue.close();
  expect(await last).toEqual({ done: true });
});

test('failure wakes a blocked producer and discards work that cannot be consumed', async () => {
  const queue = createDownloadQueue(1);
  await queue.push('first');
  const blocked = queue.push('second');
  const failure = new Error('consumer failed');
  queue.fail(failure);
  await expect(blocked).rejects.toBe(failure);
  await expect(queue.next()).rejects.toBe(failure);
});

test('failure wakes consumers waiting for the next resolved file', async () => {
  const queue = createDownloadQueue();
  const first = queue.next();
  const second = queue.next();
  const failure = new Error('resolver failed');
  queue.fail(failure);
  await expect(first).rejects.toBe(failure);
  await expect(second).rejects.toBe(failure);
});
