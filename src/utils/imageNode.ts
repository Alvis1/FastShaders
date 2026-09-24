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
import { valueStr, valueNum } from './valueCoerce';
import { getNodeValues } from '@/types';
import { base64ToBytes } from './binaryCodec';
import { fnv1a32Bytes } from './payloadDigest';
import { sanitizeUvMappingKeys } from './imageUvMapping';
import { PLATFORM_CAPS } from './platformCaps';

/** Soft per-image cap on the encoded data-URL length. 600K chars ≈ 450 KB
 *  binary; a 1024px WebP q0.85 is typically 50-300 KB, so real images fit with
 *  headroom. Bypassable via `ignoreImageLimits`.
 *
 *  This used to read "every payload char is multiplied by ~51 history clones",
 *  and that is no longer what the cap is holding back: the store's
 *  `cloneNodesSharingPayloads` carries `values.imageB64` BY REFERENCE into
 *  every undo entry (JS strings are immutable and every edit path REPLACES
 *  `values` wholesale, so one string reachable from the live graph and all 50
 *  entries cannot be mutated by any of them). What the cap still bounds is
 *  every place the payload is genuinely re-materialized: the 300 ms
 *  localStorage autosave `JSON.stringify`s it against a ~5-10 MB origin budget
 *  the graph already shares (a duplicated payload is written ONCE per
 *  document, `imagePayloadRefs.ts`), the project block re-embeds it in every
 *  export (once per node), and `decodeImageNode` runs an
 *  `atob` over it. Everything on the node OTHER than this key is still deep
 *  copied per history entry, so keeping the bulk in the one shared string is
 *  also what makes that clone cheap.
 *
 *  Web 600K; the desktop room raises it to 6M, where the autosave is a Rust-side
 *  file rather than localStorage (utils/platformCaps.ts). */
export const MAX_IMAGE_ENCODED_CHARS = PLATFORM_CAPS.imageChars;

/** Hard per-image ceiling, enforced even when the user ignores the soft
 *  limits — bounds adversarial payloads (validation, thumbnail, emission). */
export const HARD_MAX_IMAGE_ENCODED_CHARS = 8_000_000;

/** Soft cap on the combined encoded size across ALL image nodes. The per-image
 *  cap alone bounds nothing at the document level, because node count is
 *  unbounded — and it is the document that has to fit the autosave's
 *  localStorage budget and ride an export. Web 3M; the desktop room raises it to
 *  32M (utils/platformCaps.ts). */
export const MAX_TOTAL_IMAGE_CHARS = PLATFORM_CAPS.projectImageChars;

/** Default longest-side cap for the drop-time re-encode (and the relaxed cap
 *  used when limits are ignored). WebGPU guarantees 8192; these stay far under
 *  so the payload caps above are reachable. */
export const MAX_IMAGE_DIM = 1024;
export const MAX_IMAGE_DIM_RELAXED = 2048;

/** Reject source images above this pixel count before drawing them to a
 *  canvas (a 20000×20000 PNG decompresses to ~1.6 GB of RGBA). */
export const MAX_SOURCE_PIXELS = 64_000_000;

/** An encoded-chars budget as the "KB" a notice prints: base64 carries 3 bytes
 *  per 4 chars, so 600K chars ≈ 439 KB of image. Shared by every notice that
 *  names one of the caps above (LimitModal's copy, the canvas import note). */
export function formatImageBudget(chars: number): string {
  return `${Math.round((chars * 0.75) / 1024)} KB`;
}

/** Upper bound for the stored width/height fields (matches WebGPU's
 *  guaranteed maxTextureDimension2D). Exported so the texture picker's source
 *  list (textureSources.ts) holds a payload to `decodeImageNode`'s own bound. */
export const MAX_IMAGE_DIM_FIELD = 8192;

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

/** Extra provenance written only when the stored payload is NOT the original
 *  — the drop-time power-of-two snap changed it (see `imageCodec.ts`), or the
 *  user chose a Resolution in the settings menu. Absent on every node stored
 *  1:1 — including every node authored before either existed — so both
 *  shapes have to be tolerated everywhere. */
export interface ImageOriginInfo {
  /** Key of the ORIGINAL payload in `imageOriginCache` (device-local): the
   *  pre-snap encode for a drop the power-of-two snap fired on, or the
   *  pre-resize payload once the user picks a Resolution in the settings
   *  menu (which stashes lazily, at the first resize). */
  originId?: string;
  /** The ORIGINAL's dimensions, present exactly when the stored payload is
   *  NOT the original — a drop-time snap, or a resolution the user chose.
   *  They gate the settings menu's Original row + Revert button and keep the
   *  card's thumbnail at the source aspect. Always written as a pair. */
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

