import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audioInputOptions, sampleRate } from '../audio.js';
import { toolMedia, WorkspaceMediaError } from './media-source.js';

const maxSeconds = 28;
const maxBase64Bytes = 8 * 1024 * 1024;
const run = promisify(execFile);

function operationFilters({ start, end, speed, focusSpeech, normalize }) {
  const filters = [];
  if (start || end !== undefined) {
    filters.push('atrim=start=' + start.toFixed(6) + (end === undefined ? '' : ':end=' + end.toFixed(6)), 'asetpts=PTS-STARTPTS');
  }
  if (focusSpeech) filters.push('highpass=f=120', 'lowpass=f=4000', 'afftdn');
  if (speed < 0.5) filters.push('atempo=0.5', 'atempo=' + speed * 2);
  else if (speed > 2) filters.push('atempo=2', 'atempo=' + speed / 2);
  else if (speed !== 1) filters.push('atempo=' + speed);
  if (normalize) filters.push('dynaudnorm');
  return filters;
}

function wave(samples, channels) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

export async function renderAudio(source, signal) {
  const { path, channels, start, end } = source;
  const operations = source.operations ?? [];
  const edited = operations.length > 0;
  const chunkSeconds = (end - start) / sampleRate;
  const filters = ['aresample=' + sampleRate, `atrim=start_sample=${start}:end_sample=${end}`, 'asetpts=PTS-STARTPTS',
    ...operations.flatMap(operationFilters)];
  let bytes;
  try {
    const { stdout } = await run('ffmpeg', [
      '-v', 'error', '-nostdin', '-xerror', ...audioInputOptions, '-i', path, '-map', '0:a:0', '-map_metadata', '-1',
      '-af', filters.join(','), '-t', String(edited ? maxSeconds + 0.1 : chunkSeconds),
      '-ac', String(channels), '-ar', String(sampleRate),
      ...(edited ? ['-c:a', 'pcm_s16le', '-f', 's16le'] : ['-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3']), 'pipe:1'
    ], { signal, timeout: 60_000, windowsHide: true, encoding: 'buffer', maxBuffer: 6 * 1024 * 1024 });
    bytes = stdout;
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'ENOENT') throw new WorkspaceMediaError('Install FFmpeg to use audio tools.');
    throw new WorkspaceMediaError('Could not process the selected audio.');
  }
  const seconds = edited ? bytes.length / (sampleRate * channels * 2) : chunkSeconds;
  if (seconds > maxSeconds) throw new WorkspaceMediaError('The view would exceed 28 seconds. Trim the input or use a faster speed.');
  if (!bytes.length || !(seconds > 0)) throw new WorkspaceMediaError('The selected time range contains no audio.');
  const data = edited ? wave(bytes, channels) : bytes;
  if (4 * Math.ceil(data.length / 3) > maxBase64Bytes) throw new WorkspaceMediaError('The audio is too large to send. Choose a shorter clip.');
  return { seconds, data, format: edited ? 'wav' : 'mp3', contentType: edited ? 'audio/wav' : 'audio/mpeg' };
}

export function audioResult(path, { seconds, data, format }) {
  return { path, seconds, [toolMedia]: { type: 'input_audio', format, data } };
}

export const audioTools = [
  {
    name: 'audio_transform', label: 'Transform audio',
    description: 'Trims audio, changes speed while preserving pitch, reduces noise, or normalizes loudness. Returns the edited clip and its view path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Original audio chunk or edit path. Use the original path to start over.' },
        start: { type: 'number', minimum: 0, maximum: maxSeconds, description: 'Start in seconds within the selected view. Defaults to 0.' },
        end: { type: 'number', minimum: 0, maximum: maxSeconds, description: 'End in seconds before any speed change. Defaults to the end of the view.' },
        speed: { type: 'number', minimum: 0.25, maximum: 4, description: 'Playback speed with pitch preserved. Use 0.5 to stretch to about twice the duration. Defaults to 1.' },
        focusSpeech: { type: 'boolean', description: 'Reduce steady background noise and emphasize speech frequencies.' },
        normalize: { type: 'boolean', description: 'Level out volume so quieter passages are easier to hear.' }
      },
      required: ['path'], additionalProperties: false
    },
    async run({ path, start = 0, end, speed = 1, focusSpeech = false, normalize = false }, _signal, workspace) {
      if (!Number.isFinite(start) || start < 0 || start >= maxSeconds ||
          (end !== undefined && (!Number.isFinite(end) || end <= start || end > maxSeconds)) ||
          !Number.isFinite(speed) || speed < 0.25 || speed > 4 ||
          typeof focusSpeech !== 'boolean' || typeof normalize !== 'boolean') {
        throw new WorkspaceMediaError('Choose a valid time range within the chunk and a speed from 0.25 to 4.');
      }
      return workspace.edit(path, { kind: 'audio', requireChunkPath: true }, { start, end, speed, focusSpeech, normalize });
    }
  }
];
