/**
 * THE TEXTURE-STRIPPING WRITER — the preview copy of a model after "build a
 * shader from the model's materials".
 *
 * WHY IT EXISTS. A build extracts a model's textures into project images (the
 * Image nodes of the built sections). The model that then becomes the PREVIEW
 * MESH does not need those textures any more: the built materials replace them
 * wherever an index section applies. Keeping them would carry every texture
 * twice (in the project and in the mesh), in the IndexedDB cache and in every
 * zip export, and would keep a large scan over the 64 MiB model gate. So the
 * copy that becomes the preview mesh has the BUILT materials' textures removed.
 *
 * WHAT IT DOES, and the rule behind each step:
 *   - It deletes every textureInfo of the BUILT materials only (the five core
 *     slots, plus any `*Texture` object inside the material's extensions). A
 *     material that was not built keeps its textures, which is what the import
 *     dialog promises for materials over the limit.
 *   - Liveness is recomputed by a CONSERVATIVE walk over the whole document:
 *     any `texture` / `*Texture` object with a valid `index` keeps that texture
 *     alive, even inside an extension nothing here knows. Keeping too much only
 *     costs bytes; dropping a live texture would break the model.
 *   - Nothing is ever RENUMBERED. A dead texture becomes `{ source: P }` (P a
 *     dead image), a dead image becomes the 1×1 placeholder PNG `data:` URI, and
 *     a dead bufferView becomes a one-byte view at offset 0, so every index in
 *     the file, in any extension or in extras, still resolves.
 *   - Image-only bufferViews are reclaimed by 4-byte-aligned HOLE PUNCHING: each
 *     live byte range keeps its residue mod 4, so no accessor alignment moves.
 *     It is skipped (`'kept'` mode) whenever a buffer or bufferView carries an
 *     extension other than meshopt: an unknown extension may store raw byte
 *     offsets this file cannot see. meshopt's own offsets are shifted with the
 *     bytes they point at.
 *   - Texture-only extension names are pruned from `extensionsUsed` /
 *     `extensionsRequired` once nothing uses them (so a stripped KTX2-required
 *     model is no longer refused by the compression pre-check).
 *   - `extras.fastshaders` is removed from the root and every scene: the copy
 *     must never claim to carry a FastShaders module whose images were replaced
 *     (the key is loader 0.8's Phase 7 schema, engine/glbShaderContract.ts).
 *   - The FastShaders PAYLOAD views — the module and project bufferViews a
 *     single-GLB export carries (`fsPayloadViews`) — join the dead-view
 *     candidates, after the same live-site subtraction as an image view (a
 *     view the file ALSO reads as real data is never reclaimed). 'compacted'
 *     mode reclaims their bytes; 'kept' mode ZEROES them in place. So the
 *     stripped copy never carries a module, a project block or their bytes,
 *     and a FastShaders GLB with nothing else to strip still yields a plan
 *     (with `materials: []`) whose whole effect is to drop that payload.
 *     Every other unreferenced view (an EXT_structural_metadata table, …) is
 *     untouched by construction; the payload views are the one exception.
 *
 * WHAT IT NEVER DOES. Decode a picture, read accessor data as numbers, build
 * geometry, resolve or fetch a URI (a dead external-uri image is simply
 * replaced, which also removes a phone-home URL), or touch the store.
 *
 * ITS INPUT is a `GltfModelReport` (utils/gltfReader.ts), i.e. only a model the
 * reader accepted; `planTextureStrip` mutates nothing and returns a pure value,
 * and `stripGltfTextures` re-derives everything from the report, so a plan
 * never has to be trusted beyond being checked. Nothing here throws for a model
 * the reader accepted; an internal invariant failure throws an Error, which the
 * caller treats as "unreadable".
 *
 * CONTRACT FOR THE BUILDER (Phase 5 Step 8): run `stripGltfTextures`, then
 * `createPreviewMesh(originalName, bytes)`, and that must SUCCEED (the unchanged
 * 64 MiB gate and the compression pre-check) BEFORE `applyProjectToStore`, so a
 * stripped copy that still does not fit leaves the project untouched.
 */

