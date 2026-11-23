import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { WorkspaceMediaError } from '../workspace.js';

const maxEdge = 2048;
const pathParameter = { type: 'string', description: 'Image link from this conversation or a copy path returned by an image tool.' };
const image = source => sharp(source, { limitInputPixels: 2 * maxEdge ** 2 });

export const imageTools = [
  {
    name: 'image_crop',
    label: 'Crop image',
    description: 'Crops and zooms into an image region. Returns the copy’s workspace path. Pass it to read_file in a separate call to view it.',
    parameters: {
      type: 'object',
      properties: {
        path: pathParameter,
        x: { type: 'integer', minimum: 0, description: 'Left edge in source pixels.' },
        y: { type: 'integer', minimum: 0, description: 'Top edge in source pixels.' },
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
        zoom: { type: 'number', minimum: 1, maximum: 4, description: 'Upscaling factor, default 2, subject to a 2048-pixel output edge limit.' }
      },
      required: ['path', 'x', 'y', 'width', 'height'],
      additionalProperties: false
    },
    async run({ path, x, y, width, height, zoom = 2 }, signal, workspace) {
      const { path: source } = await workspace.input(path, { kind: 'image' });
      const input = image(source);
      const bounds = await input.metadata();
      if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1 ||
          x + width > bounds.width || y + height > bounds.height || !Number.isFinite(zoom) || zoom < 1 || zoom > 4) {
        throw new WorkspaceMediaError(`Choose a crop inside the ${bounds.width} × ${bounds.height} image and a zoom from 1 to 4.`);
      }
      const scale = Math.min(zoom, maxEdge / Math.max(width, height));
      const crop = input.extract({ left: x, top: y, width, height }).resize({
        width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), fit: 'fill'
      });
      return workspace.copy('webp', async output => {
        const result = await crop.webp({ lossless: true }).toFile(output);
        return { width: result.width, height: result.height };
      });
    }
  },
  {
    name: 'image_rotate',
    label: 'Rotate image',
    description: 'Rotates an image. Returns the copy’s workspace path. Pass it to read_file in a separate call to view it.',
    parameters: {
      type: 'object',
      properties: { path: pathParameter, degrees: { type: 'number', description: 'Clockwise rotation in degrees. Negative values rotate counterclockwise.' } },
      required: ['path', 'degrees'],
      additionalProperties: false
    },
    async run({ path, degrees }, signal, workspace) {
      if (!Number.isFinite(degrees)) throw new WorkspaceMediaError('Provide a rotation angle in degrees.');
      const { path: source } = await workspace.input(path, { kind: 'image' });
      const { data, info } = await image(source).rotate(degrees % 360, { background: '#00000000' })
        .webp({ lossless: true }).toBuffer({ resolveWithObject: true });
      return workspace.copy('webp', async output => {
        if (Math.max(info.width, info.height) <= maxEdge) {
          await writeFile(output, data, { signal });
          return { width: info.width, height: info.height };
        }
        const result = await image(data).resize(maxEdge, maxEdge, { fit: 'inside' }).webp({ lossless: true }).toFile(output);
        return { width: result.width, height: result.height };
      });
    }
  }
];

export async function readWorkspaceImage(reference, { path }, signal) {
  const data = await readFile(path, { signal });
  const { width, height } = await image(data).metadata();
  return {
    result: { path: reference, width, height },
    contentPart: { type: 'image_url', image_url: { url: 'data:image/webp;base64,' + data.toString('base64') } }
  };
}
