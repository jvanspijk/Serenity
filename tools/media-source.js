import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uploadError } from '../multipart.js';

export class WorkspaceMediaError extends Error {}
export const ignoredChunkWarning = 'This file is not split into chunks. The chunk selection was ignored.';

export function appendOperation(source, operation) {
  const operations = source.operations ?? [];
  if (operations.length >= 16) throw new WorkspaceMediaError('This view has 16 edits. Start again from the original attachment path.');
  return [...operations, operation];
}

const run = promisify(execFile);
const pdfOptions = { timeout: 60_000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } };

export async function pdfPages(path, name, signal) {
  try {
    const { stdout } = await run('pdfinfo', [path], { ...pdfOptions, signal });
    const pages = Number(/^Pages:\s*(\d+)$/m.exec(stdout.replaceAll('\r', ''))?.[1]);
    if (!Number.isSafeInteger(pages) || pages < 1 || /^Encrypted:\s*yes/m.test(stdout)) throw new Error('Unreadable PDF.');
    return pages;
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'ENOENT') throw uploadError(503, 'Install Poppler to upload PDFs.');
    throw uploadError(422, 'Could not process PDF “' + name + '”.');
  }
}

export async function renderPdfPage(path, page, signal) {
  try {
    const number = String(page);
    const { stdout, stderr } = await run('pdftoppm', [
      '-f', number, '-l', number, '-scale-to', '1800', '-png', '-singlefile', path
    ], { ...pdfOptions, signal, encoding: 'buffer', maxBuffer: 12 * 1024 * 1024 });
    if (!stdout.length || /^Syntax Error:\s*(?!No display font for\b)\S/im.test(stderr.toString())) throw new Error('Unreadable page.');
    return stdout;
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'ENOENT') throw new WorkspaceMediaError('Install Poppler to read PDF pages.');
    throw new WorkspaceMediaError('Could not render PDF page ' + page + '.');
  }
}
