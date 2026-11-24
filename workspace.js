import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { inspectAudio, isAudioUpload, samplesPerChunk } from './audio.js';
import { quotaError, uploadError, workspaceLimit } from './multipart.js';
import { pdfPages, WorkspaceMediaError } from './tools/media-source.js';
import { renderImage } from './tools/workspace-image.js';

export { WorkspaceMediaError } from './tools/media-source.js';

const root = resolve(process.env.SERENITY_WORKSPACE_DIR ||
  join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'serenity-workspaces'));
const instructions = '# Conversation workspace\n\n' +
  '- /files contains attachments for this conversation.\n' +
  '- /scripts is reserved for future use.\n';
const rasterExtension = /\.(avif|gif|jpe?g|png|tiff?|webp)$/i;
const directoryKind = kind => kind === 'pdf' || kind === 'audio';
const mediaKind = kind => kind === 'pdf' ? 'image' : kind;
const attachmentReference = ({ entry, kind }) => '/files/' + entry + (directoryKind(kind) ? '/' : '');
const chunkName = (kind, index) => kind === 'audio' ? String(index).padStart(6, '0') + '.mp3' : index + '.webp';
const workspacePath = id => join(root, id);
const fullError = () => uploadError(413, quotaError);

async function entryStat(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function checkDirectory(path) {
  const info = await entryStat(path);
  if (info && !info.isDirectory()) throw new Error('Invalid workspace directory.');
  return Boolean(info);
}

async function ensureRoot() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
    throw new Error('The workspace root must be private.');
  }
}

async function storedSize(path) {
  let size = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) size += await storedSize(child);
    else if (entry.isFile()) size += (await lstat(child)).size;
    else throw new Error('Unexpected entry in the conversation workspace.');
  }
  return size;
}

