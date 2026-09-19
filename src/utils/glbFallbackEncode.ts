/**
 * The PNG/JPEG COPY of a WebP texture in a single-GLB export (Phase 7 Step 4),
 * for viewers that IGNORE `EXT_texture_webp`. three r184 never uses it:
 * GLTFLoader's GLTFTextureWebPExtension always loads the WebP source and has
 * no fallback path, so three, A-Frame pages and every FastShaders surface
 * take the WebP; the copy costs bytes only for other viewers.
 *
 * DOM-only (createImageBitmap, a canvas, `toBlob`); never imported by a node
 * test — engine/exportSingleGlb.ts takes an injectable encoder, and node
 * suites inject bytes.
 *
 * What it can promise, and what it cannot:
 *   - a JPEG copy is a SECOND lossy generation of a lossy WebP (q0.92, so it
 *     loses little); a lossless source always gets PNG, as does any picture
 *     with alpha — the drop-time alpha-never-JPEG rule, through the SAME
 *     `scanPixels` the drop uses;
 *   - canvas premultiplication makes a PNG copy bit-exact only where pixels
 *     are opaque;
 *   - encoder bytes differ between Chrome, WebKit and Firefox, so the export
 *     is deterministic only up to this copy (the repacker itself is pure);
 *   - an engine that silently answers with another format (WebKit's WebP
 *     trap, in the other direction) is a refusal, never a mislabelled copy;
 *   - a copy the repacker could not embed (over `GLTF_IMAGE_MAX_BYTES`, which
 *     a lossless PNG of a large WebP really can exceed) is a refusal too: the
 *     repacker's `validate` REFUSES such a fallback in both WebP modes, so
 *     returning it would fail the whole export as `bad-input` ("The model
 *     could not be read.") instead of shipping the texture WebP-only.
 * Every failure is `null`: the texture is then written WebP-only and the
 * export report says so.
 */
import { encodeBlob, scanPixels } from './imageImport';
import { sniffImageFormat } from './glbContainer';
import { GLTF_IMAGE_MAX_BYTES } from './gltfReader';
import type { RepackFallback, RepackPayload } from './glbRepack';

export const GLB_FALLBACK_JPEG_QUALITY = 0.92;

/**
 * Encode `p` (a WebP payload) as PNG or JPEG at `width` × `height` — the
 * node's validated stored size; a bitmap of any other size is refused.
 * The caller runs this SEQUENTIALLY (one encoder at a time, the drop rule).
 */
export async function encodeGlbFallback(p: RepackPayload, width: number, height: number): Promise<RepackFallback | null> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(new Blob([p.bytes as BlobPart], { type: p.mime }), {
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
    const alpha = p.lossless ? true : scanPixels(ctx, width, height).alpha;
    const mime: RepackFallback['mime'] = p.lossless || alpha ? 'image/png' : 'image/jpeg';
    const blob = await encodeBlob(canvas, mime, mime === 'image/jpeg' ? GLB_FALLBACK_JPEG_QUALITY : undefined);
    if (!blob || blob.type !== mime) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length > GLTF_IMAGE_MAX_BYTES) return null;
    if (sniffImageFormat(bytes) !== (mime === 'image/png' ? 'png' : 'jpeg')) return null;
    return { mime, bytes };
  } catch {
    return null;
  } finally {
    try {
      bitmap?.close();
    } catch {
      /* already closed */
    }
  }
}
