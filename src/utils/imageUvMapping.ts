/**
 * The glTF MAPPING of an Image/Texture node: how its picture lands on the UVs
 * of the model it came with. Four settings over eight `values` keys:
 *
 *   - `orientation`  exactly `'gltf'`: the texture is uploaded unflipped
 *                    (`Texture.flipY = false`, GLTFLoader's own choice) and the
 *                    app's baked 1-u correction is dropped;
 *   - `normalGreen`  exactly `'flip'`: the Output's normal-map decode flips its
 *                    green axis, GLTFLoader's `normalScale.y *= -1` for a
 *                    primitive without TANGENT;
 *   - `uvSet`        exactly the NUMBER 1, 2 or 3: sample `uv(n)` (three's
 *                    `uv1`..`uv3`, i.e. glTF TEXCOORD_1..3) instead of `uv()`;
 *   - `xfOffsetX`, `xfOffsetY`, `xfRotation` (radians), `xfScaleX`,
 *     `xfScaleY`    KHR_texture_transform, finite numbers with |v| ≤ 1e6.
 *
 * `readImageUvMapping` is the ONE reader (codegen, the settings menu, tests),
 * and `withUvMapping` / `gltfTextureValues` are the ONLY writers — the GLB
 * importer (Phase 5) must go through `gltfTextureValues`. Every key comes out
 * of a `.fastshader` and is adversarial, so every read is EXACT: an absent,
 * junk or default-valued key means today's emission, byte for byte. Numbers
 * are read only as real numbers — `Number(true)` is 1, `Number(null)`,
 * `Number('')` and `Number([])` are 0, and a coerced 0 scale would collapse
 * the texture — and the writers only ever write the canonical form (numbers
 * as numbers, `'gltf'`/`'flip'` as the two strings), deleting a key whose
 * value is its default, so a node toggled on and back off is JSON-identical
 * to one never touched.
 *
 * Only the ORIENTATION is a property of the Texture OBJECT, so only it joins
 * `ImageTextureSpec` (`flipY: values.orientation !== 'gltf'`, inlined there so
 * that module stays a leaf; `imageUvMapping.test.ts` pins that the two agree).
 * The UV set, the transform and the green flip are UV or channel math and
 * never enter a texture key: two nodes differing only in them share one
 * texture.
 *
 * `gltfSamplerValues(sampler) → { values, unsupported }` (GLB Phase 5) sits
 * beside `gltfTextureValues` and writes the node's EXISTING texture keys
 * (`repeat`, `filter`), not mapping keys. A glTF sampler's separate
 * wrapS/wrapT and MIRRORED_REPEAT have no node setting, so it reports them as
 * `unsupported` rather than approximating them silently; the min-filter
 * variants are not reported, because the node's mip rule follows its colour
 * space.
 *
 * A LEAF: it imports nothing.
 */

export type ImageOrientation = 'app' | 'gltf';
export type ImageUvSet = 0 | 1 | 2 | 3;

