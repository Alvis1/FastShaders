/**
 * The RAW PIXELS a KTX2 encode needs (Phase 8 Step 5), from an Image node's
 * stored `data:` payload. The encoder seam takes RGBA8 and never an encoded
 * image (utils/ktx2Encoder.ts says why: an encoder that re-decoded a PNG would
 * apply its own colour handling to a normal or data map).
 *
 * DOM-only, like `glbFallbackEncode.ts` beside it: `createImageBitmap` plus a
 * canvas. No node suite imports it — `engine/exportSingleGlb.ts` takes an
 * injectable reader and the suites inject pixels — and it is source-pinned
 * instead.
 *
 * Three decode options carry the whole point. `colorSpaceConversion: 'none'`
 * keeps the engine from converting an image's own ICC profile into the display
 * space, which would silently rewrite a normal or data map; `premultiplyAlpha:
 * 'none'` keeps the stored RGB where alpha is partial; `imageOrientation:
 * 'none'` keeps EXIF from turning the picture, which the payload already had
 * applied at drop time.
 *
 * KNOWN LIMIT: a 2D canvas stores premultiplied pixels, so `getImageData`
 * un-premultiplies on the way out and RGB below alpha 255 comes back rounded —
 * up to one unit per channel. Exactly the loss `glbFallbackEncode` documents
 * for its PNG copy, and it lands only on the KTX2 COPY: the texture's own
 * image is the untouched payload.
 */
import { decodeDataUri } from './glbContainer';
import { HARD_MAX_IMAGE_ENCODED_CHARS, validImageDataUrl } from './imageNode';

export interface Ktx2Pixels {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/**
 * `dataUrl` (an Image node's canonical payload) as RGBA8 at `width` × `height`
 * — the node's stored size, which the caller has already checked is KTX2-
 * eligible — or null on ANY failure: an unreadable payload, a decode the engine
 * refuses, no 2D context, or a bitmap of a DIFFERENT size. That last one is
 * `encodeGlbFallback`'s rule and it is a bound, not tidiness: nothing validates
 * an imported node's `values.width`/`height`, so a payload free to declare 512
 * and really be 8192² would otherwise reach `getImageData` as ~0.75 GB.
 * The caller runs these SEQUENTIALLY, one decode at a time (the drop rule).
 */
export async function payloadToRgba(dataUrl: string, width: number, height: number): Promise<Ktx2Pixels | null> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  if (!validImageDataUrl(dataUrl)) return null;
  const decoded = decodeDataUri(dataUrl, 'image', HARD_MAX_IMAGE_ENCODED_CHARS);
  if (!decoded.ok) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(new Blob([decoded.bytes as BlobPart], { type: decoded.mime }), {
      imageOrientation: 'none',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    if (bitmap.width !== width || bitmap.height !== height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { rgba: new Uint8Array(data.buffer.slice(0)), width, height };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
