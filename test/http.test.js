import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/helpers.js', 'utf8');

test('a stalled HTTP request rejects on its deadline instead of hanging resolution', async () => {
  const sandbox = {
    http: options => {
      queueMicrotask(() => {
        if (options.timeout === 20) options.ontimeout();
        else options.onload({ responseText: 'unexpected success', status: 200 });
      });
      return { abort() {} };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.request = h.http.get;', sandbox);
  await expect(sandbox.request('https://example.com/stalled', {}, {}, 'text', 20)).rejects.toThrow('Request timed out');
});
