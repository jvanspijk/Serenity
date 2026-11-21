export async function* sse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let lines = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (pending.startsWith('data:')) lines.push(pending.slice(5).trimStart());
        if (lines.length) yield lines.join('\n');
        return;
      }
      pending += value;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
        if (!line && lines.length) {
          yield lines.join('\n');
          lines = [];
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Enter an HTTP or HTTPS URL without embedded credentials or a fragment.');
  }
  return url;
}

export function bearer(token) {
  return token ? { Authorization: 'Bearer ' + token } : {};
}
