/**
 * The TEXTURE-OBJECT half of an Image node's settings, read one way.
 *
 * graphToCode's image branch sets exactly these on the module-scope
 * `THREE.Texture`: the colour space (and with it mipmaps), the Nearest filter,
 * the wrap mode, and `flipY`. Everything else an Image node carries — tile,
 * offset, the Flip X/Y checkboxes, a wired uv or Direction — changes only the
 * uv EXPRESSION a sample is taken at, never the texture object. That split is
 * what makes this the key texture sharing is decided on: two nodes holding the
 * same payload with the same spec can sample one texture. A new setting that
 * lands on the Texture OBJECT must therefore JOIN this spec, or two nodes that
 * differ in it would silently share one texture. Phase 4's glTF orientation
 * joined here as `flipY`, and it is the ONLY mapping key that did: the UV set,
 * the glTF texture transform and the normal-map green flip are uv or channel
 * math (utils/imageUvMapping.ts) and stay out of the key.
 *
 * NB `values.flipY` is the Flip Y CHECKBOX, a uv mirror. `spec.flipY` is
 * `Texture.flipY`, which the emitter always writes explicitly — `true`, or
 * `false` under the glTF orientation — so orientation never rides on a
 * three.js default. They are unrelated.
 *
 * The reads are byte-for-byte what graphToCode's image branch did inline
 * before this module existed (`imageTextureSpec.test.ts` sweeps junk values
 * through both), so every image saved before it emits identically. The values
 * come out of a `.fastshader` and are adversarial: every read is an exact
 * compare or a `Number()` coercion, and nothing here reaches emitted text.
 *
 * A LEAF: it imports nothing.
 */

export interface ImageTextureSpec {
  /** `'data'` turns mipmaps off and stores linear values (NoColorSpace). */
  readonly colorSpace: 'color' | 'data';
  /** Nearest-texel filtering; false is three's default linear. */
  readonly nearest: boolean;
  /** RepeatWrapping when true, ClampToEdgeWrapping when false. */
  readonly repeat: boolean;
  /** `Texture.flipY` — true unless the node carries the glTF orientation;
   *  always written explicitly (see the header). */
  readonly flipY: boolean;
}

export function readImageTextureSpec(values: Record<string, unknown>): ImageTextureSpec {
  // An exact compare: only the literal string 'data' is a data map, so 'DATA',
  // a number or an absent key all read as a colour image.
  const colorSpace = String(values.colorSpace ?? 'color') === 'data' ? 'data' : 'color';
  // Exact again: anything but the literal string is linear, absent included.
  const nearest = values.filter === 'nearest';
  // A non-finite number (absent, NaN, 'x') falls back to 1 = repeat, while
  // null, '' and 0 coerce to 0 = clamp. That asymmetry is the historical read
  // (graphToCode's `numVal('repeat', 1) >= 0.5`), kept exactly.
  const r = Number(values.repeat);
  const repeat = (Number.isFinite(r) ? r : 1) >= 0.5;
  // glTF textures are stored top-down and uploaded unflipped — GLTFLoader's
  // `texture.flipY = false`. The rule is readImageUvMapping's
  // (imageUvMapping.ts), inlined so this module keeps importing nothing;
  // imageUvMapping.test.ts pins that the two agree. Exact compare: 'GLTF',
  // 'gltf ' or a number is the app orientation, i.e. today's `true`.
  const flipY = values.orientation !== 'gltf';
  return { colorSpace, nearest, repeat, flipY };
}

/**
 * One string per distinct spec, e.g. `'color|linear|repeat|flipY'`. Equal
 * specs give equal keys and different specs different keys.
 */
export function imageTextureSpecKey(s: ImageTextureSpec): string {
  return `${s.colorSpace}|${s.nearest ? 'nearest' : 'linear'}|${s.repeat ? 'repeat' : 'clamp'}|${s.flipY ? 'flipY' : 'noFlipY'}`;
}
