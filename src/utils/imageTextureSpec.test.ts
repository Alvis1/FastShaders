import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readImageTextureSpec, imageTextureSpecKey, type ImageTextureSpec } from './imageTextureSpec';

const SPEC_SRC = readFileSync(new URL('./imageTextureSpec.ts', import.meta.url), 'utf8');
const CODEGEN = readFileSync(new URL('../engine/graphToCode.ts', import.meta.url), 'utf8');
const PLAN = readFileSync(new URL('../engine/imageTexturePlan.ts', import.meta.url), 'utf8');

/**
 * The reads graphToCode's image branch did INLINE before this module existed,
 * restated verbatim. The spec must agree with them on every value, or an image
 * saved before the move would emit different texture settings after it.
 */
function historicalReads(nv: Record<string, unknown>) {
  const numVal = (key: string, dflt: number) => {
    const v = Number(nv[key]);
    return Number.isFinite(v) ? v : dflt;
  };
  return {
    isData: String(nv.colorSpace ?? 'color') === 'data',
    nearest: nv.filter === 'nearest',
    repeat: numVal('repeat', 1) >= 0.5,
  };
}

const JUNK: unknown[] = [
  undefined, null, '', ' ', 0, 1, -1, 0.4, 0.5, 0.49999, 2, NaN, Infinity, -Infinity,
  '0', '1', '0.5', 'x', 'data', 'DATA', 'Data', 'color', 'nearest', 'Nearest', 'linear',
  true, false, [], [1], {}, '__proto__', 'constructor',
];

describe('readImageTextureSpec', () => {
  it('reads an untouched node as a repeating, linear, colour texture', () => {
    expect(readImageTextureSpec({})).toEqual({ colorSpace: 'color', nearest: false, repeat: true, flipY: true });
  });

  it('agrees with the historical inline reads on every junk value, key by key', () => {
    for (const v of JUNK) {
      for (const key of ['colorSpace', 'filter', 'repeat']) {
        const values = { [key]: v };
        const spec = readImageTextureSpec(values);
        const old = historicalReads(values);
        expect(spec.colorSpace === 'data', `${key}=${String(v)}`).toBe(old.isData);
        expect(spec.nearest, `${key}=${String(v)}`).toBe(old.nearest);
        expect(spec.repeat, `${key}=${String(v)}`).toBe(old.repeat);
        expect(spec.flipY).toBe(true);
      }
    }
  });

  it('repeat: absent and non-finite mean repeat; null, empty and 0 mean clamp', () => {
    const rep = (v: unknown) => readImageTextureSpec(v === 'ABSENT' ? {} : { repeat: v }).repeat;
    expect(rep('ABSENT')).toBe(true);
    expect(rep(undefined)).toBe(true);
    expect(rep(NaN)).toBe(true);
    expect(rep('x')).toBe(true);
    expect(rep(Infinity)).toBe(true);
    expect(rep('1')).toBe(true);
    expect(rep(1)).toBe(true);
    expect(rep(0.5)).toBe(true);
    expect(rep(null)).toBe(false);
    expect(rep('')).toBe(false);
    expect(rep(0)).toBe(false);
    expect(rep(0.4)).toBe(false);
  });

  it('colour space and filter are exact-string compares', () => {
    expect(readImageTextureSpec({ colorSpace: 'data' }).colorSpace).toBe('data');
    for (const v of [undefined, 'color', 'DATA', 'Data', ' data', 5, true]) {
      expect(readImageTextureSpec({ colorSpace: v }).colorSpace).toBe('color');
    }
    expect(readImageTextureSpec({ filter: 'nearest' }).nearest).toBe(true);
    for (const v of [undefined, 'Nearest', 'NEAREST', 'linear', true, 1]) {
      expect(readImageTextureSpec({ filter: v }).nearest).toBe(false);
    }
  });

  it('ignores the uv-expression settings, the Flip Y checkbox included', () => {
    const plain = readImageTextureSpec({});
    const uvOnly = readImageTextureSpec({ tileX: 2, tileY: 3, offsetX: 0.5, offsetY: 0.25, flipX: 1, flipY: 1 });
    expect(uvOnly).toEqual(plain);
    expect(readImageTextureSpec({ flipY: 0 }).flipY).toBe(true);
  });

  it('works on a null-prototype values object', () => {
    const values = Object.create(null) as Record<string, unknown>;
    values.colorSpace = 'data';
    expect(readImageTextureSpec(values)).toEqual({ colorSpace: 'data', nearest: false, repeat: true, flipY: true });
  });
});

