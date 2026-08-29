/**
 * Build / decode / bound the `imageNode` payload.
 *
 * A dropped image becomes one Image node whose pixels are stored as a
 * compressed `data:` URL (WebP/PNG/JPEG, re-encoded via canvas at drop time)
 * on `data.values.imageB64` — so the whole node round-trips through
 * localStorage and the embedded `.js` project snapshot with no special
 * handling, exactly like the Data node's CSV blob.
 *
 * SECURITY MODEL — the stored payload is ADVERSARIAL (a shared `.fastshader`
 * can contain anything). Two rules keep it inert:
 *   1. `decodeImageNode` strict-validates in this order: length ceiling
 *      (O(1)) → whole-URL regex (linear, admits only the base64 alphabet and
 *      a whitelisted MIME) → try/catch'd byte decode (the regex still admits
 *      atob-invalid strings like "A=A="). Any violation → null, and
 *      graphToCode emits an inert `vec3(0, 0, 0)` fallback.
 *   2. The stored string itself is NEVER emitted into generated code or an
 *      interpreted sink. graphToCode re-encodes the decoded bytes
 *      (`bytesToBase64`) and the MIME comes from the regex capture whitelist;
 *      the editor thumbnail renders only `validImageDataUrl`'s result.
 *
 * Everything here is pure and dependency-free (node-testable); the DOM-side
 * canvas encode lives in `imageImport.ts`.
 */

import type { AppNode, ShaderNodeData } from '@/types';
import { getNodeValues } from '@/types';
import { base64ToBytes } from './binaryCodec';

/** Soft per-image cap on the encoded data-URL length. Undo history keeps up to
 *  ~51 `structuredClone`d copies of the graph, so every payload char is
 *  multiplied — 600K chars ≈ 450 KB binary keeps one image node at ~30-60 MB
 *  worst-case history footprint. A 1024px WebP q0.85 is typically 50-300 KB,
 *  so real images fit with headroom. Bypassable via `ignoreImageLimits`. */
export const MAX_IMAGE_ENCODED_CHARS = 600_000;

/** Hard per-image ceiling, enforced even when the user ignores the soft
 *  limits — bounds adversarial payloads (validation, thumbnail, emission). */
export const HARD_MAX_IMAGE_ENCODED_CHARS = 8_000_000;

/** Soft cap on the combined encoded size across ALL image nodes. The per-image
 *  cap alone doesn't bound history RAM because node count is unbounded. */
export const MAX_TOTAL_IMAGE_CHARS = 3_000_000;

/** Default longest-side cap for the drop-time re-encode (and the relaxed cap
 *  used when limits are ignored). WebGPU guarantees 8192; these stay far under
 *  so the payload caps above are reachable. */
export const MAX_IMAGE_DIM = 1024;
export const MAX_IMAGE_DIM_RELAXED = 2048;

/** Reject source images above this pixel count before drawing them to a
 *  canvas (a 20000×20000 PNG decompresses to ~1.6 GB of RGBA). */
export const MAX_SOURCE_PIXELS = 64_000_000;

/** Upper bound for the stored width/height fields (matches WebGPU's
 *  guaranteed maxTextureDimension2D). */
const MAX_IMAGE_DIM_FIELD = 8192;

const IMAGE_MIME_TYPES = ['png', 'jpeg', 'webp'] as const;
type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

