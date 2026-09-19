import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Matrix3, Vector3 } from 'three';
import {
  readImageUvMapping,
  gltfUvMatrix,
  sanitizeUvMappingKeys,
  withUvMapping,
  gltfTextureValues,
  gltfSamplerValues,
  UV_MAPPING_KEYS,
  MAX_UV_TRANSFORM_MAGNITUDE,
  type GltfUvTransform,
} from './imageUvMapping';
import { readImageTextureSpec } from './imageTextureSpec';

const SRC = readFileSync(new URL('./imageUvMapping.ts', import.meta.url), 'utf8');
/** The module's code with every comment removed, for the source pins. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Junk under EVERY key: none of these may change what the node means. */
const JUNK: unknown[] = [
  null, '', [], {}, true, false, NaN, Infinity, -Infinity, 1e7, -1e7,
  '1', ' 2', 'GLTF', 'gltf ', 'flip ', 'Flip', '__proto__', 'constructor', '1); alert(1',
];

const DEFAULTS = { orientation: 'app', normalGreenFlip: false, uvSet: 0, transform: null };

const t = (over: Partial<GltfUvTransform> = {}): GltfUvTransform => ({
  offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, ...over,
});

describe('readImageUvMapping: strict reads', () => {
  it('reads an untouched node as today\'s mapping', () => {
    expect(readImageUvMapping({})).toEqual(DEFAULTS);
  });

  it('every junk value under every key reads as the default', () => {
    for (const key of UV_MAPPING_KEYS) {
      for (const v of JUNK) {
        expect(readImageUvMapping({ [key]: v }), `${key}=${String(v)}`).toEqual(DEFAULTS);
      }
    }
  });

  it('accepts exactly the two strings and nothing like them', () => {
    expect(readImageUvMapping({ orientation: 'gltf' }).orientation).toBe('gltf');
    expect(readImageUvMapping({ normalGreen: 'flip' }).normalGreenFlip).toBe(true);
    for (const v of ['GLTF', 'Gltf', ' gltf', 'gltf ', 'app', 1, true]) {
      expect(readImageUvMapping({ orientation: v }).orientation).toBe('app');
    }
    for (const v of ['FLIP', 'Flip', 'flip ', 1, -1, true]) {
      expect(readImageUvMapping({ normalGreen: v }).normalGreenFlip).toBe(false);
    }
  });

  it('uvSet accepts exactly the numbers 1, 2 and 3', () => {
    for (const n of [1, 2, 3] as const) expect(readImageUvMapping({ uvSet: n }).uvSet).toBe(n);
    for (const v of [0, 4, -1, 1.5, 0.5, '1', '2', true, Infinity, NaN]) {
      expect(readImageUvMapping({ uvSet: v }).uvSet, String(v)).toBe(0);
    }
  });

  it('reads transform numbers only as real, bounded numbers', () => {
    expect(readImageUvMapping({ xfScaleX: 2 }).transform).toEqual(t({ scaleX: 2 }));
    expect(readImageUvMapping({ xfOffsetY: -MAX_UV_TRANSFORM_MAGNITUDE }).transform).toEqual(t({ offsetY: -1e6 }));
    // One past the bound is junk, not a clamp.
    expect(readImageUvMapping({ xfOffsetY: -1e6 - 1 }).transform).toBeNull();
    // Number('') is 0: a coerced 0 scale would collapse the texture.
    expect(readImageUvMapping({ xfScaleX: '' }).transform).toBeNull();
  });

  it('an identity transform is null, whichever keys spell it', () => {
    expect(readImageUvMapping({ xfOffsetX: 0, xfOffsetY: 0, xfRotation: 0, xfScaleX: 1, xfScaleY: 1 }).transform).toBeNull();
    expect(readImageUvMapping({ xfOffsetX: -0 }).transform).toBeNull();
  });

  it('never throws on a primitive, null or null-prototype values object', () => {
    expect(readImageUvMapping(5 as unknown as Record<string, unknown>)).toEqual(DEFAULTS);
    expect(readImageUvMapping(null as unknown as Record<string, unknown>)).toEqual(DEFAULTS);
    const np = Object.create(null) as Record<string, unknown>;
    np.uvSet = 2;
    expect(readImageUvMapping(np).uvSet).toBe(2);
  });
});

