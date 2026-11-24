import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { uploadError } from './multipart.js';

const run = promisify(execFile);
const sharedExtension = /\.(ogg|webm)$/i;
const audioExtension = /\.(aac|aif[fc]?|flac|m4[ab]|mka|mp3|oga|opus|wav|wave|weba|wma)$/i;
export const audioInputOptions = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', 'aac,aiff,asf,flac,matroska,webm,mov,mp3,ogg,wav'
];
export const sampleRate = 48_000;
// Leave room for MP3 frame padding and the encoder delay within the 28-second cap.
export const samplesPerChunk = 1_339_200;

export function isAudioUpload(name, mimeType) {
  return audioExtension.test(name) || sharedExtension.test(name) || mimeType?.startsWith('audio/');
}

export async function inspectAudio(source, name, uploadSignal) {
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
    signal.throwIfAborted();
    const decoder = spawn('ffmpeg', [
      '-v', 'error', '-nostdin', '-xerror', ...audioInputOptions, '-i', source,
      '-map', '0:a:0', '-ac', String(channels), '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'
    ], { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let decoderError;
    decoder.on('error', error => { decoderError = error; });
    const closed = new Promise(resolve => decoder.once('close', resolve));
    let bytes = 0;
    try {
      for await (const data of decoder.stdout) bytes += data.length;
      const code = await closed;
      if (decoderError) throw decoderError;
      if (code !== 0 || !bytes || bytes % (channels * 2)) throw new Error('Incomplete audio stream.');
      signal.throwIfAborted();
      return { samples: bytes / (channels * 2), channels };
    } finally {
      if (decoder.exitCode === null && decoder.signalCode === null) decoder.kill();
      await closed;
    }
  } catch (error) {
    uploadSignal.throwIfAborted();
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw uploadError(503, 'Install FFmpeg and ffprobe to upload audio.');
    throw uploadError(422, 'Could not process audio “' + name + '”.');
  }
}
