import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP } from 'node:net';

const publicIPv6 = new BlockList();
publicIPv6.addSubnet('2000::', 3, 'ipv6');
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['168.63.129.16', 32], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

const redirects = new Set([301, 302, 303, 307, 308]);
const maxBytes = 256 * 1024;
const maxText = 32000;
class FetchError extends Error {}

function publicTarget(input) {
  let url;
  try {
    if (typeof input !== 'string' || input.length > 4096) throw new Error();
    url = new URL(input);
  } catch {
    throw new FetchError('Enter a valid public HTTP or HTTPS URL of up to 4,096 characters.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new FetchError('Only public HTTP and HTTPS URLs on their standard ports are allowed.');
  }
  url.hash = '';
  return url;
}

function isPublic({ address, family }) {
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && publicIPv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

async function resolvePublic(host, signal) {
  const family = isIP(host);
  if (!family && (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host))) {
    throw new FetchError('This URL points to a private or reserved address.');
  }
  signal.throwIfAborted();
  let onAbort;
  try {
    const addresses = family ? [{ address: host, family }] : await Promise.race([
      lookup(host, { all: true, order: 'ipv4first' }),
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      })
    ]);
    if (!addresses.length || !addresses.every(isPublic)) {
      throw new FetchError('This URL points to a private or reserved address.');
    }
    return addresses;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function getPublic(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$|\.$/g, '');
  const addresses = await resolvePublic(hostname, signal);
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    // Connect only to validated DNS answers while retaining the real hostname for TLS.
    const req = get({
      hostname, path: url.pathname + url.search, agent: false, rejectUnauthorized: true, signal,
      headers: {
        Accept: 'application/json, text/html, text/plain, text/*;q=0.8',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Serenity/1.0'
      },
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }
    }, resolve);
    req.on('error', reject);
  });
}

function htmlText(html) {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|svg|template)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\/?(?:p|div|h[1-6]|li|br|article|section|tr|td)\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, entity) => ({
      nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"
    })[entity])
    .replace(/[ \t]+/g, ' ')
    .replace(/\n(?:[ \t]*\n){2,}/g, '\n\n');
}

async function readContent(response, url) {
  try {
    const { headers, statusCode } = response;
    if (statusCode < 200 || statusCode >= 300) throw new FetchError('The public server returned HTTP ' + statusCode + '.');
    let mime = (headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    const json = mime === 'application/json' || mime.endsWith('+json');
    if ((!json && !mime.startsWith('text/')) || (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) {
      throw new FetchError('This URL did not return supported text, HTML, or JSON.');
    }
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    for await (const chunk of response) {
      chunks.push(chunk.subarray(0, maxBytes - bytes));
      bytes += chunk.length;
      if (bytes > maxBytes) { truncated = true; break; }
    }
    let content = Buffer.concat(chunks).toString('utf8').trim();
    // Some public APIs, including wttr.in, return JSON without a JSON content type.
    if (!truncated && (json || (mime === 'text/plain' && /^[{\[]/.test(content)))) {
      try {
        content = JSON.stringify(JSON.parse(content));
        if (!json) mime = 'application/json';
      } catch {
        if (json) throw new FetchError('The public server did not return valid JSON.');
      }
    }
    if (mime === 'text/html') content = htmlText(content).trim();
    if (!content) throw new FetchError('The public server returned an empty response.');
    return { url: url.href, contentType: mime, content: content.slice(0, maxText), truncated: truncated || content.length > maxText };
  } finally {
    if (!response.complete) response.destroy();
  }
}

async function fetchUrl(input, signal) {
  let url = publicTarget(input);
  for (let hop = 0; hop <= 4; hop++) {
    const response = await getPublic(url, signal);
    if (!redirects.has(response.statusCode)) return readContent(response, url);
    const location = response.headers.location;
    response.destroy();
    if (!location || hop === 4) throw new FetchError('The page redirected too many times or did not supply a redirect URL.');
    try { url = publicTarget(new URL(location, url).href); }
    catch (error) {
      if (error instanceof FetchError) throw error;
      throw new FetchError('The page supplied an invalid redirect URL.');
    }
  }
}

export async function fetchPublicUrl(url, signal) {
  const deadline = AbortSignal.timeout(12000);
  try {
    return await fetchUrl(url, AbortSignal.any([signal, deadline]));
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof FetchError ? error.message :
      deadline.aborted ? 'The public server took too long to respond.' : 'Could not reach the public URL.';
    return { isError: true, error: message };
  }
}