describe('gltfUvMatrix', () => {
  it('scale alone is a diagonal', () => {
    const m = gltfUvMatrix(t({ scaleX: 2, scaleY: 3 }));
    expect(m).toEqual({ m00: 2, m01: 0, m10: 0, m11: 3, tx: 0, ty: 0 });
  });

  it('a quarter turn emits clean integers and never −0', () => {
    const m = gltfUvMatrix(t({ rotation: Math.PI / 2 }));
    expect([m.m00, m.m01, m.m10, m.m11]).toEqual([0, 1, -1, 0]);
    expect(Object.is(m.m00, 0)).toBe(true);
    expect(Object.is(m.m11, 0)).toBe(true);
    const half = gltfUvMatrix(t({ rotation: Math.PI }));
    expect([half.m00, half.m01, half.m10, half.m11]).toEqual([-1, 0, 0, -1]);
    expect(Object.is(half.m01, 0)).toBe(true);
    expect(Object.is(half.m10, 0)).toBe(true);
  });

  it('takes the rotation mod 2π', () => {
    const a = gltfUvMatrix(t({ rotation: 2 * Math.PI + 0.3 }));
    const b = gltfUvMatrix(t({ rotation: 0.3 }));
    for (const k of ['m00', 'm01', 'm10', 'm11'] as const) expect(a[k]).toBeCloseTo(b[k], 12);
    const full = gltfUvMatrix(t({ rotation: 2 * Math.PI }));
    expect([full.m00, full.m01, full.m10, full.m11]).toEqual([1, 0, 0, 1]);
  });

  /** The Khronos reference renderer (glTF-Sample-Viewer), restated literally:
   *  column-major 3×3 arrays, `translation × rotation × scale`, applied to
   *  (u, v, 1). */
  function referenceRenderer(ox: number, oy: number, r: number, sx: number, sy: number, u: number, v: number) {
    const c = Math.cos(r);
    const s = Math.sin(r);
    const R = [c, -s, 0, s, c, 0, 0, 0, 1];
    const S = [sx, 0, 0, 0, sy, 0, 0, 0, 1];
    const T = [1, 0, 0, 0, 1, 0, ox, oy, 1];
    const mul = (a: number[], b: number[]) => {
      const out = new Array<number>(9).fill(0);
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
          let sum = 0;
          for (let k = 0; k < 3; k++) sum += a[k * 3 + row] * b[col * 3 + k];
          out[col * 3 + row] = sum;
        }
      }
      return out;
    };
    const M = mul(mul(T, R), S);
    const p = [u, v, 1];
    const at = (row: number) => M[row] * p[0] + M[3 + row] * p[1] + M[6 + row] * p[2];
    return [at(0), at(1)];
  }

  const CASE = { ox: 0.1, oy: -0.2, r: 0.4, sx: 2, sy: 0.5 };
  const POINTS: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1], [0.3, 0.7]];

  it('matches the reference renderer, non-uniform scale with rotation included', () => {
    const m = gltfUvMatrix(t({ offsetX: CASE.ox, offsetY: CASE.oy, rotation: CASE.r, scaleX: CASE.sx, scaleY: CASE.sy }));
    for (const [u, v] of POINTS) {
      const [ru, rv] = referenceRenderer(CASE.ox, CASE.oy, CASE.r, CASE.sx, CASE.sy, u, v);
      expect(m.m00 * u + m.m01 * v + m.tx).toBeCloseTo(ru, 12);
      expect(m.m10 * u + m.m11 * v + m.ty).toBeCloseTo(rv, 12);
    }
  });

  it('differs from three\'s setUvTransform on that case (the known GLTFLoader divergence)', () => {
    const three = new Matrix3().setUvTransform(CASE.ox, CASE.oy, CASE.sx, CASE.sy, CASE.r, 0, 0);
    const m = gltfUvMatrix(t({ offsetX: CASE.ox, offsetY: CASE.oy, rotation: CASE.r, scaleX: CASE.sx, scaleY: CASE.sy }));
    const q = new Vector3(1, 1, 1).applyMatrix3(three);
    const ours = [m.m00 + m.m01 + m.tx, m.m10 + m.m11 + m.ty];
    expect(Math.abs(q.x - ours[0]) + Math.abs(q.y - ours[1])).toBeGreaterThan(1e-3);
    // …and agrees with it under uniform scale, which is why parity fixtures
    // against GLTFLoader must use uniform scale.
    const uni = new Matrix3().setUvTransform(CASE.ox, CASE.oy, 2, 2, CASE.r, 0, 0);
    const mu = gltfUvMatrix(t({ offsetX: CASE.ox, offsetY: CASE.oy, rotation: CASE.r, scaleX: 2, scaleY: 2 }));
    for (const [u, v] of POINTS) {
      const qu = new Vector3(u, v, 1).applyMatrix3(uni);
      expect(mu.m00 * u + mu.m01 * v + mu.tx).toBeCloseTo(qu.x, 12);
      expect(mu.m10 * u + mu.m11 * v + mu.ty).toBeCloseTo(qu.y, 12);
    }
  });
});

