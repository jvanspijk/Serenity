import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { quotaError, workspaceLimit } from '../multipart.js';
import { renderImage } from '../tools/workspace-image.js';

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

test('image delivery caps dimensions and encoded bytes for a detailed crop', async () => {
  const width = 1800;
  const height = 1200;
  const source = await sharp(randomBytes(width * height * 4), { raw: { width, height, channels: 4 } }).png().toBuffer();
  const operations = [{ type: 'crop', x: 0, y: 0, width: 1330, height: 900, zoom: 4 }];
  const { data, info } = await renderImage({ path: source, operations }, new AbortController().signal);
  assert.ok(Math.max(info.width, info.height) <= 2048);
  assert.ok(info.width * info.height <= 2_300_000);
  assert.ok(data.toString('base64').length <= 4 * 1024 * 1024);
});

test('conversation workspace lifecycle, uploads and model links', async t => {
  const data = await mkdtemp(join(tmpdir(), 'serenity-workspace-test-'));
  const root = join(data, 'workspaces');
  const prompts = [];
  const toolRounds = [];
  let declarations;
  let latestTools;
  let interruptNext = false;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages, tools } = JSON.parse(Buffer.concat(chunks));
    prompts.push(messages);
    latestTools = tools;
    if (interruptNext) {
      interruptNext = false;
      res.writeHead(502).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const next = toolRounds.shift();
    if (next) declarations = tools;
    const delta = next ? { tool_calls: next(messages) } : { content: 'OK' };
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: next ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
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
  let serverLog = '';
  app.stderr.setEncoding('utf8').on('data', chunk => { serverLog += chunk; });
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
  const call = (name, args, id = name) => ({ id, function: { name, arguments: JSON.stringify(args) } });
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

  const mediaTools = { builtIn: ['workspaceImage', 'workspaceAudio'], mcp: [] };
  const toolNames = () => latestTools.map(tool => tool.function.name);
  const first = (await start(await send({ content: 'Only text', tools: mediaTools }))).chat.id;
  assert.deepEqual(toolNames(), ['read_file']);
  const textOnlyPrompt = prompts.at(-1)[0].content;
  assert.match(textOnlyPrompt, /Reads a workspace file/);
  assert.doesNotMatch(textOnlyPrompt, /image|audio/i);
  assert.equal(latestTools[0].function.description, undefined);
  const workspace = join(root, first);
  const files = join(workspace, 'files');
  const agents = await readFile(join(workspace, 'AGENTS.md'));
  assert.match(agents.toString(), /\/files[\s\S]+\/scripts/);
  assert.deepEqual(await readdir(join(workspace, 'scripts')), []);
  assert.deepEqual(await readdir(files), []);

  const marker = await sharp({ create: { width: 400, height: 310, channels: 3, background: 'red' } }).png().toBuffer();
  const photo = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: 'teal' } })
    .composite([{ input: marker, top: 1850, left: 0 }])
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const binary = Buffer.from([0, 255, 23, 10]);
  const attachments = [['Photo.jpg', photo], ['Data?.bin', binary], ['data?.BIN', binary],
    ['Note.txt', 'Attachment bytes must never reach inference\nSecond line'], ['archive.zip', binary], ['work (draft.bin', binary]];
  const upload = await start(await send({ id: first, content: 'Visible message' }, attachments));
  assert.deepEqual(toolNames(), ['image_crop', 'image_rotate', 'read_file']);
  const imagePrompt = prompts.at(-1)[0].content;
  assert.match(imagePrompt, /image_crop.*Crops and zooms/);
  assert.doesNotMatch(imagePrompt, /audio/i);
  assert.deepEqual(prompts.at(-1).filter(message => message.role === 'user').map(message => message.content)
    .filter(content => typeof content === 'string' && content.includes('# Tool descriptions')), []);
  assert.equal(upload.attachments.length, 6);
  assert.deepEqual(await readFile(join(files, 'Data-.bin')), binary);
  assert.deepEqual(await readFile(join(files, 'data--2.BIN')), binary);
  assert.deepEqual(await readFile(join(files, 'Photo.webp')), photo);
  const photoURL = base + upload.attachments[0].url;
  const preview = await fetch(photoURL);
  assert.equal(preview.headers.get('Content-Type'), 'image/webp');
  const image = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  assert.equal(image.format, 'webp');
  assert.ok(image.height > image.width && image.height <= 1600 && image.width * image.height <= 1_310_000);
  const userPrompt = prompts.at(-1).findLast(message => message.role === 'user').content;
  assert.match(userPrompt, /^Visible message\n\nFiles added in this message:\n- \[Photo\.jpg\]\(\/files\/Photo\.webp\) \(chunks: 1\)/);
  assert.ok(userPrompt.includes('[Note.txt](/files/Note.txt)'));
  assert.ok(userPrompt.includes('[work (draft.bin](/files/work_-draft.bin)'));
  assert.doesNotMatch(userPrompt, /Attachment bytes must never reach inference|data:image|file:\/\//);
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
    const originalPdf = join(files, 'Two-_pages-');
    const directoryPath = '/files/Two-_pages-/';
    const fileResult = (messages, id) => JSON.parse(messages.find(item => item.tool_call_id === id).content);
    toolRounds.push(
      messages => [call('read_file', { path: /\]\((\/files\/[^)]+)\)/.exec(messages.at(-1).content)[1] }, 'pdf_directory'),
        call('read_file', { path: 'Two: pages?.pdf' }, 'pdf_filename'),
        call('read_file', { path: '/files/Two: pages?.pdf' }, 'pdf_filename_with_prefix')],
      messages => [call('read_file', { path: fileResult(messages, 'pdf_filename').next_path }, 'second_page'),
        call('read_file', { path: 'Two: pages?.pdf', chunk: 2 }, 'selected_page'),
        call('read_file', { path: pathToFileURL(join(originalPdf, '1.webp')).href }, 'file_url_page'),
        call('read_file', { path: directoryPath + '3.webp' }, 'missing_page'),
        call('read_file', { path: directoryPath, chunk: 3 }, 'out_of_range'),
        call('read_file', { path: directoryPath, chunk: 0 }, 'invalid_chunk'),
        call('read_file', { path: directoryPath + '../Note.txt' }, 'parent_file')]
    );
    await start(await send({ id: first }, [['Two: pages?.pdf', samplePDF()]]));
    assert.deepEqual(await readFile(originalPdf), Buffer.from(samplePDF()));
    const pdfPrompt = prompts.at(-3).at(-1).content;
    assert.equal(pdfPrompt, 'Files added in this message:\n- [Two: pages?.pdf](/files/Two-_pages-/) (chunks: 2)');
    const pageReply = prompts.at(-1);
    const firstPage = fileResult(pageReply, 'pdf_directory');
    assert.equal(firstPage.path, directoryPath + '1.webp');
    assert.equal(firstPage.next_path, directoryPath + '2.webp');
    for (const id of ['pdf_filename', 'pdf_filename_with_prefix', 'file_url_page']) {
      assert.deepEqual(fileResult(pageReply, id), firstPage);
    }
    const lastPage = fileResult(pageReply, 'second_page');
    assert.equal(lastPage.path, directoryPath + '2.webp');
    assert.equal(lastPage.next_path, undefined);
    assert.deepEqual(fileResult(pageReply, 'selected_page'), lastPage);
    assert.match(fileResult(pageReply, 'out_of_range').content[0].text, /out of range.*2 chunks/);
    assert.match(fileResult(pageReply, 'invalid_chunk').content[0].text, /positive integer/);
    const firstMedia = prompts.at(-2).at(-1).content;
    const laterMedia = pageReply.at(-1).content;
    for (const [parts, paths] of [[firstMedia, [firstPage.path, firstPage.path, firstPage.path]],
      [laterMedia, [lastPage.path, lastPage.path, firstPage.path]]]) {
      assert.deepEqual(parts.map(part => part.type === 'text' ? part.text : part.type),
        paths.flatMap(path => ['Image from ' + path, 'image_url']));
    }
    const firstImages = firstMedia.filter(part => part.type === 'image_url');
    const laterImages = laterMedia.filter(part => part.type === 'image_url');
    assert.equal(firstImages.length, 3);
    assert.equal(laterImages.length, 3);
    assert.deepEqual(laterImages[0], laterImages[1]);
    assert.ok([...firstImages, laterImages[2]].every(image => image.image_url.url === firstImages[0].image_url.url));
    for (const [index, channel] of [0, 2].entries()) {
      const dataUrl = [firstImages[0], laterImages[0]][index].image_url.url;
      const page = Buffer.from(dataUrl.split(',')[1], 'base64');
      const { data: pixels, info } = await sharp(page).raw().toBuffer({ resolveWithObject: true });
      assert.ok(pixels[channel] > 240);
      assert.ok(info.height <= 1800 && info.width * info.height <= 2_300_000);
    }
    for (const id of ['missing_page', 'parent_file']) {
      const error = pageReply.find(message => message.tool_call_id === id);
      assert.equal(JSON.parse(error.content).isError, true);
    }
    toolRounds.push(() => [
      call('read_file', { path: ' <' + directoryPath + '> ', chunk: 2 }, 'copied_link'),
      call('read_file', { path: '/files/Two: pages?.pdf/', chunk: 2 }, 'display_name_directory'),
      call('read_file', { path: '/files/Two: pages?.pdf/2.webp' }, 'display_name_page'),
      call('read_file', { path: '/files/unknown.pdf', chunk: 2 }, 'unknown_path')
    ]);
    await start(await send({ id: first, content: 'Look again at page 2' }));
    const followUp = prompts.at(-1);
    for (const id of ['copied_link', 'display_name_directory', 'display_name_page']) {
      assert.deepEqual(fileResult(followUp, id), lastPage);
    }
    assert.ok(fileResult(followUp, 'unknown_path').content[0].text.includes('Available attachment paths: "' + directoryPath + '"'));
    before = (await readdir(files)).sort();
  } else t.diagnostic('Poppler unavailable. PDF assertions skipped.');

  const audio = sampleWave(29.25, 2);
  const hasAudio = ['ffmpeg', 'ffprobe'].every(command =>
    !spawnSync(command, ['-version'], { windowsHide: true }).error);
  if (hasAudio) {
    const longAudio = await start(await send({ id: first }, [['Long recording.WAV', audio]]));
    assert.ok(toolNames().includes('audio_transform'));
    assert.match(prompts.at(-1)[0].content, /audio_transform.*Trims audio/);
    assert.equal(longAudio.attachments[0].kind, 'audio');
    assert.equal(longAudio.attachments[0].available, true);
    assert.equal(prompts.at(-1).at(-1).content, 'Files added in this message:\n' +
      '- [Long recording.WAV](/files/Long_recording/000001.mp3) (chunks: 2)');
    assert.deepEqual(await readFile(join(files, 'Long_recording')), audio);

    const short = sampleWave(0.25);
    const duplicate = await start(await send({ id: first }, [['Long recording.take', short, 'audio/wav']]));
    assert.equal(duplicate.attachments[0].kind, 'audio');
    assert.deepEqual(await readFile(join(files, 'Long_recording-2')), short);

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
    assert.deepEqual(await readFile(join(files, 'song')), m4a);
    assert.deepEqual(await readFile(join(files, 'voice')), voice);
    assert.deepEqual(await readFile(join(files, 'video.webm')), video);
    before = (await readdir(files)).sort();

    const previousPrompts = prompts.length;
    const corrupt = await send({ id: first }, [['staged.bin', binary], ['bad.wav', 'invalid audio']]);
    assert.equal(corrupt.status, 422, await corrupt.text());
    assert.deepEqual((await readdir(files)).sort(), before);
    assert.equal(prompts.length, previousPrompts);
  } else t.diagnostic('FFmpeg unavailable. Audio assertions skipped.');

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
      return staged && (await readdir(join(root, staged))).length === 2;
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

  const tools = (await (await api('settings')).json()).tools;
  for (const id of ['workspaceImage', 'workspaceAudio']) {
    assert.equal(tools.find(tool => tool.id === id)?.enabledByDefault, false);
  }
  const mediaSelection = await api('chats/' + first + '/tools', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ builtIn: ['workspaceImage', ...(hasAudio ? ['workspaceAudio'] : [])], mcp: [] })
  });
  assert.equal(mediaSelection.status, 200);
  const toolContent = (messages, name) => messages.findLast(message => message.tool_call_id === name).content;
  const result = (messages, name) => JSON.parse(toolContent(messages, name));
  const photoPath = /\]\((\/files\/[^)]+)\)/.exec(userPrompt)[1];
  const audioPrompt = prompts.find(messages => messages.at(-1).content?.includes('[Long recording.WAV]'));
  const audioPath = audioPrompt && /\]\((\/files\/[^)]+)\)/.exec(audioPrompt.at(-1).content)[1];
  const secondAudioPath = audioPath?.replace(/000001\.mp3$/, '000002.mp3');
  const pdfPage = '/files/Two-_pages-/2.webp';
  const mediaDirectory = join(workspace, 'media');
  await assert.rejects(readdir(mediaDirectory), { code: 'ENOENT' });
  toolRounds.push(
    () => [call('image_crop', { path: photoPath, x: 20, y: 10, width: 100, height: 80 }), ...(hasPoppler ? [
      call('image_crop', { path: 'Two: pages?.pdf', chunk: 2, x: 0, y: 0, width: 70, height: 90 }, 'crop_pdf')
    ] : []), ...(hasAudio ? [
      call('audio_transform', { path: secondAudioPath, start: 0.1, end: 1.1, speed: 0.5, focusSpeech: true, normalize: true })
    ] : [])],
    messages => [call('image_rotate', { path: result(messages, 'image_crop').path, degrees: 90 }), ...(hasPoppler ? [
      call('image_rotate', { path: result(messages, 'crop_pdf').path, degrees: 90 }, 'rotate_pdf')
    ] : []), ...(hasAudio ? [
      call('audio_transform', { path: result(messages, 'audio_transform').path, start: 0.1, end: 1.5 }, 'trim_audio_view')
    ] : [])],
    messages => [call('read_file', { path: result(messages, 'image_rotate').path }, 'read_image'), ...(hasPoppler ? [
      call('image_crop', { path: result(messages, 'rotate_pdf').path, x: 500, y: 0, width: 10, height: 10 }, 'invalid_pdf_crop'),
      call('read_file', { path: result(messages, 'rotate_pdf').path }, 'read_pdf_view')
    ] : []), ...(hasAudio ? [
      call('read_file', { path: result(messages, 'trim_audio_view').path }, 'read_audio')
    ] : [])]
  );
  await start(await send({ id: first, content: 'Inspect edited media' }));
  const inspected = prompts.at(-1);
  assert.equal(declarations.filter(tool => tool.function.name === 'read_file').length, 1);
  assert.ok(declarations.some(tool => tool.function.name === 'image_rotate'));
  assert.equal(declarations.some(tool => tool.function.name === 'audio_transform'), hasAudio);
  assert.ok(prompts.at(-4).every(message => !Array.isArray(message.content)));
  for (const messages of prompts.slice(-3)) {
    assert.ok(messages.at(-1).content.some(part => part.type === 'image_url'));
  }
  const multimodal = inspected.at(-1);
  assert.equal(multimodal.role, 'user');
  assert.equal(inspected.at(-2).role, 'tool');
  const rotated = result(inspected, 'read_image');
  assert.deepEqual([rotated.width, rotated.height], [160, 200]);
  assert.equal(result(inspected, 'image_crop').path, '/media/view-1.webp');
  assert.match(rotated.path, /^\/media\/view-\d+\.webp$/);
  assert.notEqual(rotated.path, result(inspected, 'image_crop').path);
  const imagePart = multimodal.content.find(part => part.type === 'image_url');
  assert.match(imagePart.image_url.url, /^data:image\/webp;base64,/);
  assert.deepEqual(imagePart, prompts.at(-2).at(-1).content.find(part => part.type === 'image_url'));
  const orientedCrop = await sharp(Buffer.from(imagePart.image_url.url.split(',')[1], 'base64')).raw().toBuffer();
  assert.ok(orientedCrop[0] > 240 && orientedCrop[1] < 15 && orientedCrop[2] < 15);
  assert.deepEqual(await readFile(join(files, 'Photo.webp')), photo);
  if (hasPoppler) {
    const pdf = result(inspected, 'read_pdf_view');
    const croppedPdf = result(inspected, 'crop_pdf');
    assert.notEqual(pdf.path, croppedPdf.path);
    assert.deepEqual(pdf, result(inspected, 'rotate_pdf'));
    assert.deepEqual([pdf.width, pdf.height], [180, 140]);
    assert.equal(result(inspected, 'invalid_pdf_crop').isError, true);
    toolRounds.push(() => [
      call('image_crop', { path: pdfPage, x: 0, y: 0, width: 500, height: 600, zoom: 4 }, 'reset_pdf'),
      call('image_rotate', { path: '/files/Two-_pages-/', chunk: 2, degrees: 90 }, 'rotate_original_pdf'),
      call('image_crop', { path: pdf.path, x: 10, y: 10, width: 40, height: 30 }, 'branch_pdf'),
      call('image_rotate', { path: '/files/Two-_pages-/', chunk: 3, degrees: 90 }, 'pdf_out_of_range'),
      call('read_file', { path: pdf.path }, 'read_prior_rotation'),
      call('read_file', { path: croppedPdf.path }, 'read_prior_crop')
    ]);
    await start(await send({ id: first, content: 'Start a new view from the original page' }));
    const reset = result(prompts.at(-1), 'reset_pdf');
    assert.notEqual(reset.path, pdf.path);
    assert.ok(reset.width * reset.height <= 2_300_000);
    const payload = prompts.at(-1).at(-1).content.find(part => part.type === 'image_url').image_url.url.split(',')[1];
    assert.ok(payload.length <= 4 * 1024 * 1024);
    const recipe = JSON.parse(await readFile(join(mediaDirectory, reset.path.split('/').at(-1).replace('.webp', '.json')), 'utf8'));
    assert.equal(recipe.source, pdfPage);
    assert.equal(recipe.operations.length, 1);
    const branched = prompts.at(-1);
    assert.deepEqual(result(branched, 'read_prior_rotation'), pdf);
    assert.deepEqual(result(branched, 'read_prior_crop'), croppedPdf);
    const priorImageIndex = multimodal.content.findIndex(part => part.text === 'Image from ' + pdf.path);
    const repeated = branched.at(-1).content;
    const repeatedImageIndex = repeated.findIndex(part => part.text === 'Image from ' + pdf.path);
    assert.ok(priorImageIndex >= 0 && repeatedImageIndex >= 0);
    assert.deepEqual(repeated[repeatedImageIndex + 1], multimodal.content[priorImageIndex + 1]);
    const alternate = result(branched, 'branch_pdf');
    assert.notEqual(alternate.path, pdf.path);
    assert.deepEqual([alternate.width, alternate.height], [80, 60]);
    const direct = result(branched, 'rotate_original_pdf');
    assert.equal(JSON.parse(await readFile(join(mediaDirectory, direct.path.split('/').at(-1).replace('.webp', '.json')), 'utf8')).source, pdfPage);
    assert.match(result(branched, 'pdf_out_of_range').content[0].text, /out of range/);
    assert.deepEqual(await readFile(join(files, 'Two-_pages-')), Buffer.from(samplePDF()));
  }
  if (hasAudio) {
    assert.ok(!Object.hasOwn(declarations.find(tool => tool.function.name === 'audio_transform').function.parameters.properties, 'chunk'));
    const edited = result(inspected, 'read_audio');
    assert.ok(Math.abs(edited.seconds - 1.4) < 0.1);
    assert.notEqual(edited.path, result(inspected, 'audio_transform').path);
    assert.match(edited.path, /^\/media\/view-\d+\.wav$/);
    const { input_audio: clip } = multimodal.content.find(part => part.type === 'input_audio');
    assert.equal(clip.format, 'wav');
    assert.ok(clip.data.length <= 8 * 1024 * 1024);
    assert.deepEqual(await readFile(join(files, 'Long_recording')), audio);

    const recipePath = join(mediaDirectory, edited.path.split('/').at(-1).replace('.wav', '.json'));
    const recipe = await readFile(recipePath);
    toolRounds.push(() => [call('audio_transform', { path: audioPath, speed: 0.5 }),
      call('audio_transform', { path: edited.path, start: 20 }, 'invalid_trim')]);
    await start(await send({ id: first, content: 'Try stretching the first chunk' }));
    assert.match(result(prompts.at(-1), 'audio_transform').content[0].text, /exceed 28 seconds/);
    assert.equal(result(prompts.at(-1), 'invalid_trim').isError, true);
    assert.deepEqual(await readFile(recipePath), recipe);
  }
  const recipes = await readdir(mediaDirectory);
  assert.equal(recipes.length, 2 + 5 * Number(hasPoppler) + 2 * Number(hasAudio));
  assert.ok(recipes.every(name => /^view-\d+\.json$/.test(name)));
  const disabled = await api('chats/' + first + '/tools', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ builtIn: [], mcp: [] })
  });
  assert.equal(disabled.status, 200);
  toolRounds.push(
    () => [
      call('read_file', { path: '/files/Note.txt', offset: 2, limit: 1 }, 'read_text'),
      call('read_file', { path: '/files/Note.txt', limit: 1 }, 'read_limited'),
      call('read_file', { path: 'Note.txt', chunk: 2, offset: 2 }, 'unchunked_text'),
      call('read_file', { path: '/files/Data-.bin' }, 'read_binary'),
      call('read_file', { path: '/files/Paged.txt' }, 'read_page'),
      call('read_file', { path: '/files/Wide.txt' }, 'read_byte_limit')
    ],
    messages => [
      call('read_file', { path: '/files/Paged.txt', offset: Number(/offset=(\d+)/.exec(toolContent(messages, 'read_page'))[1]) }, 'read_next_page'),
      call('read_file', { path: rotated.path, chunk: 2 }, 'read_image'),
      ...(hasAudio ? [
        call('read_file', { path: audioPath, chunk: 2 }, 'read_audio'),
        call('read_file', { path: audioPath.replace(/000001\.mp3$/, '') }, 'read_audio_folder')
      ] : [])
    ]
  );
  const paged = ['x'.repeat(2001), ...Array.from({ length: 204 }, (_, i) => 'Line ' + (i + 2))];
  const wide = Array(9).fill('x'.repeat(1999));
  await start(await send({ id: first, content: 'Read files with editing disabled' }, [
    ['Paged.txt', paged.join('\r\n')], ['Wide.txt', wide.join('\n')]
  ]));
  const checked = prompts.at(-1);
  assert.deepEqual(declarations.map(tool => tool.function.name), ['read_file']);
  assert.deepEqual(Object.keys(declarations[0].function.parameters.properties), ['path', 'chunk', 'offset', 'limit']);
  assert.deepEqual(declarations[0].function.parameters.required, ['path']);
  assert.equal(result(checked, 'read_image').width, 160);
  assert.match(result(checked, 'read_image').warning, /chunk selection was ignored/);
  assert.match(toolContent(checked, 'unchunked_text'), /^Second line\n\n\[.*chunk selection was ignored\.\]$/);
  assert.equal(toolContent(checked, 'read_text'), 'Second line');
  assert.equal(toolContent(checked, 'read_limited'), 'Attachment bytes must never reach inference\n\n[More lines available. Use offset=2 to continue.]');
  assert.equal(result(checked, 'read_binary').isError, true);
  const firstPage = toolContent(checked, 'read_page');
  assert.equal(firstPage, ['x'.repeat(2000), ...paged.slice(1, 200)].join('\n') +
    '\n\n[Clipped line 1. More lines available. Use offset=201 to continue.]');
  assert.equal(toolContent(checked, 'read_next_page'), paged.slice(200).join('\n'));
  assert.equal(toolContent(checked, 'read_byte_limit'), wide.slice(0, 8).join('\n') + '\n\n[More lines available. Use offset=9 to continue.]');
  if (hasAudio) {
    assert.equal(result(checked, 'read_audio').path, secondAudioPath);
    assert.equal(result(checked, 'read_audio').next_path, undefined);
    assert.equal(result(checked, 'read_audio_folder').path, audioPath);
    assert.equal(result(checked, 'read_audio_folder').next_path, secondAudioPath);
    const chunks = checked.at(-1).content.filter(part => part.type === 'input_audio').map(part => part.input_audio);
    for (const [index, chunk] of chunks.entries()) {
      assert.equal(chunk.format, 'mp3');
      const decoded = media('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], Buffer.from(chunk.data, 'base64'));
      assert.ok(decoded.length / (4 * 48_000) <= 28);
      let crossings = 0;
      let below = false;
      // Measure away from MP3 encoder priming and the chunk boundary.
      for (let frame = 4_800; frame < 52_800; frame++) {
        const sample = decoded.readInt16LE(frame * 4);
        if (sample < -1000) below = true;
        if (below && sample > 1000) {
          crossings++;
          below = false;
        }
      }
      assert.ok(Math.abs(crossings - [400, 800][index]) < 4, String(crossings));
    }
  }
  toolRounds.push(() => [call('read_file', { path: rotated.path }),
    call('read_file', { path: 'Photo.jpg' }, 'other_chat_filename'),
    call('read_file', { path: 'duplicate.txt' }, 'ambiguous_filename'),
    call('read_file', { path: '/files/duplicate.txt' }, 'exact_path')]);
  const isolated = await start(await send({ content: 'Check another workspace', tools: { builtIn: [], mcp: [] } },
    [['duplicate.txt', 'first'], ['duplicate.txt', 'second']]));
  for (const id of ['read_file', 'other_chat_filename', 'ambiguous_filename']) {
    assert.equal(result(prompts.at(-1), id).isError, true);
  }
  assert.equal(toolContent(prompts.at(-1), 'exact_path'), 'first');
  assert.equal((await api('chats/' + isolated.chat.id, { method: 'DELETE' })).status, 200);

  const beforeManyReads = prompts.length;
  for (let round = 0; round < 32; round++) {
    toolRounds.push(() => [call('read_file', { path: '/files/Note.txt' }, 'long_run_' + round)]);
  }
  const longRun = await start(await send({ id: first, content: 'Check the note with a long tool sequence' }));
  assert.equal(longRun.chat.id, first);
  assert.equal(prompts.length - beforeManyReads, 33);
  assert.equal(prompts.at(-1).filter(message => message.role === 'tool').length, 32);
  const completed = await (await api('chats/' + first)).json();
  assert.equal(completed.messages.at(-1).content, 'OK');
  assert.equal(completed.messages.at(-1).issue, undefined);

  const failedCalls = [
    call('read_file', { path: '/files/missing\nfile.pdf', chunk: 2 }, 'failed_file'),
    { id: 'malformed_call', function: { name: 'read_file', arguments: '{"path":' } },
    call('no_such_tool', { path: 'test' }, 'unavailable_tool'),
    call('web__run', { open: [{ ref_id: 'relative-path' }] }, 'failed_web')
  ];
  toolRounds.push(() => [...failedCalls, call('web__run', {}, 'invalid_web')]);
  const response = await send({ content: 'Handle tool errors internally', tools: { builtIn: ['webSearch'], mcp: [] } });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
  const errorChat = events[0].chat.id;
  assert.ok(!events.some(event => event.type === 'notice'));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).issue, undefined);
  assert.equal(events.find(event => event.type === 'content').text, 'OK');
  for (const item of failedCalls) assert.equal(result(prompts.at(-1), item.id).isError, true);
  await eventually(() => serverLog.includes('"toolCallId":"invalid_web"'));
  const errors = serverLog.split('\n').filter(line => line.startsWith('{"event":"tool_call_failed",')).map(line => JSON.parse(line))
    .filter(entry => entry.chatId === errorChat);
  assert.equal(errors.length, 5);
  assert.ok(errors.every(entry => entry.replyId === events[0].replyId && entry.error));
  for (const [index, item] of failedCalls.entries()) {
    assert.equal(errors[index].toolCallId, item.id);
    assert.equal(errors[index].tool, item.function.name);
    assert.equal(errors[index].arguments, item.function.arguments);
  }
  assert.equal((await api('chats/' + errorChat, { method: 'DELETE' })).status, 200);

  await rm(workspace, { force: true, recursive: true });
  assert.equal((await fetch(photoURL)).status, 404);
  assert.equal((await api('chats/' + first + '/tools', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mediaTools)
  })).status, 200);
  await start(await send({ id: first, content: 'Check expired attachments' }));
  assert.deepEqual(toolNames(), ['read_file']);
  assert.doesNotMatch(prompts.at(-1)[0].content, /image|audio/i);
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
