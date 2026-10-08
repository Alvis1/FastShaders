/**
 * How an Image/Texture node's picture lands on the UVs, beside the placement
 * sockets themselves (Tile, Offset) and the Flip boxes: the facts a model's
 * texture brings, the picture's turn, and the legacy transform the turn
 * replaced. Nine `values` keys:
 *
 *   - `orientation`  exactly `'gltf'`: a fact about the BYTES, not a setting —
 *                    the texture is uploaded unflipped (`Texture.flipY =
 *                    false`, GLTFLoader's own choice). That is ALL it
 *                    changes: the UV chain, the Flips and the turn's sign
 *                    read the same in both orientations;
 *   - `normalGreen`  exactly `'flip'`: the Output's normal-map decode flips its
 *                    green axis, GLTFLoader's `normalScale.y *= -1` for a
 *                    primitive without TANGENT;
 *   - `uvSet`        exactly the NUMBER 1, 2 or 3: sample `uv(n)` (three's
 *                    `uv1`..`uv3`, i.e. glTF TEXCOORD_1..3) instead of `uv()`;
 *   - `rotation`     radians: the picture's TURN about its own centre, the
 *                    last step of the placement chain (utils/imagePlacement.ts).
 *                    Stored only — never a socket, a `defaultValues` entry or a
 *                    texture key — and taken mod 2π, so a whole number of turns
 *                    reads as none;
 *   - `xfOffsetX`, `xfOffsetY`, `xfRotation` (radians), `xfScaleX`,
 *     `xfScaleY`    LEGACY KHR_texture_transform, applied BEFORE the mirror.
 *                    The importer no longer writes them, and every restore
 *                    folds them into Tile/Offset/Rotation
 *                    (`foldLegacyUvTransform`); a node the fold cannot express
 *                    exactly keeps them and emits as it always did.
 *
 * Every number is finite with |v| ≤ 1e6, or it reads as its default.
 * `readImageUvMapping` and `readPictureRotation` are the readers, and
 * `readImagePlacement` (utils/imagePlacement.ts) composes them with the flips
 * and the stored tile/offset into the ONE placement read that codegen, the
 * fold and the GLB export share. Each writer owns its keys: `withUvMapping`
 * (the importer's orientation, UV set and green flip, and the settings menu's
 * UV set and green-flip rows), `gltfTextureValues` (the GLB importer — Phase 5
 * must go through it — which writes a model's KHR_texture_transform as the
 * node's own Tile/Offset/Rotation, a negative scale as that axis's Flip —
 * `storedPlacement`, which the restore fold shares; the turn's sign is
 * `turnSignOf`, the one the reader uses), `withPictureRotation` (the menu's
 * Rotation row), `withoutLegacyTransform` (its "Older transform" Clear; both also used
 * by the restore fold), and `withImagePayload` (utils/textureSources.ts), which
 * moves `orientation` with the bytes. No menu sets `orientation`, and nothing
 * writes an `xf*` key. Every key comes out of a `.fastshader`
 * and is adversarial, so every read is EXACT: an absent, junk or
 * default-valued key means today's emission, byte for byte. Numbers are read
 * only as real numbers — `Number(true)` is 1, `Number(null)`, `Number('')` and
 * `Number([])` are 0, and a coerced 0 scale would collapse the texture — and
 * this module's writers only ever write the canonical form (numbers as
 * numbers, `'gltf'`/`'flip'` as the two strings), deleting a key whose value is
 * its default, so a node toggled on and back off is JSON-identical to one never
 * touched.
 *
 * Only the ORIENTATION is a property of the Texture OBJECT, so only it joins
 * `ImageTextureSpec` (`flipY: values.orientation !== 'gltf'`, inlined there so
 * that module stays a leaf; `imageUvMapping.test.ts` pins that the two agree).
 * The UV set, the turn, the transform and the green flip are UV or channel
 * math and never enter a texture key: two nodes differing only in them share
 * one texture.
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
  'rotation',
  'xfOffsetX',
  'xfOffsetY',
  'xfRotation',
  'xfScaleX',
  'xfScaleY',
] as const;

/** The largest |value| a transform key may hold. Anything past it (or not a
 *  finite number at all) reads as the key's default. */
