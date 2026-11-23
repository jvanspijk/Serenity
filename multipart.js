import Busboy from 'busboy';

export const workspaceLimit = 262_144_000;
export const quotaError = "Can't upload any more files in this conversation.";

export function uploadError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function readMultipart(req) {
  const invalid = () => uploadError(400, 'Invalid attachment upload.');
  let parser;
  try {
    parser = Busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      preservePath: true,
      limits: { fieldSize: 640 * 1024, fileSize: workspaceLimit + 1 }
    });
  } catch { throw invalid(); }

  const message = Promise.withResolvers();
  const consumer = Promise.withResolvers();
  const done = Promise.withResolvers();
  // The request can fail before generate() starts consuming files.
  done.promise.catch(() => {});
  let foundMessage = false;
  let work = Promise.resolve();
  const reject = error => {
    message.reject(error);
    done.reject(error);
  };
  parser.on('field', (name, value, { valueTruncated }) => {
    if (name !== 'message' || foundMessage || valueTruncated) return reject(invalid());
    try {
      const input = JSON.parse(value);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
      foundMessage = true;
      message.resolve(input);
    } catch { reject(invalid()); }
  });
  parser.on('file', (field, stream, { filename, mimeType }) => {
    stream.on('error', () => {});
    if (!foundMessage || field !== 'files' || !filename) {
      stream.resume();
      reject(invalid());
      return;
    }
    stream.once('limit', () => reject(uploadError(413, quotaError)));
    work = work.then(async () => {
      const store = await consumer.promise;
      if (store) await store(stream, filename, mimeType);
      else stream.resume();
    });
    work.catch(reject);
  });
  parser.on('error', () => reject(invalid()));
  parser.on('close', () => {
    if (!foundMessage) reject(invalid());
    else work.then(done.resolve, done.reject);
  });
  const disconnected = () => {
    if (!req.complete) reject(invalid());
  };
  req.on('close', disconnected);
  req.pipe(parser);
  async function close() {
    consumer.resolve(null);
    req.off('close', disconnected);
    req.unpipe(parser);
    parser.destroy();
    req.resume();
    await work.catch(() => {});
  }
  return {
    input: message.promise,
    async receive(store) {
      consumer.resolve(store);
      try { await done.promise; }
      catch (error) {
        await close();
        throw error;
      }
    },
    close
  };
}
