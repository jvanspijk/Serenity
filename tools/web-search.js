import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const python = process.env.SERENITY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = fileURLToPath(new URL('./web-search.py', import.meta.url));

export async function searchWeb(query, signal) {
  if (typeof query !== 'string' || !query.trim() || query.length > 400) {
    return { isError: true, error: 'Provide a web search query of 1 to 400 characters.' };
  }
  try {
    const results = await new Promise((resolve, reject) => {
      const child = execFile(python, [script], {
        signal, timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true
      }, (error, stdout) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout)); }
        catch (error) { reject(error); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(query.trim()));
    });
    return { results };
  } catch {
    signal.throwIfAborted();
    return { isError: true, error: 'Web search could not run. Try opening a known public URL directly.' };
  }
}