export const MAX_UV_TRANSFORM_MAGNITUDE = 1e6;

/** The five LEGACY transform keys: read, folded and deleted — nothing in the
 *  app writes them any more. */
const XF_KEYS = ['xfOffsetX', 'xfOffsetY', 'xfRotation', 'xfScaleX', 'xfScaleY'] as const;

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

/**
 * The picture's turn θ in radians, read strictly — a real finite number with
 * |v| ≤ 1e6, else 0, never `Number()` — and taken mod 2π (JS `%`, so −30°
 * stays −30°). It is 0 whenever its snapped matrix is the identity: a whole
 * number of turns, or float dust beside one, is no turn at all, so it emits
 * nothing.
 */
export function readPictureRotation(values: Readonly<Record<string, unknown>>): number {
  return canonicalTurn(fin(field(values, 'rotation'), 0));
}

/** `radians` mod 2π, or exactly 0 when that turn snaps to the identity. */
function canonicalTurn(radians: number): number {
  const r = radians % (2 * Math.PI);
  return isIdentityTurn(turnMatrix(r)) ? 0 : r;
}

/** Clean up float dust so a quarter turn emits `0`/`1`/`-1`, and never −0.
 *  Exported for the placement fold, which writes numbers the same way. */
export function snap(x: number): number {
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

/** A turn of the UVs, in `gltfUvMatrix`'s row form. */
export interface UvTurn {
  readonly m00: number;
  readonly m01: number;
  readonly m10: number;
  readonly m11: number;
  readonly tx: number;
  readonly ty: number;
}

/**
 * The turn by `radians` about the picture's centre c = (½, ½), in
 * `gltfUvMatrix`'s row form: `u' = m00·u + m01·v + tx`, `v' = m10·u + m11·v +
 * ty`. The 2×2 part is R(radians) with `gltfUvMatrix`'s rows (cos, sin),
 * (−sin, cos), taken mod 2π and snapped the same way (it equals that matrix at
 * unit scale), so a quarter turn is clean integers and a whole turn EXACTLY the
 * identity; (tx, ty) = c − R·c, from the snapped R, keeps the centre in place.
 * Anything but a finite number is the identity.
 */
export function turnMatrix(radians: number): UvTurn {
  if (typeof radians !== 'number' || !Number.isFinite(radians)) return { m00: 1, m01: 0, m10: 0, m11: 1, tx: 0, ty: 0 };
  const r = radians % (2 * Math.PI);
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m00 = snap(c);
  const m01 = snap(s);
  const m10 = snap(-s);
  const m11 = snap(c);
  return { m00, m01, m10, m11, tx: snap(0.5 - 0.5 * (m00 + m01)), ty: snap(0.5 - 0.5 * (m10 + m11)) };
}

/** Whether a turn's 2×2 part is exactly the identity (then nothing is emitted). */
export function isIdentityTurn(t: UvTurn): boolean {
  return t.m00 === 1 && t.m01 === 0 && t.m10 === 0 && t.m11 === 1;
}

/**
 * THE sign of the picture's turn: the chain turns by ψ = θ·turnSignOf(…), i.e.
 * ψ = θ·(exactly one Flip ticked ? −1 : 1) — the mirror stage's determinant,
 * which it cancels. Each ticked box mirrors its axis and nothing else mirrors,
 * in either orientation (the app's old baked 1-u is gone), so the orientation
 * has no say. With positive tiles a positive θ turns the picture
 * COUNTER-clockwise on UVs that run u right and v up — three's primitives,
 * the Teapot, and the generated spherical UVs of the Bunny and of an OBJ
 * without UVs — in all 8 orientation × flip states: the sense three.js's
 * `Texture.rotation` and glTF's KHR_texture_transform `rotation` use, so a
 * model's φ imports as θ = φ. `readImagePlacement` (utils/imagePlacement.ts —
 * the emitter's read, and through it the restore fold and the GLB export) and
 * `storedPlacement` (the KHR import and the fold) all take it from here, so
 * the four cannot disagree.
 */
export function turnSignOf(flipX: boolean, flipY: boolean): 1 | -1 {
  return flipX !== flipY ? -1 : 1;
}

/**
 * A placement as a WRITER computes it, before it is stored: the Flips as
 * ticked, the tile and offset that follow the mirror — a tile may be negative
 * here — and ψ, the turn the chain must turn by.
 */
export interface PlacementDraft {
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly tileX: number;
  readonly tileY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly psi: number;
}

/** What a writer stores for a draft: no negative tile, and the turn θ. */
export interface StoredPlacement {
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly tileX: number;
  readonly tileY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** ψ·turnSignOf(the RESULTING Flips) — `withPictureRotation` takes it mod 2π. */
  readonly theta: number;
}

/**
 * A draft as the node stores it, with NO negative tile. An axis whose tile k
 * is negative becomes that axis's Flip toggled, tile |k| and offset o + k:
 *
 *   K·(d·u + e) + o  ≡  (−K)·(−d·u + 1 − e) + (o + K)
 *
 * with (d, e) that axis's mirror — which toggling the box toggles, since each
 * ticked box mirrors its own axis in either orientation. The chain before the
 * turn is unchanged, so ψ is too, and θ is ψ over the RESULTING Flips'
 * sign. The two writers of a model's transform — the KHR import
 * (`gltfTextureValues`) and the restore fold of a legacy one
 * (utils/imagePlacement.ts) — both store through here, so they agree to the
 * bit. A Tile the USER types negative is left as typed: it mirrors once more,
 * so it turns the picture the other way.
 */
export function storedPlacement(d: PlacementDraft): StoredPlacement {
  const negX = d.tileX < 0;
  const negY = d.tileY < 0;
  const flipX = negX ? !d.flipX : d.flipX;
  const flipY = negY ? !d.flipY : d.flipY;
  return {
    flipX,
    flipY,
    tileX: negX ? -d.tileX : d.tileX,
    tileY: negY ? -d.tileY : d.tileY,
    offsetX: negX ? snap(d.offsetX + d.tileX) : d.offsetX,
    offsetY: negY ? snap(d.offsetY + d.tileY) : d.offsetY,
    theta: d.psi * turnSignOf(flipX, flipY),
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
  for (const key of ['rotation', ...XF_KEYS]) {
    // NaN as the default can never equal a real read, so this is "does it
    // pass `fin`" without a second copy of the rule.
    if (has(key) && Number.isNaN(fin(field(values, key), NaN))) drop.push(key);
  }
  if (drop.length === 0) return null;
  const next = { ...values };
  for (const k of drop) delete next[k];
  return next;
}

/** The three facts `withUvMapping` writes. The turn has its own writer
 *  (`withPictureRotation`), and the legacy `xf*` keys have none. */
export interface UvMappingPatch {
  orientation?: ImageOrientation;
  normalGreenFlip?: boolean;
  uvSet?: ImageUvSet;
}

/**
 * A NEW values object with `patch` applied in canonical form: `'gltf'` and
 * `'flip'` as the two strings, the UV set as the number 1, 2 or 3, and a
 * patched field at its default DELETES its key. Fields absent from `patch`
 * keep whatever the node already holds.
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
  return next;
}

/**
 * A NEW values object with `radians` as the picture's turn, in the canonical
 * form `readPictureRotation` returns: mod 2π, and DELETED when that is no turn
 * — 0, a whole number of turns, or anything the reader would not take (a
 * non-number, NaN, |v| > 1e6) — so what is stored is exactly what is read.
 */
export function withPictureRotation(
  values: Record<string, string | number>,
  radians: number,
): Record<string, string | number> {
  const next: Record<string, string | number> = { ...values };
  const r = canonicalTurn(fin(radians, 0));
  if (r === 0) delete next.rotation;
  else next.rotation = r;
  return next;
}

/** A NEW values object without the five legacy `xf*` keys. It CHANGES the
 *  picture unless the fold (utils/imagePlacement.ts) has absorbed them first. */
export function withoutLegacyTransform(values: Record<string, string | number>): Record<string, string | number> {
  const next: Record<string, string | number> = { ...values };
  for (const key of XF_KEYS) delete next[key];
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
 * The transform becomes the node's OWN Tile, Offset and Rotation, exactly
 * (`withKhrPlacement`) — a negative scale as that axis's Flip, never a
 * negative Tile, and never the legacy `xf*` keys. The result always carries
 * `orientation: 'gltf'`: a texture that came with a model is stored top-down,
 * whatever else it says.
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

  // KHR_texture_transform's own defaults: no offset, no turn, unit scale.
  let offset: [number, number] = [0, 0];
  let rotation = 0;
  let scale: [number, number] = [1, 1];
  if (ext) {
    const off = own(ext, 'offset');
    if (off !== undefined) {
      const p = pair(off);
      if (p) offset = p;
      else unsupported.push('offset');
    }
    const rot = own(ext, 'rotation');
    if (rot !== undefined) {
      if (isBounded(rot)) rotation = rot;
      else unsupported.push('rotation');
    }
    const sc = own(ext, 'scale');
    if (sc !== undefined) {
      const p = pair(sc);
      if (p) scale = p;
      else unsupported.push('scale');
    }
  }
  const mapping = withUvMapping({}, { orientation: 'gltf', uvSet, normalGreenFlip: opts.normalGreenFlip === true });
  return { values: withKhrPlacement(mapping, offset, rotation, scale), unsupported };
}

/**
 * A KHR_texture_transform — `u' = R(φ)·(s∘u) + t`, the Khronos reference
 * order (`gltfUvMatrix`) — as the node's own placement. The chain turns by ψ
 * about c = (½, ½), AFTER the tile and the offset (utils/imagePlacement.ts),
 * so on a glTF node with neither Flip ticked it is KHR's map exactly when
 * ψ = φ, Tile = s and Offset = t + (R(−φ)(t − c) − (t − c)) — the offset that
 * lands the picture where KHR's turn about the UV ORIGIN puts it; with no turn
 * R(−φ) is exactly the identity, so it is t itself. `storedPlacement` then
 * writes a negative scale as that axis's Flip, tile |s| and offset + s, and
 * θ = φ·turnSignOf(the resulting Flips): an unflipped import stores
 * Rotation = φ, the file's own number.
 *
 * θ is stored in the form the reader returns (`withPictureRotation`), and the
 * offset is computed with the very matrix the chain turns by (`turnMatrix`).
 * Every number is snapped as `gltfUvMatrix` snaps its own, so an unrotated
 * transform with no negative scale keeps the digits the legacy stage emitted;
 * a value at its default is not written. `values` is a fresh mapping (no Flip,
 * Tile, Offset or turn of its own): `gltfTextureValues` is the only caller.
 */
function withKhrPlacement(
  values: Record<string, string | number>,
  t: readonly [number, number],
  phi: number,
  s: readonly [number, number],
): Record<string, string | number> {
  const back = turnMatrix(-phi);
  const dx = t[0] - 0.5;
  const dy = t[1] - 0.5;
  const p = storedPlacement({
    flipX: false,
    flipY: false,
    tileX: snap(s[0]),
    tileY: snap(s[1]),
    offsetX: snap(t[0] + (back.m00 * dx + back.m01 * dy - dx)),
    offsetY: snap(t[1] + (back.m10 * dx + back.m11 * dy - dy)),
    psi: phi,
  });
  const next: Record<string, string | number> = { ...values };
  // A ticked box is written the way the menu's checkbox writes one.
  if (p.flipX) next.flipX = 1;
  if (p.flipY) next.flipY = 1;
  const placement: readonly (readonly [string, number, number])[] = [
    ['tileX', p.tileX, 1],
    ['tileY', p.tileY, 1],
    ['offsetX', p.offsetX, 0],
    ['offsetY', p.offsetY, 0],
  ];
  for (const [key, n, dflt] of placement) if (n !== dflt) next[key] = n;
  return withPictureRotation(next, p.theta);
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
