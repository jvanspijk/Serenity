import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { samplesPerChunk } from './audio.js';
import { workspaceLimit } from './multipart.js';
import { WorkspaceMediaError } from './tools/media-source.js';
import { audioResult, renderAudio } from './tools/workspace-audio.js';
import { imageResult, renderImage } from './tools/workspace-image.js';
import { checkDirectory, chunkedKind, entryStat, root, storedSize, workspacePath } from './workspace.js';

const mediaKind = kind => kind === 'pdf' ? 'image' : kind;
const chunkName = (kind, index) => kind === 'audio' ? String(index).padStart(6, '0') + '.mp3' : index + '.webp';
const attachmentReference = ({ entry, kind }, firstChunk = false) =>
  '/files/' + entry + (chunkedKind(kind) ? '/' + (firstChunk ? chunkName(kind, 1) : '') : '');
const chunkWarning = chunk => chunk === undefined ? undefined : 'This file is not split into chunks. The chunk selection was ignored.';

export const workspaceRenderers = new Map([
  ['image', { render: renderImage, result: imageResult, extension: 'webp', presentLabel: 'an image or PDF page',
    readDescription: 'Returns the image pixels and dimensions for an image file or PDF page. For a PDF, chunk selects the page and defaults to 1. Inspect the returned image directly.' }],
  ['audio', { render: renderAudio, result: audioResult, extension: 'wav', presentLabel: 'an audio clip with playback controls',
    readDescription: 'Returns one playable chunk of an audio file.' }]
]);
const viewKinds = new Map(Array.from(workspaceRenderers, ([kind, { extension }]) => [extension, kind]));

function chunkSource(path, attachment, filename, chunk) {
  const { chunks, samples, channels } = attachment.media;
  const requested = filename === undefined ? 1 : Number(filename.split('.')[0]);
  const kind = attachment.kind;
  if (filename !== undefined && (!Number.isSafeInteger(requested) || requested < 1 ||
      requested > chunks || filename !== chunkName(kind, requested))) return;
  const index = chunk ?? requested;
  if (index > chunks) {
    throw new WorkspaceMediaError('Chunk ' + index + ' is out of range. This attachment has ' + chunks +
      (chunks === 1 ? ' chunk.' : ' chunks.'));
  }
  const prefix = attachmentReference(attachment);
  const source = { path, reference: prefix + chunkName(kind, index) };
  if (index < chunks) source.nextPath = prefix + chunkName(kind, index + 1);
  if (kind === 'pdf') return { ...source, kind: 'image', page: index };
  return { ...source, kind: 'audio', channels, start: (index - 1) * samplesPerChunk, end: Math.min(index * samplesPerChunk, samples) };
}

