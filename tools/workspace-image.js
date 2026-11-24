import sharp from 'sharp';
import { renderPdfPage, toolMedia, WorkspaceMediaError } from './media-source.js';

const maxEdge = 2048;
const maxPixels = 2_300_000;
const maxBase64Bytes = 4 * 1024 * 1024;
const transparent = '#00000000';
const pathParameter = { type: 'string', description: 'Attachment path or filename, PDF page path, or an earlier view path to start from.' };
const chunkParameter = { type: 'integer', minimum: 1, description: 'PDF page number starting at 1. Defaults to the linked page, or page 1 for a PDF.' };

function sizeWithin(width, height, edge, pixels, zoom = 1) {
  const scale = Math.min(zoom, edge / Math.max(width, height), Math.sqrt(pixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

function cropSize({ x, y, width, height, zoom }, bounds) {
  if (x + width > bounds.width || y + height > bounds.height) {
    throw new WorkspaceMediaError(`Choose a crop inside the ${bounds.width} × ${bounds.height} image.`);
  }
  return sizeWithin(width, height, maxEdge, maxPixels, zoom);
}

function pixels(image) {
  return image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function openPixels({ data, info }) {
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
}

function resize(image, { width, height }) {
  return image.resize(width, height, { fit: 'fill' });
}

async function encode(frame, quality, signal) {
  const formats = [quality ? { quality, smartSubsample: true } : { lossless: true },
    { quality: 80, alphaQuality: 80, smartSubsample: true }, { quality: 45, alphaQuality: 45, smartSubsample: true }];
  for (const options of formats) {
    signal.throwIfAborted();
    const output = await openPixels(frame).webp(options).toBuffer({ resolveWithObject: true });
    if (4 * Math.ceil(output.data.length / 3) <= maxBase64Bytes) {
      signal.throwIfAborted();
      return { ...output, contentType: 'image/webp' };
    }
  }
  throw new WorkspaceMediaError('This image is too large to send. Choose a smaller crop.');
}

export async function renderImage(source, signal) {
  signal.throwIfAborted();
  const page = source.page;
  const input = page ? await renderPdfPage(source.path, page, signal) : source.path;
  const image = sharp(input, { limitInputPixels: 100_000_000 }).autoOrient();
  const { autoOrient: original } = await image.metadata();
  const baseline = sizeWithin(original.width, original.height, page ? 1800 : 1600, page ? maxPixels : 1_310_000);
  const operations = source.operations ?? [];
  const first = operations[0];
  let frame;
  let remaining = operations;
  if (first?.type === 'crop') {
    const size = cropSize(first, baseline);
    const left = Math.floor(first.x * original.width / baseline.width);
    const top = Math.floor(first.y * original.height / baseline.height);
    const right = Math.ceil((first.x + first.width) * original.width / baseline.width);
    const bottom = Math.ceil((first.y + first.height) * original.height / baseline.height);
    frame = await pixels(resize(image.extract({ left, top, width: right - left, height: bottom - top }), size));
    remaining = operations.slice(1);
  } else {
    frame = await pixels(resize(image, baseline));
  }
  for (const step of remaining) {
    signal.throwIfAborted();
    if (step.type === 'crop') {
      const size = cropSize(step, frame.info);
      const { x, y, width, height } = step;
      frame = await pixels(resize(openPixels(frame).extract({ left: x, top: y, width, height }), size));
    } else {
      frame = await pixels(openPixels(frame).rotate(step.degrees, { background: transparent }));
      const { width, height } = frame.info;
      const size = sizeWithin(width, height, maxEdge, maxPixels);
      if (size.width !== width || size.height !== height) frame = await pixels(resize(openPixels(frame), size));
    }
  }
  return encode(frame, operations.length ? undefined : page ? 92 : 88, signal);
}

export function imageResult(path, { data, contentType, info: { width, height } }) {
  return { path, width, height,
    [toolMedia]: { type: 'image_url', image_url: { url: 'data:' + contentType + ';base64,' + data.toString('base64') } } };
}

export const imageTools = [
  {
    name: 'image_crop', label: 'Crop image',
    description: 'Crops and zooms into an image or PDF page. Returns a new image and view path. The input view stays available.',
    parameters: {
      type: 'object',
      properties: {
        path: pathParameter,
        chunk: chunkParameter,
        x: { type: 'integer', minimum: 0, description: 'Left edge in the selected view.' },
        y: { type: 'integer', minimum: 0, description: 'Top edge in the selected view.' },
        width: { type: 'integer', minimum: 1, description: 'Crop width in pixels.' },
        height: { type: 'integer', minimum: 1, description: 'Crop height in pixels.' },
        zoom: { type: 'number', minimum: 1, maximum: 4, description: 'Upscaling factor, default 2.' }
      },
      required: ['path', 'x', 'y', 'width', 'height'], additionalProperties: false
    },
    async run({ path, chunk, x, y, width, height, zoom = 2 }, _signal, workspace) {
      if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1 ||
          !Number.isFinite(zoom) || zoom < 1 || zoom > 4) {
        throw new WorkspaceMediaError('Use a valid pixel region and a zoom from 1 to 4.');
      }
      return workspace.edit(path, { kind: 'image', chunk }, { type: 'crop', x, y, width, height, zoom });
    }
  },
  {
    name: 'image_rotate', label: 'Rotate image',
    description: 'Rotates an image or PDF page. Returns a new image and view path. The input view stays available.',
    parameters: {
      type: 'object',
      properties: { path: pathParameter, chunk: chunkParameter,
        degrees: { type: 'number', description: 'Clockwise rotation in degrees. Negative values rotate counterclockwise.' } },
      required: ['path', 'degrees'], additionalProperties: false
    },
    async run({ path, chunk, degrees }, _signal, workspace) {
      if (!Number.isFinite(degrees)) throw new WorkspaceMediaError('Provide a rotation angle in degrees.');
      return workspace.edit(path, { kind: 'image', chunk }, { type: 'rotate', degrees: degrees % 360 });
    }
  }
];
