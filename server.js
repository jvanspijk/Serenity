import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bearer, httpUrl, sse } from './protocol.js';
import { connectMcp } from './mcp.js';
import { builtInTools } from './tool-registry.js';
import { createMcpDiscovery } from './tools/mcp-discovery.js';
import { createPresentView } from './tools/present-view.js';
import { readFileTool } from './tools/read-file.js';
import { renderAudio } from './tools/workspace-audio.js';
import { renderImage } from './tools/workspace-image.js';
import { discoverPlugins, pluginTools } from './plugin-sdk.js';
import { readMultipart } from './multipart.js';
import {
  attachmentMarkdown, attachmentPresentation, attachmentPreview, deleteWorkspace, withWorkspace,
  workspaceMedia, workspaceMediaKinds, WorkspaceMediaError
} from './workspace.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
const data = resolve(process.env.DATA_DIR || 'data');
const pluginDirectory = resolve(process.env.PLUGIN_DIR || 'plugins');
const pluginWorkspace = process.env.PLUGIN_WORKSPACE ? resolve(process.env.PLUGIN_WORKSPACE) : '';
const chats = join(data, 'chats');
const configPath = join(data, 'settings.json');
const active = new Map();
const baseSystemPrompt = `You are an assistant using Serenity, an agentic chat harness.
Serenity focuses only on essentials, minimizing mental effort for the agent and user.

# Working Style

- Complete all explicit and implied user requirements until writing a final response.
- If an intermediary step fails or provides minimal data, alter strategy instead of repeating the same action.
- Only report that something cannot be fulfilled after all reasonable and viable attempts have been exhausted.`;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const paletteDirectory = new URL('./public/palettes/', import.meta.url);
const paletteLabels = { 'e-ink': 'e-ink (light)', 'e-ink-dark': 'e-ink (dark)' };
const colorPalettes = new Set((await readdir(paletteDirectory, { withFileTypes: true }))
  .filter(file => file.isFile() && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.css$/.test(file.name))
  .map(file => file.name.slice(0, -4))
  .sort());
const defaults = {
  endpoint: process.env.INFERENCE_URL || 'http://127.0.0.1:11434/v1',
  token: process.env.INFERENCE_API_KEY || '',
  systemPrompt: '',
  showInferenceStats: false,
  chatTextSize: 'medium',
  colorPalette: 'nordic',
  followUpBehavior: 'queue',
  shareTimezone: false,
  mcp: []
};
await mkdir(chats, { recursive: true });
const plugins = await discoverPlugins(pluginDirectory, pluginWorkspace);
const availableTools = [
  ...builtInTools,
  ...plugins.map(plugin => ({
    id: 'plugin:' + plugin.id,
    label: plugin.name,
    description: plugin.description,
    permissions: plugin.permissions,
    systemPrompt: plugin.skill,
    tools: pluginTools(plugin, pluginWorkspace)
  }))
];

const paletteNames = [defaults.colorPalette, ...[...colorPalettes].filter(name => name !== defaults.colorPalette)];
const paletteLinks = [...colorPalettes].map(name => `<link rel="stylesheet" href="/palettes/${name}.css">`);
const paletteOptions = paletteNames.filter(name => colorPalettes.has(name)).map(name => {
  const label = Object.hasOwn(paletteLabels, name) ? paletteLabels[name] :
    name.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  return `<option value="${name}">${label}</option>`;
});
const index = (await readFile(new URL('./public/index.html', import.meta.url), 'utf8'))
  .replace('<!-- Palette stylesheets -->', paletteLinks.join('\n  '))
  .replace('<!-- Palette options -->', paletteOptions.join('\n              '));
