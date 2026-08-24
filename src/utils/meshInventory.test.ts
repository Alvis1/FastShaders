import { describe, it, expect } from 'vitest';
import {
  isUsableMeshName,
  sanitizeMeshInventory,
  meshNameCounts,
  MESH_NAME_MAX,
  MAX_INVENTORY_MESHES,
  MATERIAL_NAME_MAX,
} from './meshInventory';

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

describe('meshNameCounts', () => {
  it('counts duplicates — the ordinary case, not an error', () => {
    const counts = meshNameCounts([
      { index: 0, name: 'Dup', materialName: '', vertexCount: 1 },
      { index: 1, name: 'Dup', materialName: '', vertexCount: 1 },
      { index: 2, name: 'Solo', materialName: '', vertexCount: 1 },
    ]);
    expect(counts.get('Dup')).toBe(2);
    expect(counts.get('Solo')).toBe(1);
  });

  it('is a Map, so a mesh named like an Object member cannot fake a count', () => {
    const counts = meshNameCounts([
      { index: 0, name: 'toString', materialName: '', vertexCount: 1 },
    ]);
    expect(counts.get('toString')).toBe(1);
    expect(counts.get('constructor')).toBeUndefined();
    expect(counts.get('hasOwnProperty')).toBeUndefined();
  });
});
