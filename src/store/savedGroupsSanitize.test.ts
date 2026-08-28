import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadSavedGroups } from './useAppStore';

/**
 * fs:savedGroups is the THIRD untrusted restore path (same localStorage trust
 * level as fs:graph), and instantiating a saved group clones its nodes/edges
 * straight into the live graph. Both render-time sinks throw with no error
 * boundary anywhere in the app: ShaderNode does `new Set(data.exposedPorts)`
 * (`new Set(5)` is a TypeError) and TypedEdge dereferences `waypoints[i].x`.
 * A poisoned group must therefore be REPAIRED at load, exactly like loadGraph
 * and applyProjectToStore repair the other two paths.
 */
describe('loadSavedGroups sanitizes fs:savedGroups as adversarial input', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(value: string) {
    const store: Record<string, string> = { 'fs:savedGroups': value };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  }

  it('repairs poisoned exposedPorts and edge waypoints before they can reach render', () => {
    stubStorage(JSON.stringify([
      {
        id: 'g1',
        name: 'evil',
        color: '#ff0000',
        nodes: [
          {
            id: 'a',
            type: 'shader',
            position: { x: 0, y: 0 },
            data: { registryType: 'perlin', label: 'perlin', values: {}, exposedPorts: 5 },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 'a',
            sourceHandle: 'out',
            target: 'b',
            targetHandle: 'x',
            data: { waypoints: [null, { x: '1e999', y: 0 }, { x: 1, y: 2 }] },
          },
        ],
      },
    ]));

    const groups = loadSavedGroups();
    expect(groups).toHaveLength(1);

    for (const n of groups[0].nodes) {
      const ep = (n.data as { exposedPorts?: unknown }).exposedPorts;
      expect(ep === undefined || Array.isArray(ep)).toBe(true);
      expect(() => new Set((ep as string[]) ?? [])).not.toThrow();
    }
    for (const e of groups[0].edges) {
      const wps = (e.data?.waypoints ?? []) as Array<{ x: number; y: number }>;
      expect(Array.isArray(wps)).toBe(true);
      for (const w of wps) {
        expect(Number.isFinite(w.x)).toBe(true);
        expect(Number.isFinite(w.y)).toBe(true);
      }
    }
  });

  it('keeps well-formed groups intact', () => {
    stubStorage(JSON.stringify([
      {
        id: 'g2',
        name: 'fine',
        color: '#00ff00',
        nodes: [
          {
            id: 'a',
            type: 'shader',
            position: { x: 0, y: 0 },
            data: { registryType: 'mul', label: 'mul', values: {}, exposedPorts: ['a'] },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 'x',
            sourceHandle: 'out',
            target: 'a',
            targetHandle: 'a',
            data: { waypoints: [{ x: 10, y: 20 }] },
          },
        ],
      },
    ]));

    const groups = loadSavedGroups();
    expect(groups).toHaveLength(1);
    expect((groups[0].nodes[0].data as { exposedPorts?: string[] }).exposedPorts).toEqual(['a']);
    expect(groups[0].edges[0].data?.waypoints).toEqual([{ x: 10, y: 20 }]);
  });

  it('non-array and element-shape garbage degrade to an empty library', () => {
    stubStorage('{"not":"an array"}');
    expect(loadSavedGroups()).toEqual([]);
    stubStorage(JSON.stringify([null, 42, { id: 'x' }, { id: 'y', nodes: 'nope', edges: [] }]));
    expect(loadSavedGroups()).toEqual([]);
  });

  /**
   * A group may legitimately CONTAIN the Output — `groupSelection` filters only
   * groups and notes — so its per-mesh MATERIALS arrive by this path too. It
   * was the one restore path `sanitizeOutputMaterials`' own docstring claimed
   * to cover and did not: `loadGraph` and `applyProjectToStore` ran it, this
   * did not.
   */
  it('repairs Output materials, the third payload this path carries', () => {
    const output = (id: string, materials: unknown) => ({
      id,
      type: 'output',
      position: { x: 0, y: 0 },
      data: { registryType: 'output', label: 'Output', materials },
    });
    stubStorage(JSON.stringify([
      {
        id: 'g3',
        name: 'materials',
        color: '#00ff00',
        nodes: [
          output('a', 'Glass'),                       // not an array
          output('b', [
            { meshTargets: ['Glass'], junk: 'x'.repeat(4000) }, // unbounded ride-along
            { meshTargets: ['Glass'] },        // duplicate claim: LEGAL
            { values: { color: '#ff0000' } },         // no target: shades nothing
            // A control character, built rather than written: a raw byte makes
            // this file binary to grep (`sourceControlBytes.test.ts` fails on
            // one) and an escape is easy to mis-copy as a literal backslash.
            { meshTarget: { name: String.fromCharCode(1) + 'hidden' } },
          ]),
        ],
        edges: [],
      },
    ]));

    const groups = loadSavedGroups();
    expect(groups).toHaveLength(1);
    const [a, b] = groups[0].nodes;
    // A non-array `materials` is dropped outright.
    expect((a.data as { materials?: unknown }).materials).toBeUndefined();
    // The ride-along is stripped to `{ meshTargets }`. Nothing is DELETED: an
    // entry whose names are all unusable is kept EMPTY (it shades nothing,
    // which is a legal state and the one a mesh swap passes through), and a
    // duplicate claim is kept too — emission resolves that, first claim
    // winning. Dropping either here would delete a section the user can see,
    // with its wiring, on the next reload.
    expect((b.data as { materials?: unknown }).materials).toEqual([
      { meshTargets: ['Glass'] },
      { meshTargets: ['Glass'] },
      { meshTargets: [], values: { color: '#ff0000' } },
      { meshTargets: [] },
    ]);
    // Neither node is DELETED — each carries the user's wiring.
    expect(groups[0].nodes).toHaveLength(2);
  });
});