const staticFiles = new Map(await Promise.all([
  ['/style.css', 'style.css', 'text/css'],
  ...[...colorPalettes].map(name => ['/palettes/' + name + '.css', 'palettes/' + name + '.css', 'text/css']),
  ['/app.js', 'app.js', 'text/javascript'],
  ['/markdown.js', 'markdown.js', 'text/javascript'],
  ['/icons.svg', 'icons.svg', 'image/svg+xml']
].map(async ([url, file, type]) => [url, [type, await readFile(new URL('./public/' + file, import.meta.url))]])));
staticFiles.set('/', ['text/html', index]);
staticFiles.set('/markdown-it.mjs', ['text/javascript',
  await readFile(new URL(import.meta.resolve('markdown-it/browser')))]);
staticFiles.set('/protocol.js', ['text/javascript', await readFile(new URL('./protocol.js', import.meta.url))]);

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function load(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function save(path, value, signal) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    signal?.throwIfAborted();
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

const settings = async () => {
  const config = { ...defaults, ...await load(configPath) };
  if (!colorPalettes.has(config.colorPalette)) config.colorPalette = defaults.colorPalette;
  config.toolDefaults = selectedBuiltIns(config.toolDefaults, config.webSearchByDefault);
  return config;
};
const chatPath = id => join(chats, id + '.json');
const summary = ({ id, title, model, updated }) => ({ id, title, model, updated });

function publicSettings({ endpoint, token, systemPrompt, showInferenceStats, chatTextSize, colorPalette, followUpBehavior, shareTimezone, toolDefaults, mcp }) {
  return {
    endpoint, hasToken: Boolean(token), systemPrompt, showInferenceStats: showInferenceStats === true, chatTextSize, colorPalette, followUpBehavior,
    shareTimezone: shareTimezone === true, webSearchByDefault: toolDefaults.includes('webSearch'),
    tools: availableTools.map(({ id, label, description, permissions }) => ({
      id, label, description, permissions, enabledByDefault: toolDefaults.includes(id)
    })),
    mcp: mcp.map(({ id, name, url, token: key, enabledByDefault }) => ({
      id, name, url, hasToken: Boolean(key), enabledByDefault: Boolean(enabledByDefault)
    }))
  };
}

function selectedBuiltIns(ids, legacyWebSearch, fallback = []) {
  if (!Array.isArray(ids)) {
    ids = legacyWebSearch === undefined ? fallback : fallback.filter(id => id !== 'webSearch');
    if (legacyWebSearch === true) ids = [...ids, 'webSearch'];
  }
  return availableTools.flatMap(({ id }) => ids.includes(id) ? [id] : []);
}

function chatTools(selection, config, previous = {}) {
  const builtIn = selectedBuiltIns(selection.builtIn, selection.webSearch,
    Array.isArray(previous?.builtIn) ? previous.builtIn : previous?.webSearch === true ? ['webSearch'] : []);
  return {
    builtIn, webSearch: builtIn.includes('webSearch'),
    mcp: config.mcp.filter(server => selection.mcp?.includes(server.id)).map(server => server.id)
  };
}

function validToolIds(ids) {
  return Array.isArray(ids) && ids.every(id => typeof id === 'string');
}

function validateTools(selection) {
  const builtInValid = selection?.builtIn === undefined ? typeof selection?.webSearch === 'boolean' : validToolIds(selection.builtIn);
  if (!builtInValid || !Array.isArray(selection.mcp) ||
      selection.mcp.length > 12 || selection.mcp.some(id => typeof id !== 'string' || !uuid.test(id))) {
    fail(400, 'Invalid chat tools.');
  }
  return selection;
}

function endpointUrl(value) {
  try {
    const url = httpUrl(value);
    if (url.search) throw new Error();
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/v1') ? path : path + '/v1';
    return url.href;
  } catch {
    fail(400, 'Enter an HTTP or HTTPS inference URL, such as http://localhost:11434/v1.');
  }
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    fail(415, 'Expected a JSON request.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 28 * 1024 * 1024) fail(413, 'The JSON request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { fail(400, 'Invalid JSON.'); }
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function inference(config, path, options, signal) {
  let response;
  try {
    response = await fetch(endpointUrl(config.endpoint) + path, {
      ...options, redirect: 'error', signal,
      headers: { ...bearer(config.token), ...options?.headers }
    });
  } catch (error) {
    if (signal.aborted) throw error;
    fail(502, 'Could not reach the inference server. Check that it is running and that the URL is correct.');
  }
  if (!response.ok) {
    const message = await response.json().catch(() => null);
    const detail = message?.error?.message ?? message?.error;
    fail(502, 'Inference server returned HTTP ' + response.status + (typeof detail === 'string' ? ': ' + detail.slice(0, 500) : '.'));
  }
  return response;
}

// Keep partial tags buffered so reasoning never flashes in the visible answer.
function splitReasoning(write) {
  let buffer = '';
  let inside = false;
  let closing = '';
  function drain(final = false) {
    while (buffer) {
      const tags = inside ? [closing] : ['<think>', '<reasoning>'];
      const pattern = new RegExp(tags.join('|'), 'i');
      const match = pattern.exec(buffer);
      if (match) {
        write(inside ? 'reasoning' : 'content', buffer.slice(0, match.index));
        if (!inside) closing = '</' + match[0].slice(1);
        inside = !inside;
        buffer = buffer.slice(match.index + match[0].length);
        continue;
      }
      let keep = 0;
      for (const tag of tags) {
        for (let i = 1; i < tag.length; i++) {
          if (buffer.toLowerCase().endsWith(tag.slice(0, i).toLowerCase())) keep = Math.max(keep, i);
        }
      }
      const end = buffer.length - keep;
      write(inside ? 'reasoning' : 'content', buffer.slice(0, end));
      buffer = final ? '' : buffer.slice(end);
      break;
    }
  }
  return { add(text) { buffer += text; drain(); }, finish() { drain(true); } };
}

async function completion(config, model, messages, tools, write, signal) {
  const response = await inference(config, '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: true, stream_options: { include_usage: true }, ...(tools.length && { tools })
    })
  }, signal);
  const toolCalls = new Map();
  let content = '';
  let finished = false;
  let usage;
  let timings;
  const reasoning = splitReasoning((kind, text) => {
    if (kind === 'content') content += text;
    write(kind, text);
  });
  try {
    for await (const part of sse(response.body)) {
      if (part === '[DONE]') { finished = true; break; }
      const event = JSON.parse(part);
      if (event.error) fail(502, String(event.error.message || 'The model interrupted the stream.'));
      usage = event.usage ?? usage;
      timings = event.timings ?? timings;
      const choice = event.choices?.[0];
      if (!choice) continue;
      finished ||= Boolean(choice.finish_reason);
      const delta = choice.delta || {};
      write('reasoning', delta.reasoning_content ?? delta.reasoning);
      if (typeof delta.content === 'string') reasoning.add(delta.content);
      for (const [position, piece] of (delta.tool_calls || []).entries()) {
        const index = piece.index ?? position;
        const call = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (piece.id) call.id = piece.id;
        call.function.name += piece.function?.name || '';
        call.function.arguments += piece.function?.arguments || '';
        toolCalls.set(index, call);
      }
    }
    if (!finished) fail(502, 'The inference stream ended early. You can retry the message.');
  } finally {
    reasoning.finish();
  }
  return { content, calls: [...toolCalls.values()].map(call => ({ ...call, id: call.id || randomUUID() })), usage, timings };
}

