import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { audioInputOptions } from '../audio.js';
import { WorkspaceMediaError } from '../workspace.js';

const maxSeconds = 28;
const run = promisify(execFile);
export const audioChunkParameter = {
  type: 'integer', minimum: 1, description: 'Optional one-based chunk number for an uploaded audio recording. Defaults to 1.'
};

async function ffmpeg(command, args, signal) {
  try {
    return await run(command, args, { signal, timeout: 30_000, windowsHide: true });
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'ENOENT') throw new WorkspaceMediaError('Install FFmpeg and ffprobe to use audio tools.');
    throw new WorkspaceMediaError('Could not process the selected audio.');
  }
}

async function duration(path, signal) {
  const { stdout } = await ffmpeg('ffprobe', [
    '-v', 'error', ...audioInputOptions, '-show_entries', 'format=duration', '-of', 'csv=p=0', path
  ], signal);
  return Number(stdout.trim());
}

export const audioTools = [
  {
    name: 'audio_transform',
    label: 'Transform audio',
    description: 'Trims audio, changes speed while preserving pitch, reduces noise, or normalizes loudness. Returns the workspace path of a copy up to 28 seconds long. Pass it to read_file in a separate call to listen.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Audio recording link from this conversation or a copy path returned by audio_transform.' },
        chunk: audioChunkParameter,
        start: { type: 'number', minimum: 0, maximum: maxSeconds, description: 'Start in seconds within the chosen chunk. Defaults to 0.' },
        end: { type: 'number', minimum: 0, maximum: maxSeconds, description: 'End in seconds within the chosen chunk, before any speed change. Defaults to the end of the chunk.' },
        speed: { type: 'number', minimum: 0.25, maximum: 4, description: 'Playback speed with pitch preserved. Use 0.5 to stretch to about twice the duration. Defaults to 1.' },
        focusSpeech: { type: 'boolean', description: 'Reduce steady background noise and emphasize speech frequencies.' },
        normalize: { type: 'boolean', description: 'Level out volume so quieter passages are easier to hear.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run({ path, chunk, start = 0, end, speed = 1, focusSpeech = false, normalize = false }, signal, workspace) {
      if (!Number.isFinite(start) || start < 0 || start >= maxSeconds ||
          (end !== undefined && (!Number.isFinite(end) || end <= start || end > maxSeconds)) ||
          !Number.isFinite(speed) || speed < 0.25 || speed > 4 ||
          typeof focusSpeech !== 'boolean' || typeof normalize !== 'boolean') {
        throw new WorkspaceMediaError('Choose a valid time range within the chunk and a speed from 0.25 to 4.');
      }
      const { path: source } = await workspace.input(path, { kind: 'audio', chunk });
      const filters = [];
      if (start || end !== undefined) {
        filters.push('atrim=start=' + start.toFixed(6) + (end === undefined ? '' : ':end=' + end.toFixed(6)), 'asetpts=PTS-STARTPTS');
      }
      if (focusSpeech) filters.push('highpass=f=120', 'lowpass=f=4000', 'afftdn');
      // Chain tempo changes to keep each stage in the range that preserves samples.
      if (speed < 0.5) filters.push('atempo=0.5', 'atempo=' + speed * 2);
      else if (speed > 2) filters.push('atempo=2', 'atempo=' + speed / 2);
      else if (speed !== 1) filters.push('atempo=' + speed);
      if (normalize) filters.push('dynaudnorm');
      return workspace.copy('wav', async output => {
        await ffmpeg('ffmpeg', [
          '-v', 'error', '-nostdin', '-xerror', ...audioInputOptions, '-i', source, '-map', '0:a:0', '-map_metadata', '-1',
          ...(filters.length ? ['-af', filters.join(',')] : []),
          '-t', String(maxSeconds + 0.1), '-ar', '48000', '-c:a', 'pcm_s16le', output
        ], signal);
        const seconds = await duration(output, signal);
        if (seconds > maxSeconds) throw new WorkspaceMediaError('The copy would exceed 28 seconds. Trim the input or use a faster speed.');
        if (!(seconds > 0)) throw new WorkspaceMediaError('The selected time range contains no audio.');
        return { seconds };
      });
    }
  }
];

export async function readWorkspaceAudio(reference, { path, format, chunk, chunks }, signal) {
  const seconds = await duration(path, signal);
  if (!(seconds > 0 && seconds <= maxSeconds)) throw new WorkspaceMediaError('Choose an audio clip up to 28 seconds long.');
  const data = await readFile(path, { signal });
  return {
    result: { path: reference, seconds, ...(chunks && { chunk, chunks }) },
    contentPart: { type: 'input_audio', input_audio: { data: data.toString('base64'), format } }
  };
}