export interface GltfUvTransform {
  readonly offsetX: number;
  readonly offsetY: number;
  /** Radians, counter-clockwise in the Khronos reference sense. */
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export interface ImageUvMapping {
  readonly orientation: ImageOrientation;
  readonly normalGreenFlip: boolean;
  readonly uvSet: ImageUvSet;
  /** Null = the identity transform (nothing to emit). */
  readonly transform: GltfUvTransform | null;
}

export const UV_MAPPING_KEYS = [
  'orientation',
  'normalGreen',
  'uvSet',
  'xfOffsetX',
  'xfOffsetY',
  'xfRotation',
  'xfScaleX',
  'xfScaleY',
] as const;

/** The largest |value| a transform key may hold. Anything past it (or not a
 *  finite number at all) reads as the key's default. */
export const MAX_UV_TRANSFORM_MAGNITUDE = 1e6;

/** Each transform key, the patch field it is written from, and its default. */
const XF_KEYS = [
  { key: 'xfOffsetX', field: 'offsetX', dflt: 0 },
  { key: 'xfOffsetY', field: 'offsetY', dflt: 0 },
  { key: 'xfRotation', field: 'rotation', dflt: 0 },
  { key: 'xfScaleX', field: 'scaleX', dflt: 1 },
  { key: 'xfScaleY', field: 'scaleY', dflt: 1 },
] as const;

/** A real, finite, bounded number — or the default. Never `Number()`. */
function fin(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_UV_TRANSFORM_MAGNITUDE ? v : dflt;
}

function isUvSet(v: unknown): v is 1 | 2 | 3 {
  return v === 1 || v === 2 || v === 3;
}

/** Plain property access, never `'k' in values`: `in` THROWS on a primitive,
 *  and these values come straight out of an untrusted file. */
function field(values: unknown, key: string): unknown {
  if (values === null || values === undefined) return undefined;
  return (values as Record<string, unknown>)[key];
}

export function readImageUvMapping(values: Readonly<Record<string, unknown>>): ImageUvMapping {
  const orientation: ImageOrientation = field(values, 'orientation') === 'gltf' ? 'gltf' : 'app';
  const normalGreenFlip = field(values, 'normalGreen') === 'flip';
  const u = field(values, 'uvSet');
  const uvSet: ImageUvSet = isUvSet(u) ? u : 0;
  const t = {
    offsetX: fin(field(values, 'xfOffsetX'), 0),
    offsetY: fin(field(values, 'xfOffsetY'), 0),
    rotation: fin(field(values, 'xfRotation'), 0),
    scaleX: fin(field(values, 'xfScaleX'), 1),
    scaleY: fin(field(values, 'xfScaleY'), 1),
  };
  const identity = t.offsetX === 0 && t.offsetY === 0 && t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1;
  return { orientation, normalGreenFlip, uvSet, transform: identity ? null : t };
}

/** Clean up float dust so a quarter turn emits `0`/`1`/`-1`, and never −0. */
function snap(x: number): number {
  if (Math.abs(x) < 1e-12) return 0;
  const r = Math.round(x);
  if (Math.abs(x - r) < 1e-12) return r === 0 ? 0 : r;
  return x === 0 ? 0 : x;
}

/**
 * The transform as ROWS: `u' = m00·u + m01·v + tx`, `v' = m10·u + m11·v + ty`.
 *
 * The order is the Khronos REFERENCE renderer's (glTF-Sample-Viewer): scale,
 * then rotation about the UV origin, then offset — `T · R · S` with the
 * rotation `[c, -s, 0, s, c, 0, 0, 0, 1]` read column-major, i.e. rows
 * (c, s), (−s, c). The rotation is taken mod 2π first, so a full turn is
 * exactly the identity again.
 *
 * NB three's GLTFLoader goes through `Matrix3.setUvTransform`, which SCALES
 * AFTER rotating (`S · R`), so it differs from this whenever the scale is
 * non-uniform AND the rotation is non-zero. The reference renderer is the
 * authority; a parity check against GLTFLoader needs uniform-scale fixtures.
 */
export function gltfUvMatrix(t: GltfUvTransform): {
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  tx: number;
  ty: number;
} {
  const r = t.rotation % (2 * Math.PI);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    m00: snap(c * t.scaleX),
    m01: snap(s * t.scaleY),
    m10: snap(-s * t.scaleX),
    m11: snap(c * t.scaleY),
    tx: snap(t.offsetX),
    ty: snap(t.offsetY),
  };
}

/**
 * Drop every mapping key that does not hold its exact shape. Null when
 * nothing was dropped, so an untouched graph keeps its identity (the store
 * compares by reference to decide whether to re-sync). Run on all three
 * restore paths through `sanitizeImageNodes`; emission reads strictly anyway,
 * so this is canonicalisation and a resource bound, not the security control.
 */
