import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const refresh = source.slice(source.indexOf('const modelRefreshCooldown'), source.indexOf('function refreshModelsOnReturn'));

test('a timed-out background model check keeps the current model usable', async () => {
  const elements = { 'retry-models': {}, 'model-error': {}, models: { value: 'example' } };
  const context = vm.createContext({
    state: { modelState: 'online', models: ['example'], chat: null },
    $: id => elements[id],
    api: async () => { throw new Error('The inference server took too long to respond.'); },
    performance: { now: () => 6000 },
    renderModels: () => {}
  });
  await vm.runInContext(refresh + '\nrefreshModels()', context);
  assert.equal(context.state.modelState, 'online');
  assert.deepEqual(context.state.models, ['example']);
});
