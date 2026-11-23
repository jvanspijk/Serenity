import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('local time reaches the model and timezone sharing is enforced', async () => {
  let prompt;
  const inference = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    prompt = JSON.parse(body).messages[0].content;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => inference.listen(0, '127.0.0.1', resolve));
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const data = await mkdtemp(join(tmpdir(), 'serenity-time-'));
  const app = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, SERENITY_WORKSPACE_DIR: join(data, 'workspaces'),
      INFERENCE_URL: `http://127.0.0.1:${inference.address().port}/v1` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await once(app.stdout, 'data');
    const base = `http://127.0.0.1:${port}/api/`;
    const settings = await (await fetch(base + 'settings')).json();
    const send = body => fetch(base + 'chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const message = { model: 'test', content: 'Hello', localDateTime: '2026-11-21 00:07', timezone: 'Europe/Amsterdam' };
    let response = await send(message);
    await response.text();
    assert.match(prompt, /Current local date and time: 2026-11-21 00:07\./);
    assert.doesNotMatch(prompt, /Europe\/Amsterdam/);
    response = await fetch(base + 'settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: settings.endpoint, systemPrompt: '', mcp: [], shareTimezone: true }) });
    assert.equal(response.status, 200);
    response = await send(message);
    await response.text();
    assert.match(prompt, /Current local date and time: 2026-11-21 00:07 \(Europe\/Amsterdam\)\./);
    response = await send({ model: 'test', content: 'Hello', localDate: '2026-11-21', timezone: 'Europe/Amsterdam' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Refresh Serenity/);
    response = await send({ ...message, timezone: undefined });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Refresh Serenity/);
  } finally {
    app.kill();
    await once(app, 'exit');
    await new Promise(resolve => inference.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
});