export function sanitizeUvMappingKeys(
  values: Record<string, string | number>,
): Record<string, string | number> | null {
  const drop: string[] = [];
  const has = (k: string): boolean => field(values, k) !== undefined;
  if (has('orientation') && field(values, 'orientation') !== 'gltf') drop.push('orientation');
  if (has('normalGreen') && field(values, 'normalGreen') !== 'flip') drop.push('normalGreen');
  if (has('uvSet') && !isUvSet(field(values, 'uvSet'))) drop.push('uvSet');
  for (const { key } of XF_KEYS) {
    // NaN as the default can never equal a real read, so this is "does it
    // pass `fin`" without a second copy of the rule.
    if (has(key) && Number.isNaN(fin(field(values, key), NaN))) drop.push(key);
  }
  if (drop.length === 0) return null;
  const next = { ...values };
  for (const k of drop) delete next[k];
  return next;
}

export interface UvMappingPatch {
  orientation?: ImageOrientation;
  normalGreenFlip?: boolean;
  uvSet?: ImageUvSet;
  offsetX?: number;
  offsetY?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}

/**
 * A NEW values object with `patch` applied in canonical form. A patched field
 * at its default DELETES its key; a non-finite number reads as the default
 * (so it deletes too), and a finite one past `MAX_UV_TRANSFORM_MAGNITUDE` is
 * clamped to it rather than written as something the reader would ignore.
 * Fields absent from `patch` keep whatever the node already holds.
 */