describe('imageTextureSpecKey', () => {
  const specs: ImageTextureSpec[] = [];
  for (const colorSpace of ['color', 'data'] as const) {
    for (const nearest of [false, true]) {
      for (const repeat of [false, true]) specs.push({ colorSpace, nearest, repeat, flipY: true });
    }
  }

  it('spells the default spec as documented', () => {
    expect(imageTextureSpecKey(readImageTextureSpec({}))).toBe('color|linear|repeat|flipY');
    expect(imageTextureSpecKey({ colorSpace: 'data', nearest: true, repeat: false, flipY: true })).toBe('data|nearest|clamp|flipY');
  });

  it('is injective over every spec and equal for equal specs', () => {
    const keys = specs.map(imageTextureSpecKey);
    expect(new Set(keys).size).toBe(specs.length);
    for (const s of specs) expect(imageTextureSpecKey({ ...s })).toBe(imageTextureSpecKey(s));
  });
});

describe('imageTextureSpec: the ONE normaliser', () => {
  it('is a leaf: the ONLY thing it imports is a deeper leaf', () => {
    // The rule is "never inside the store's import cycle" (the costTable
    // lesson: evaluating across the cycle during initialisation throws a TDZ
    // ReferenceError that depends on which module a vitest worker reached
    // first) — not "no imports" for its own sake. `utils/valueCoerce.ts` is
    // itself import-free, so the chain stays a leaf chain and no cycle is
    // reachable; it is here because this normaliser reads ADVERSARIAL
    // `values`, and a bare `String()`/`Number()` on a tampered entry throws
    // inside codegen, inside a render, with no error boundary above it.
    const imports = [...SPEC_SRC.matchAll(/^\s*import\s[^;]*from\s*'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./valueCoerce']);
    expect(SPEC_SRC).not.toMatch(/\brequire\(/);
    // …and the thing it imports imports nothing.
    const coerce = readFileSync(new URL('./valueCoerce.ts', import.meta.url), 'utf8');
    expect(coerce).not.toMatch(/^\s*import\s/m);
    expect(coerce).not.toMatch(/\brequire\(/);
  });

  it('the texture planner reads colour space, filter and wrap through it, and codegen reads them nowhere else', () => {
    // graphToCode's image branch places each node through the planner
    // (engine/imageTexturePlan.ts), which is where the spec is read now.
    expect(CODEGEN).toContain('imagePlanner.place(node.id, nv)');
    expect(PLAN).toContain("from '@/utils/imageTextureSpec'");
    expect(PLAN).toContain('readImageTextureSpec(values)');
    for (const src of [CODEGEN, PLAN]) {
      expect(src).not.toContain("numVal('repeat'");
      expect(src).not.toContain('String(nv.colorSpace');
      expect(src).not.toContain("nv.filter === 'nearest'");
    }
  });
});

describe('readImageTextureSpec: the glTF orientation is the flipY term', () => {
  it('exactly the string gltf uploads unflipped', () => {
    expect(readImageTextureSpec({ orientation: 'gltf' }).flipY).toBe(false);
    for (const v of [undefined, 'GLTF', 'gltf ', 'app', 1, true, null, '']) {
      expect(readImageTextureSpec({ orientation: v }).flipY, String(v)).toBe(true);
    }
  });

  it('keeps every existing key and appends noFlipY for the glTF orientation', () => {
    expect(imageTextureSpecKey(readImageTextureSpec({}))).toBe('color|linear|repeat|flipY');
    expect(imageTextureSpecKey(readImageTextureSpec({ orientation: 'gltf' }))).toBe('color|linear|repeat|noFlipY');
    const all: ImageTextureSpec[] = [];
    for (const colorSpace of ['color', 'data'] as const) {
      for (const nearest of [false, true]) {
        for (const repeat of [false, true]) {
          for (const flipY of [false, true]) all.push({ colorSpace, nearest, repeat, flipY });
        }
      }
    }
    expect(new Set(all.map(imageTextureSpecKey)).size).toBe(all.length);
  });

  it('no other mapping key reaches the texture key', () => {
    const plain = imageTextureSpecKey(readImageTextureSpec({}));
    expect(imageTextureSpecKey(readImageTextureSpec({
      uvSet: 2, normalGreen: 'flip', xfOffsetX: 1, xfOffsetY: 1, xfRotation: 1, xfScaleX: 2, xfScaleY: 2,
    }))).toBe(plain);
  });
});
