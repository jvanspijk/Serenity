import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { fetchPublicUrl } from '../tools/fetch-url.js';
import { webLookup } from '../tools/web-lookup.js';

test('Fetch URL validates every address and redirect before opening a socket', async t => {
  const connections = [];
  t.mock.method(dns, 'lookup', async (host, options) => {
    assert.equal(options.all, true);
    const publicAddress = { address: '93.184.216.34', family: 4 };
    if (host === 'mixed.example') return [publicAddress, { address: '10.0.0.1', family: 4 }];
    if (host === 'private.example') return [{ address: 'fd00::1', family: 6 }];
    return [publicAddress];
  });
  t.mock.method(https, 'get', (options, onResponse) => {
    connections.push(options.hostname + options.path);
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    options.lookup('ignored.example', { all: true }, (error, addresses) => {
      assert.ifError(error);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
    });
    let statusCode = 200;
    let headers = { 'content-type': 'application/json' };
    let data = '{ "forecast": "rain" }';
    if (options.path === '/weather') headers = { 'content-type': 'text/plain; charset=utf-8' };
    if (options.path.startsWith('/redirect-')) {
      statusCode = 302;
      headers = { location: {
        '/redirect-public': '/weather',
        '/redirect-loopback': 'http://127.0.0.1/',
        '/redirect-private-name': '//private.example/'
      }[options.path] };
      data = '';
    }
    if (options.path === '/large') {
      headers = { 'content-type': 'text/plain' };
      data = 'x'.repeat(270000);
    }
    const response = Object.assign(Readable.from([Buffer.from(data)]), { statusCode, headers });
    queueMicrotask(() => onResponse(response));
    return new EventEmitter();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const run = url => fetchPublicUrl(url, new AbortController().signal);
  for (const url of [
    'https://localhost./', 'https://127.0.0.1/', 'https://2130706433/',
    'https://169.254.169.254/', 'https://[::ffff:127.0.0.1]/', 'https://[fe80::1]/',
    'https://mixed.example/', 'https://private.example/', 'https://user:pass@example.com/',
    'https://example.com:8443/', 'file:///example.txt'
  ]) {
    assert.equal((await run(url)).isError, true, url);
  }
  assert.deepEqual(connections, []);

  for (const path of ['/redirect-loopback', '/redirect-private-name']) {
    assert.match((await run('https://public.example' + path)).error, /private or reserved/);
  }
  assert.deepEqual(connections, ['public.example/redirect-loopback', 'public.example/redirect-private-name']);

  const result = await run('https://public.example/redirect-public');
  assert.equal(result.url, 'https://public.example/weather');
  assert.equal(result.contentType, 'application/json');
  assert.deepEqual(JSON.parse(result.content), { forecast: 'rain' });
  const large = await run('https://public.example/large');
  assert.equal(large.truncated, true);
  assert.equal(large.content.length, 32000);

  const hit = { title: 'Forecast', url: 'https://public.example/redirect-public', snippet: 'Rain' };
  t.mock.method(childProcess, 'execFile', (_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify([hit])));
    return { stdin: new PassThrough() };
  });
  syncBuiltinESMExports();
  const signal = new AbortController().signal;
  const search = await webLookup.run({ search_query: [{ q: 'forecast' }] }, signal);
  assert.deepEqual(search.search_query, [{ q: 'forecast', results: [hit] }]);
  const directUrl = 'https://public.example/weather';
  const lookup = await webLookup.run({ open: [{ ref_id: search.search_query[0].results[0].url }, { ref_id: directUrl }] }, signal);
  assert.deepEqual(lookup.open, [result, result]);
});