  // A valid payload with a TAMPERED width is the reachable case: the typeof
  // guard above already rejected a poisoned payload, so `Number()` here would
  // be the throw. `valueNum` yields NaN, which the integer test below rejects.
  const width = valueNum(values.width);
  const height = valueNum(values.height);
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
 *
 * ONE entry per DISTINCT image: the decoded bytes and the MIME are compared in
 * full (the FNV digest only buckets them), and the first node's name wins. So
 * non-canonical base64 of the same bytes is one file, while the same bytes
 * under a different MIME claim are two, since their extensions differ. A
 * skipped duplicate claims no name, but it still advances the `image<n>`
 * fallback counter, so the fallback names of distinct images do not move. A
 * graph without duplicates yields exactly the entries it always did. No
 * FastShaders reader or Podest reads images/, so this is compatibility-free.
 */
export function collectImageFiles(nodes: AppNode[]): ImageFileEntry[] {
  const used = new Set<string>();
  const out: ImageFileEntry[] = [];
  const seen = new Map<string, Uint8Array[]>();
  let counter = 0;
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const values = getNodeValues(n);
    const decoded = decodeImageNode(values);
    if (!decoded) continue;
    counter++;
    const ident = `${decoded.mime}|${decoded.bytes.length}|${fnv1a32Bytes(decoded.bytes)}`;
    const bucket = seen.get(ident);
    if (bucket && bucket.some((b) => bytesEqual(b, decoded.bytes))) continue;
    if (bucket) bucket.push(decoded.bytes);
    else seen.set(ident, [decoded.bytes]);
    const ext = decoded.mime === 'jpeg' ? 'jpg' : decoded.mime;
    const rawStem = valueStr(values.fileName).replace(/\.[^.]*$/, '');
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

/** Byte-for-byte equality (collectImageFiles' identity check). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
  /** Whether this payload is lossless (encodeImageFile's `lossless`). */
  lossless?: boolean;
  original?: { dataUrl: string; width: number; height: number; lossless?: boolean };
}

export interface ResolvedImageDrop {
  payload: { dataUrl: string; width: number; height: number; lossless?: boolean };
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
  // Only a SNAPPED drop stashes. An unsnapped payload IS the original, so the
  // settings menu's Resolution ladder reads it straight off the node and
  // stashes it lazily at the first resize (ImageNodeSettings) — stashing it
  // here as well was tried on 2026-09-09 and reverted the same day: every
  // drop then competed for the origin cache's slots, so an ordinary drop
  // could evict the ONE record that undoes a destructive snap, and the study
  // clean slate learned about bytes it never had to.
  if (!res.potApplied || !res.original) return { payload: res };

  const originId = stash({ ...res.original, fileName });
  // A refused stash means the snap would ship with no way back — so the
  // un-snapped encode is shipped instead (the whole POT design rests on "a
  // destructive step never ships without its escape hatch").
  if (!originId) return { payload: res.original };

  return {
    payload: res,
    origin: { originId, srcWidth: res.original.width, srcHeight: res.original.height },
  };
}

/** Sum of stored image-payload chars across every Image node INSTANCE
 *  (duplicates each carry their own copy). That is what an export and
 *  0.3.33's import pay; localStorage no longer does — it stores a duplicated
 *  payload once per document (`imagePayloadRefs.ts`, `uniqueImageChars`). */
export function totalImageChars(nodes: AppNode[]): number {
  let total = 0;
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const url = getNodeValues(n).imageB64;
    if (typeof url === 'string') total += url.length;
  }
  return total;
}

/**
 * The saved-group library's OWN image budget. `fs:savedGroups` is a second
 * localStorage document that re-materialises every payload it holds on each
 * write and shares the origin quota with `fs:graph`, so it is counted against
 * its own total rather than against the project's (a group is a subset of a
 * project already under budget, so checking the group alone would be vacuous).
 * Web 3M (the project's number); the desktop room raises it to 32M
 * (utils/platformCaps.ts).
 */
export const MAX_LIBRARY_IMAGE_CHARS = PLATFORM_CAPS.libraryImageChars;

/**
 * The value key a STORED Image node carries when its payload is written once
 * per localStorage document and this node only points at it
 * (`utils/imagePayloadRefs.ts`). It lives here rather than there so
 * imagePayloadRefs can import this module without a cycle. It never reaches
 * the store: every restore path resolves it, and `sanitizeImageNodes` strips
 * a stray one.
 */
export const IMAGE_REF_KEY = 'imageRef';

/**
 * Rollback lever for the storage de-duplication. `true` (the default) writes
 * a duplicated payload once per `fs:graph` / `fs:savedGroups` document. `false`
 * writes every copy inline again, exactly as 0.3.33 did; the readers keep
 * resolving refs either way, so flipping it never strands a stored image. It
 * also puts the LIBRARY budget back on per-instance counting, since the
 * library then pays for every copy again.
 */
