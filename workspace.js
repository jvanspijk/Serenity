import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { inspectAudio, isAudioUpload, samplesPerChunk } from './audio.js';
import { quotaError, uploadError, workspaceLimit } from './multipart.js';
import { pdfPages } from './tools/media-source.js';

export const root = resolve(process.env.SERENITY_WORKSPACE_DIR || join(process.env.DATA_DIR || 'data', 'workspaces'));
const instructions = '# Conversation workspace\n\n' +
  '- /files contains attachments for this conversation.\n' +
  '- /scripts is reserved for future use.\n';
const rasterExtension = /\.(avif|gif|jpe?g|png|tiff?|webp)$/i;
export const chunkedKind = kind => kind === 'pdf' || kind === 'audio';
export const workspacePath = id => join(root, id);
const fullError = () => uploadError(413, quotaError);

export async function entryStat(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function checkDirectory(path) {
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

export async function cleanWorkspaceStaging() {
  await ensureRoot();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.(upload|media)-[a-z0-9]{6}$/i.test(entry.name)) {
      await rm(join(root, entry.name), { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

export async function storedSize(path) {
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
  const extension = kind === 'image' ? '.webp' : chunkedKind(kind) || !sourceExtension ? '' : '.' + safeName(sourceExtension.slice(1));
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
  try {
    await receive(async (stream, filename, mimeType) => {
      signal.throwIfAborted();
      staged ??= await mkdtemp(join(root, '.upload-'));
      const source = join(staged, 'source');
      const result = join(staged, randomUUID());
      await pipeline(stream, createWriteStream(source, { mode: 0o600, flags: 'wx' }), { signal });
      if (stream.truncated) throw fullError();
      size += (await lstat(source)).size;
      if (size > workspaceLimit) throw fullError();
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
