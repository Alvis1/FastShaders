/**
 * The texture picker's source list (menus/TexturePicker.tsx) and the value
 * swap a pick performs. Pure and node-tested.
 *
 * A pick is a COPY of a value, never a link: the chosen node gets the payload
 * string (and the provenance that travels with it), so resizing or reverting
 * either node later never touches the other — history and Phase 2's storage
 * have no notion of two nodes sharing one picture beyond an equal string, and
 * the texture planner already shares the module-scope objects of equal
 * strings (engine/imageTexturePlan.ts). The node's own sampling settings
 * (colour space, filter, flips, tile/offset, the future glTF mapping keys)
 * stay as they are: they describe how THIS node samples the picture.
 *
 * Provenance (`originId`, `srcWidth`/`srcHeight`) moves WITH the payload,
 * because the original cache behind Revert and the Resolution ladder is
 * content-keyed (imageOriginCache.ts): the record a payload's holder points at
 * reverts the picked copy just as well. It comes from ONE holder, never
 * assembled from several — a pair of dimensions from one node beside an id
 * from another would describe an original nobody has.
 *
 * `TextureSource` is a discriminated union on `kind` from day one. Today the
 * only kind is 'project' (an Image node already holds the pixels). Phase 5
 * adds 'model' (a GLB-embedded image), which is NOT a value to copy: it must
 * be materialised through the import pipeline, budget-checked like a drop and
 * shown through a display URL distinct from the payload. Every consumer
 * therefore switches on `kind` with a `never` default, so a new kind fails
 * `tsc` in each of them until it is handled.
 */
import { getNodeValues, type AppNode } from '@/types';
import { validImageDataUrl, ORIGIN_ID_RE, MAX_IMAGE_DIM_FIELD } from './imageNode';

/** An image an Image node in this project already holds. */
export interface ProjectTextureSource {
  readonly kind: 'project';
  /** `validImageDataUrl`-checked; the holder's own string, never re-encoded. */
  readonly dataUrl: string;
  /** Integers in 1..MAX_IMAGE_DIM_FIELD (decodeImageNode's own bound). */
  readonly width: number;
  readonly height: number;
  readonly fileName: string;
  readonly originId?: string;
  readonly srcWidth?: number;
  readonly srcHeight?: number;
  /** The Image nodes holding this payload, in document order. */
  readonly holderIds: readonly string[];
}

/** Phase 5 widens this union (`| ModelTextureSource`); see the header. */
export type TextureSource = ProjectTextureSource;
export type TextureSourceKind = TextureSource['kind'];

/** The grid shows at most this many cells; the rest are counted in a line
 *  under it. Up to 64 thumbnails of up to 600K-char data URLs decode when the
 *  grid opens — the strings are already in memory, decoding is the cost. */
export const MAX_LISTED_TEXTURE_SOURCES = 64;

/** A stored dimension the picker will carry: a REAL integer number in range.
 *  Stricter than `decodeImageNode` (which coerces with `Number()`) on purpose —
 *  a pick writes what it read, and the canonical writers only ever store
 *  numbers, so a string dimension is a hand-edited file and is not offered. */
function dimOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_IMAGE_DIM_FIELD ? v : null;
}

function originIdOf(v: unknown): string | null {
  return typeof v === 'string' && ORIGIN_ID_RE.test(v) ? v : null;
}

/**
 * Every DISTINCT valid payload held by an Image node, in document order.
 *
 * Grouped on the FULL payload string in a Map — never on a hash, which
 * collides (payloadDigest.ts). A node whose payload fails the whitelist, or
 * whose width/height are not integers in range, is skipped: it already renders
 * the inert fallback, and copying it would spread a picture nobody can see.
 *
 * Each group's record comes from ONE provenance holder: the first holder
 * carrying a valid `originId`; else the first carrying a valid
 * `srcWidth`/`srcHeight` pair; else the first holder. Dimensions, file name and
 * provenance all come from that same node.
 */
