import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceLimit } from '../multipart.js';
import { checkDirectory, entryStat, root, storedSize, workspacePath } from '../workspace.js';

const digest = /^[a-f0-9]{64}$/;

export function toolMediaParts({ label, type, format }, data) {
  const encoded = data.toString('base64');
  const part = type === 'image_url'
    ? { type, image_url: { url: 'data:' + format + ';base64,' + encoded } }
    : { type, input_audio: { format, data: encoded } };
  return [{ type: 'text', text: label }, part];
}

export function toolMediaHistory(chatId, signal) {
  const workspace = workspacePath(chatId);
  const directory = join(workspace, 'tool-media');
  return {
    async save({ type, format, data }, label) {
      const hash = createHash('sha256').update(data).digest('hex');
      const path = join(directory, hash);
      if (!await checkDirectory(directory)) await mkdir(directory, { mode: 0o700 });
      if (!await entryStat(path)) {
        if (await storedSize(workspace) + data.length > workspaceLimit) {
          throw Object.assign(new Error('The conversation workspace is full. Tool media could not be saved.'), { status: 413 });
        }
        const staging = await mkdtemp(join(root, '.media-'));
        try {
          const staged = join(staging, hash);
          await writeFile(staged, data, { mode: 0o600, signal });
          signal.throwIfAborted();
          await rename(staged, path);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
      return { label, type, format, hash };
    },
    async restore(reference) {
      if (digest.test(reference.hash)) {
        try {
          return toolMediaParts(reference, await readFile(join(directory, reference.hash), { signal }));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return [{ type: 'text', text: reference.label + ' (saved media unavailable).' }];
    },
    async prune(messages) {
      if (!await checkDirectory(directory)) return;
      const referenced = new Set();
      for (const message of messages) {
        for (const round of message.toolRounds ?? []) {
          for (const media of round.media) referenced.add(media.hash);
        }
      }
      for (const name of await readdir(directory)) {
        if (digest.test(name) && !referenced.has(name)) await rm(join(directory, name), { force: true });
      }
    }
  };
}