/**
 * Whole-URL whitelist. Everything outside `[A-Za-z0-9+/=]` (plus the fixed
 * `data:image/<mime>;base64,` prefix) is rejected, so a passing string can
 * never escape a double-quoted JS literal, a template literal, or a <script>
 * HTML context (no `"` `\` `` ` `` `${` `<` `>` or line terminators; JS `$`
 * without /m does not match before a trailing newline).
 */
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export interface DecodedImageNode {
  mime: ImageMime;
  /** The decoded payload bytes — re-encode THESE for any emission. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Extra provenance written only when the drop-time power-of-two snap
 *  actually changed the image (see `imageCodec.ts`). Absent on every node
 *  that was stored 1:1 — including every node authored before the snap
 *  existed — so both shapes have to be tolerated everywhere. */
export interface ImageOriginInfo {
  /** Key of the pre-snap payload in `imageOriginCache` (device-local). */
  originId?: string;
  /** Dimensions BEFORE the snap, so the card can show the shape the user
   *  actually dropped rather than the snapped one. */
  srcWidth?: number;
  srcHeight?: number;
}

/** `originId` is used as an IndexedDB key and comes back from imported
 *  project JSON — keep it to the hex digest shape it is generated in. */
export const ORIGIN_ID_RE = /^[0-9a-f]{8,64}$/;

/** Construct the `ShaderNodeData` for an Image node. `fileName` is
 *  display-only (shown under the node header) and never reaches generated
 *  code. `colorSpace` 'color' = sRGB texture; 'data' = linear non-mipmapped
 *  (normal/height maps), toggled in the node settings menu. */
export function makeImageNodeData(
  dataUrl: string,
  width: number,
  height: number,
  cost: number,
  fileName = '',
  origin?: ImageOriginInfo,
): ShaderNodeData {
  return {
    registryType: 'imageNode',
    label: 'Image',
    cost,
    values: {
      imageB64: dataUrl,
      width,
      height,
      fileName,
      colorSpace: 'color',
      ...(origin?.originId ? { originId: origin.originId } : {}),
      ...(origin?.srcWidth && origin?.srcHeight
        ? { srcWidth: origin.srcWidth, srcHeight: origin.srcHeight }
        : {}),
    },
  };
}

/** Validate a stored payload for DISPLAY (the `<img src>` thumbnail): full
 *  whitelist check, no byte decode. Returns the string only if it is provably
 *  a whitelisted `data:` URL — never render the raw stored value. */
export function validImageDataUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  if (url.length > HARD_MAX_IMAGE_ENCODED_CHARS) return null;
  return IMAGE_DATA_URL_RE.test(url) ? url : null;
}

/** Decode an Image node's stored payload for code emission. Returns null if
 *  anything is off (graphToCode then emits an inert `vec3(0,0,0)` fallback —
 *  explicitly, since consumers still reference the node's variable). */
export function decodeImageNode(
  values: Record<string, string | number>,
): DecodedImageNode | null {
  const url = values.imageB64;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (url.length > HARD_MAX_IMAGE_ENCODED_CHARS) return null;
  const m = IMAGE_DATA_URL_RE.exec(url);
  if (!m) return null;

  const width = Number(values.width);
  const height = Number(values.height);
  if (!Number.isInteger(width) || width <= 0 || width > MAX_IMAGE_DIM_FIELD) return null;
  if (!Number.isInteger(height) || height <= 0 || height > MAX_IMAGE_DIM_FIELD) return null;

  // The regex admits atob-invalid strings (e.g. "A=A=", or a length ≡ 1 mod
  // 4) — decode under try/catch so a hostile payload degrades instead of
  // throwing mid-codegen.
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(url.slice(url.indexOf(',') + 1));
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  return { mime: m[1] as ImageMime, bytes, width, height };
}

/**
 * The name to SHOW for an image node: the dropped file's stem with the
 * extension of what is actually stored.
 *
 * Drop-time re-encoding means the stored bytes routinely aren't the format the
 * file name claims — a `.png` can be sitting there as WebP or JPEG. Showing
 * the raw name made the card assert something false, and left the real format
 * discoverable only by opening the settings menu. The extension comes from the
 * validated payload, exactly like the zip export's file names do; an unusable
 * payload falls back to the stored name rather than inventing one.
 */
export function displayImageFileName(fileName: unknown, dataUrl: unknown): string {
  const name = typeof fileName === 'string' ? fileName : '';
  const url = validImageDataUrl(dataUrl);
  if (!url) return name;
  const m = /^data:image\/(png|jpeg|webp);base64,/.exec(url);
  if (!m) return name;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const stem = name.replace(/\.[^./\\]*$/, '');
  return `${stem || 'image'}.${ext}`;
}