export function projectTextureSources(nodes: readonly AppNode[]): TextureSource[] {
  const groups = new Map<string, AppNode[]>();
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const v = getNodeValues(n);
    const url = validImageDataUrl(v.imageB64);
    if (!url || dimOf(v.width) === null || dimOf(v.height) === null) continue;
    const g = groups.get(url);
    if (g) g.push(n);
    else groups.set(url, [n]);
  }
  const out: TextureSource[] = [];
  for (const [dataUrl, holders] of groups) {
    const pairOf = (n: AppNode) => {
      const v = getNodeValues(n);
      const sw = dimOf(v.srcWidth);
      const sh = dimOf(v.srcHeight);
      return sw !== null && sh !== null ? { srcWidth: sw, srcHeight: sh } : null;
    };
    const holder =
      holders.find((n) => originIdOf(getNodeValues(n).originId) !== null) ??
      holders.find((n) => pairOf(n) !== null) ??
      holders[0];
    const v = getNodeValues(holder);
    const originId = originIdOf(v.originId);
    const pair = pairOf(holder);
    out.push({
      kind: 'project',
      dataUrl,
      width: dimOf(v.width)!,
      height: dimOf(v.height)!,
      fileName: String(v.fileName ?? ''),
      ...(originId !== null ? { originId } : {}),
      ...(pair ?? {}),
      holderIds: holders.map((n) => n.id),
    });
  }
  return out;
}

/**
 * Phase 5's extension point: combine source lists, de-duplicated by payload.
 * The FIRST list to name a payload wins its record; the holders of later
 * duplicates are appended (distinct, in order).
 */
export function mergeTextureSources(...lists: ReadonlyArray<readonly TextureSource[]>): TextureSource[] {
  const first = new Map<string, TextureSource>();
  const holders = new Map<string, string[]>();
  for (const list of lists) {
    for (const s of list) {
      const ids = holders.get(s.dataUrl);
      if (!ids) {
        first.set(s.dataUrl, s);
        holders.set(s.dataUrl, [...new Set(s.holderIds)]);
        continue;
      }
      for (const id of s.holderIds) if (!ids.includes(id)) ids.push(id);
    }
  }
  return [...first.values()].map((s) => ({ ...s, holderIds: holders.get(s.dataUrl)! }));
}

/**
 * A cheap subscription key for the open grid (the two-step selector: subscribe
 * to this string, rebuild the list from `getState()` only when it changes).
 * No hashing: per Image node its id, payload length and last 32 characters,
 * dimensions and file-name length. A position-only edit — every drag frame —
 * leaves it unchanged. It can in principle miss a change (two edits hitting
 * the same length and tail); the grid is then stale until the next change, and
 * a pick from it still writes a validated payload.
 */
export function textureSourcesKey(nodes: readonly AppNode[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.data?.registryType !== 'imageNode') continue;
    const v = getNodeValues(n);
    const url = typeof v.imageB64 === 'string' ? v.imageB64 : '';
    parts.push(`${n.id}:${url.length}:${url.slice(-32)}:${String(v.width)}x${String(v.height)}:${String(v.fileName ?? '').length}`);
  }
  return parts.join('|');
}

/** The payload fields that make a picture this node's image. */
export interface ImagePayloadFields {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly fileName: string;
  readonly originId?: string;
  readonly srcWidth?: number;
  readonly srcHeight?: number;
}

/**
 * `current` with its picture replaced by `p` — the ONE shape "a payload becomes
 * this node's image" takes, shared by a pick and by "From file…" so the two
 * cannot drift. Every other value is kept; the previous payload's provenance
 * is DELETED and only `p`'s own is written, so a stale `originId` can never
 * point Revert at the picture that was replaced.
 */
export function withImagePayload(
  current: Readonly<Record<string, string | number>>,
  p: ImagePayloadFields,
): Record<string, string | number> {
  const next: Record<string, string | number> = {
    ...current,
    imageB64: p.dataUrl,
    width: p.width,
    height: p.height,
    fileName: p.fileName,
  };
  delete next.originId;
  delete next.srcWidth;
  delete next.srcHeight;
  if (p.originId) next.originId = p.originId;
  if (p.srcWidth && p.srcHeight) {
    next.srcWidth = p.srcWidth;
    next.srcHeight = p.srcHeight;
  }
  return next;
}

/** The values a pick of `src` gives the node, or null when the node already
 *  holds exactly that payload (nothing to write, no undo entry). */
export function pickTextureValues(
  current: Readonly<Record<string, string | number>>,
  src: TextureSource,
): Record<string, string | number> | null {
  if (current.imageB64 === src.dataUrl) return null;
  return withImagePayload(current, src);
}
