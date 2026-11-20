/**
 * A picture added to a request: read ONCE, on this computer, into what the
 * dialog needs — the measurements a model is sent (imageAnalysis.ts), a small
 * thumbnail the app painted itself, the copy a model that SEES is shown
 * (`seeUrl`, the app's own JPEG, for a model server on this computer only),
 * and the file as given for "Use the picture itself"
 * (docs/dev/node-generator.md § A picture in the request).
 *
 * The file is adversarial like every dropped one. It is decoded by the
 * browser's own image decoder and nothing else; only pixels the app drew onto
 * its own canvas are measured or shown, so no metadata, no markup and no byte
 * of the file reaches the page or a model. SVG is refused outright (markup,
 * not pixels — imageImport.ts's rule). Never throws.
 */
import { isImageFile, isSvgFile } from '@/utils/imageImport';
import { MAX_SOURCE_PIXELS } from '@/utils/imageNode';
export { pictureFrom } from '@/utils/pictureTransfer';
import { analyzePicture, type PictureFacts } from './imageAnalysis';
import { isSeenPictureUrl } from './protocol/openaiCompat';

/** The largest file taken as a request's picture. */
export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
/** The copy that is measured: its longest side. */
const ANALYSIS_SIDE = 256;
/** The thumbnail's longest side (drawn at 64 CSS px, twice that for a dense screen). */
const THUMB_SIDE = 128;
/** The copy a seeing model gets: longest side and JPEG quality, tried in
 *  order until one fits `MAX_SEEN_PICTURE_CHARS`. */
const SEE_TRIES: readonly (readonly [side: number, quality: number])[] = [[768, 0.85], [768, 0.6], [512, 0.6]];

export interface HeldPicture {
  /** The file as given — never sent anywhere; "Use the picture itself" hands
   *  it to the canvas's own picture drop. */
  file: File;
  width: number;
  height: number;
  bytes: number;
  /** A `data:image/png` of the app's own downscaled drawing. */
  thumbUrl: string;
  /** A `data:image/jpeg` of the app's own drawing, at most 768 px: what a
   *  model that sees is sent. No metadata and no byte of the file. Absent when
   *  no encoding fits the request (the model then gets the measurements). */
  seeUrl?: string;
  facts: PictureFacts;
}

export type ReadPictureResult =
  | { ok: true; picture: HeldPicture }
  | { ok: false; reason: 'not-image' | 'too-big' };

/** A file the dialog must not take as a picture because it is a document:
 *  a shader, a project, a model. Opening one behind an open dialog is refused. */
export function isDocumentFile(file: File): boolean {
  return /\.(js|mjs|tsl|zip|fastshader|glb|gltf|obj|ply|spz|splat|ksplat)$/i.test(file.name);
}

async function decode(file: File): Promise<ImageBitmap | null> {
  for (const opts of [{ imageOrientation: 'from-image' } as const, undefined]) {
    try {
      return await createImageBitmap(file, opts);
    } catch {
      /* option unsupported, or not a picture: try the plain form, then give up */
    }
  }
  return null;
}

function drawn(bitmap: ImageBitmap, side: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

/** The picture as a seeing model gets it: re-drawn by the app (JPEG has no
 *  alpha, so transparency is laid on white), small enough for one request. */
function seenCopy(bitmap: ImageBitmap): string | undefined {
  for (const [side, quality] of SEE_TRIES) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    if (isSeenPictureUrl(url)) return url;
  }
  return undefined;
}

export async function readPicture(file: File): Promise<ReadPictureResult> {
  if (!isImageFile(file) || isSvgFile(file)) return { ok: false, reason: 'not-image' };
  if (file.size > MAX_PICTURE_BYTES) return { ok: false, reason: 'too-big' };
  const bitmap = await decode(file);
  if (!bitmap) return { ok: false, reason: 'not-image' };
  try {
    const { width, height } = bitmap;
    if (width < 1 || height < 1) return { ok: false, reason: 'not-image' };
    if (width * height > MAX_SOURCE_PIXELS) return { ok: false, reason: 'too-big' };
    const small = drawn(bitmap, ANALYSIS_SIDE);
    const thumb = drawn(bitmap, THUMB_SIDE);
    if (!small || !thumb) return { ok: false, reason: 'not-image' };
    const pixels = small.ctx.getImageData(0, 0, small.canvas.width, small.canvas.height);
    const facts = analyzePicture(pixels);
    // Nothing to measure: every pixel transparent.
    if (!facts) return { ok: false, reason: 'not-image' };
    const seeUrl = seenCopy(bitmap);
    return {
      ok: true,
      picture: {
        file, width, height, bytes: file.size, thumbUrl: thumb.canvas.toDataURL('image/png'), facts,
        ...(seeUrl ? { seeUrl } : {}),
      },
    };
  } catch {
    return { ok: false, reason: 'not-image' };
  } finally {
    bitmap.close();
  }
}