export const WRITE_IMAGE_REFS: boolean = true;

/** How an image budget counts payloads: every instance, or each distinct
 *  payload once. */
export type ImageBudgetCount = 'instances' | 'unique';

/**
 * The PROJECT budget (drop, paste, Ctrl+D, the menu's Duplicate Node,
 * saved-group instantiate, Revert, Resolution) counts INSTANCES — the
 * COMPATIBILITY default. Every export still carries one copy PER NODE (the
 * inlined module and the project block), and 0.3.33's `applyProjectToStore`
 * enforces `MAX_TOTAL_IMAGE_CHARS` per INSTANCE on import, so counting
 * duplicates as free would export files 0.3.33 opens with the later
 * duplicates stripped. Flip only by owner decision.
 */
export const PROJECT_IMAGE_BUDGET_COUNT: ImageBudgetCount = 'instances';

/**
 * The LIBRARY budget (saveGroupToLibrary) counts each DISTINCT payload once:
 * `fs:savedGroups` stores each payload once (`imagePayloadRefs.ts`) and never
 * leaves this browser, and 0.3.33 reads it with hard caps only. Falls back to
 * instances while `WRITE_IMAGE_REFS` is off, because the library then writes
 * every copy.
 */
export const LIBRARY_IMAGE_BUDGET_COUNT: ImageBudgetCount = WRITE_IMAGE_REFS ? 'unique' : 'instances';

/** Every Image node's non-empty payload string, in document order, one entry
 *  per INSTANCE (a duplicated payload repeats). */
export function imagePayloadsOf(nodes: AppNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const url = getNodeValues(n).imageB64;
    if (typeof url === 'string' && url.length > 0) out.push(url);
  }
  return out;
}

function sumLengths(payloads: Iterable<string>): number {
  let total = 0;
  for (const p of payloads) total += p.length;
  return total;
}

/** Sum of payload chars over DISTINCT payloads — what `fs:graph` and
 *  `fs:savedGroups` now write, each payload once per document. */
export function uniqueImageChars(nodes: AppNode[]): number {
  return sumLengths(new Set(imagePayloadsOf(nodes)));
}

/**
 * The image total `nodes` would have if node `nodeId`'s payload were
 * `nextUrl` — the Revert and Resolution checks, which REPLACE a payload
 * rather than add one. An empty `nextUrl` drops that node's payload; a node
 * id that is not in `nodes` replaces nothing. It reads the node's payload off
 * `nodes` itself, so the caller passes LIVE state.
 */
export function imageCharsReplacing(
  nodes: AppNode[],
  nodeId: string,
  nextUrl: string,
  count: ImageBudgetCount = PROJECT_IMAGE_BUDGET_COUNT,
): number {
  const payloads: string[] = [];
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const url = n.id === nodeId ? nextUrl : getNodeValues(n).imageB64;
    if (typeof url === 'string' && url.length > 0) payloads.push(url);
  }
  return count === 'unique' ? sumLengths(new Set(payloads)) : sumLengths(payloads);
}

/**
 * Whether adding these payload strings to `existing` would cross an image
 * budget. `exceedsImageBudget` is this over the payloads of a node list; the
 * drop path asks it directly, since it holds an encode rather than a node.
 *
 * Never true under `ignoreLimits`, and never true when the addition carries no
 * NEW payload (empty strings are ignored; under `'unique'` a payload the
 * existing nodes already hold is free). `'instances'` is exactly the
 * arithmetic this rule has always used: `totalImageChars(existing)` plus the
 * sum of the added lengths.
 */
export function exceedsImageBudgetAdding(
  existing: AppNode[],
  payloads: readonly string[],
  ignoreLimits: boolean,
  cap: number = MAX_TOTAL_IMAGE_CHARS,
  count: ImageBudgetCount = PROJECT_IMAGE_BUDGET_COUNT,
): boolean {
  if (ignoreLimits) return false;
  const adding = payloads.filter((p) => typeof p === 'string' && p.length > 0);
  if (count === 'instances') {
    const a = sumLengths(adding);
    if (a === 0) return false;
    return totalImageChars(existing) + a > cap;
  }
  const have = new Set(imagePayloadsOf(existing));
  const fresh = new Set<string>();
  for (const p of adding) if (!have.has(p)) fresh.add(p);
  const a = sumLengths(fresh);
  if (a === 0) return false;
  return sumLengths(have) + a > cap;
}

