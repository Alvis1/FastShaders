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
 * `TextureSource` is a discriminated union on `kind`. 'project' is an Image
 * node that already holds the pixels — a pick is the string copy above.
 * 'model' (`utils/modelTextureSources.ts`, landed 2026-09-19) is a picture
 * still inside the loaded 3D model, and is NOT a value to copy: it is
 * materialised through the import pipeline on pick — decoded and re-encoded by
 * the drop path's own encoder, at the class its glTF SLOT demands, checked
 * against the project budget — and it is shown through a display URL distinct
 * from any payload, because until it is picked there is no payload. Every
 * consumer switches on `kind` with a `never` default, so a third kind fails
 * `tsc` in each of them until it is handled.
 */
import { getNodeValues, type AppNode } from '@/types';
import { validImageDataUrl, ORIGIN_ID_RE, MAX_IMAGE_DIM_FIELD } from './imageNode';
import type { ModelTextureSource } from './modelTextureSources';
import { valueStr } from './valueCoerce';

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
  /** The holder's row order — a glTF-sourced picture's first row is the TOP. */
  readonly orientation?: 'gltf';
  /** The Image nodes holding this payload, in document order. */
  readonly holderIds: readonly string[];
}

export type TextureSource = ProjectTextureSource | ModelTextureSource;
export type TextureSourceKind = TextureSource['kind'];

/**
 * A source's identity for de-duplication and for React keys.
 *
 * The two kinds are identified by different things and neither can stand in
 * for the other: a project source IS its payload string (two nodes holding
 * equal bytes are one entry), while a model source has no payload yet and is
 * its image index inside the loaded model. Prefixed so the two namespaces can
 * never collide in one Map.
 */
export function textureSourceKey(s: TextureSource): string {
  switch (s.kind) {
    case 'project':
      return `p:${s.dataUrl}`;
    case 'model':
      return `m:${s.image}`;
    default: {
      const unhandled: never = s;
      return String(unhandled);
    }
  }
}

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
export function projectTextureSources(nodes: readonly AppNode[]): ProjectTextureSource[] {
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
  const out: ProjectTextureSource[] = [];
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
      fileName: valueStr(v.fileName),
      ...(originId !== null ? { originId } : {}),
      ...(pair ?? {}),
      ...(v.orientation === 'gltf' ? { orientation: 'gltf' as const } : {}),
      holderIds: holders.map((n) => n.id),
    });
  }
  return out;
}

/**
 * Combine source lists, de-duplicated by {@link textureSourceKey}. The FIRST
 * list to name a key wins its record; for a PROJECT source the holders of
 * later duplicates are appended (distinct, in order), which is the only field
 * where a second sighting adds anything.
 *
 * Order matters at the call site: project sources come first, so a model
 * texture the import already turned into an Image node is offered as the node
 * that HOLDS it (one click, no re-encode) rather than as a picture to
 * materialise again.
 */
export function mergeTextureSources(...lists: ReadonlyArray<readonly TextureSource[]>): TextureSource[] {
  const first = new Map<string, TextureSource>();
  const holders = new Map<string, string[]>();
  for (const list of lists) {
    for (const s of list) {
      const key = textureSourceKey(s);
      const seen = first.get(key);
      if (!seen) {
        first.set(key, s);
        if (s.kind === 'project') holders.set(key, [...new Set(s.holderIds)]);
        continue;
      }
      if (s.kind !== 'project') continue;
      const ids = holders.get(key);
      if (!ids) continue;
      for (const id of s.holderIds) if (!ids.includes(id)) ids.push(id);
    }
  }
  return [...first.values()].map((s) =>
    s.kind === 'project' ? { ...s, holderIds: holders.get(textureSourceKey(s))! } : s,
  );
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
    parts.push(`${n.id}:${url.length}:${url.slice(-32)}:${valueStr(v.width)}x${valueStr(v.height)}:${valueStr(v.fileName).length}`);
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
  /** Row order is a fact about the BYTES, so it travels with them too. */
  readonly orientation?: 'gltf';
}

/**
 * `current` with its picture replaced by `p` — the ONE shape "a payload becomes
 * this node's image" takes, shared by a pick and by "From file…" so the two
 * cannot drift. Every other value is kept; the previous payload's provenance
 * is DELETED and only `p`'s own is written, so a stale `originId` can never
 * point Revert at the picture that was replaced. `orientation` is the same
 * kind of fact — a model texture's rows are top-first, a file drop's are not —
 * so a photo loaded after a model pick is never uploaded flipped. The colour
 * space is NOT: it follows the wiring (a normal map switches on connect) and
 * is the user's setting to keep.
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
  delete next.orientation;
  if (p.orientation === 'gltf') next.orientation = 'gltf';
  if (p.originId) next.originId = p.originId;
  if (p.srcWidth && p.srcHeight) {
    next.srcWidth = p.srcWidth;
    next.srcHeight = p.srcHeight;
  }
  return next;
}

/**
 * The values a pick of `src` gives the node, or null when the node already
 * holds exactly that payload (nothing to write, no undo entry).
 *
 * PROJECT sources only, and the type says so: a 'model' source has no payload
 * to copy — it has to be encoded first, and the fields that come back from the
 * encoder go through {@link withImagePayload} at that call site
 * (ImageNodeSettings' `materialiseModelTexture`). Widening this to the union
 * would make the one path that CANNOT be synchronous look like it is.
 */
export function pickTextureValues(
  current: Readonly<Record<string, string | number>>,
  src: ProjectTextureSource,
): Record<string, string | number> | null {
  if (current.imageB64 === src.dataUrl) return null;
  return withImagePayload(current, src);
}