describe('sanitizeUvMappingKeys', () => {
  const clean: Record<string, string | number> = {
    imageB64: 'x', orientation: 'gltf', normalGreen: 'flip', uvSet: 2,
    xfOffsetX: 0.25, xfOffsetY: -0.5, xfRotation: 0.3, xfScaleX: 2, xfScaleY: 1,
  };

  it('returns null when every key holds its shape, so a graph keeps its identity', () => {
    expect(sanitizeUvMappingKeys(clean)).toBeNull();
    expect(sanitizeUvMappingKeys({ imageB64: 'x' })).toBeNull();
  });

  it('drops each junk key and nothing else', () => {
    for (const key of UV_MAPPING_KEYS) {
      for (const junk of ['GLTF', 1e7, true, '1'] as unknown[]) {
        const values = { ...clean, [key]: junk } as Record<string, string | number>;
        const out = sanitizeUvMappingKeys(values);
        expect(out, `${key}=${String(junk)}`).not.toBeNull();
        expect(out![key]).toBeUndefined();
        for (const other of Object.keys(clean)) if (other !== key) expect(out![other]).toBe(clean[other]);
        expect(values[key]).toBe(junk); // the input is not mutated
      }
    }
  });

  it('never throws on a primitive or null values object', () => {
    expect(sanitizeUvMappingKeys(5 as unknown as Record<string, string | number>)).toBeNull();
    expect(sanitizeUvMappingKeys(null as unknown as Record<string, string | number>)).toBeNull();
  });

  it('reads by plain property access, never the `in` operator (it THROWS on a primitive)', () => {
    expect(CODE).not.toMatch(/\bin values\b/);
    expect(CODE).not.toMatch(/'\w+' in /);
  });
});

describe('withUvMapping', () => {
  it('writes the canonical form: the two strings, and numbers as numbers', () => {
    const on = withUvMapping({}, { orientation: 'gltf', normalGreenFlip: true, uvSet: 2, offsetX: 0.25, rotation: 0.3, scaleY: 3 });
    expect(on).toEqual({ orientation: 'gltf', normalGreen: 'flip', uvSet: 2, xfOffsetX: 0.25, xfRotation: 0.3, xfScaleY: 3 });
    expect(typeof on.uvSet).toBe('number');
  });

  it('toggled on and back off is JSON-identical to a node never touched', () => {
    const orig: Record<string, string | number> = { imageB64: 'x', tileX: 2, flipX: 1 };
    const on = withUvMapping(orig, {
      orientation: 'gltf', normalGreenFlip: true, uvSet: 3,
      offsetX: 0.25, offsetY: 0.5, rotation: 0.3, scaleX: 2, scaleY: 3,
    });
    expect(orig).toEqual({ imageB64: 'x', tileX: 2, flipX: 1 }); // not mutated
    const off = withUvMapping(on, {
      orientation: 'app', normalGreenFlip: false, uvSet: 0,
      offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1,
    });
    expect(off).toEqual(orig);
    expect(JSON.stringify(off)).toBe(JSON.stringify(orig));
  });

  it('leaves fields absent from the patch alone', () => {
    const v = withUvMapping({ orientation: 'gltf', xfScaleX: 2 }, { uvSet: 1 });
    expect(v).toEqual({ orientation: 'gltf', xfScaleX: 2, uvSet: 1 });
  });

  it('a non-finite number deletes, an out-of-range one clamps, −0 is the default', () => {
    expect(withUvMapping({ xfScaleX: 2 }, { scaleX: NaN })).toEqual({});
    expect(withUvMapping({}, { offsetX: 1e9 }).xfOffsetX).toBe(MAX_UV_TRANSFORM_MAGNITUDE);
    expect(withUvMapping({}, { offsetX: -1e9 }).xfOffsetX).toBe(-MAX_UV_TRANSFORM_MAGNITUDE);
    expect(withUvMapping({ xfOffsetX: 1 }, { offsetX: -0 })).toEqual({});
  });

  it('what it writes reads back as what was asked', () => {
    const v = withUvMapping({}, { orientation: 'gltf', uvSet: 2, rotation: 0.3, scaleX: 2 });
    expect(readImageUvMapping(v)).toEqual({
      orientation: 'gltf', normalGreenFlip: false, uvSet: 2, transform: t({ rotation: 0.3, scaleX: 2 }),
    });
    expect(sanitizeUvMappingKeys(v)).toBeNull();
  });
});