/**
 * Whether adding `added` to `existing` would cross an image budget — the ONE
 * rule every path that ADDS a payload asks (drop, paste, Ctrl+D, the menu's
 * Duplicate Node, saved-group instantiate; saved-group save against
 * `MAX_LIBRARY_IMAGE_CHARS`).
 *
 * Never true under `ignoreLimits`, and never true when `added` carries no
 * image payload: a paste or group without images is not refused even in a
 * project that is already over budget (placed or imported under ignore-limits,
 * then the checkbox cleared). Counted per `count` — the project per instance
 * (`PROJECT_IMAGE_BUDGET_COUNT`), the library per distinct payload
 * (`LIBRARY_IMAGE_BUDGET_COUNT`); an addition carrying no NEW payload is never
 * refused.
 */
export function exceedsImageBudget(
  existing: AppNode[],
  added: AppNode[],
  ignoreLimits: boolean,
  cap: number = MAX_TOTAL_IMAGE_CHARS,
  count: ImageBudgetCount = PROJECT_IMAGE_BUDGET_COUNT,
): boolean {
  return exceedsImageBudgetAdding(existing, imagePayloadsOf(added), ignoreLimits, cap, count);
}

/**
 * Who a budget notice for `nodes` is about: how many of them carry an image
 * payload, and — only when exactly one does — its display file name (the
 * STORED extension, `displayImageFileName`). Several images name no file; the
 * notice then says "these images".
 */
export function imageNodesForNotice(nodes: AppNode[]): { count: number; fileName: string } {
  const images = nodes.filter((n) => {
    if (n.data?.registryType !== 'imageNode') return false;
    const url = getNodeValues(n).imageB64;
    return typeof url === 'string' && url.length > 0;
  });
  if (images.length !== 1) return { count: images.length, fileName: '' };
  const v = getNodeValues(images[0]);
  return { count: 1, fileName: displayImageFileName(v.fileName, v.imageB64) };
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
 *
 * The running total is 0.3.33's per-instance total, plus one rule on top: a
 * repeat of a payload that is already kept is free. `runningTotal` therefore
 * evolves exactly as it did in 0.3.33, so every instance 0.3.33 keeps is kept
 * here too, and the extra keeps are only repeats (the distinct kept total stays
 * within the cap). Counting DISTINCT payloads instead is NOT a superset: kept
 * duplicates leave room for later distinct payloads 0.3.33 strips, which can
 * then fill the total and strip a small late image 0.3.33 keeps. A stray
 * `imageRef` (IMAGE_REF_KEY) is removed: the restore
 * paths resolve refs before this runs, so one still standing is junk, and a
 * ref never survives into the store. Removing it is not counted as a strip.
 *
 * `caps` defaults to THIS build's soft budgets (web 600K/3M, desktop 6M/32M —
 * utils/platformCaps.ts), so every two-argument caller follows the platform;
 * a test passes the other table's numbers explicitly. The hard ceiling is the
 * same on both builds and is not a parameter.
 */
export function sanitizeImageNodes(
  nodes: AppNode[],
  enforceSoft: boolean,
  caps: { image: number; total: number } = { image: MAX_IMAGE_ENCODED_CHARS, total: MAX_TOTAL_IMAGE_CHARS },
): ImageSanitizeResult {
  let strippedCount = 0;
  let runningTotal = 0;
  let changed = false;
  const kept = new Set<string>();
  const out = nodes.map((n) => {
    if (n.data?.registryType !== 'imageNode') return n;
    const values = getNodeValues(n);

    // Provenance keys ride imported JSON like everything else. `originId`
    // becomes an IndexedDB key and the src dims feed a CSS aspect-ratio, so
    // both are whitelisted here rather than at every read site; a malformed
    // one is dropped (the node keeps working, it just can't be reverted).
    let base = sanitizeOriginKeys(values) ?? values;
    // The glTF mapping keys (utils/imageUvMapping.ts) are canonicalised here
    // on all three restore paths (loadGraph, applyProjectToStore,
    // loadSavedGroups): a malformed one is dropped as a resource bound.
    // Emission reads them strictly anyway, so this is not the security control.
    base = sanitizeUvMappingKeys(base) ?? base;
    // Plain property access, never `in` (see sanitizeOriginKeys).
    if ((base as Record<string, unknown>)[IMAGE_REF_KEY] !== undefined) {
      base = { ...base };
      delete base[IMAGE_REF_KEY];
    }
    if (base !== values) changed = true;

    const url = base.imageB64;
    let bad = false;
    if (typeof url === 'string' && url.length > 0) {
      bad = validImageDataUrl(url) === null;
      if (!bad && enforceSoft) {
        bad =
          url.length > caps.image ||
          runningTotal + url.length > caps.total;
      }
      if (!bad) runningTotal += url.length;
      if (bad && kept.has(url)) bad = false;
      if (!bad) kept.add(url);
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
