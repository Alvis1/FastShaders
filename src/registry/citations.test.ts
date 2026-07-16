import { describe, it, expect } from 'vitest';
import { CITATIONS, getCitation } from './citations';
import { getAllDefinitions } from './nodeRegistry';
import { getBuiltinTextures } from './builtinTextures';

const nodeKeys = Object.keys(CITATIONS.nodes);
const textureKeys = Object.keys(CITATIONS.textures);

const allEntries: Array<[string, string, { ref: string; url?: string }]> = [
  ...nodeKeys.map((k) => ['nodes', k, CITATIONS.nodes[k]] as [string, string, { ref: string; url?: string }]),
  ...textureKeys.map((k) => ['textures', k, CITATIONS.textures[k]] as [string, string, { ref: string; url?: string }]),
];

describe('citations — key drift guards', () => {
  // DRIFT GUARD: a renamed/removed node type must fail CI rather than silently
  // orphan its citation.
  it('every `nodes` key is a real node type', () => {
    const realTypes = new Set(getAllDefinitions().map((d) => d.type));
    const orphans = nodeKeys.filter((k) => !realTypes.has(k));
    expect(orphans, `citations.json cites node types that no longer exist: ${orphans.join(', ')}`).toEqual([]);
  });

  // DRIFT GUARD: same for built-in texture ids.
  it('every `textures` key is a real texture id', () => {
    const realIds = new Set(getBuiltinTextures().map((t) => t.id));
    expect(realIds.size).toBe(8);
    const orphans = textureKeys.filter((k) => !realIds.has(k));
    expect(orphans, `citations.json cites texture ids that no longer exist: ${orphans.join(', ')}`).toEqual([]);
  });

  it('has no duplicate keys and is sparse by design', () => {
    // Coverage is deliberately partial — standard ops carry no citation.
    expect(nodeKeys.length).toBeLessThan(getAllDefinitions().length);
    expect(textureKeys.length).toBeLessThanOrEqual(8);
  });
});

describe('citations — entry shape', () => {
  it.each(allEntries)('%s.%s has a non-empty single-line ref', (_kind, _key, entry) => {
    expect(typeof entry.ref).toBe('string');
    expect(entry.ref.trim().length).toBeGreaterThan(0);
    // Refs render as one line in the table, and the /__nd/citations endpoint
    // rejects multi-line refs on write. (Not descriptionSplice's doing — that
    // only guards descriptions spliced into .ts; citations.json is plain JSON,
    // where a newline would escape legally and slip through unnoticed.)
    expect(entry.ref).not.toMatch(/[\r\n]/);
    expect(entry.ref).toBe(entry.ref.trim());
  });

  it.each(allEntries)('%s.%s has a valid absolute http(s) url when present', (_kind, _key, entry) => {
    if (entry.url === undefined) return;
    expect(entry.url).not.toMatch(/[\r\n\s]/);
    const parsed = new URL(entry.url);
    expect(['http:', 'https:']).toContain(parsed.protocol);
    expect(parsed.hostname.length).toBeGreaterThan(0);
  });

  it('exposes only the ref/url keys', () => {
    for (const [, , entry] of allEntries) {
      expect(Object.keys(entry).sort()).toEqual(entry.url === undefined ? ['ref'] : ['ref', 'url']);
    }
  });
});

describe('getCitation', () => {
  it('returns the entry for a known node type', () => {
    const c = getCitation('node', 'voronoi');
    expect(c?.ref).toMatch(/Worley/);
    expect(c?.url).toBe('https://doi.org/10.1145/237170.237267');
  });

  it('returns the entry for a known texture id', () => {
    const c = getCitation('texture', 'crumpled-fabric');
    expect(c?.ref).toMatch(/tsl-textures/);
  });

  it('returns undefined for an unknown key', () => {
    expect(getCitation('node', 'definitelyNotANode')).toBeUndefined();
    expect(getCitation('texture', 'definitelyNotATexture')).toBeUndefined();
  });

  it('returns undefined for standard ops that are intentionally uncited', () => {
    for (const t of ['add', 'mix', 'sin', 'smoothstep', 'clamp']) {
      expect(getCitation('node', t), `${t} must stay uncited`).toBeUndefined();
    }
  });

  it('does not leak inherited Object properties', () => {
    expect(getCitation('node', '__proto__')).toBeUndefined();
    expect(getCitation('node', 'constructor')).toBeUndefined();
    expect(getCitation('texture', 'toString')).toBeUndefined();
  });

  it('keeps node and texture namespaces separate', () => {
    expect(getCitation('node', 'crumpled-fabric')).toBeUndefined();
    expect(getCitation('texture', 'voronoi')).toBeUndefined();
  });
});
