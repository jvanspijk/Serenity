import { createReadStream } from 'node:fs';
import { WorkspaceMediaError } from './media-source.js';
import { workspaceRenderers } from '../workspace-media.js';

const maxLineLength = 2000;
const maxTextBytes = 16_000;
const maxLines = 200;

function decodeText(decoder, bytes) {
  let text;
  try { text = decoder.decode(bytes, { stream: bytes !== undefined }); }
  catch { throw new WorkspaceMediaError('This file does not contain supported text. Use UTF-8 or UTF-16 with a byte order mark.'); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new WorkspaceMediaError('This file contains binary data.');
  return text;
}

async function* textLines(path, signal) {
  let decoder;
  let pending = '';
  let clipped = false;
  for await (const bytes of createReadStream(path, { signal })) {
    if (!decoder) {
      const bom = bytes.subarray(0, 2).toString('hex');
      decoder = new TextDecoder(bom === 'fffe' ? 'utf-16le' : bom === 'feff' ? 'utf-16be' : 'utf-8', { fatal: true });
    }
    const parts = decodeText(decoder, bytes).split('\n');
    for (const [index, part] of parts.entries()) {
      const room = maxLineLength + 2 - pending.length;
      pending += part.slice(0, room);
      clipped ||= part.length > room;
      if (index === parts.length - 1) break;
      const line = pending.replace(/\r$/, '');
      yield { text: line.slice(0, maxLineLength), clipped: clipped || line.length > maxLineLength };
      pending = '';
      clipped = false;
    }
  }
  if (decoder) decodeText(decoder);
  if (pending) {
    const line = pending.replace(/\r$/, '');
    yield { text: line.slice(0, maxLineLength), clipped: clipped || line.length > maxLineLength };
  }
}

async function readWorkspaceText(path, offset, limit, signal) {
  const lines = [];
  const clippedLines = [];
  let lineNumber = 0;
  let bytes = 0;
  let nextLine;
  for await (const line of textLines(path, signal)) {
    lineNumber++;
    if (lineNumber < offset) continue;
    const lineBytes = Buffer.byteLength(line.text) + (lines.length ? 1 : 0);
    if (lines.length >= limit || bytes + lineBytes > maxTextBytes) {
      nextLine = lineNumber;
      break;
    }
    lines.push(line.text);
    bytes += lineBytes;
    if (line.clipped) clippedLines.push(lineNumber);
  }
  if (lineNumber < offset && offset !== 1) throw new WorkspaceMediaError('The file ends before line ' + offset + '.');
  const notes = [];
  if (clippedLines.length) notes.push('Clipped ' + (clippedLines.length === 1 ? 'line ' : 'lines ') + clippedLines.join(', ') + '.');
  if (nextLine) notes.push('More lines available. Use offset=' + nextLine + ' to continue.');
  const content = lines.join('\n');
  return notes.length ? content + '\n\n[' + notes.join(' ') + ']' : content;
}

export const readFileTool = {
  name: 'read_file',
  label: 'Read file',
  description: 'Reads a workspace file. Returns a bounded line range for text. Use paths from earlier tool results to inspect their media again.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Exact attachment path, uploaded filename, or workspace edit path.' },
      chunk: { type: 'integer', minimum: 1, description: 'Chunk number starting at 1 for files stored in chunks.' },
      offset: { type: 'integer', minimum: 1, description: 'First text line to read, starting at 1.' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of text lines to read.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  async run({ path, chunk, offset, limit }, signal, workspace) {
    const source = await workspace.input(path, { chunk });
    const { warning } = source;
    if (source.kind === 'file') {
      const first = offset === undefined ? 1 : offset;
      const count = limit === undefined ? maxLines : limit;
      if (!Number.isSafeInteger(first) || first < 1 || !Number.isSafeInteger(count) || count < 1) {
        throw new WorkspaceMediaError('Use positive integers for offset and limit.');
      }
      const text = await readWorkspaceText(source.path, first, Math.min(count, maxLines), signal);
      return warning ? text + '\n\n[' + warning + ']' : text;
    }
    if (offset !== undefined || limit !== undefined) throw new WorkspaceMediaError('Use offset and limit with text files.');
    const { render, result } = workspaceRenderers.get(source.kind);
    const output = result(source.reference, await render(source, signal));
    if (source.nextPath) output.next_path = source.nextPath;
    if (warning) output.warning = warning;
    return output;
  }
};
