import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const idPattern = /^[a-z][a-z0-9_-]{0,39}$/;
const maxResult = 64 * 1024;
const maxInput = 64 * 1024;
const timeoutMs = 10000;
const modelName = (id, name) => `plugin_${id.length}_${id}_${name}`;
const runner = resolve(import.meta.dirname, 'plugin-runner.mjs');

async function checkFile(path, limit = Infinity) {
  const file = await lstat(path);
  if (!file.isFile() || file.size > limit) throw new Error('Invalid plugin file: ' + path);
}

function validSchema(schema) {
  return schema && typeof schema === 'object' && !Array.isArray(schema) &&
    schema.type === 'object' && schema.properties && typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties);
}

export async function discoverPlugins(directory, workspace = '') {
  const plugins = [];
  let folders;
  try { folders = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return plugins; throw error; }
  for (const folder of folders) {
    if (!folder.isDirectory() || !idPattern.test(folder.name)) continue;
    try {
      const root = await realpath(join(directory, folder.name));
      const manifestPath = join(root, 'plugin.json');
      await checkFile(manifestPath, 64 * 1024);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.apiVersion !== 1 || manifest.id !== folder.name ||
          typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 ||
          typeof manifest.description !== 'string' || manifest.description.length > 500 ||
          !Array.isArray(manifest.tools) || manifest.tools.length > 12) throw new Error('Invalid plugin manifest');
      let skill = '';
      try {
        const skillPath = join(root, 'SKILL.md');
        await checkFile(skillPath, 32 * 1024);
        skill = (await readFile(skillPath, 'utf8')).trim();
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (skill.length > 32000 || (!skill && !manifest.tools.length) ||
          (manifest.tools.length ? manifest.main !== 'index.mjs' : manifest.main !== undefined)) {
        throw new Error('Plugin needs tools or a SKILL.md');
      }
      const permissions = manifest.permissions ?? {};
      if (typeof permissions !== 'object' || Array.isArray(permissions) ||
          Object.keys(permissions).some(key => !['workspaceRead', 'workspaceWrite'].includes(key)) ||
          Object.values(permissions).some(value => typeof value !== 'boolean') ||
          (permissions.workspaceWrite && !permissions.workspaceRead) ||
          (!manifest.tools.length && (permissions.workspaceRead || permissions.workspaceWrite)) ||
          ((permissions.workspaceRead || permissions.workspaceWrite) && !workspace)) {
        throw new Error('Invalid or unavailable workspace permission');
      }
      const names = new Set();
      for (const tool of manifest.tools) {
        if (typeof tool?.name !== 'string' || !idPattern.test(tool.name) || modelName(manifest.id, tool.name).length > 64 || names.has(tool.name) ||
            typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1000 ||
            !validSchema(tool.parameters) || JSON.stringify(tool.parameters).length > 16000) {
          throw new Error('Invalid tool definition');
        }
        names.add(tool.name);
      }
      const entry = manifest.tools.length ? join(root, manifest.main) : '';
      if (entry) await checkFile(entry);
      plugins.push({ ...manifest, permissions, root, entry, skill });
    } catch (error) {
      console.warn(`Skipping plugin ${folder.name}: ${error.message}`);
    }
  }
  return plugins;
}

export function pluginTools(plugin, workspace = '') {
  return plugin.tools.map(tool => ({
    name: modelName(plugin.id, tool.name),
    label: `${plugin.name} · ${tool.name}`,
    description: tool.description,
    parameters: tool.parameters,
    run: (args, signal) => runPlugin(plugin, tool.name, args, workspace, signal)
  }));
}

async function runPlugin(plugin, toolName, args, workspace, signal) {
  signal?.throwIfAborted();
  const input = JSON.stringify(args);
  if (Buffer.byteLength(input) > maxInput) throw new Error('Plugin input is too large');
  const flags = ['--permission', `--allow-fs-read=${runner}`, `--allow-fs-read=${plugin.root}`];
  if (plugin.permissions.workspaceRead) flags.push(`--allow-fs-read=${workspace}`);
  if (plugin.permissions.workspaceWrite) flags.push(`--allow-fs-write=${workspace}`);
  const child = spawn(process.execPath, [...flags, '--max-old-space-size=64', runner, plugin.entry, toolName], {
    cwd: plugin.root,
    env: plugin.permissions.workspaceRead ? { PLUGIN_WORKSPACE: workspace } : {},
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });
  const closed = once(child, 'close');
  let output = '';
  let failure;
  const stop = error => {
    if (failure) return;
    failure = error;
    child.kill('SIGKILL');
  };
  const abort = () => stop(signal.reason);
  const timer = setTimeout(() => stop(new Error('Plugin timed out')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (failure) return;
    output += chunk;
    if (Buffer.byteLength(output) > maxResult) stop(new Error('Plugin output is too large'));
  });
  child.stdin.on('error', stop);
  try {
    child.stdin.end(input);
    const [code] = await closed;
    if (failure) throw failure;
    if (code !== 0) throw new Error('Plugin failed');
    const result = JSON.parse(output);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Plugin must return an object');
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