function safeName(name) {
  const safe = name.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*()\[\]`#%&]/g, '-')
    .trim().replace(/\s/g, '_').replace(/^\.+|\.+$/g, '');
  const bounded = Array.from(safe).slice(0, 56).join('').replace(/[. ]+$/g, '') || 'attachment';
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(bounded) ? '_' + bounded : bounded;
}

function uniqueName(name, kind, used) {
  const originalExtension = kind === 'pdf' && /\.pdf$/i.test(name) ? name.slice(-4) : extname(name);
  const sourceExtension = kind === 'file' && !/^\.[^.]{1,12}$/u.test(originalExtension) ? '' : originalExtension;
  const extension = kind === 'image' ? '.webp' : directoryKind(kind) || !sourceExtension ? '' : '.' + safeName(sourceExtension.slice(1));
  const base = safeName(name.slice(0, name.length - sourceExtension.length));
  let candidate = base + extension;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) {
    candidate = base + '-' + suffix + extension;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function fileKind(path, name, mimeType) {
  const handle = await open(path);
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(1024));
    const header = buffer.subarray(0, bytesRead);
    const text = header.toString('latin1');
    if (/\.pdf$/i.test(name) || /^(?:\s|\xef\xbb\xbf)*%PDF-\d\.\d/.test(text)) return 'pdf';
    if (/^(?:\x89PNG\r\n\x1a\n|\xff\xd8\xff|GIF8[79]a|RIFF....WEBP|II\x2a\x00|MM\x00\x2a|....ftypavi[fs])/s.test(text)) {
      return 'image';
    }
    if (rasterExtension.test(name)) throw uploadError(422, 'Could not process image “' + name + '”.');
    return isAudioUpload(name, mimeType) ? 'audio' : 'file';
  } finally {
    await handle.close();
  }
}

export async function withWorkspace(id, previousEntries, receive, signal, commit) {
  await ensureRoot();
  const workspace = workspacePath(id);
  const files = join(workspace, 'files');
  const existing = await checkDirectory(workspace);
  const hasFiles = existing && await checkDirectory(files);
  const used = new Set([...previousEntries, ...(hasFiles ? await readdir(files) : [])].map(name => name.toLowerCase()));
  const agents = join(workspace, 'AGENTS.md');
  const hasAgents = existing && Boolean(await entryStat(agents));
  const attachments = [];
  const published = [];
  let staged;
  let created = false;
  let size = (existing ? await storedSize(workspace) : 0) + (hasAgents ? 0 : Buffer.byteLength(instructions));
  const charge = bytes => {
    size += bytes;
    if (size > workspaceLimit) throw fullError();
  };
  try {
    await receive(async (stream, filename, mimeType) => {
      signal.throwIfAborted();
      staged ??= await mkdtemp(join(root, '.upload-'));
      const source = join(staged, 'source');
      const result = join(staged, randomUUID());
      await pipeline(stream, createWriteStream(source, { mode: 0o600, flags: 'wx' }), { signal });
      if (stream.truncated) throw fullError();
      charge((await lstat(source)).size);
      const name = Array.from(filename.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).slice(0, 240).join('') || 'Attachment';
      let kind = await fileKind(source, name, mimeType);
      let media;
      if (kind === 'pdf') {
        media = { chunks: await pdfPages(source, name, signal) };
      } else if (kind === 'audio') {
        const audio = await inspectAudio(source, name, signal);
        if (audio) media = { ...audio, chunks: Math.ceil(audio.samples / samplesPerChunk) };
        else kind = 'file';
      } else if (kind === 'image') {
        try {
          const image = sharp(source, { limitInputPixels: 100_000_000, failOn: 'warning' });
          await image.autoOrient().resize(1, 1).raw().toBuffer();
        }
        catch (error) {
          signal.throwIfAborted();
          throw uploadError(422, 'Could not process image “' + name + '”.');
        }
      }
      await rename(source, result);
      attachments.push({ id: randomUUID(), name, kind, entry: uniqueName(name, kind, used), media, result });
    });
    signal.throwIfAborted();
    if (!existing) {
      await mkdir(workspace, { mode: 0o700 });
      created = true;
    }
    await mkdir(files, { recursive: true, mode: 0o700 });
    await mkdir(join(workspace, 'scripts'), { recursive: true, mode: 0o700 });
    if (!hasAgents) {
      await writeFile(agents, instructions, { flag: 'wx', mode: 0o600 });
      published.push(agents);
    }
    for (const { result, entry } of attachments) {
      const path = join(files, entry);
      await rename(result, path);
      published.push(path);
    }
    signal.throwIfAborted();
    return await commit(attachments.map(({ result, ...attachment }) => attachment));
  } catch (error) {
    if (created) await rm(workspace, { recursive: true, force: true });
    else for (const path of published) await rm(path, { recursive: true, force: true });
    throw error;
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true });
  }
}

export async function deleteWorkspace(id) {
  if (await checkDirectory(root)) await rm(workspacePath(id), { recursive: true, force: true, maxRetries: 3 });
}

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
  const source = { path, reference: prefix + chunkName(kind, index), chunked: true };
  if (index < chunks) source.nextPath = prefix + chunkName(kind, index + 1);
  if (kind === 'pdf') return { ...source, kind: 'image', page: index };
  return { ...source, kind: 'audio', channels, start: (index - 1) * samplesPerChunk, end: Math.min(index * samplesPerChunk, samples) };
}

const recipeId = value => createHash('sha256').update(value).digest('hex').slice(0, 36);

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
    if (!['image', 'audio', 'file', 'pdf'].includes(attachment.kind)) continue;
    const path = join(workspace, 'files', attachment.entry);
    const isDirectory = directoryKind(attachment.kind);
    const url = pathToFileURL(isDirectory ? join(path, '/') : path).href;
    sources.set(url, attachment);
    sources.set(attachmentReference(attachment), attachment);
    names.set(attachment.name, names.has(attachment.name) ? null : attachment);
  }
  async function attachmentInput(reference, expectedKind, chunk) {
    const separator = reference.lastIndexOf('/') + 1;
    const parentReference = reference.slice(0, separator);
    const parent = sources.get(parentReference) ?? names.get(attachmentName(parentReference));
    const name = attachmentName(reference);
    const byName = expectedKind !== 'audio' && !name.includes('/') ? names.get(name) : null;
    const direct = sources.get(reference) ?? sources.get(reference + '/') ?? byName;
    const attachment = direct ?? parent;
    if (!attachment || !await checkDirectory(join(workspace, 'files'))) return;
    const path = await attachmentPath(chatId, attachment);
    if (!path) return;
    if (directoryKind(attachment.kind)) {
      const kind = mediaKind(attachment.kind);
      if (expectedKind && (expectedKind !== kind || (expectedKind === 'audio' && direct))) return;
      return chunkSource(path, attachment, direct ? undefined : reference.slice(separator), chunk);
    }
    if (direct && (!expectedKind || direct.kind === expectedKind)) {
      return { path, kind: direct.kind, reference: attachmentReference(direct) };
    }
  }
  return {
    async input(reference, { kind: expectedKind, chunk } = {}) {
      signal.throwIfAborted();
      if (chunk !== undefined && (!Number.isSafeInteger(chunk) || chunk < 1)) {
        throw new WorkspaceMediaError('Use a positive integer for chunk.');
      }
      if (typeof reference === 'string' && await checkDirectory(workspace)) {
        reference = reference.trim();
        if (reference.startsWith('<') && reference.endsWith('>') && !names.has(attachmentName(reference))) {
          reference = reference.slice(1, -1);
        }
        const source = await attachmentInput(reference, expectedKind, chunk);
        if (source) return source;
        const copy = /^\/media\/(view-[1-9]\d*|[a-f0-9]{36})\.(webp|wav)$/.exec(reference);
        if (copy) {
          const [, name, format] = copy;
          const kind = format === 'webp' ? 'image' : 'audio';
          const path = join(directory, name + '.json');
          if ((!expectedKind || kind === expectedKind) && await checkDirectory(directory) &&
              (await entryStat(path))?.isFile()) {
            const recipe = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
            const baseline = await attachmentInput(recipe.source, kind);
            if (baseline && (name.startsWith('view-') || recipeId(baseline.reference) === name)) {
              return { ...baseline, reference, baseReference: baseline.reference, operations: recipe.operations,
                nextPath: undefined, chunked: false };
            }
          }
        }
      }
      const paths = [];
      for (const attachment of attachments.toReversed()) {
        const kind = mediaKind(attachment.kind);
        if (expectedKind && expectedKind !== kind) continue;
        if (!await attachmentPath(chatId, attachment)) continue;
        const prefix = attachmentReference(attachment);
        paths.push(expectedKind === 'audio' ? prefix + chunkName(attachment.kind, 1) : prefix);
        if (paths.length === 3) break;
      }
      const suggestion = paths.length ? ' Available attachment paths: ' + paths.map(path => JSON.stringify(path)).join(', ') + '.' : '';
      throw new WorkspaceMediaError('That ' + (expectedKind || 'file') + ' is unavailable. Use an attachment link from this conversation or a workspace copy path returned by a tool.' + suggestion);
    },
    async saveView(source, operations) {
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
        const extension = source.kind === 'image' ? '.webp' : '.wav';
        for (;; next++) {
          signal.throwIfAborted();
          const name = 'view-' + next;
          try {
            await link(staged, join(directory, name + '.json'));
            return '/media/' + name + extension;
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

async function attachmentPath(chatId, attachment) {
  if (/[\\/]/.test(attachment.entry) || !attachment.entry || /^\.+$/.test(attachment.entry)) return null;
  const path = join(workspacePath(chatId), 'files', attachment.entry);
  if (directoryKind(attachment.kind) && !attachment.media?.chunks) return null;
  return (await entryStat(path))?.isFile() ? path : null;
}

export async function workspaceMediaKinds(chatId, attachments) {
  const kinds = new Set();
  for (const attachment of attachments) {
    const kind = mediaKind(attachment.kind);
    if ((kind === 'image' || kind === 'audio') && !kinds.has(kind) && await attachmentPath(chatId, attachment)) {
      kinds.add(kind);
      if (kinds.size === 2) break;
    }
  }
  return kinds;
}

export async function attachmentPresentation(chatId, attachment) {
  const { id, name, kind } = attachment;
  const available = Boolean(await attachmentPath(chatId, attachment));
  return {
    id, name, kind, available,
    ...(available && kind === 'image' && { url: '/api/chats/' + chatId + '/attachments/' + id })
  };
}

export async function attachmentPreview(chatId, attachment) {
  if (attachment?.kind !== 'image') return null;
  const path = await attachmentPath(chatId, attachment);
  if (!path) return null;
  try { return (await renderImage({ path }, AbortSignal.timeout(30_000))).data; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function attachmentMarkdown(chatId, attachments) {
  if (!attachments?.length) return '';
  const links = [];
  for (const attachment of attachments) {
    const path = await attachmentPath(chatId, attachment);
    const label = attachment.name.replace(/[\\\[\]]/g, '\\$&');
    const reference = attachmentReference(attachment);
    if (!path) {
      links.push('- ' + label + ' (workspace file unavailable)');
      continue;
    }
    const count = attachment.media?.chunks ?? 1;
    const firstAudioChunk = attachment.kind === 'audio' ? chunkName('audio', 1) : '';
    links.push('- [' + label + '](' + reference + firstAudioChunk + ') (chunks: ' + count + ')');
  }
  return 'Files added in this message:\n' + links.join('\n');
}
