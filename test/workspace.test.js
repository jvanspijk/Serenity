import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { quotaError, workspaceLimit } from '../multipart.js';

function samplePDF() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'
  ];
  for (const [index, color] of ['1 0 0', '0 0 1'].entries()) {
    const contents = color + ' rg 0 0 400 600 re f\n' +
      '1 1 1 rg BT /F1 30 Tf 50 530 Td (Page ' + (index + 1) + ') Tj ET';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600]' +
      ' /Resources << /Font << /F1 7 0 R >> >> /Contents ' + (index * 2 + 4) + ' 0 R >>');
    objects.push('<< /Length ' + contents.length + ' >>\nstream\n' + contents + '\nendstream');
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let file = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    offsets.push(String(file.length).padStart(10, '0') + ' 00000 n \n');
    file += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  return file + 'xref\n0 ' + offsets.length + '\n' + offsets.join('') +
    'trailer\n<< /Root 1 0 R /Size ' + offsets.length + ' >>\nstartxref\n' + file.length + '\n%%EOF\n';
}

function sampleWave(seconds, channels = 1) {
  const rate = 48_000;
  const frames = rate * seconds;
  const samples = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame++) {
    const frequency = frame < rate * 27.9 ? 800 : 400;
    const value = Math.round(8000 * Math.sin(2 * Math.PI * frequency * frame / rate));
    for (let channel = 0; channel < channels; channel++) {
      samples.writeInt16LE(value, (frame * channels + channel) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

function media(command, args, input) {
  const result = spawnSync(command, args, { input, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('The upload state did not settle.');
}

test('conversation workspace lifecycle, uploads and model links', async t => {
  const data = await mkdtemp(join(tmpdir(), 'serenity-workspace-test-'));
  const root = join(data, 'workspaces');
  const prompts = [];
  let interruptNext = false;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    prompts.push(JSON.parse(Buffer.concat(chunks)).messages);
    if (interruptNext) {
      interruptNext = false;
      res.writeHead(502).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => model.close(resolve)));
  const reserve = createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const app = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, SERENITY_WORKSPACE_DIR: root,
      INFERENCE_URL: 'http://127.0.0.1:' + model.address().port + '/v1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (app.exitCode === null) {
      app.kill();
      await once(app, 'exit');
    }
    await rm(data, { recursive: true, force: true, maxRetries: 3 });
  });
  await Promise.race([once(app.stdout, 'data'), once(app, 'exit').then(() => assert.fail('The server exited.'))]);
  const base = 'http://127.0.0.1:' + port;
  const api = (path, options) => fetch(base + '/api/' + path, options);
  const defaults = { model: 'test', localDateTime: '2026-11-23 12:00' };
  function send(input, files = []) {
    const message = JSON.stringify({ ...defaults, ...input });
    if (!files.length) return api('chat', { method: 'POST', body: message, headers: { 'Content-Type': 'application/json' } });
    const body = new FormData();
    body.append('message', message);
    for (const [name, contents, type] of files) body.append('files', new Blob([contents], { type }), name);
    return api('chat', { method: 'POST', body });
  }
  async function start(response) {
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body.split('\n')[0].slice(6));
  }

  const first = (await start(await send({ content: 'Only text' }))).chat.id;
  const workspace = join(root, first);
  const files = join(workspace, 'files');
  const agents = await readFile(join(workspace, 'AGENTS.md'));
  assert.match(agents.toString(), /\/files[\s\S]+\/scripts/);
  assert.deepEqual(await readdir(join(workspace, 'scripts')), []);
  assert.deepEqual(await readdir(files), []);

  const photo = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: 'teal' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const binary = Buffer.from([0, 255, 23, 10]);
  const attachments = [['Photo.jpg', photo], ['Data?.bin', binary], ['data?.BIN', binary],
    ['Note.txt', 'Attachment bytes must never reach inference'], ['archive.zip', binary], ['last.bin', binary]];
  const upload = await start(await send({ id: first, content: 'Visible message' }, attachments));
  assert.equal(upload.attachments.length, 6);
  assert.deepEqual(await readFile(join(files, 'Data-.bin')), binary);
  assert.deepEqual(await readFile(join(files, 'data--2.BIN')), binary);
  const photoURL = base + upload.attachments[0].url;
  const preview = await fetch(photoURL);
  assert.equal(preview.headers.get('Content-Type'), 'image/webp');
  const image = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  assert.equal(image.format, 'webp');
  assert.ok(image.height > image.width && image.height <= 1600 && image.width * image.height <= 1_310_000);
  const userPrompt = prompts.at(-1).findLast(message => message.role === 'user').content;
  assert.match(userPrompt, /^Visible message\n\nFiles added in this message:\n- \[Photo.jpg\]\(<file:\/\/\/.+\/files\/Photo.webp>\)/);
  assert.doesNotMatch(userPrompt, /Attachment bytes must never reach inference|data:image/);
  const stored = JSON.parse(await readFile(join(data, 'chats', first + '.json'), 'utf8'));
  assert.equal(stored.messages.at(-2).content, 'Visible message');
  assert.doesNotMatch(JSON.stringify(stored), /Attachment bytes must never reach inference|file:\/\//);

  const second = (await start(await send({ content: 'Other chat' }, [['Photo.jpg', photo]]))).chat.id;
  assert.notEqual(second, first);
  assert.equal((await fetch(photoURL.replace(first, second))).status, 404);
  let before = (await readdir(files)).sort();
  const beforeCorrupt = prompts.length;
  const hasPoppler = !spawnSync('pdfinfo', ['-v'], { windowsHide: true }).error;
  if (hasPoppler) {
    const corrupt = await send({ id: first }, [['staged.bin', binary], ['bad.pdf', '%PDF-1.4\ninvalid']]);
    assert.equal(corrupt.status, 422, await corrupt.text());
    assert.deepEqual((await readdir(files)).sort(), before);
    assert.equal(prompts.length, beforeCorrupt);
    await start(await send({ id: first }, [['Two: pages?.pdf', samplePDF()]]));
    const folder = join(files, 'Two- pages-');
    assert.deepEqual((await readdir(folder)).sort(), ['1.webp', '2.webp']);
    for (const [index, channel] of [0, 2].entries()) {
      const page = await readFile(join(folder, index + 1 + '.webp'));
      const { data: pixels, info } = await sharp(page).raw().toBuffer({ resolveWithObject: true });
      assert.ok(pixels[channel] > 240);
      assert.ok(info.height <= 1800 && info.width * info.height <= 2_300_000);
    }
    assert.match(prompts.at(-1).at(-1).content, /Two-%20pages-\/>\)/);
    before = (await readdir(files)).sort();
  } else t.diagnostic('Poppler unavailable. PDF assertions skipped.');

  const audio = sampleWave(29.25, 2);
  const hasAudio = ['ffmpeg', 'ffprobe', 'lame'].every(command =>
    !spawnSync(command, ['-version'], { windowsHide: true }).error);
  if (hasAudio) {
    const longAudio = await start(await send({ id: first }, [['Long recording.WAV', audio]]));
    assert.equal(longAudio.attachments[0].kind, 'audio');
    assert.equal(longAudio.attachments[0].available, true);
    assert.match(prompts.at(-1).at(-1).content, /\[Long recording\.WAV\]\(<file:\/\/\/.+\/files\/Long%20recording\/>\)/);
    const directory = join(files, 'Long recording');
    const chunks = (await readdir(directory)).sort();
    assert.deepEqual(chunks, ['000001.mp3', '000002.mp3']);
    let samples = 0;
    for (const [index, chunk] of chunks.entries()) {
      const path = join(directory, chunk);
      const details = JSON.parse(media('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,channels', '-of', 'json', path
      ]));
      assert.equal(details.streams[0].codec_name, 'mp3');
      assert.equal(details.streams[0].channels, 2);
      assert.ok(Number(details.format.duration) > 0 && Number(details.format.duration) <= 28);
      const decoded = media('ffmpeg', ['-v', 'error', '-i', path, '-f', 's16le', 'pipe:1']);
      samples += decoded.length / 4;
      let crossings = 0;
      for (let frame = 1; frame < 48_000; frame++) {
        if (decoded.readInt16LE(frame * 4) > 0 && decoded.readInt16LE((frame - 1) * 4) <= 0) crossings++;
      }
      assert.ok(Math.abs(crossings - [800, 400][index]) < 4, String(crossings));
    }
    assert.equal(samples, 29.25 * 48_000);

    const short = sampleWave(0.25);
    const duplicate = await start(await send({ id: first }, [['Long recording.take', short, 'audio/wav']]));
    assert.equal(duplicate.attachments[0].kind, 'audio');
    const shortDirectory = join(files, 'Long recording-2');
    assert.deepEqual(await readdir(shortDirectory), ['000001.mp3']);
    const mono = media('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=channels', '-of', 'json', join(shortDirectory, '000001.mp3')
    ]);
    assert.equal(JSON.parse(mono).streams[0].channels, 1);

    const m4a = media('ffmpeg', [
      '-v', 'error', '-i', 'pipe:0', '-c:a', 'aac', '-movflags', '+frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'
    ], short);
    const voice = media('ffmpeg', [
      '-v', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'
    ], short);
    const video = media('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:duration=0.12', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'
    ]);
    const shared = await start(await send({ id: first }, [
      ['song.m4a', m4a], ['voice.webm', voice], ['video.webm', video]
    ]));
    assert.deepEqual(shared.attachments.map(item => item.kind), ['audio', 'audio', 'file']);
    assert.deepEqual(await readFile(join(files, 'video.webm')), video);
    before = (await readdir(files)).sort();

    const previousPrompts = prompts.length;
    const corrupt = await send({ id: first }, [['staged.bin', binary], ['bad.wav', 'invalid audio']]);
    assert.equal(corrupt.status, 422, await corrupt.text());
    assert.deepEqual((await readdir(files)).sort(), before);
    assert.equal(prompts.length, previousPrompts);
  } else t.diagnostic('FFmpeg or LAME unavailable. Audio assertions skipped.');

  const hasStaging = async () => (await readdir(root)).some(name => name.startsWith('.upload-'));
  async function beginPartialUpload(firstFile) {
    const partial = request(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=workspace-test' }
    });
    partial.on('error', () => {});
    partial.write('--workspace-test\r\nContent-Disposition: form-data; name="message"\r\n\r\n' +
      JSON.stringify({ ...defaults, id: first }) + '\r\n--workspace-test\r\n');
    if (firstFile) {
      partial.write('Content-Disposition: form-data; name="files"; filename="cancelled.wav"\r\n\r\n');
      partial.write(firstFile);
      partial.write('\r\n--workspace-test\r\n');
    }
    partial.write('Content-Disposition: form-data; name="files"; filename="incomplete.bin"\r\n\r\n' + 'x'.repeat(65536));
    await eventually(hasStaging);
    return partial;
  }
  const partial = await beginPartialUpload();
  assert.equal((await api('chats/' + first, { method: 'DELETE' })).status, 409);
  partial.destroy();
  await eventually(async () => !await hasStaging());
  assert.deepEqual((await readdir(files)).sort(), before);

  if (hasAudio) {
    const pendingAudio = await beginPartialUpload(audio);
    await eventually(async () => {
      const staged = (await readdir(root)).find(name => name.startsWith('.upload-'));
      return staged && (await readdir(join(root, staged))).includes('audio.pcm');
    });
    pendingAudio.destroy();
    await eventually(async () => !await hasStaging());
    assert.deepEqual((await readdir(files)).sort(), before);
  }

  const failedSave = await beginPartialUpload();
  const history = join(data, 'chats', first + '.json');
  const backup = history + '.backup';
  await rename(history, backup);
  await mkdir(history);
  const failure = once(failedSave, 'response');
  failedSave.end('\r\n--workspace-test--\r\n');
  const [failedResponse] = await failure;
  failedResponse.resume();
  assert.equal(failedResponse.statusCode, 500);
  await rm(history, { recursive: true });
  await rename(backup, history);
  assert.deepEqual((await readdir(files)).sort(), before);

  const capacityChat = (await start(await send({ content: 'Quota boundary' }))).chat.id;
  const capacityFiles = join(root, capacityChat, 'files');
  const filler = await open(join(capacityFiles, 'filler.bin'), 'w');
  await filler.truncate(workspaceLimit - agents.length - 5);
  await filler.close();
  await start(await send({ id: capacityChat }, [['exact.bin', '12345']]));
  const rejected = await send({ id: capacityChat }, [['one-over.bin', '1']]);
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error, quotaError);
  if (hasAudio) {
    const rejectedAudio = await send({ id: capacityChat }, [['over-quota.wav', audio]]);
    assert.equal(rejectedAudio.status, 413, await rejectedAudio.text());
    assert.equal(await hasStaging(), false);
  }
  assert.deepEqual((await readdir(capacityFiles)).sort(), ['exact.bin', 'filler.bin']);
  assert.equal((await api('chats/' + capacityChat, { method: 'DELETE' })).status, 200);

  const oversizedPath = join(data, 'oversized.bin');
  const oversized = await open(oversizedPath, 'w');
  await oversized.truncate(workspaceLimit + 1);
  await oversized.close();
  const tooLarge = await send({ id: first }, [['too-large.bin', await openAsBlob(oversizedPath)]]);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, quotaError);
  assert.deepEqual((await readdir(files)).sort(), before);

  await rm(workspace, { force: true, recursive: true });
  assert.equal((await fetch(photoURL)).status, 404);
  interruptNext = true;
  await start(await send({ id: first }, [['Photo.jpg', photo]]));
  const current = await (await api('chats/' + first)).json();
  assert.equal(current.messages[2].attachments[0].available, false);
  assert.equal(current.messages.at(-2).attachments[0].available, true);
  assert.deepEqual(await readdir(files), ['Photo-2.webp']);
  assert.match(prompts.at(-1)[3].content, /workspace file unavailable/);
  await start(await send({ id: first, retry: true }));
  assert.deepEqual(await readdir(files), ['Photo-2.webp']);
  assert.equal((await api('chats/' + first, { method: 'DELETE' })).status, 200);
  assert.equal((await api('chats/' + first)).status, 404);
  assert.deepEqual(await readdir(root), [second]);
});