import { buildGlbContainer, encodeDataUri, PLACEHOLDER_PNG_DATA_URI } from './glbContainer';
import { readGltfModel, type GltfModelReport } from './gltfReader';
import { modelSignatureMatches } from '@/engine/materialPartsContract';
import { fsPayloadViews, hasFsExtras } from '@/engine/glbShaderContract';

/** Extensions that exist only to serve textures: pruned from the two lists once
 *  no remaining texture or textureInfo uses them. */
export const TEXTURE_ONLY_EXTENSIONS = [
  'EXT_texture_webp',
  'EXT_texture_avif',
  'KHR_texture_basisu',
  'KHR_texture_transform',
] as const;

/** The buffer / bufferView extensions whose raw offsets this writer understands
 *  (and shifts). Any other one switches compaction off. */
export const MESHOPT_EXTENSIONS = ['EXT_meshopt_compression', 'KHR_meshopt_compression'] as const;

/** How many values the planning walks may visit in total; over it, the plan is
 *  null (no strip) rather than slow. */
export const STRIP_WALK_BUDGET = 4_000_000;

/**
 * What `stripGltfTextures` will do, as plain numbers (the report is untouched).
 *   - `materials`: the built materials that really carried a texture, ascending;
 *   - `deadTextures` / `deadImages` / `deadViews`: what becomes a placeholder;
 *   - `mode`: `'compacted'` reclaims the dead views' bytes, `'kept'` does not;
 *   - `bytesBefore`: the input's length; `estimatedBytes`: the output's, to
 *     within a few hundred bytes for compact JSON (an upper bound in general —
 *     a pretty-printed input shrinks further when it is re-serialised).
 */
