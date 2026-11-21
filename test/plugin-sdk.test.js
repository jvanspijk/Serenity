import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins, pluginTools } from '../plugin-sdk.js';

test('discovers tool, skill, and combined plugins and executes a tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serenity-plugins-'));
  try {
    const source = new URL('../examples/word-count/', import.meta.url);
    const combined = join(root, 'word-count');
    await mkdir(combined);
    for (const file of ['plugin.json', 'index.mjs', 'SKILL.md']) {
      await writeFile(join(combined, file), await readFile(new URL(file, source)));
    }
    const skillOnly = join(root, 'skill-only');
    await mkdir(skillOnly);
    await writeFile(join(skillOnly, 'plugin.json'), JSON.stringify({
      apiVersion: 1, id: 'skill-only', name: 'Skill only', description: '', tools: []
    }));
    await writeFile(join(skillOnly, 'SKILL.md'), '# Skill only\nUse concise answers.');
    const toolOnly = join(root, 'tool-only');
    await mkdir(toolOnly);
    await writeFile(join(toolOnly, 'plugin.json'), JSON.stringify({
      apiVersion: 1, id: 'tool-only', name: 'Tool only', description: '', main: 'index.mjs',
      tools: [{ name: 'count', description: 'Count words.', parameters: { type: 'object', properties: {} } }]
    }));
    await writeFile(join(toolOnly, 'index.mjs'), await readFile(new URL('index.mjs', source)));
    const plugins = await discoverPlugins(root);
    assert.deepEqual(plugins.map(plugin => plugin.id).sort(), ['skill-only', 'tool-only', 'word-count']);
    assert.equal(plugins.find(plugin => plugin.id === 'skill-only').skill.includes('Use concise'), true);
    assert.equal(plugins.find(plugin => plugin.id === 'tool-only').skill, '');
    const result = await pluginTools(plugins.find(plugin => plugin.id === 'word-count'))[0].run({ text: 'one two three' });
    assert.deepEqual(JSON.parse(result.content[0].text), { words: 3, characters: 13 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin process cannot read outside its folder without a workspace grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serenity-plugin-deny-'));
  try {
    await writeFile(join(root, 'secret.txt'), 'private');
    const folder = join(root, 'reader');
    await mkdir(folder);
    await writeFile(join(folder, 'plugin.json'), JSON.stringify({
      apiVersion: 1, id: 'reader', name: 'Reader', description: '', main: 'index.mjs',
      tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }]
    }));
    await writeFile(join(folder, 'index.mjs'), `import { readFile } from 'node:fs/promises';
      export async function run() {
        try { return { text: await readFile('../secret.txt', 'utf8') }; }
        catch (error) { return { error: error.code }; }
      }`);
    const [plugin] = await discoverPlugins(root);
    const result = await pluginTools(plugin)[0].run({});
    assert.equal(result.error, 'ERR_ACCESS_DENIED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
