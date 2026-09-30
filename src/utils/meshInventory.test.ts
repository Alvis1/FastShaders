import { describe, it, expect } from 'vitest';
import {
  isUsableMeshName,
  sanitizeMeshInventory,
  sanitizeSplatReport,
  MESH_NAME_MAX,
  MAX_INVENTORY_MESHES,
  MATERIAL_NAME_MAX,
} from './meshInventory';
import { SPLAT_MAX_COUNT } from './splatLimits';

const entry = (over: Record<string, unknown> = {}) => ({
  index: 0,
  name: 'Body',
  materialName: 'Steel',
  vertexCount: 100,
  ...over,
});

describe('isUsableMeshName', () => {
  it('keeps the names three actually produces, in any language', () => {
    // The measured output of r184's PropertyBinding.sanitizeNodeName: it maps
    // whitespace to _ and strips [ ] . : / — and preserves everything else.
    // An ASCII whitelist here would make this app's own primary language
    // untargetable, which is why these are pinned by example.
    expect(isUsableMeshName('Body')).toBe(true);
    expect(isUsableMeshName('Ķermenis_āda_2')).toBe(true);
    expect(isUsableMeshName('Zīle')).toBe(true);
    expect(isUsableMeshName('メッシュ')).toBe(true);
    expect(isUsableMeshName('Стекло')).toBe(true);
    expect(isUsableMeshName('Body_1')).toBe(true);
  });

  it('keeps names only OBJ can produce — they are real and matchable', () => {
    // OBJLoader does not route `o`/`g` names through the sanitizer, so these
    // land in the scene verbatim and an exact-name dispatch does match them.
    expect(isUsableMeshName('my mesh')).toBe(true);
    expect(isUsableMeshName('Body.001')).toBe(true);
    expect(isUsableMeshName('a/b')).toBe(true);
    expect(isUsableMeshName('Sw[ord]')).toBe(true);
  });

  it('refuses what cannot be addressed or cannot be shown honestly', () => {
    expect(isUsableMeshName('')).toBe(false);
    expect(isUsableMeshName('a'.repeat(MESH_NAME_MAX + 1))).toBe(false);
    // Control characters and the two line terminators: invisible in every UI
    // that would show them, so a name carrying one cannot be displayed
    // honestly. A plain SPACE is fine and stays usable (see the OBJ case).
    expect(isUsableMeshName('a\u0000b')).toBe(false);
    expect(isUsableMeshName('a\nb')).toBe(false);
    expect(isUsableMeshName('a\u007Fb')).toBe(false);
    expect(isUsableMeshName('a\u009Fb')).toBe(false);
    expect(isUsableMeshName('a\u2028b')).toBe(false);
    expect(isUsableMeshName('a\u2029b')).toBe(false);
  });

  it('refuses __proto__ outright', () => {
    // Not because a Map cannot hold it, but because a name whose only effect is
    // to endanger every future plain-object lookup is not worth carrying.
    expect(isUsableMeshName('__proto__')).toBe(false);
    // Its neighbours are ordinary strings and stay usable — the refusal is
    // exactly one name, not a class of them.
    expect(isUsableMeshName('constructor')).toBe(true);
    expect(isUsableMeshName('toString')).toBe(true);
  });

  it('refuses every non-string', () => {
    for (const v of [null, undefined, 0, 1, true, {}, [], Symbol('x')]) {
      expect(isUsableMeshName(v)).toBe(false);
    }
  });
});