describe('gltfTextureValues (the GLB importer\'s one writer)', () => {
  const opts = { normalGreenFlip: false };

  it('always carries the glTF orientation, whatever it was handed', () => {
    for (const info of [undefined, null, 5, 'x', [], {}, { index: 0 }]) {
      const r = gltfTextureValues(info, opts);
      expect(r.values).toEqual({ orientation: 'gltf' });
      expect(r.unsupported).toEqual([]);
    }
  });

  it('texCoord becomes the UV set, and the extension\'s overrides the textureInfo\'s', () => {
    expect(gltfTextureValues({ index: 0, texCoord: 2 }, opts).values).toEqual({ orientation: 'gltf', uvSet: 2 });
    expect(gltfTextureValues({ index: 0, texCoord: 0 }, opts).values).toEqual({ orientation: 'gltf' });
    const ext = { texCoord: 1, extensions: { KHR_texture_transform: { texCoord: 3 } } };
    expect(gltfTextureValues(ext, opts).values.uvSet).toBe(3);
  });

  it('an unrepresentable texCoord is reported, and reads as set 0', () => {
    for (const bad of [5, '1', -1, 1.5, null, true]) {
      const r = gltfTextureValues({ texCoord: bad }, opts);
      expect(r.values.uvSet, String(bad)).toBeUndefined();
      expect(r.unsupported).toEqual(['texCoord']);
    }
  });

  it('reads the KHR_texture_transform, ignoring and reporting malformed parts', () => {
    const ok = gltfTextureValues({ extensions: { KHR_texture_transform: { offset: [0.25, 0.5], rotation: 0.3, scale: [2, 3] } } }, opts);
    expect(ok.values).toEqual({ orientation: 'gltf', xfOffsetX: 0.25, xfOffsetY: 0.5, xfRotation: 0.3, xfScaleX: 2, xfScaleY: 3 });
    expect(ok.unsupported).toEqual([]);
    for (const bad of [[1], [NaN, 0], 'x', [0, 0, 0], [1e7, 0]]) {
      const r = gltfTextureValues({ extensions: { KHR_texture_transform: { offset: bad, scale: bad } } }, opts);
      expect(r.values, JSON.stringify(bad)).toEqual({ orientation: 'gltf' });
      expect(r.unsupported).toEqual(['offset', 'scale']);
    }
    const rot = gltfTextureValues({ extensions: { KHR_texture_transform: { rotation: 'x' } } }, opts);
    expect(rot.values).toEqual({ orientation: 'gltf' });
    expect(rot.unsupported).toEqual(['rotation']);
  });

  it('passes the normal-green flip through', () => {
    expect(gltfTextureValues({}, { normalGreenFlip: true }).values).toEqual({ orientation: 'gltf', normalGreen: 'flip' });
  });

  it('reads OWN properties only', () => {
    const inherited = Object.create({ texCoord: 2, extensions: { KHR_texture_transform: { scale: [2, 2] } } });
    expect(gltfTextureValues(inherited, opts).values).toEqual({ orientation: 'gltf' });
  });
});