function recordUsage(reply, usage, timings) {
  const stats = reply.stats ?? {};
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  const timedTokens = timings?.predicted_n ?? output;
  const duration = timings?.predicted_ms;
  if (Number.isSafeInteger(input) && input >= 0) stats.input = (stats.input ?? 0) + input;
  if (Number.isSafeInteger(output) && output >= 0) stats.output = (stats.output ?? 0) + output;
  if (Number.isSafeInteger(timedTokens) && timedTokens >= 0 && Number.isFinite(duration) && duration > 0) {
    stats.timedTokens = (stats.timedTokens ?? 0) + timedTokens;
    stats.generationMs = (stats.generationMs ?? 0) + duration;
  }
  if (Object.keys(stats).length) reply.stats = stats;
}

async function modelMessage(chatId, { role, content, attachments, views }) {
  const links = await attachmentMarkdown(chatId, attachments);
  const presented = views?.length && 'Views shown in this reply:\n' + views.map(view => '- ' + view.path).join('\n');
  return { role, content: [content, links, presented].filter(Boolean).join('\n\n') };
}

async function presentAttachments(chatId, attachments) {
  return await Promise.all(attachments.map(attachment => attachmentPresentation(chatId, attachment)));
}

function viewURL(chatId, viewId) {
  return '/api/chats/' + chatId + '/views/' + viewId;
}

