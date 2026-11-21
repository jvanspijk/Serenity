import { bearer, sse } from './protocol.js';

export async function connectMcp(config, signal) {
  let session;
  let version = '2025-11-25';
  let id = 0;
  let modern = false;

  async function rpc(method, params = {}, notification = false) {
    const requestId = ++id;
    const headers = {
      ...bearer(config.token),
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': version
    };
    if (session) headers['Mcp-Session-Id'] = session;
    if (modern) {
      headers['Mcp-Method'] = method;
      if (params.name) headers['Mcp-Name'] = params.name;
      params = { ...params, _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'serenity', version: '1.0.0' } } };
    }
    const deadline = AbortSignal.timeout(method === 'tools/call' ? 30000 : 4000);
    const response = await fetch(config.url, {
      method: 'POST', headers, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notification && { id: requestId }), method, params })
    });
    if (!response.ok || notification) {
      await response.body?.cancel();
      if (!response.ok) throw new Error('MCP returned HTTP ' + response.status);
      return;
    }
    session = response.headers.get('mcp-session-id') || session;
    let reply;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for await (const event of sse(response.body)) {
        const message = JSON.parse(event);
        if (message.id === requestId) { reply = message; break; }
      }
    } else {
      reply = await response.json();
    }
    if (reply?.id !== requestId || reply.error || !reply.result) throw new Error('MCP request failed: ' + method);
    return reply.result;
  }

  async function close() {
    if (!session) return;
    try {
      const response = await fetch(config.url, {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(1500),
        headers: { ...bearer(config.token), 'Mcp-Session-Id': session, 'MCP-Protocol-Version': version }
      });
      await response.body?.cancel();
    } catch {}
  }

  async function listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await rpc('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tool list');
      tools.push(...result.tools.filter(tool => typeof tool.name === 'string' && tool.inputSchema));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error('MCP tool list exceeds the supported page count');
  }

  try {
    let hello;
    try {
      hello = await rpc('initialize', {
        protocolVersion: version, capabilities: {}, clientInfo: { name: 'serenity', version: '1.0.0' }
      });
    } catch {
      signal?.throwIfAborted();
      session = undefined;
      modern = true;
      version = '2026-07-28';
    }
    if (hello) {
      version = hello.protocolVersion || version;
      await rpc('notifications/initialized', {}, true);
    }
    return { tools: hello && !hello.capabilities?.tools ? [] : await listTools(), rpc, close };
  } catch (error) {
    await close();
    throw error;
  }
}