describe('gltfSamplerValues (a glTF sampler as the node\'s texture keys)', () => {
  const REPEAT = 10497;
  const CLAMP = 33071;
  const MIRROR = 33648;

  it('writes nothing for a REPEAT/LINEAR sampler, none at all, or junk', () => {
    for (const sampler of [undefined, null, 5, 'x', [], {}, { wrapS: REPEAT, wrapT: REPEAT }, { magFilter: 9729 }]) {
      expect(gltfSamplerValues(sampler), JSON.stringify(sampler)).toEqual({ values: {}, unsupported: [] });
    }
  });

  it('both axes clamped → repeat: 0, the only value it ever writes for wrap', () => {
    expect(gltfSamplerValues({ wrapS: CLAMP, wrapT: CLAMP })).toEqual({ values: { repeat: 0 }, unsupported: [] });
  });

  it('mixed repeat and clamp repeats both and says so', () => {
    for (const s of [{ wrapS: CLAMP, wrapT: REPEAT }, { wrapS: REPEAT, wrapT: CLAMP }, { wrapS: CLAMP }]) {
      expect(gltfSamplerValues(s), JSON.stringify(s)).toEqual({ values: {}, unsupported: ['wrapMixed'] });
    }
  });

  it('MIRRORED_REPEAT is read as repeat and reported; with a clamp beside it, mixed too', () => {
    expect(gltfSamplerValues({ wrapS: MIRROR, wrapT: MIRROR })).toEqual({ values: {}, unsupported: ['wrapMirrored'] });
    expect(gltfSamplerValues({ wrapS: MIRROR, wrapT: REPEAT })).toEqual({ values: {}, unsupported: ['wrapMirrored'] });
    expect(gltfSamplerValues({ wrapS: MIRROR, wrapT: CLAMP })).toEqual({ values: {}, unsupported: ['wrapMirrored', 'wrapMixed'] });
  });

  it('magFilter NEAREST → filter: nearest; min filters are never reported', () => {
    expect(gltfSamplerValues({ magFilter: 9728 })).toEqual({ values: { filter: 'nearest' }, unsupported: [] });
    for (const minFilter of [9728, 9729, 9984, 9985, 9986, 9987]) {
      expect(gltfSamplerValues({ minFilter })).toEqual({ values: {}, unsupported: [] });
    }
    expect(gltfSamplerValues({ wrapS: CLAMP, wrapT: CLAMP, magFilter: 9728 }).values).toEqual({ repeat: 0, filter: 'nearest' });
  });

  it('an unknown or mistyped enum is REPEAT / LINEAR, as GLTFLoader and the reader read it', () => {
    for (const bad of ['33071', 33071.5, NaN, null, true, 12345, -1, '9728']) {
      expect(gltfSamplerValues({ wrapS: bad, wrapT: bad, magFilter: bad }), String(bad)).toEqual({ values: {}, unsupported: [] });
    }
  });

  it('reads OWN properties only', () => {
    const inherited = Object.create({ wrapS: CLAMP, wrapT: CLAMP, magFilter: 9728 });
    expect(gltfSamplerValues(inherited)).toEqual({ values: {}, unsupported: [] });
  });

  it('what it writes is what the texture spec reads back', () => {
    const clampNearest = readImageTextureSpec(gltfSamplerValues({ wrapS: CLAMP, wrapT: CLAMP, magFilter: 9728 }).values);
    expect(clampNearest.repeat).toBe(false);
    expect(clampNearest.nearest).toBe(true);
    const plain = readImageTextureSpec(gltfSamplerValues({}).values);
    expect(plain.repeat).toBe(true);
    expect(plain.nearest).toBe(false);
  });

  it('never writes a mapping key: the sampler lands on the texture, not on the UVs', () => {
    const { values } = gltfSamplerValues({ wrapS: CLAMP, wrapT: CLAMP, magFilter: 9728 });
    for (const k of UV_MAPPING_KEYS) expect(k in values, k).toBe(false);
  });
});

describe('imageUvMapping: one reader, one leaf', () => {
  it('agrees with the texture spec about orientation on every value', () => {
    for (const v of [...JUNK, 'gltf', 'app', undefined]) {
      expect(readImageTextureSpec({ orientation: v }).flipY, String(v))
        .toBe(readImageUvMapping({ orientation: v }).orientation !== 'gltf');
    }
  });

  it('is a leaf: it imports nothing', () => {
    expect(SRC).not.toMatch(/^\s*import\s/m);
    expect(SRC).not.toMatch(/\brequire\(/);
  });

  it('lists the eight keys in the documented order', () => {
    expect([...UV_MAPPING_KEYS]).toEqual([
      'orientation', 'normalGreen', 'uvSet', 'xfOffsetX', 'xfOffsetY', 'xfRotation', 'xfScaleX', 'xfScaleY',
    ]);
  });
});
