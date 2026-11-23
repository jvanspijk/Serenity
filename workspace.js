import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { quotaError, uploadError, workspaceLimit } from './multipart.js';

const root = resolve(process.env.SERENITY_WORKSPACE_DIR ||
  join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'serenity-workspaces'));
const instructions = '# Conversation workspace\n\n' +
  '- /files contains attachments for this conversation.\n' +
  '- /scripts is reserved for future use.\n';
const run = promisify(execFile);
const rasterExtension = /\.(avif|gif|jpe?g|png|tiff?|webp)$/i;
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
  const safe = name.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-')
    .trim().replace(/^\.+|[. ]+$/g, '');
  const bounded = Array.from(safe).slice(0, 56).join('').replace(/[. ]+$/g, '') || 'attachment';
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(bounded) ? '_' + bounded : bounded;
}

function uniqueName(name, kind, used) {
  const originalExtension = kind === 'pdf' && /\.pdf$/i.test(name) ? name.slice(-4) : extname(name);
  const sourceExtension = kind === 'file' && !/^\.[^.]{1,12}$/u.test(originalExtension) ? '' : originalExtension;
  const extension = kind === 'image' ? '.webp' : kind === 'pdf' || !sourceExtension ? '' : '.' + safeName(sourceExtension.slice(1));
  const base = safeName(name.slice(0, name.length - sourceExtension.length));
  let candidate = base + extension;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) {
    candidate = base + '-' + suffix + extension;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function fileKind(path, name) {
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
    return 'file';
  } finally {
    await handle.close();
  }
}

async function encodeImage(source, output, { edge, pixels, quality, signal }) {
  signal.throwIfAborted();
  const image = sharp(source, { limitInputPixels: 100_000_000 });
  const { autoOrient } = await image.metadata();
  const { width, height } = autoOrient;
  const scale = Math.min(1, edge / Math.max(width, height), Math.sqrt(pixels / (width * height)));
  const result = await image.autoOrient().resize({
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    fit: 'inside', withoutEnlargement: true
  }).webp({ quality, smartSubsample: true }).toFile(output);
  signal.throwIfAborted();
  return result.size;
}

async function convertPDF(source, output, scratch, name, charge, signal) {
  const options = { signal, timeout: 60_000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } };
  try {
    const { stdout } = await run('pdfinfo', [source], options);
    const pages = Number(/^Pages:\s*(\d+)$/m.exec(stdout.replaceAll('\r', ''))?.[1]);
    if (!Number.isSafeInteger(pages) || pages < 1 || /^Encrypted:\s*yes/m.test(stdout)) throw new Error('Unreadable PDF.');
    await mkdir(output);
    for (let page = 1; page <= pages; page++) {
      const index = String(page);
      const rendered = await run('pdftoppm', [
        '-f', index, '-l', index, '-scale-to', '1800', '-png', '-singlefile', source, scratch
      ], options);
      if (/^Syntax Error:\s*(?!No display font for\b)\S/im.test(rendered.stderr)) throw new Error('Unreadable PDF page.');
      charge(await encodeImage(scratch + '.png', join(output, index + '.webp'), {
        edge: 1800, pixels: 2_300_000, quality: 92, signal
      }));
      await rm(scratch + '.png');
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw uploadError(503, 'Install Poppler to upload PDFs.');
    throw uploadError(422, 'Could not process PDF “' + name + '”.');
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
    await receive(async (stream, filename) => {
      signal.throwIfAborted();
      staged ??= await mkdtemp(join(root, '.upload-'));
      const source = join(staged, 'source');
      const result = join(staged, randomUUID());
      await pipeline(stream, createWriteStream(source, { mode: 0o600, flags: 'wx' }), { signal });
      if (stream.truncated) throw fullError();
      const name = Array.from(filename.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).slice(0, 240).join('') || 'Attachment';
      const kind = await fileKind(source, name);
      if (kind === 'pdf') {
        await convertPDF(source, result, join(staged, 'page'), name, charge, signal);
      } else if (kind === 'image') {
        let bytes;
        try { bytes = await encodeImage(source, result, { edge: 1600, pixels: 1_310_000, quality: 88, signal }); }
        catch (error) {
          signal.throwIfAborted();
          throw uploadError(422, 'Could not process image “' + name + '”.');
        }
        charge(bytes);
      } else {
        charge((await lstat(source)).size);
        await rename(source, result);
      }
      await rm(source, { force: true });
      attachments.push({ id: randomUUID(), name, kind, entry: uniqueName(name, kind, used), result });
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
    return await commit(attachments.map(({ id, name, kind, entry }) => ({ id, name, kind, entry })));
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

async function attachmentPath(chatId, attachment) {
  if (/[\\/]/.test(attachment.entry) || !attachment.entry || /^\.+$/.test(attachment.entry)) return null;
  const path = join(workspacePath(chatId), 'files', attachment.entry);
  const info = await entryStat(path);
  return (attachment.kind === 'pdf' ? info?.isDirectory() : info?.isFile()) ? path : null;
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
  try { return await readFile(path); }
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
    if (path) {
      const url = pathToFileURL(attachment.kind === 'pdf' ? join(path, '/') : path).href;
      links.push('- [' + label + '](<' + url + '>)');
    } else links.push('- ' + label + ' (workspace file unavailable)');
  }
  return 'Files added in this message:\n' + links.join('\n');
}
