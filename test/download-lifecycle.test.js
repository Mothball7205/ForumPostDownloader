import { setProcessing, runWithPostProcessing } from '../src/download/lifecycle.js';

describe('setProcessing', () => {
  test('adds a new entry when the post is unknown', () => {
    const state = [];
    setProcessing(true, 'p1', state);
    expect(state).toEqual([{ postId: 'p1', processing: true }]);
  });

  test('updates an existing entry', () => {
    const state = [{ postId: 'p1', processing: true }];
    setProcessing(false, 'p1', state);
    expect(state).toEqual([{ postId: 'p1', processing: false }]);
  });
});

describe('runWithPostProcessing', () => {
  test('successful task returns its result and restores once when idle', async () => {
    const state = [];
    const restore = jest.fn(async () => {});
    const result = await runWithPostProcessing('p1', async () => 'ok', state, restore);
    expect(result).toBe('ok');
    expect(state).toEqual([{ postId: 'p1', processing: false }]);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('task error is rethrown and restore still runs', async () => {
    const state = [];
    const restore = jest.fn(async () => {});
    await expect(
      runWithPostProcessing(
        'p1',
        async () => {
          throw new Error('boom');
        },
        state,
        restore,
      ),
    ).rejects.toThrow('boom');
    expect(state).toEqual([{ postId: 'p1', processing: false }]);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('restore is deferred while another post is still processing', async () => {
    const state = [{ postId: 'p2', processing: true }];
    const restore = jest.fn(async () => {});
    await runWithPostProcessing('p1', async () => 'ok', state, restore);
    expect(restore).not.toHaveBeenCalled();
    expect(state).toEqual([
      { postId: 'p2', processing: true },
      { postId: 'p1', processing: false },
    ]);
  });

  test('restore failure does not mask a successful task result', async () => {
    const state = [];
    const restore = jest.fn(async () => {
      throw new Error('restore failed');
    });
    const result = await runWithPostProcessing('p1', async () => 'ok', state, restore);
    expect(result).toBe('ok');
    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('restore failure does not replace the original task error', async () => {
    const state = [];
    const restore = jest.fn(async () => {
      throw new Error('restore failed');
    });
    await expect(
      runWithPostProcessing(
        'p1',
        async () => {
          throw new Error('task failed');
        },
        state,
        restore,
      ),
    ).rejects.toThrow('task failed');
  });
});