function attachmentName(reference) {
  const name = reference.startsWith('/files/') ? reference.slice('/files/'.length) : reference;
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

export function workspaceMedia(chatId, attachments, signal) {
  const workspace = workspacePath(chatId);
  const directory = join(workspace, 'media');
  const sources = new Map();
  const names = new Map();
  for (const attachment of attachments) {
    if (attachment.kind !== 'file' && !workspaceRenderers.has(mediaKind(attachment.kind))) continue;
    sources.set(attachmentReference(attachment), attachment);
    names.set(attachment.name, names.has(attachment.name) ? null : attachment);
  }
  function findAttachment(reference, allowName) {
    const separator = reference.lastIndexOf('/') + 1;
    const parent = reference.slice(0, separator);
    const name = attachmentName(reference);
    const direct = sources.get(reference) ?? sources.get(reference + '/') ??
      (allowName && !name.includes('/') ? names.get(name) : null);
    const attachment = direct ?? sources.get(parent) ?? names.get(attachmentName(parent));
    return attachment && { attachment, filename: direct ? undefined : reference.slice(separator) };
  }
  async function attachmentInput(reference, resolveAttachment, { kind, chunk, requireChunkPath }) {
    const match = findAttachment(reference, !requireChunkPath);
    const path = match && await resolveAttachment(match.attachment);
    if (!path) return;
    const { attachment, filename } = match;
    const actualKind = mediaKind(attachment.kind);
    if (kind && kind !== actualKind) return;
    if (chunkedKind(attachment.kind)) {
      if (!requireChunkPath || filename !== undefined) return chunkSource(path, attachment, filename, chunk);
    } else if (filename === undefined) {
      return { path, kind: actualKind, reference: attachmentReference(attachment), warning: chunkWarning(chunk) };
    }
  }
  async function input(reference, options = {}) {
    const { kind: expectedKind, chunk, requireChunkPath } = options;
    signal.throwIfAborted();
    if (chunk !== undefined && (!Number.isSafeInteger(chunk) || chunk < 1)) {
      throw new WorkspaceMediaError('Use a positive integer for chunk.');
    }
    const resolveAttachment = attachmentResolver(chatId);
    if (typeof reference === 'string') {
      reference = reference.trim();
      if (reference.startsWith('<') && reference.endsWith('>') && !names.has(attachmentName(reference))) {
        reference = reference.slice(1, -1);
      }
      const source = await attachmentInput(reference, resolveAttachment, options);
      if (source) return source;
      const copy = /^\/media\/(view-[1-9]\d*)\.(\w+)$/.exec(reference);
      if (copy) {
        const [, name, format] = copy;
        const kind = viewKinds.get(format);
        const path = join(directory, name + '.json');
        if (kind && (!expectedKind || kind === expectedKind) && await checkDirectory(workspace) && await checkDirectory(directory) &&
            (await entryStat(path))?.isFile()) {
          const recipe = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
          const baseline = await attachmentInput(recipe.source, resolveAttachment, { kind, requireChunkPath: true });
          if (baseline) {
            return { ...baseline, reference, baseReference: baseline.reference, operations: recipe.operations,
              nextPath: undefined, warning: chunkWarning(chunk) };
          }
        }
      }
    }
    const paths = [];
    for (const attachment of attachments.toReversed()) {
      const kind = mediaKind(attachment.kind);
      if (expectedKind && expectedKind !== kind) continue;
      if (!await resolveAttachment(attachment)) continue;
      paths.push(attachmentReference(attachment, requireChunkPath));
      if (paths.length === 3) break;
    }
    const suggestion = paths.length ? ' Available attachment paths: ' + paths.map(path => JSON.stringify(path)).join(', ') + '.' : '';
    throw new WorkspaceMediaError('That ' + (expectedKind || 'file') + ' is unavailable. Use an attachment link from this conversation or a workspace copy path returned by a tool.' + suggestion);
  }
  return {
    input,
    async edit(reference, options, operation) {
      const source = await input(reference, options);
      const renderer = workspaceRenderers.get(source.kind);
      const previous = source.operations ?? [];
      if (previous.length >= 16) throw new WorkspaceMediaError('This view has 16 edits. Start again from the original attachment path.');
      const operations = [...previous, operation];
      const output = await renderer.render({ ...source, operations }, signal);
      signal.throwIfAborted();
      const baseline = source.baseReference ?? source.reference;
      const recipe = JSON.stringify({ source: baseline, operations });
      if (await storedSize(workspace) + Buffer.byteLength(recipe) > workspaceLimit) {
        throw new WorkspaceMediaError('The conversation workspace is full.');
      }
      const staging = await mkdtemp(join(root, '.media-'));
      try {
        const staged = join(staging, 'view.json');
        await writeFile(staged, recipe, { mode: 0o600, signal });
        signal.throwIfAborted();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await checkDirectory(directory);
        let next = 1;
        for (const file of await readdir(directory)) {
          const numbered = /^view-([1-9]\d*)\.json$/.exec(file);
          if (numbered) next = Math.max(next, Number(numbered[1]) + 1);
        }
        for (;; next++) {
          signal.throwIfAborted();
          const name = 'view-' + next;
          try {
            await link(staged, join(directory, name + '.json'));
            const result = renderer.result('/media/' + name + '.' + renderer.extension, output);
            if (source.warning) result.warning = source.warning;
            return result;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
  };
}

export function attachmentResolver(chatId) {
  const workspace = workspacePath(chatId);
  const files = join(workspace, 'files');
  const checks = new Map();
  let filesReady;
  return async ({ entry, kind, media }) => {
    if (!entry || /[\\/]|^\.+$/.test(entry) || (chunkedKind(kind) && !media?.chunks)) return null;
    const path = join(files, entry);
    filesReady ??= checkDirectory(workspace).then(exists => exists && checkDirectory(files));
    if (!await filesReady) return null;
    if (!checks.has(path)) checks.set(path, entryStat(path));
    return (await checks.get(path))?.isFile() ? path : null;
  };
}

export async function availableMedia(attachments, resolveAttachment) {
  const kinds = new Set();
  for (const attachment of attachments) {
    const kind = mediaKind(attachment.kind);
    if (workspaceRenderers.has(kind) && !kinds.has(kind) && await resolveAttachment(attachment)) {
      kinds.add(kind);
      if (kinds.size === workspaceRenderers.size) return workspaceRenderers;
    }
  }
  return new Map([...workspaceRenderers].filter(([kind]) => kinds.has(kind)));
}

export function presentAttachments(chatId, attachments, resolveAttachment) {
  return Promise.all(attachments.map(async attachment => {
    const { id, name, kind } = attachment;
    const available = Boolean(await resolveAttachment(attachment));
    return { id, name, kind, available,
      ...(available && kind === 'image' && { url: '/api/chats/' + chatId + '/attachments/' + id }) };
  }));
}

export async function attachmentPreview(chatId, attachment) {
  if (attachment?.kind !== 'image') return null;
  const path = await attachmentResolver(chatId)(attachment);
  if (!path) return null;
  try { return await renderImage({ path }, AbortSignal.timeout(30_000)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function attachmentMarkdown(attachments, resolveAttachment) {
  if (!attachments?.length) return '';
  const links = [];
  for (const attachment of attachments) {
    const label = attachment.name.replace(/[\\\[\]]/g, '\\$&');
    const count = attachment.media?.chunks ?? 1;
    links.push('- ' + (await resolveAttachment(attachment)
      ? '[' + label + '](' + attachmentReference(attachment, attachment.kind === 'audio') + ') (chunks: ' + count + ')'
      : label + ' (workspace file unavailable)'));
  }
  return 'Files added in this message:\n' + links.join('\n');
}
