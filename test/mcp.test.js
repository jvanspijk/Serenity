import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectMcp } from '../mcp.js';

test('MCP tool calls keep useful data and remove protocol metadata and duplicate text', async t => {
  let result;
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    const reply = payload => Response.json({ jsonrpc: '2.0', id, result: payload });
    if (method === 'initialize') return reply({ protocolVersion: '2026-07-28', capabilities: { tools: {} } });
    if (method === 'tools/list') return reply({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] });
    assert.equal(method, 'tools/call');
    assert.deepEqual(params, { name: 'lookup', arguments: { query: 'forecast' } });
    return reply(result);
  });
  const session = await connectMcp({ url: 'https://mcp.example' });
  t.after(() => session.close());
  const call = () => session.callTool('lookup', { query: 'forecast' });

  const structuredContent = { count: 2, forecast: ['rain'], _meta: { source: 'weather station' } };
  const duplicate = {
    type: 'text',
    text: '{ "forecast": ["rain"], "_meta": { "source": "weather station" }, "count": 2 }',
    _meta: { internal: true }, annotations: { audience: ['assistant'] }
  };
  result = { _meta: { traceId: 'private' }, resultType: 'complete', isError: false, structuredContent, content: [duplicate] };
  assert.deepEqual(await call(), { structuredContent });

  const note = { type: 'text', text: 'Forecast was updated an hour ago.' };
  const resource = { type: 'resource', resource: { uri: 'weather://forecast', text: 'Hourly forecast' } };
  const link = { type: 'resource_link', uri: 'weather://archive', name: 'Archive' };
  const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' };
  result.content.push(note, { ...resource, resource: { ...resource.resource, _meta: { internal: true } } },
    { ...link, icons: [{ src: 'https://mcp.example/icon.png' }] }, image);
  assert.deepEqual(await call(), { structuredContent, content: [note, resource, link, image] });

  const error = { type: 'text', text: 'The forecast is unavailable.' };
  result = { isError: true, content: [error], structuredContent: null, _meta: { traceId: 'private' } };
  assert.deepEqual(await call(), { isError: true, content: [error], structuredContent: null });

  for (const value of [null, false, 0, 'rain', ['rain']]) {
    result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    assert.deepEqual(await call(), { structuredContent: value });
  }

  result = { content: [{ type: 'text', text: 'rain' }], structuredContent: 'rain' };
  assert.deepEqual(await call(), { structuredContent: 'rain' });
  result = { content: [note] };
  assert.deepEqual(await call(), { content: [note] });
});

test('MCP tool schemas reach the model only after selection and reset on the next reply', async t => {
  const inventory = Array.from({ length: 8 }, (_, index) => ({
    name: 'item_' + index, description: 'Read an inventory item.', inputSchema: { type: 'object' }
  }));
  const weatherSchema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const weather = { name: 'lookup', description: 'Read a weather forecast.', inputSchema: weatherSchema };
  const weatherName = 'mcp_8_lookup';
  const requests = [];
  const mcpRequests = [];
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const rounds = [
    [call('search', 'mcp_discover', { query: 'forecast' })],
    [call('browse', 'mcp_discover', {})],
    [call('page', 'mcp_discover', { offset: 8 })],
    [call('load', 'mcp_discover', { load: [weatherName] }), call('early', weatherName, { city: 'Oslo' })],
    [call('forecast', weatherName, { city: 'Oslo' })]
  ];
  const backend = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/v1/chat/completions') {
      const calls = rounds[requests.length];
      requests.push(body);
      const delta = calls ? { tool_calls: calls } : { content: 'OK' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
    }
    const { id, method, params } = body;
    mcpRequests.push({ url: req.url, method, params });
    if (method === 'notifications/initialized') return res.writeHead(202).end();
    let result;
    if (method === 'initialize') result = { capabilities: { tools: {} } };
    if (method === 'tools/list') {
      if (req.url === '/inventory') result = params.cursor ? { tools: inventory.slice(4) } : { tools: inventory.slice(0, 4), nextCursor: 'next' };
      else result = { tools: [weather] };
    }
    if (method === 'tools/call') result = { structuredContent: { forecast: 'rain' }, _meta: { trace: 'internal' } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }).listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const url = 'http://127.0.0.1:' + backend.address().port;
  const data = await mkdtemp(join(tmpdir(), 'serenity-mcp-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const mcp = ['inventory', 'weather', 'disabled'].map((name, i) => ({
    name, id: '00000000-0000-0000-0000-00000000000' + i, url: url + '/' + name, enabledByDefault: i < 2
  }));
  await writeFile(join(data, 'settings.json'), JSON.stringify({ endpoint: url + '/v1', mcp }));
  const reserve = createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const app = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, SERENITY_WORKSPACE_DIR: join(data, 'workspaces') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([once(app.stdout, 'data'), once(app, 'exit').then(() => assert.fail('The server exited.'))]);
    const send = async input => {
      const response = await fetch('http://127.0.0.1:' + port + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', localDateTime: '2026-11-24 12:00', ...input })
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body.split('\n')[0].slice(6)).chat.id;
    };
    const id = await send({ content: 'What is the forecast in Oslo?' });
    await send({ id, content: 'Thanks' });

    const names = request => request.tools.map(tool => tool.function.name);
    for (const index of [0, 1, 2, 3, 6]) assert.deepEqual(names(requests[index]), ['read_file', 'mcp_discover']);
    for (const index of [4, 5]) assert.deepEqual(names(requests[index]), ['read_file', 'mcp_discover', weatherName]);
    assert.deepEqual(requests[4].tools.at(-1).function.parameters, weatherSchema);
    for (const [index, { messages, tools }] of requests.entries()) {
      const system = messages.filter(message => message.role === 'system');
      assert.equal(system.length, 1);
      assert.equal(system[0].content.split('# Tool descriptions').length, 2);
      assert.equal(system[0].content.split(weather.description).length, [4, 5].includes(index) ? 2 : 1);
      assert.ok(tools.every(tool => tool.function.description === undefined));
      assert.ok(messages.filter(message => message.role === 'user')
        .every(message => !message.content.includes('# Tool descriptions')));
    }
    const output = id => JSON.parse(requests[5].messages.find(message => message.tool_call_id === id).content);
    const weatherMatch = { name: weatherName, server: 'weather', description: weather.description };
    assert.deepEqual(output('search'), { matches: [weatherMatch] });
    assert.equal(output('browse').matches.length, 8);
    assert.equal(output('browse').next_offset, 8);
    assert.deepEqual(output('page'), { matches: [weatherMatch] });
    assert.deepEqual(output('load'), { loaded: [weatherName] });
    assert.equal(output('early').isError, true);
    assert.deepEqual(output('forecast'), { structuredContent: { forecast: 'rain' } });
    assert.ok(mcpRequests.some(request => request.url === '/inventory' && request.params.cursor === 'next'));
    assert.ok(mcpRequests.every(request => request.url !== '/disabled'));
    assert.deepEqual(mcpRequests.filter(request => request.method === 'tools/call'), [
      { url: '/weather', method: 'tools/call', params: { name: 'lookup', arguments: { city: 'Oslo' } } }
    ]);
  } finally {
    if (app.exitCode === null) {
      app.kill();
      await once(app, 'exit');
    }
  }
});
