import { env } from 'cloudflare:workers';
import { ApiError } from './server';

export const FRAME_MAX_BYTES = 150 * 1024;
export const FRAME_MAX_DIMENSION = 640;
export const FRAME_DETAIL_SELECT = `SELECT jobs.*, job_frames.status AS frame_status,
  job_frames.width AS frame_width, job_frames.height AS frame_height, job_frames.kind AS frame_kind
  FROM jobs LEFT JOIN job_frames ON job_frames.job_id=jobs.id`;

export function frameBucket() {
  if (!env.BUCKET) throw new ApiError(503, 'Video preview storage is not ready. Please try again shortly.');
  return env.BUCKET;
}

export const frameLeaseExpiry = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();

/** Read the actual JPEG SOF dimensions, never worker-supplied width/height headers. */
export function jpegDimensions(bytes: Uint8Array, maxDimension = FRAME_MAX_DIMENSION) {
  const invalid = () => new ApiError(400, 'Upload a valid JPEG video preview.');
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw invalid();
  let position = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (position < bytes.length - 2) {
    if (bytes[position++] !== 0xff) throw invalid();
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) throw invalid();
    if (position + 2 > bytes.length) throw invalid();
    const length = (bytes[position] << 8) | bytes[position + 1];
    if (length < 2 || position + length > bytes.length - 2) throw invalid();
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (dimensions || length < 8) throw invalid();
      const height = (bytes[position + 3] << 8) | bytes[position + 4];
      const width = (bytes[position + 5] << 8) | bytes[position + 6];
      const components = bytes[position + 7];
      if (!width || !height || !components || length !== 8 + 3 * components) throw invalid();
      if (width > maxDimension || height > maxDimension) throw new ApiError(400, `Images must be at most ${maxDimension} × ${maxDimension} pixels.`);
      dimensions = { width, height };
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6) throw invalid();
      return dimensions;
    }
    position += length;
  }
  throw invalid();
}

/** Enforce the byte limit while streaming; Content-Length alone is not trusted. */
export async function readFrameJpeg(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg') throw new ApiError(415, 'Upload the video preview as image/jpeg.');
  const statedLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(statedLength) && statedLength > FRAME_MAX_BYTES) throw new ApiError(413, 'Video previews must be at most 150 KiB.');
  if (!request.body) throw new ApiError(400, 'The video preview is empty.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > FRAME_MAX_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'Video previews must be at most 150 KiB.');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, ...jpegDimensions(bytes) };
}