export interface ImageFileEntry {
  /** Archive-safe file name (sanitized stem + extension from the REAL mime). */
  name: string;
  bytes: Uint8Array;
}

/**
 * Extract every valid image payload as a standalone file entry (for the
 * zip export). `fileName` is adversarial: only a conservative character
 * whitelist of its stem survives (no path separators, no leading dots), and
 * the extension always comes from the validated payload's actual MIME — the
 * stored name may lie (a drop re-encodes, so "cat.jpg" is often WebP data).
 */
export function collectImageFiles(nodes: AppNode[]): ImageFileEntry[] {
  const used = new Set<string>();
  const out: ImageFileEntry[] = [];
  let counter = 0;
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const values = getNodeValues(n);
    const decoded = decodeImageNode(values);
    if (!decoded) continue;
    counter++;
    const ext = decoded.mime === 'jpeg' ? 'jpg' : decoded.mime;
    const rawStem = String(values.fileName ?? '').replace(/\.[^.]*$/, '');
    const stem =
      rawStem
        .replace(/[^a-zA-Z0-9._ -]/g, '_')
        .replace(/\.{2,}/g, '.')
        .replace(/^[. ]+|[. ]+$/g, '')
        .slice(0, 64) || `image${counter}`;
    let name = `${stem}.${ext}`;
    let dedupe = 2;
    while (used.has(name)) name = `${stem}-${dedupe++}.${ext}`;
    used.add(name);
    out.push({ name, bytes: decoded.bytes });
  }
  return out;
}

/** Sum of stored image-payload chars across every Image node instance
 *  (duplicates each carry their own copy — that's what history/storage pay). */
/**
 * Build the Image node for a finished encode — the ONE construction path,
 * shared by the canvas drop and the store's "Add anyway" overrides, so an
 * override can't produce a node the drop path wouldn't have.
 *
 * `origin` carries the stash id + pre-snap dimensions; passing them together
 * with the payload is what keeps "the node was snapped" and "the node can be
 * reverted" from ever drifting apart.
 */
export function makeImageNodeFromEncode(
  encoded: { dataUrl: string; width: number; height: number },
  cost: number,
  fileName: string,
  origin?: ImageOriginInfo,
): ShaderNodeData {
  return makeImageNodeData(encoded.dataUrl, encoded.width, encoded.height, cost, fileName, origin);
}

/** What `encodeImageFile` hands back, structurally — declared here so this
 *  module stays free of the DOM-only import. */
export interface EncodedImagePair {
  dataUrl: string;
  width: number;
  height: number;
  potApplied: boolean;
  original?: { dataUrl: string; width: number; height: number };
}

export interface ResolvedImageDrop {
  payload: { dataUrl: string; width: number; height: number };
  origin?: ImageOriginInfo;
}

/**
 * Decide what a finished encode actually becomes on the canvas, and enforce
 * the rule the whole power-of-two design rests on: **a destructive snap only
 * ships with its escape hatch.**
 *
 * The snap happens inside `encodeImageFile`, before any stash is attempted,
 * so the stash can still be refused afterwards — the pre-snap payload is
 * bounded by the ENCODE budget, which the ignore-limits override raises to
 * the hard ceiling, while the cache only accepts the normal per-image cap.
 * When that happens the snapped payload is discarded and the un-snapped one
 * is placed instead: an irreversible resample is worse than no resample, and
 * a node must never advertise (via srcWidth/srcHeight) a snap it can't undo.
 *
 * `stash` is injected so this stays pure and node-testable.
 */
export function resolveImageDrop(
  res: EncodedImagePair,
  fileName: string,
  stash: (payload: { dataUrl: string; width: number; height: number; fileName: string }) => string | null,
): ResolvedImageDrop {
  if (!res.potApplied || !res.original) return { payload: res };

  const originId = stash({ ...res.original, fileName });
  if (!originId) return { payload: res.original };

  return {
    payload: res,
    origin: { originId, srcWidth: res.original.width, srcHeight: res.original.height },
  };
}