describe('sanitizeMeshInventory', () => {
  it('accepts a well-formed report', () => {
    const got = sanitizeMeshInventory('custom:3', [entry(), entry({ index: 1, name: 'Glass' })]);
    expect(got).toEqual({
      key: 'custom:3',
      truncated: false,
      meshes: [
        { index: 0, name: 'Body', materialName: 'Steel', vertexCount: 100 },
        { index: 1, name: 'Glass', materialName: 'Steel', vertexCount: 100 },
      ],
    });
  });

  it('returns null rather than an empty inventory', () => {
    // "no addressable meshes" and "no model" must look identical to readers.
    expect(sanitizeMeshInventory('custom:1', [])).toBeNull();
    expect(sanitizeMeshInventory('custom:1', [entry({ name: '' })])).toBeNull();
    expect(sanitizeMeshInventory('custom:1', 'not-an-array')).toBeNull();
    expect(sanitizeMeshInventory('custom:1', null)).toBeNull();
  });

  it('refuses a report with no usable key — a keyless report cannot be aged out', () => {
    expect(sanitizeMeshInventory('', [entry()])).toBeNull();
    expect(sanitizeMeshInventory(null, [entry()])).toBeNull();
    expect(sanitizeMeshInventory(7, [entry()])).toBeNull();
    expect(sanitizeMeshInventory('a\u0000b', [entry()])).toBeNull();
  });

  it('drops unusable entries without dropping the report', () => {
    const got = sanitizeMeshInventory('k', [
      entry({ name: 'Keep' }),
      entry({ name: '' }),
      entry({ name: '__proto__' }),
      'string',
      null,
      [],
      entry({ name: 'AlsoKeep' }),
    ]);
    expect(got?.meshes.map((m) => m.name)).toEqual(['Keep', 'AlsoKeep']);
    expect(got?.truncated).toBe(false);
  });

  it('coerces counts to finite non-negative integers', () => {
    const got = sanitizeMeshInventory('k', [
      entry({ vertexCount: -5, index: NaN }),
      entry({ name: 'B', vertexCount: Infinity, index: 2.7 }),
      entry({ name: 'C', vertexCount: '40', index: undefined }),
    ]);
    expect(got?.meshes[0]).toMatchObject({ vertexCount: 0, index: 0 });
    expect(got?.meshes[1]).toMatchObject({ index: 2 });
    expect(Number.isFinite(got!.meshes[1].vertexCount)).toBe(true);
    expect(got?.meshes[2]).toMatchObject({ vertexCount: 40, index: 0 });
  });

  it('caps the list and SAYS it capped', () => {
    const many = Array.from({ length: MAX_INVENTORY_MESHES + 5 }, (_, i) =>
      entry({ index: i, name: `M${i}` }),
    );
    const got = sanitizeMeshInventory('k', many);
    expect(got?.meshes).toHaveLength(MAX_INVENTORY_MESHES);
    // The overflow is reported so a shortened list is never presented as whole.
    expect(got?.truncated).toBe(true);
  });

  it('treats a material name as display-only: trimmed, never load-bearing', () => {
    const got = sanitizeMeshInventory('k', [
      entry({ materialName: 'x'.repeat(MATERIAL_NAME_MAX + 10) }),
      entry({ name: 'B', materialName: 'bad\u0007name' }),
      entry({ name: 'C', materialName: 42 }),
    ]);
    expect(got?.meshes[0].materialName).toHaveLength(MATERIAL_NAME_MAX);
    expect(got?.meshes[1].materialName).toBe('');
    expect(got?.meshes[2].materialName).toBe('');
  });

  it('never lets a forged payload reach the output shape', () => {
    // The preview runs adversarial shader code and can forge this message.
    const got = sanitizeMeshInventory('k', [
      { name: 'Body', extra: 'ignored', __proto__: { polluted: true } },
    ]);
    expect(Object.keys(got!.meshes[0]).sort()).toEqual(
      ['index', 'materialName', 'name', 'vertexCount'].sort(),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('sanitizeMeshInventory — a Gaussian splat row', () => {
  const splatRow = (over: Record<string, unknown> = {}) => ({
    index: 0, name: '', materialName: '', vertexCount: 0, splat: true, splats: 100_000, ...over,
  });

  it('keeps the splat BESIDE the meshes, never among them — it can never be a part target', () => {
    const got = sanitizeMeshInventory('custom:4', [splatRow()]);
    expect(got).toEqual({ key: 'custom:4', meshes: [], truncated: false, splat: { index: 0, splats: 100_000 } });
  });

  it('ignores whatever name, material or vertex count the splat row claims', () => {
    // A hostile document can name its splat row anything; a usable name must
    // still never reach the list targets are picked from.
    const got = sanitizeMeshInventory('custom:4', [
      splatRow({ name: 'Body', materialName: 'Steel', vertexCount: 999, index: 3 }),
    ]);
    expect(got?.meshes).toEqual([]);
    expect(got?.splat).toEqual({ index: 3, splats: 100_000 });
  });

  it('sits beside ordinary meshes without disturbing them', () => {
    const got = sanitizeMeshInventory('k', [entry(), splatRow({ index: 1 }), entry({ index: 2, name: 'Glass' })]);
    expect(got?.meshes.map((m) => m.name)).toEqual(['Body', 'Glass']);
    expect(got?.splat).toEqual({ index: 1, splats: 100_000 });
  });

  it('refuses a splat count that is not a safe integer in [0, SPLAT_MAX_COUNT]', () => {
    for (const splats of [-1, 1.5, SPLAT_MAX_COUNT + 1, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, '5', null, undefined, {}]) {
      expect(sanitizeMeshInventory('k', [splatRow({ splats })]), String(splats)).toBeNull();
    }
    expect(sanitizeMeshInventory('k', [splatRow({ splats: 0 })])?.splat).toEqual({ index: 0, splats: 0 });
    expect(sanitizeMeshInventory('k', [splatRow({ splats: SPLAT_MAX_COUNT })])?.splat?.splats).toBe(SPLAT_MAX_COUNT);
  });

  it('keeps only the first well-formed splat row', () => {
    const got = sanitizeMeshInventory('k', [splatRow({ splats: 'x' }), splatRow({ splats: 7 }), splatRow({ splats: 9 })]);
    expect(got?.splat).toEqual({ index: 0, splats: 7 });
  });

  it('only the literal `true` marks a splat row — anything else is an ordinary row, judged by its name', () => {
    for (const splat of [1, 'true', {}, false]) {
      const got = sanitizeMeshInventory('k', [entry({ splat, splats: 5 })]);
      expect(got?.splat, String(splat)).toBeUndefined();
      expect(got?.meshes).toEqual([{ index: 0, name: 'Body', materialName: 'Steel', vertexCount: 100 }]);
    }
  });

  it('adds no `splat` key at all to a mesh-only report, so it compares as it always did', () => {
    const got = sanitizeMeshInventory('k', [entry()]);
    expect(got && 'splat' in got).toBe(false);
  });
});

describe('sanitizeSplatReport — the fs:model-splat report', () => {
  const ok = { type: 'fs:model-splat', geometry: 'custom:9', count: 250_001, shDropped: 3 };

  it('accepts a report for the splat mesh on screen, as a fresh object', () => {
    const got = sanitizeSplatReport(ok, 'custom:9', 9);
    expect(got).toEqual({ meshId: 9, count: 250_001, shDropped: 3 });
    expect(got).not.toBe(ok);
    expect(Object.keys(got!).sort()).toEqual(['count', 'meshId', 'shDropped']);
  });

  it('refuses a report for another model: a stale key, another id, or no splat on screen', () => {
    expect(sanitizeSplatReport({ ...ok, geometry: 'custom:8' }, 'custom:9', 9)).toBeNull();
    expect(sanitizeSplatReport(ok, 'custom:8', 8)).toBeNull();
    // The live document key must be THIS mesh's (a rebuild window, a primitive).
    expect(sanitizeSplatReport(ok, '__primitive__', 9)).toBeNull();
    expect(sanitizeSplatReport(ok, 'custom:9', 10)).toBeNull();
    // The caller passes null when the loaded mesh is not a splat kind.
    expect(sanitizeSplatReport(ok, 'custom:9', null)).toBeNull();
    for (const id of [9.5, NaN, '9', undefined]) expect(sanitizeSplatReport(ok, 'custom:9', id)).toBeNull();
    for (const geometry of [undefined, null, 9, ['custom:9'], { toString: () => 'custom:9' }]) {
      expect(sanitizeSplatReport({ ...ok, geometry }, 'custom:9', 9)).toBeNull();
    }
  });

  it('refuses a junk count — never coerced', () => {
    for (const count of [-1, 0.5, SPLAT_MAX_COUNT + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity, '250001', null, undefined, true, [5], { valueOf: () => 5 }]) {
      expect(sanitizeSplatReport({ ...ok, count }, 'custom:9', 9), String(count)).toBeNull();
    }
    expect(sanitizeSplatReport({ ...ok, count: 0 }, 'custom:9', 9)?.count).toBe(0);
    expect(sanitizeSplatReport({ ...ok, count: SPLAT_MAX_COUNT }, 'custom:9', 9)?.count).toBe(SPLAT_MAX_COUNT);
  });

  it('accepts shDropped only as the literal 0, 1, 2 or 3', () => {
    for (const shDropped of [0, 1, 2, 3] as const) {
      expect(sanitizeSplatReport({ ...ok, shDropped }, 'custom:9', 9)?.shDropped).toBe(shDropped);
    }
    for (const shDropped of [4, -1, 1.5, '1', null, undefined, NaN, true]) {
      expect(sanitizeSplatReport({ ...ok, shDropped }, 'custom:9', 9), String(shDropped)).toBeNull();
    }
  });

  it('refuses a non-object report', () => {
    for (const r of [null, undefined, 'fs:model-splat', 7, [ok]]) expect(sanitizeSplatReport(r, 'custom:9', 9)).toBeNull();
  });
});