function sendView(req, res, type, bytes) {
  const headers = { 'Content-Type': type, 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!range || (!range[1] && !range[2])) {
    res.writeHead(200, headers);
    return res.end(bytes);
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'Content-Length': end - start + 1,
    'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length });
  return res.end(bytes.subarray(start, end + 1));
}

async function generate(res, input, receive = async () => {}) {
  const { id, model, retry } = input;
  if (id && !uuid.test(id)) fail(400, 'Invalid conversation.');
  if (typeof model !== 'string' || !model.trim() || model.length > 500) fail(400, 'Choose a model first.');
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (content.length > 100000) fail(400, 'This message is too long.');
  if (input.images?.length || input.files?.length) fail(400, 'Refresh Serenity to upload files.');
  const chatId = id || randomUUID();
  if (active.has(chatId)) fail(409, 'A reply is already running for this conversation.');
  if (editing.has(chatId)) fail(409, 'This conversation is being updated.');
  const controller = new AbortController();
  const replyId = randomUUID();
  const run = { controller, replyId };
  active.set(chatId, run);
  const sessions = [];
  const disconnected = () => controller.abort();
  res.on('close', disconnected);
  if (res.destroyed) disconnected();
  const emit = (type, fields = {}) => {
    if (!res.destroyed) res.write('data: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  };
  try {
    const chat = await load(chatPath(chatId));
    if (id && !chat) fail(404, 'Conversation not found.');
    const config = await settings();
    const localDateTime = typeof input.localDateTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(input.localDateTime)
      ? input.localDateTime : '';
    if (!localDateTime) fail(400, 'Refresh Serenity to send your local date and time.');
    const timezone = config.shareTimezone === true && typeof input.timezone === 'string' &&
      /^[A-Za-z0-9_+\-/]{1,100}$/.test(input.timezone) ? input.timezone : '';
    if (config.shareTimezone === true && !timezone) fail(400, 'Refresh Serenity to share your local timezone.');
    const history = chat || { id: chatId, title: '', messages: [] };
    const selected = chat ? chat.tools || {} : input.tools === undefined ? {
      builtIn: config.toolDefaults, mcp: config.mcp.filter(server => server.enabledByDefault).map(server => server.id)
    } : validateTools(input.tools);
    history.tools = chatTools(selected, config);
    if (retry) {
      const last = history.messages.at(-1);
      if (last?.role !== 'assistant' || !last.issue) fail(409, 'There is no interrupted reply to retry.');
    }
    const reply = { role: 'assistant', model, content: '', reasoning: '', issue: 'Reply interrupted.' };
    const previousEntries = history.messages.flatMap(message => (message.attachments || []).map(attachment => attachment.entry));
    const attachments = await withWorkspace(chatId, previousEntries, receive, controller.signal, async attachments => {
      if (retry && attachments.length) fail(400, 'A reply retry cannot upload files.');
      if (!retry && !content && !attachments.length) fail(400, 'Enter a message or attach a file.');
      if (!chat) history.title = (content.replace(/\s+/g, ' ') || attachments[0]?.name).slice(0, 58);
      if (retry) history.messages.pop();
      else history.messages.push({ role: 'user', content, attachments });
      history.messages.push(reply);
      history.model = model;
      history.updated = new Date().toISOString();
      const presentation = await presentAttachments(chatId, attachments);
      await save(chatPath(chatId), history, controller.signal);
      return presentation;
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    emit('start', { chat: summary(history), tools: history.tools, replyId, attachments });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 12000);
    const deadline = AbortSignal.timeout(15 * 60 * 1000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    const write = (field, text) => {
      if (typeof text === 'string' && text) {
        reply[field] += text;
        emit(field, { text });
      }
    };
    try {
      const workspaceAttachments = history.messages.flatMap(message => message.attachments || []);
      const mediaKinds = await workspaceMediaKinds(chatId, workspaceAttachments);
      const enabled = availableTools.filter(({ id, mediaKind }) =>
        history.tools.builtIn.includes(id) && (!mediaKind || mediaKinds.has(mediaKind)));
      const tools = new Map(enabled.flatMap(group => group.tools.map(tool => [tool.name, tool])));
      tools.set(readFileTool.name, {
        ...readFileTool,
        description: [
          readFileTool.description,
          mediaKinds.has('image') && 'Returns an image for an image file or selected PDF page.',
          mediaKinds.has('audio') && 'Returns one chunk for an audio file.'
        ].filter(Boolean).join(' ')
      });
      const media = workspaceMedia(chatId, workspaceAttachments, signal);
      if (mediaKinds.size) {
        run.attachments = workspaceAttachments;
        const presentView = createPresentView(mediaKinds, view => {
          const entry = { ...view, id: randomUUID() };
          run.views = reply.views ??= [];
          run.views.push(entry);
          emit('view', { view: { ...entry, url: viewURL(chatId, entry.id) } });
        });
        tools.set(presentView.name, presentView);
      }
      const servers = config.mcp.filter(server => history.tools.mcp.includes(server.id));
      const connections = await Promise.all(servers.map(async server => {
        try {
          const session = await connectMcp(server, signal);
          sessions.push(session);
          return { server: server.name, session };
        } catch (error) {
          if (!signal.aborted) console.warn(JSON.stringify({ event: 'tool_connection_failed', chatId,
            replyId, server: server.name, error: error?.message }));
          return null;
        }
      }));
      const discovery = createMcpDiscovery(connections.filter(Boolean), tools);
      if (discovery) tools.set(discovery.name, discovery);
      const systemPrompt = [
        baseSystemPrompt,
        `Current local date and time: ${localDateTime}${timezone ? ` (${timezone})` : ''}.`,
        config.systemPrompt.trim() && config.systemPrompt,
        ...enabled.map(({ systemPrompt }) => systemPrompt)
      ].filter(Boolean).join('\n\n');
      const messages = [
        { role: 'system', content: systemPrompt },
        ...await Promise.all(history.messages.slice(0, -1)
          .filter(message => message.role === 'user' || message.content || message.views?.length)
          .map(message => modelMessage(chatId, message)))
      ];
      const maxToolRounds = 32;
      for (let round = 0; round <= maxToolRounds; round++) {
        const roundTools = round < maxToolRounds ? new Map(tools) : new Map();
        const descriptions = [];
        const declarations = [...roundTools].map(([name, { description, parameters }]) => {
          if (description) descriptions.push(`- \`${name}\`: ${description}`);
          return { type: 'function', function: { name, parameters } };
        });
        messages[0].content = descriptions.length ? systemPrompt + '\n\n# Tool descriptions\n\n' +
          descriptions.join('\n') : systemPrompt;
        const { content: answer, calls, usage, timings } = await completion(config, model, messages, declarations, write, signal);
        recordUsage(reply, usage, timings);
        signal.throwIfAborted();
        if (!calls.length) {
          if (!reply.content && !reply.views?.length) fail(502, 'The model returned no answer.');
          delete reply.issue;
          break;
        }
        if (round === maxToolRounds) fail(502, 'The model exceeded the tool call limit.');
        messages.push({ role: 'assistant', content: answer || null, tool_calls: calls });
        const mediaParts = [];
        for (const call of calls) {
          signal.throwIfAborted();
          const entry = roundTools.get(call.function.name);
          const unavailable = 'This tool is unavailable.';
          let result = { isError: true, content: [{ type: 'text', text: unavailable }] };
          let failure = entry ? undefined : unavailable;
          if (entry) {
            try {
              const args = JSON.parse(call.function.arguments || '{}');
              if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
              emit('tool', { text: entry.label });
              const output = await entry.run(args, signal, media);
              if (entry.supportsMedia) {
                result = output.result;
                if (output.contentPart) {
                  const label = output.contentPart.type === 'image_url' ? 'Image from ' + result.path :
                    'Media from tool call ' + call.id + '.';
                  mediaParts.push({ type: 'text', text: label }, output.contentPart);
                }
              } else result = output;
            } catch (error) {
              signal.throwIfAborted();
              const message = error instanceof WorkspaceMediaError ? error.message :
                entry.label + ' could not run. Continuing without its results.';
              result = { isError: true, content: [{ type: 'text', text: message }] };
              failure = error?.message || message;
            }
          }
          if (result?.isError === true) {
            console.warn(JSON.stringify({ event: 'tool_call_failed', chatId, replyId, toolCallId: call.id,
              tool: call.function.name, arguments: call.function.arguments,
              error: failure ?? result.error ?? 'Tool returned an error.' }));
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
        }
        // Chat Completions accepts image and audio parts in user messages, after all tool replies.
        if (mediaParts.length) messages.push({ role: 'user', content: mediaParts });
      }
    } catch (error) {
      reply.issue = controller.signal.aborted ? 'Reply stopped.' : deadline.aborted ? 'The model took too long to respond.' :
        error.status ? error.message : 'The model connection was interrupted. You can retry the message.';
    } finally {
      clearInterval(heartbeat);
      await save(chatPath(chatId), history);
    }
    emit('done', { issue: reply.issue, stats: reply.stats });
    res.end();
  } finally {
    active.delete(chatId);
    res.off('close', disconnected);
    await Promise.all(sessions.map(session => session.close()));
  }
}

const editing = new Set();
createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const method = req.method;
    const origin = req.headers.origin;
    if (origin && (!/^https?:\/\//.test(origin) || new URL(origin).host !== req.headers.host)) {
      fail(403, 'Cross-origin requests are disabled.');
    }
    if (method === 'GET' && staticFiles.has(pathname)) {
      const [type, body] = staticFiles.get(pathname);
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      return res.end(body);
    }
    if (pathname === '/api/settings' && method === 'GET') return send(res, 200, publicSettings(await settings()));
    if (pathname === '/api/settings' && method === 'PUT') {
      const input = await readJson(req);
      const current = await settings();
      const endpoint = endpointUrl(input.endpoint);
      const systemPrompt = input.systemPrompt === undefined ? current.systemPrompt : input.systemPrompt;
      if (typeof systemPrompt !== 'string' || systemPrompt.length > 100000) fail(400, 'Enter a system prompt of up to 100,000 characters.');
      const shareTimezone = input.shareTimezone ?? current.shareTimezone;
      if (typeof shareTimezone !== 'boolean') fail(400, 'Invalid privacy setting.');
      const showInferenceStats = input.showInferenceStats ?? current.showInferenceStats;
      if (typeof showInferenceStats !== 'boolean') fail(400, 'Invalid inference statistics setting.');
      const chatTextSize = input.chatTextSize ?? current.chatTextSize;
      if (!['small', 'medium', 'large'].includes(chatTextSize)) fail(400, 'Invalid chat text size.');
      const colorPalette = input.colorPalette ?? current.colorPalette;
      if (!colorPalettes.has(colorPalette)) fail(400, 'Invalid color palette.');
      const followUpBehavior = input.followUpBehavior ?? current.followUpBehavior;
      if (!['queue', 'interrupt'].includes(followUpBehavior)) fail(400, 'Invalid follow-up behavior.');
      if (!Array.isArray(input.mcp) || input.mcp.length > 12) fail(400, 'Add up to 12 MCP connections.');
      const ids = new Set();
      const mcp = input.mcp.map(entry => {
        const name = typeof entry?.name === 'string' ? entry.name.trim().slice(0, 80) : '';
        if (!name) fail(400, 'Give each MCP connection a name.');
        let url;
        try { url = httpUrl(entry.url).href; }
        catch { fail(400, 'Enter a valid HTTP or HTTPS MCP URL for ' + name + '.'); }
        const id = uuid.test(entry.id) ? entry.id : randomUUID();
        if (ids.has(id)) fail(400, 'Duplicate MCP connection.');
        ids.add(id);
        const previous = current.mcp.find(server => server.id === id);
        const token = typeof entry.token === 'string' ? entry.token.trim() : previous?.url === url ? previous.token : '';
        const enabledByDefault = (entry.enabledByDefault ?? previous?.enabledByDefault) === true;
        return { id, name, url, token, enabledByDefault };
      });
      const token = typeof input.token === 'string' ? input.token.trim() :
        endpoint === endpointUrl(current.endpoint) ? current.token : '';
      if (input.toolDefaults !== undefined && !validToolIds(input.toolDefaults)) fail(400, 'Invalid tool defaults.');
      const toolDefaults = selectedBuiltIns(input.toolDefaults, input.webSearchByDefault ?? undefined, current.toolDefaults);
      const next = { endpoint, token, systemPrompt, showInferenceStats, chatTextSize, colorPalette, followUpBehavior, shareTimezone, toolDefaults, mcp };
      await save(configPath, next);
      return send(res, 200, publicSettings(next));
    }
    if (pathname === '/api/models' && method === 'GET') {
      const signal = AbortSignal.timeout(5500);
      try {
        const response = await inference(await settings(), '/models', {}, signal);
        const result = await response.json();
        if (!Array.isArray(result.data)) fail(502, 'The inference server did not return an OpenAI-compatible model list.');
        const models = [...new Set(result.data.map(model => model?.id).filter(id => typeof id === 'string' && id.trim()))];
        return send(res, 200, models);
      } catch (error) {
        if (error.status) throw error;
        fail(502, signal.aborted ? 'The inference server took too long to respond.' : 'Could not read the model list.');
      }
    }
    if (pathname === '/api/mcp' && method === 'GET') {
      const config = await settings();
      const status = await Promise.all(config.mcp.map(async server => {
        try {
          const session = await connectMcp(server);
          const count = session.tools.length;
          await session.close();
          return { id: server.id, online: true, count };
        } catch {
          return { id: server.id, online: false };
        }
      }));
      return send(res, 200, status);
    }
    if (pathname === '/api/chats' && method === 'GET') {
      const files = await readdir(chats);
      const list = [];
      for (const file of files) {
        if (!file.endsWith('.json') || !uuid.test(file.slice(0, -5))) continue;
        const chat = await load(join(chats, file));
        if (chat) list.push(summary(chat));
      }
      return send(res, 200, list.sort((a, b) => b.updated.localeCompare(a.updated)));
    }
    if (pathname === '/api/chat' && method === 'POST') {
      if (/^multipart\/form-data(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        const upload = readMultipart(req);
        try { return await generate(res, await upload.input, upload.receive); }
        finally { await upload.close(); }
      }
      const input = await readJson(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid message.');
      return await generate(res, input);
    }
    const preview = /^\/api\/chats\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && preview && uuid.test(preview[1]) && uuid.test(preview[2])) {
      const [, chatId, attachmentId] = preview;
      const chat = await load(chatPath(chatId));
      const attachment = chat?.messages.flatMap(message => message.attachments || [])
        .find(attachment => attachment.id === attachmentId);
      const image = await attachmentPreview(chatId, attachment);
      if (!image) fail(404, 'Attachment unavailable.');
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': image.length });
      return res.end(image);
    }
    const viewRoute = /^\/api\/chats\/([^/]+)\/views\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && viewRoute && uuid.test(viewRoute[1]) && uuid.test(viewRoute[2])) {
      const [, chatId, viewId] = viewRoute;
      const run = active.get(chatId);
      let view = run?.views?.find(view => view.id === viewId);
      let attachments = run?.attachments;
      if (!view) {
        const chat = await load(chatPath(chatId));
        view = chat?.messages.flatMap(message => message.views || []).find(view => view.id === viewId);
        if (!view) fail(404, 'View unavailable.');
        attachments = chat.messages.flatMap(message => message.attachments || []);
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
      try {
        const source = await workspaceMedia(chatId, attachments, signal).input(view.path, { kind: view.kind });
        if (source.kind === 'image') {
          return sendView(req, res, 'image/webp', (await renderImage(source, signal)).data);
        }
        const { data, format } = await renderAudio(source, signal);
        return sendView(req, res, format === 'wav' ? 'audio/wav' : 'audio/mpeg', data);
      } catch (error) {
        if (error instanceof WorkspaceMediaError || error.code === 'ENOENT') fail(404, 'View unavailable.');
        throw error;
      }
    }
    const match = /^\/api\/chats\/([^/]+)(?:\/(stop|tools))?$/.exec(pathname);
    if (match && uuid.test(match[1])) {
      const [, id, action] = match;
      if (action === 'stop' && method === 'POST') {
        const run = active.get(id);
        const replyId = searchParams.get('reply');
        if (run && (replyId === null || replyId === run.replyId)) run.controller.abort();
        return send(res, 200, {});
      }
      if (!action && method === 'GET') {
        const chat = await load(chatPath(id));
        if (!chat) fail(404, 'Conversation not found.');
        chat.tools = chatTools(chat.tools || {}, await settings());
        await Promise.all(chat.messages.map(async message => {
          if (message.attachments) message.attachments = await presentAttachments(id, message.attachments);
          if (message.views) message.views = message.views.map(view => ({ ...view, url: viewURL(id, view.id) }));
        }));
        return send(res, 200, chat);
      }
      if ((!action && method === 'DELETE') || (action === 'tools' && method === 'PUT')) {
        const selection = action ? validateTools(await readJson(req)) : null;
        if (active.has(id)) fail(409, 'Wait for the reply to finish or stop it first.');
        if (editing.has(id)) fail(409, 'This conversation is being updated.');
        editing.add(id);
        try {
          if (!selection) {
            await deleteWorkspace(id);
            await rm(chatPath(id), { force: true });
            return send(res, 200, {});
          }
          const chat = await load(chatPath(id));
          if (!chat) fail(404, 'Conversation not found.');
          chat.tools = chatTools(selection, await settings(), chat.tools);
          await save(chatPath(id), chat);
          return send(res, 200, chat.tools);
        } finally {
          editing.delete(id);
        }
      }
    }
    fail(404, 'Not found.');
  } catch (error) {
    if (res.destroyed) return;
    if (!error.status) console.error(error);
    if (res.headersSent) return res.end();
    send(res, error.status || 500, { error: error.status ? error.message : 'The app could not complete the request.' });
  }
}).listen(port, host, () => console.log('Serenity · http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port));
