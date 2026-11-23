import { execFile, spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { uploadError } from './multipart.js';

const run = promisify(execFile);
const sharedExtension = /\.(ogg|webm)$/i;
const audioExtension = /\.(aac|aif[fc]?|flac|m4[ab]|mka|mp3|oga|opus|wav|wave|weba|wma)$/i;
export const audioInputOptions = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', 'aac,aiff,asf,flac,matroska,webm,mov,mp3,ogg,wav'
];
const sampleRate = 48_000;
// Leave room for MP3 frame padding and the encoder delay within the 28-second cap.
const samplesPerChunk = 1_339_200;

export function isAudioUpload(name, mimeType) {
  return audioExtension.test(name) || sharedExtension.test(name) || mimeType?.startsWith('audio/');
}

export async function convertAudio(source, output, scratch, name, charge, uploadSignal) {
  const signal = AbortSignal.any([uploadSignal, AbortSignal.timeout(300_000)]);
  const options = { signal, windowsHide: true, timeout: 60_000 };
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', ...audioInputOptions,
      '-show_entries', 'stream=codec_type,channels:stream_disposition=attached_pic', '-of', 'json', source
    ], options);
    const { streams } = JSON.parse(stdout);
    if (streams.some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)) {
      if (sharedExtension.test(name)) return false;
      throw new Error('Video track in audio upload.');
    }
    const track = streams.find(stream => stream.codec_type === 'audio');
    if (!track?.channels) throw new Error('No audio track.');
    const channels = Math.min(track.channels, 2);
    const block = Buffer.allocUnsafe(samplesPerChunk * channels * 2);
    await mkdir(output);
    signal.throwIfAborted();
    const decoder = spawn('ffmpeg', [
      '-v', 'error', '-nostdin', '-xerror', ...audioInputOptions, '-i', source,
      '-map', '0:a:0', '-ac', String(channels), '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'
    ], { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let decoderError;
    decoder.on('error', error => { decoderError = error; });
    const closed = new Promise(resolve => decoder.once('close', resolve));
    let index = 0;
    let used = 0;
    async function encodeChunk() {
      const chunk = join(output, String(++index).padStart(6, '0') + '.mp3');
      await writeFile(scratch, block.subarray(0, used), { signal, mode: 0o600 });
      await run('lame', [
        '--silent', '-V2', '-r', '-s', String(sampleRate / 1000),
        '-m', channels === 1 ? 'm' : 'j', scratch, chunk
      ], options);
      charge((await stat(chunk)).size);
      used = 0;
    }
    try {
      for await (const data of decoder.stdout) {
        let offset = 0;
        while (offset < data.length) {
          const copied = data.copy(block, used, offset, offset + block.length - used);
          offset += copied;
          used += copied;
          if (used === block.length) await encodeChunk();
        }
      }
      const code = await closed;
      if (decoderError) throw decoderError;
      if (code !== 0 || used % (channels * 2)) throw new Error('Incomplete audio stream.');
      if (used) await encodeChunk();
      if (!index) throw new Error('Empty audio stream.');
      signal.throwIfAborted();
      return true;
    } finally {
      if (decoder.exitCode === null && decoder.signalCode === null) decoder.kill();
      await closed;
    }
  } catch (error) {
    uploadSignal.throwIfAborted();
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw uploadError(503, 'Install FFmpeg and LAME to upload audio.');
    throw uploadError(422, 'Could not process audio “' + name + '”.');
  }
}