export interface StripPlan {
  materials: number[];
  deadTextures: number[];
  deadImages: number[];
  deadViews: number[];
  mode: 'compacted' | 'kept';
  bytesBefore: number;
  estimatedBytes: number;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const isIndex = (v: unknown, length: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < length;

function own(o: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

function hasOwn(o: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** A top-level array of the document ([] when absent; the reader has already
 *  checked that a present one holds plain objects). */
function list(doc: Obj, key: string): Obj[] {
  const v = own(doc, key);
  return Array.isArray(v) ? (v as Obj[]) : [];
}

const MESHOPT: ReadonlySet<string> = new Set(MESHOPT_EXTENSIONS);
const TEXTURE_ONLY: readonly string[] = TEXTURE_ONLY_EXTENSIONS;

/** The top-level arrays the liveness walk skips: they hold the things being
 *  decided about, and accessors can be a million entries. */
const WALK_SKIP: ReadonlySet<string> = new Set(['textures', 'images', 'samplers', 'buffers', 'bufferViews', 'accessors']);

const CORE_PBR_SLOTS = ['baseColorTexture', 'metallicRoughnessTexture'] as const;
const CORE_TOP_SLOTS = ['normalTexture', 'occlusionTexture', 'emissiveTexture'] as const;
/** How deep the built-material deletion looks inside a material's extensions. */
const EXT_DELETE_DEPTH = 6;

class OverBudget {}

interface Budget {
  left: number;
}

function spend(b: Budget): void {
  if (--b.left < 0) throw new OverBudget();
}

const ceil4 = (n: number) => Math.ceil(n / 4) * 4;
const floor4 = (n: number) => Math.floor(n / 4) * 4;

interface Range {
  start: number;
  end: number;
}

/** Sorted, merged copy of `ranges` (touching ranges merge). */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** `[start, end)` minus the merged, sorted `cut` ranges. */
function subtract(start: number, end: number, cut: Range[]): Range[] {
  const out: Range[] = [];
  let at = start;
  for (const c of cut) {
    if (c.end <= at) continue;
    if (c.start >= end) break;
    if (c.start > at) out.push({ start: at, end: c.start });
    at = Math.max(at, c.end);
    if (at >= end) break;
  }
  if (at < end) out.push({ start: at, end });
  return out;
}

/* ── the analysis (steps 1–7 of the plan), shared by plan and strip ──────── */

interface ViewDef {
  buffer: number;
  offset: number;
  length: number;
  /** The meshopt extension objects on the view (their own buffer/range). */
  meshopt: Obj[];
}

interface Analysis {
  /** The CLONE, with the built materials' textureInfos already deleted. */
  doc: Obj;
  materials: number[];
  deadTextures: number[];
  deadImages: number[];
  deadViews: number[];
  mode: 'compacted' | 'kept';
  /** Texture-only extension names something still uses. */
  stillUsed: Set<string>;
  views: ViewDef[];
  /** Per data buffer: the byte ranges compaction removes (sorted, merged). */
  removals: Map<number, Range[]>;
  /** The original dead image objects (for the size estimate). */
  deadImageDefs: Obj[];
  /** The FastShaders payload views (module, project) among `deadViews`. */
  payloadViews: number[];
  /** JSON characters the dropped `extras.fastshaders` objects took (for the size estimate). */
  fsExtrasChars: number;
}

/** `extras.fastshaders` off an object (the root, a scene); returns the JSON
 *  characters it took (key, colon and a separator included), 0 when absent. */
function dropFastShadersExtras(o: Obj): number {
  const extras = own(o, 'extras');
  if (!isObj(extras) || !hasOwn(extras, 'fastshaders')) return 0;
  let chars = '"fastshaders":,'.length;
  try {
    chars += JSON.stringify(extras.fastshaders)?.length ?? 0;
  } catch {
    /* an unserialisable value: the estimate simply skips it */
  }
  delete extras.fastshaders;
  return chars;
}

/** Delete one built material's textureInfos from the clone; how many went. */
function deleteMaterialTextures(mat: Obj, budget: Budget): number {
  let removed = 0;
  const pbr = own(mat, 'pbrMetallicRoughness');
  if (isObj(pbr)) {
    for (const k of CORE_PBR_SLOTS) {
      if (hasOwn(pbr, k)) {
        delete pbr[k];
        removed++;
      }
    }
  }
  for (const k of CORE_TOP_SLOTS) {
    if (hasOwn(mat, k)) {
      delete mat[k];
      removed++;
    }
  }
  const exts = own(mat, 'extensions');
  if (!isObj(exts)) return removed;
  // Every `*Texture` object with a safe-integer `index`, at most
  // EXT_DELETE_DEPTH deep (the extension object itself is depth 1).
  const stack: { o: unknown; depth: number }[] = [{ o: exts, depth: 0 }];
  while (stack.length > 0) {
    const { o, depth } = stack.pop()!;
    if (Array.isArray(o)) {
      for (const v of o) {
        spend(budget);
        if (depth < EXT_DELETE_DEPTH && typeof v === 'object' && v !== null) stack.push({ o: v, depth: depth + 1 });
      }
      continue;
    }
    if (!isObj(o)) continue;
    for (const key of Object.keys(o)) {
      spend(budget);
      const v = o[key];
      if (key.endsWith('Texture') && isObj(v) && typeof v.index === 'number' && Number.isSafeInteger(v.index)) {
        delete o[key];
        removed++;
      } else if (depth < EXT_DELETE_DEPTH && typeof v === 'object' && v !== null) {
        stack.push({ o: v, depth: depth + 1 });
      }
    }
  }
  return removed;
}

function readViews(doc: Obj): ViewDef[] {
  return list(doc, 'bufferViews').map((v) => {
    const exts = own(v, 'extensions');
    const meshopt: Obj[] = [];
    if (isObj(exts)) {
      for (const name of MESHOPT_EXTENSIONS) {
        const e = own(exts, name);
        if (isObj(e)) meshopt.push(e);
      }
    }
    return {
      buffer: v.buffer as number,
      offset: typeof v.byteOffset === 'number' ? v.byteOffset : 0,
      length: v.byteLength as number,
      meshopt,
    };
  });
}

function extOffset(e: Obj): number {
  return typeof e.byteOffset === 'number' ? e.byteOffset : 0;
}

/** Any `extensions` on a buffer or bufferView other than meshopt (or one that
 *  is not even an object) means compaction is off. */
function carriesForeignExtension(o: Obj): boolean {
  if (!hasOwn(o, 'extensions')) return false;
  const exts = o.extensions;
  if (!isObj(exts)) return true;
  return Object.keys(exts).some((k) => !MESHOPT.has(k));
}

function analyse(m: GltfModelReport, requested: Iterable<number>): Analysis | null {
  const doc = structuredClone(m.source.doc) as Obj;
  // The FastShaders payload (Phase 7): its view pointers are read, and then
  // `extras.fastshaders` is REMOVED from the clone before the liveness walk —
  // the pointers are the one `bufferView` reference that must not keep a view
  // alive, since reclaiming those views is the point, and the copy drops the
  // key anyway (the root and every scene; other extras keys survive).
  const fsPresent = hasFsExtras(doc);
  const fsViews = fsPayloadViews(doc);
  let fsExtrasChars = dropFastShadersExtras(doc);
  for (const s of list(doc, 'scenes')) fsExtrasChars += dropFastShadersExtras(s);
  const budget: Budget = { left: STRIP_WALK_BUDGET };
  const materialsDef = list(doc, 'materials');
  const texturesDef = list(doc, 'textures');
  const imagesDef = list(doc, 'images');
  const buffersDef = list(doc, 'buffers');
  const views = readViews(doc);

  // 1–2. The valid requested materials that really carry a textureInfo.
  const wanted = new Set<number>();
  for (const i of requested) if (isIndex(i, materialsDef.length)) wanted.add(i);
  const materials: number[] = [];
  for (const i of [...wanted].sort((a, b) => a - b)) {
    if (deleteMaterialTextures(materialsDef[i], budget) > 0) materials.push(i);
  }
  // Nothing to strip — unless the file carries a FastShaders payload, which a
  // preview copy must drop whatever else is in it (a plan with no materials).
  if (materials.length === 0 && !fsPresent) return null;

  // 3. Live textures (and every remaining textureInfo's extension names, and
  //    every `bufferView` reference outside the arrays being decided about).
  const liveTex = new Uint8Array(texturesDef.length);
  const liveView = new Uint8Array(views.length);
  const stillUsed = new Set<string>();
  const stack: unknown[] = [];
  for (const key of Object.keys(doc)) {
    spend(budget);
    if (!WALK_SKIP.has(key)) stack.push(doc[key]);
  }
  while (stack.length > 0) {
    const o = stack.pop();
    if (Array.isArray(o)) {
      for (const v of o) {
        spend(budget);
        if (typeof v === 'object' && v !== null) stack.push(v);
      }
      continue;
    }
    if (!isObj(o)) continue;
    for (const key of Object.keys(o)) {
      spend(budget);
      const v = o[key];
      if ((key === 'texture' || key.endsWith('Texture')) && isObj(v) && isIndex(v.index, texturesDef.length)) {
        liveTex[v.index] = 1;
        const exts = own(v, 'extensions');
        if (isObj(exts)) for (const name of Object.keys(exts)) if (TEXTURE_ONLY.includes(name)) stillUsed.add(name);
      } else if (key === 'bufferView' && isIndex(v, views.length)) {
        liveView[v] = 1;
      }
      if (typeof v === 'object' && v !== null) stack.push(v);
    }
  }

  // 4. Live images: every source of a live texture, core and extension.
  const liveImg = new Uint8Array(imagesDef.length);
  for (let t = 0; t < texturesDef.length; t++) {
    if (!liveTex[t]) continue;
    const tex = texturesDef[t];
    spend(budget);
    if (isIndex(tex.source, imagesDef.length)) liveImg[tex.source] = 1;
    const exts = own(tex, 'extensions');
    if (!isObj(exts)) continue;
    for (const name of Object.keys(exts)) {
      spend(budget);
      if (TEXTURE_ONLY.includes(name)) stillUsed.add(name);
      const e = exts[name];
      if (isObj(e) && isIndex(e.source, imagesDef.length)) liveImg[e.source] = 1;
    }
  }

  // 5. The dead.
  const deadTextures: number[] = [];
  for (let t = 0; t < texturesDef.length; t++) if (!liveTex[t]) deadTextures.push(t);
  const deadImages: number[] = [];
  for (let i = 0; i < imagesDef.length; i++) if (!liveImg[i]) deadImages.push(i);

  // 6. Dead views: views behind a dead image that nothing live reads. Only a
  //    PLAIN view on a buffer that has bytes can die (a meshopt-compressed view
  //    or one on a fallback buffer is left alone), so a dead view can always
  //    be rewritten as a one-byte view on its own buffer.
  for (const a of list(doc, 'accessors')) {
    spend(budget);
    if (isIndex(a.bufferView, views.length)) liveView[a.bufferView] = 1;
    const sparse = own(a, 'sparse');
    if (isObj(sparse)) {
      for (const part of ['indices', 'values']) {
        const p = own(sparse, part);
        if (isObj(p) && isIndex(p.bufferView, views.length)) liveView[p.bufferView] = 1;
      }
    }
  }
  for (let i = 0; i < imagesDef.length; i++) {
    if (liveImg[i] && isIndex(imagesDef[i].bufferView, views.length)) liveView[imagesDef[i].bufferView as number] = 1;
  }
  const candidate = new Set<number>();
  for (const i of deadImages) {
    const v = imagesDef[i].bufferView;
    if (isIndex(v, views.length)) candidate.add(v);
  }
  // The FastShaders payload views (module, project): same subtraction below.
  for (const v of fsViews) candidate.add(v);
  const deadViews = [...candidate]
    .filter((v) => {
      if (liveView[v]) return false;
      const vd = views[v];
      return m.source.buffers[vd.buffer] instanceof Uint8Array && !hasOwn(list(doc, 'bufferViews')[v], 'extensions');
    })
    .sort((a, b) => a - b);

  // 7. Mode.
  const foreign = buffersDef.some(carriesForeignExtension) || list(doc, 'bufferViews').some(carriesForeignExtension);
  const mode = foreign ? 'kept' : 'compacted';

  // The removals compaction would make (computed, never copied).
  const removals = new Map<number, Range[]>();
  if (mode === 'compacted' && deadViews.length > 0) {
    const dead = new Set(deadViews);
    for (let b = 0; b < m.source.buffers.length; b++) {
      if (!(m.source.buffers[b] instanceof Uint8Array)) continue;
      const deadRanges = deadViews
        .filter((v) => views[v].buffer === b)
        .map((v) => ({ start: views[v].offset, end: views[v].offset + views[v].length }));
      if (deadRanges.length === 0) continue;
      const live: Range[] = [];
      views.forEach((vd, v) => {
        if (dead.has(v)) return;
        if (vd.buffer === b) live.push({ start: vd.offset, end: vd.offset + vd.length });
        for (const e of vd.meshopt) {
          if (e.buffer === b) live.push({ start: extOffset(e), end: extOffset(e) + (e.byteLength as number) });
        }
      });
      const liveMerged = mergeRanges(live);
      const pieces: Range[] = [];
      for (const r of deadRanges) {
        const start = ceil4(r.start);
        const end = floor4(r.end);
        if (start >= end) continue;
        for (const p of subtract(start, end, liveMerged)) {
          const ps = ceil4(p.start);
          const pe = floor4(p.end);
          if (ps < pe) pieces.push({ start: ps, end: pe });
        }
      }
      const merged = mergeRanges(pieces);
      if (merged.length > 0) removals.set(b, merged);
    }
  }

  return {
    doc,
    materials,
    deadTextures,
    deadImages,
    deadViews,
    mode,
    stillUsed,
    views,
    removals,
    deadImageDefs: deadImages.map((i) => imagesDef[i]),
    payloadViews: deadViews.filter((v) => fsViews.includes(v)),
    fsExtrasChars,
  };
}

const removedTotal = (ranges: Range[] | undefined) => (ranges ?? []).reduce((n, r) => n + (r.end - r.start), 0);
const base64Length = (n: number) => 4 * Math.ceil(n / 3);

/* ── the plan ────────────────────────────────────────────────────────────── */

/**
 * Plan stripping the textures of the BUILT `materials` (glTF material
 * indices; invalid ones are ignored). Null when none of them carries a
 * texture, or when the planning walks would exceed STRIP_WALK_BUDGET — either
 * way the caller keeps the model as it is. Mutates nothing.
 */
export function planTextureStrip(m: GltfModelReport, materials: Iterable<number>): StripPlan | null {
  let a: Analysis | null;
  try {
    a = analyse(m, materials);
  } catch (e) {
    if (e instanceof OverBudget) return null;
    throw e;
  }
  if (!a) return null;
  // The output's size without writing it: the removed bytes (a `data:` buffer
  // shrinks by their base64 length), each dead image's JSON growing to at most
  // the placeholder's (~124 characters) and dropping any data URI it held, and
  // a little slack for the container padding.
  let estimated = m.byteLength + 16 - a.fsExtrasChars;
  for (const [b, ranges] of a.removals) {
    const removed = removedTotal(ranges);
    const data = m.source.buffers[b] as Uint8Array;
    const isBin = m.kind === 'glb' && data === m.source.bin;
    estimated -= isBin ? removed : base64Length(data.length) - base64Length(data.length - removed);
  }
  for (const img of a.deadImageDefs) {
    const uri = own(img, 'uri');
    estimated += 128 - (typeof uri === 'string' ? uri.length : 0);
  }
  return {
    materials: a.materials,
    deadTextures: a.deadTextures,
    deadImages: a.deadImages,
    deadViews: a.deadViews,
    mode: a.mode,
    bytesBefore: m.byteLength,
    estimatedBytes: Math.max(0, estimated),
  };
}

/* ── the writer ──────────────────────────────────────────────────────────── */

const sameList = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** `o` shifted left by every removed range that ends at or before it. */
function shiftFor(ranges: Range[]): (o: number) => number {
  const ends = ranges.map((r) => r.end);
  const before: number[] = [];
  let sum = 0;
  for (const r of ranges) {
    sum += r.end - r.start;
    before.push(sum);
  }
  return (o) => {
    // The last range with end <= o (binary search on the sorted ends).
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] <= o) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? o : o - before[lo - 1];
  };
}

/** The bytes of `data` outside `ranges`. */
function compactBytes(data: Uint8Array, ranges: Range[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length - removedTotal(ranges));
  let at = 0;
  let from = 0;
  for (const r of ranges) {
    out.set(data.subarray(from, r.start), at);
    at += r.start - from;
    from = r.end;
  }
  out.set(data.subarray(from), at);
  return out;
}

/**
 * Write the stripped copy described by `plan` (from `planTextureStrip` on the
 * SAME report). The output keeps the input's container kind, re-reads with the
 * reader, and keeps the signature, the certain mesh names and every accessor's
 * bytes. Throws only on a plan that does not describe this report, or on an
 * internal invariant failure (asserted in development: the output must re-read
 * with the same signature).
 */
export function stripGltfTextures(
  m: GltfModelReport,
  plan: StripPlan,
): { kind: 'glb' | 'gltf'; bytes: Uint8Array<ArrayBuffer> } {
  let a: Analysis | null;
  try {
    a = analyse(m, plan.materials);
  } catch (e) {
    if (e instanceof OverBudget) throw new Error('gltfStrip: the plan does not describe this model');
    throw e;
  }
  if (
    !a ||
    !sameList(a.materials, plan.materials) ||
    !sameList(a.deadTextures, plan.deadTextures) ||
    !sameList(a.deadImages, plan.deadImages) ||
    !sameList(a.deadViews, plan.deadViews) ||
    a.mode !== plan.mode
  ) {
    throw new Error('gltfStrip: the plan does not describe this model');
  }
  const { doc } = a;
  const texturesDef = list(doc, 'textures');
  const imagesDef = list(doc, 'images');
  const viewsDef = list(doc, 'bufferViews');
  const buffersDef = list(doc, 'buffers');

  // 2. Dead textures → `{ source: P }`, P a dead image (every other key goes).
  //    With no dead image (a dead texture sharing a live one's image) the
  //    texture keeps its own valid core source, or no source at all.
  const placeholder = a.deadImages.length > 0 ? a.deadImages[0] : null;
  for (const t of a.deadTextures) {
    const own0 = texturesDef[t].source;
    texturesDef[t] =
      placeholder !== null ? { source: placeholder } : isIndex(own0, imagesDef.length) ? { source: own0 } : {};
  }

  // 3. Dead images → the placeholder `data:` URI (name and bufferView go too).
  for (const i of a.deadImages) imagesDef[i] = { uri: PLACEHOLDER_PNG_DATA_URI };

  // 4. Texture-only extension names nothing uses any more.
  for (const name of TEXTURE_ONLY_EXTENSIONS) {
    if (a.stillUsed.has(name)) continue;
    for (const key of ['extensionsUsed', 'extensionsRequired']) {
      const names = own(doc, key);
      if (!Array.isArray(names)) continue;
      const kept = names.filter((n) => n !== name);
      if (kept.length === names.length) continue;
      if (kept.length === 0) delete doc[key];
      else doc[key] = kept;
    }
  }

  // 5. `extras.fastshaders` is already gone from the root and every scene:
  //    `analyse` drops it from its clone before the liveness walk (the payload
  //    pointers must not keep their own views alive).
  const dead = new Set(a.deadViews);
  const payloadViews = a.payloadViews;

  // 6. Compaction ('compacted' mode only; 'kept' leaves buffers and views be —
  //    except the payload bytes, step 6b).
  let bin = m.source.bin;
  if (a.mode === 'compacted') {
    const shifts = new Map<number, (o: number) => number>();
    for (const [b, ranges] of a.removals) shifts.set(b, shiftFor(ranges));
    // Live views and meshopt ranges move with their bytes.
    a.views.forEach((vd, v) => {
      if (dead.has(v)) return;
      const shift = shifts.get(vd.buffer);
      if (shift) {
        const moved = shift(vd.offset);
        if (moved !== vd.offset) viewsDef[v].byteOffset = moved;
      }
      for (const e of vd.meshopt) {
        const eShift = shifts.get(e.buffer as number);
        if (!eShift) continue;
        const moved = eShift(extOffset(e));
        if (moved !== extOffset(e)) e.byteOffset = moved;
      }
    });
    // Dead views → one byte at offset 0 of their own buffer: in range,
    // unreferenced, and index-stable.
    for (const v of a.deadViews) viewsDef[v] = { buffer: a.views[v].buffer, byteOffset: 0, byteLength: 1 };
    // The buffers themselves.
    for (const [b, ranges] of a.removals) {
      const data = m.source.buffers[b] as Uint8Array;
      let out = compactBytes(data, ranges);
      if (out.length === 0) out = new Uint8Array(4);
      const def = buffersDef[b];
      const declared = def.byteLength;
      let byteLength = out.length;
      if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0) {
        let below = 0;
        for (const r of ranges) below += Math.max(0, Math.min(r.end, declared) - r.start);
        const kept = declared - below;
        if (kept >= 1 && kept <= out.length) byteLength = kept;
      }
      def.byteLength = byteLength;
      if (m.kind === 'glb' && b === 0 && data === m.source.bin) bin = out;
      else def.uri = encodeDataUri('application/octet-stream', out);
    }
  } else if (payloadViews.length > 0) {
    // 6b. 'kept' mode cannot move a byte (an extension this file cannot see
    //     into may hold raw offsets), so the module and project bytes are
    //     ZEROED where they lie: the view stays, its bytes carry nothing.
    const zeroed = new Map<number, Uint8Array<ArrayBuffer>>();
    for (const v of payloadViews) {
      const vd = a.views[v];
      const data = m.source.buffers[vd.buffer];
      if (!(data instanceof Uint8Array)) continue;
      let copy = zeroed.get(vd.buffer);
      if (!copy) {
        copy = new Uint8Array(data);
        zeroed.set(vd.buffer, copy);
      }
      copy.fill(0, Math.min(vd.offset, copy.length), Math.min(vd.offset + vd.length, copy.length));
    }
    for (const [b, copy] of zeroed) {
      const data = m.source.buffers[b] as Uint8Array;
      if (m.kind === 'glb' && b === 0 && data === m.source.bin) bin = copy;
      else buffersDef[b].uri = encodeDataUri('application/octet-stream', copy);
    }
  }

  // 7. Serialise: a well-formed stringify escapes lone surrogates, so names
  //    round-trip exactly.
  const json = JSON.stringify(doc);
  const bytes =
    m.kind === 'glb'
      ? buildGlbContainer(json, bin)
      : (new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>);

  // 8. The postcondition, checked in development (and so in every test run):
  //    the copy re-reads, and its signature is the input's.
  if (import.meta.env.DEV) {
    const again = readGltfModel(bytes, m.kind);
    if (!again.ok) throw new Error(`gltfStrip: the stripped copy does not re-read (${again.refusal.detail})`);
    if (!modelSignatureMatches(again.model.signature, m.signature)) {
      throw new Error('gltfStrip: the stripped copy changed the model signature');
    }
  }
  return { kind: m.kind, bytes };
}