export function totalImageChars(nodes: AppNode[]): number {
  let total = 0;
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const url = getNodeValues(n).imageB64;
    if (typeof url === 'string') total += url.length;
  }
  return total;
}

export interface ImageSanitizeResult {
  nodes: AppNode[];
  /** How many image payloads were emptied (node kept, pixels dropped). */
  strippedCount: number;
}

/**
 * Bound image payloads on graphs entering the store from outside the drop
 * path (project import, localStorage). Hard violations (non-whitelisted URL,
 * over the hard ceiling) are ALWAYS stripped — they can only come from a
 * tampered file. Soft caps (per-image + running total) apply only when
 * `enforceSoft` (i.e. the user hasn't opted out via the ignore-limits
 * checkbox). Stripping empties `imageB64` but keeps the node, so the graph
 * shape survives and the shader degrades to the inert fallback.
 */
export function sanitizeImageNodes(
  nodes: AppNode[],
  enforceSoft: boolean,
): ImageSanitizeResult {
  let strippedCount = 0;
  let runningTotal = 0;
  let changed = false;
  const out = nodes.map((n) => {
    if (n.data?.registryType !== 'imageNode') return n;
    const values = getNodeValues(n);

    // Provenance keys ride imported JSON like everything else. `originId`
    // becomes an IndexedDB key and the src dims feed a CSS aspect-ratio, so
    // both are whitelisted here rather than at every read site; a malformed
    // one is dropped (the node keeps working, it just can't be reverted).
    const base = sanitizeOriginKeys(values) ?? values;
    if (base !== values) changed = true;

    const url = base.imageB64;
    let bad = typeof url !== 'string' || url.length === 0 ? false : validImageDataUrl(url) === null;
    if (typeof url === 'string' && url.length > 0) {
      if (!bad && enforceSoft) {
        bad =
          url.length > MAX_IMAGE_ENCODED_CHARS ||
          runningTotal + url.length > MAX_TOTAL_IMAGE_CHARS;
      }
      if (!bad) runningTotal += url.length;
    }

    if (!bad) {
      return base === values ? n : ({ ...n, data: { ...n.data, values: base } } as AppNode);
    }
    strippedCount++;
    changed = true;
    return {
      ...n,
      data: { ...n.data, values: { ...base, imageB64: '' } },
    } as AppNode;
  });
  return { nodes: changed ? out : nodes, strippedCount };
}

/** Drop `originId` / `srcWidth` / `srcHeight` when they don't hold their
 *  expected shape. Returns a NEW values object only when something changed,
 *  so an untouched graph keeps its identity (the store compares by
 *  reference to decide whether to re-sync). */
function sanitizeOriginKeys(
  values: Record<string, string | number>,
): Record<string, string | number> | null {
  const drop: string[] = [];
  // Plain property access, never `'originId' in values` — the `in` operator
  // THROWS on a primitive, and these values come straight out of an untrusted
  // `fs:graph` / `.fastshader` / `fs:savedGroups` payload. `getNodeValues` now
  // coerces a non-object to `{}` so this is belt-and-braces, but the rule is
  // the one `sanitizeDataRangeNodes` states and this function is where it was
  // still being broken.
  const has = (k: string): boolean => (values as Record<string, unknown>)[k] !== undefined;
  if (has('originId')) {
    const id = values.originId;
    if (typeof id !== 'string' || !ORIGIN_ID_RE.test(id)) drop.push('originId');
  }
  const dimOk = (v: unknown) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= MAX_IMAGE_DIM_FIELD;
  if (has('srcWidth') && !dimOk(values.srcWidth)) drop.push('srcWidth');
  if (has('srcHeight') && !dimOk(values.srcHeight)) drop.push('srcHeight');
  // Half a pair is meaningless to the consumer (a CSS aspect-ratio needs both).
  if (has('srcWidth') !== has('srcHeight')) {
    drop.push('srcWidth', 'srcHeight');
  }
  if (drop.length === 0) return null;
  const out = { ...values };
  for (const k of drop) delete out[k];
  return out;
}