export function withUvMapping(
  values: Record<string, string | number>,
  patch: UvMappingPatch,
): Record<string, string | number> {
  const next: Record<string, string | number> = { ...values };
  if (patch.orientation !== undefined) {
    if (patch.orientation === 'gltf') next.orientation = 'gltf';
    else delete next.orientation;
  }
  if (patch.normalGreenFlip !== undefined) {
    if (patch.normalGreenFlip === true) next.normalGreen = 'flip';
    else delete next.normalGreen;
  }
  if (patch.uvSet !== undefined) {
    if (isUvSet(patch.uvSet)) next.uvSet = patch.uvSet;
    else delete next.uvSet;
  }
  for (const { key, field: f, dflt } of XF_KEYS) {
    const raw = patch[f];
    if (raw === undefined) continue;
    let n = typeof raw === 'number' && Number.isFinite(raw) ? raw : dflt;
    n = Math.max(-MAX_UV_TRANSFORM_MAGNITUDE, Math.min(MAX_UV_TRANSFORM_MAGNITUDE, n));
    if (n === dflt) delete next[key];
    else next[key] = n;
  }
  return next;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: a parsed object's prototype must never answer. */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

function isBounded(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_UV_TRANSFORM_MAGNITUDE;
}

/** A glTF `[x, y]` pair: exactly two bounded finite numbers, or null. */
function pair(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && isBounded(v[0]) && isBounded(v[1]) ? [v[0], v[1]] : null;
}

/**
 * The GLB importer's ONE writer: a glTF `textureInfo` (with its optional
 * `KHR_texture_transform` extension) as Image-node values, plus what it could
 * not represent. Read adversarially — own properties only, every field
 * shape-checked:
 *
 *   - `texCoord` is the extension's when it has one, else the textureInfo's;
 *     an integer 0..3 is taken, anything else is reported and reads as 0;
 *   - `offset` / `scale` must be `[number, number]`, `rotation` a number,
 *     each finite with |v| ≤ 1e6 — a malformed one is reported and ignored.
 *
 * The result always carries `orientation: 'gltf'`: a texture that came with a
 * model is stored top-down, whatever else it says.
 */
export function gltfTextureValues(
  textureInfo: unknown,
  opts: { normalGreenFlip: boolean },
): { values: Record<string, string | number>; unsupported: string[] } {
  const unsupported: string[] = [];
  const info = isObj(textureInfo) ? textureInfo : {};
  const exts = own(info, 'extensions');
  const extRaw = isObj(exts) ? own(exts, 'KHR_texture_transform') : undefined;
  const ext = isObj(extRaw) ? extRaw : null;

  const tcRaw = ext && own(ext, 'texCoord') !== undefined ? own(ext, 'texCoord') : own(info, 'texCoord');
  let uvSet: ImageUvSet = 0;
  if (tcRaw !== undefined) {
    if (tcRaw === 0 || isUvSet(tcRaw)) uvSet = tcRaw;
    else unsupported.push('texCoord');
  }

  const patch: UvMappingPatch = { orientation: 'gltf', uvSet, normalGreenFlip: opts.normalGreenFlip === true };
  if (ext) {
    const off = own(ext, 'offset');
    if (off !== undefined) {
      const p = pair(off);
      if (p) [patch.offsetX, patch.offsetY] = p;
      else unsupported.push('offset');
    }
    const rot = own(ext, 'rotation');
    if (rot !== undefined) {
      if (isBounded(rot)) patch.rotation = rot;
      else unsupported.push('rotation');
    }
    const sc = own(ext, 'scale');
    if (sc !== undefined) {
      const p = pair(sc);
      if (p) [patch.scaleX, patch.scaleY] = p;
      else unsupported.push('scale');
    }
  }
  return { values: withUvMapping({}, patch), unsupported };
}

/** What `gltfSamplerValues` could not represent. A closed vocabulary with no
 *  import, so the GLB importer's feature list can include it as-is. */
export type GltfSamplerFeature = 'wrapMirrored' | 'wrapMixed';

/** The glTF (WebGL) enums a sampler speaks. REPEAT (10497) is never named:
 *  it is the fallthrough of `wrapOf`. */
const GL_CLAMP_TO_EDGE = 33071;
const GL_MIRRORED_REPEAT = 33648;
const GL_NEAREST = 9728;

/** One wrap axis. Anything but the two other enums — absent, a string, a
 *  fraction, an unknown number — is REPEAT, which is what GLTFLoader falls
 *  back to (`WEBGL_WRAPPINGS[v] || RepeatWrapping`) and what the glTF reader
 *  writes for an unrecognised value. */
function wrapOf(v: unknown): 'repeat' | 'clamp' | 'mirror' {
  if (v === GL_CLAMP_TO_EDGE) return 'clamp';
  if (v === GL_MIRRORED_REPEAT) return 'mirror';
  return 'repeat';
}

/**
 * A glTF sampler as Image-node values, plus what it could not represent. The
 * node has ONE Repeat switch and ONE filter, so:
 *
 *   - both axes REPEAT → nothing written (Repeat is the node's default);
 *   - both CLAMP_TO_EDGE → `repeat: 0`;
 *   - MIRRORED_REPEAT on either axis → reported as `wrapMirrored`, and that
 *     axis is read as REPEAT (the nearest the node can draw);
 *   - the two axes still disagreeing after that (repeat on one, clamp on the
 *     other) → reported as `wrapMixed`, and both repeat;
 *   - `magFilter` NEAREST (9728) → `filter: 'nearest'`; anything else writes
 *     nothing (Linear, the default).
 *
 * The writer deletes the default, so a REPEAT/LINEAR sampler — or none at all,
 * or junk — yields `{}` and the node keeps what it already holds. Read
 * adversarially: own properties only, strict equality with the enum values.
 */
export function gltfSamplerValues(sampler: unknown): {
  values: Record<string, string | number>;
  unsupported: GltfSamplerFeature[];
} {
  const s = isObj(sampler) ? sampler : {};
  const rawS = wrapOf(own(s, 'wrapS'));
  const rawT = wrapOf(own(s, 'wrapT'));
  const unsupported: GltfSamplerFeature[] = [];
  const values: Record<string, string | number> = {};
  if (rawS === 'mirror' || rawT === 'mirror') unsupported.push('wrapMirrored');
  const ws = rawS === 'mirror' ? 'repeat' : rawS;
  const wt = rawT === 'mirror' ? 'repeat' : rawT;
  if (ws !== wt) unsupported.push('wrapMixed');
  else if (ws === 'clamp') values.repeat = 0;
  if (own(s, 'magFilter') === GL_NEAREST) values.filter = 'nearest';
  return { values, unsupported };
}
