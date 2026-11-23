import { createReadStream } from 'node:fs';
import { WorkspaceMediaError } from '../workspace.js';
import { audioChunkParameter, readWorkspaceAudio } from './workspace-audio.js';
import { readWorkspaceImage } from './workspace-image.js';

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

async function readWorkspaceText(reference, path, start, end, signal) {
  const lines = [];
  const truncatedLines = [];
  let lineNumber = 0;
  let bytes = 0;
  let nextLine;
  for await (const line of textLines(path, signal)) {
    lineNumber++;
    if (lineNumber < start) continue;
    const lineBytes = Buffer.byteLength(line.text) + (lines.length ? 1 : 0);
    if (lines.length === maxLines || bytes + lineBytes > maxTextBytes) {
      nextLine = lineNumber;
      break;
    }
    lines.push(line.text);
    bytes += lineBytes;
    if (line.clipped) truncatedLines.push(lineNumber);
    if (lineNumber === end) break;
  }
  if (lineNumber < start && start !== 1) throw new WorkspaceMediaError('The file ends before line ' + start + '.');
  return {
    result: {
      path: reference, content: lines.join('\n'),
      ...(lines.length && { start_line: start, end_line: start + lines.length - 1 }),
      ...(nextLine && { next_line: nextLine }),
      ...(truncatedLines.length && { truncated_lines: truncatedLines })
    }
  };
}

export const readFileTool = {
  name: 'read_file',
  label: 'Read file',
  description: 'Reads a workspace file. Returns a bounded line range for text, the image itself for WebP, or one audio chunk for MP3 or WAV.',
  supportsMedia: true,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Attachment link or workspace copy path.' },
      start_line: { type: 'integer', minimum: 1, description: 'First text line to read, starting at 1. Use the returned next_line to continue.' },
      end_line: { type: 'integer', minimum: 1, description: 'Last text line to read, inclusive.' },
      chunk: audioChunkParameter
    },
    required: ['file_path'],
    additionalProperties: false
  },
  async run({ file_path: reference, start_line: start, end_line: end, chunk }, signal, workspace) {
    const source = await workspace.input(reference, { chunk });
    if (source.kind === 'file') {
      const first = start === undefined ? 1 : start;
      if (!Number.isSafeInteger(first) || first < 1 || (end !== undefined && (!Number.isSafeInteger(end) || end < first))) {
        throw new WorkspaceMediaError('Choose a valid one-based line range.');
      }
      return readWorkspaceText(reference, source.path, first, end, signal);
    }
    if (start !== undefined || end !== undefined) throw new WorkspaceMediaError('Line ranges are supported for text files.');
    return source.kind === 'image' ? readWorkspaceImage(reference, source, signal) : readWorkspaceAudio(reference, source, signal);
  }
};
