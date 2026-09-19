/**
 * `unfoldOutputMaterials` — one Output NODE per material, the inverse of
 * `foldExtraOutputs` (the Output-split plan, step 6a's pure half).
 *
 * PURE and UNWIRED at this point: no restore path calls it yet, so nothing
 * else in the suite can prove it. Every assertion below is therefore a rule
 * that fails SILENTLY in production if it breaks — a stale edge id collides
 * with the next real edge, a fresh sibling id re-lays out a saved group on
 * every drop, a new array on a clean document rewrites `fs:graph` on every
 * boot, and a bogus bare handle is a wire that is in the store, emits nothing
 * and can never be drawn.
 */
import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, OutputMaterial } from '@/types';
import { unfoldOutputMaterials, emitRank, UNFOLD_DY } from './outputMaterials';
import { groupFrameSize } from './groupFrame';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { generateEdgeId } from './idGenerator';

/** An Output at `(x, y)` carrying `materials` plus any node-level fields. */
function output(
  id: string,
  materials?: OutputMaterial[],
  extra: Record<string, unknown> = {},
  at = { x: 100, y: 50 },
): AppNode {
  const node = makeNode(id, 'output');
  const d = node.data as Record<string, unknown>;
  d.values = { color: '#ff0000' };
  d.exposedPorts = ['color'];
  if (materials !== undefined) d.materials = materials;
  Object.assign(d, extra);
  (node as { position: { x: number; y: number } }).position = { ...at };
  return node;
}

const dataOf = (n: AppNode) => n.data as Record<string, unknown>;
const outs = (nodes: AppNode[]) => nodes.filter((n) => dataOf(n).registryType === 'output');

describe('unfoldOutputMaterials — the shape', () => {
  it('node 0 IS the original node, minus `materials`', () => {
    // Its id, position and channel state must survive: a fresh node for
    // material 0 would strand every edge on the bare handles that already
    // spell its channels, and lose its place in the user's layout.
    const o = output('o1', [{ meshTargets: ['Glass'] }], { meshTargets: ['Body'] });
    const r = unfoldOutputMaterials([o], []);
    const [first] = outs(r.nodes);
    expect(first.id).toBe('o1');
    expect(first.position).toEqual({ x: 100, y: 50 });
    expect(dataOf(first).values).toEqual({ color: '#ff0000' });
    expect(dataOf(first).exposedPorts).toEqual(['color']);
    expect(dataOf(first).meshTargets).toEqual(['Body']);
    expect('materials' in dataOf(first)).toBe(false);
  });

  it('each material becomes its own node, carrying its own binding and state', () => {
    const o = output('o1', [
      { meshTargets: ['Glass'], values: { color: '#00ff00' }, exposedPorts: ['color', 'opacity'] },
      { gltfMaterialIndex: 2, materialSettings: { transparent: true } },
    ], { modelSignature: { materials: ['A', 'B', 'C'] } });
    const [, glass, index2] = outs(unfoldOutputMaterials([o], []).nodes);

    expect(dataOf(glass).meshTargets).toEqual(['Glass']);
    expect(dataOf(glass).values).toEqual({ color: '#00ff00' });
    expect(dataOf(glass).exposedPorts).toEqual(['color', 'opacity']);
    // A named section is not an index section, and vice versa: carrying both
    // bindings would make the node two things at once.
    expect('gltfMaterialIndex' in dataOf(glass)).toBe(false);

    expect(dataOf(index2).gltfMaterialIndex).toBe(2);
    expect(dataOf(index2).materialSettings).toEqual({ transparent: true });
    expect('meshTargets' in dataOf(index2)).toBe(false);
    // No node carries `materials` afterwards — that key is what the split
    // retires, and step 6b's emission reads the node set instead.
    for (const n of outs(unfoldOutputMaterials([o], []).nodes)) {
      expect('materials' in dataOf(n)).toBe(false);
    }
  });

  it('the ACTIVE flag is never copied onto a sibling', () => {
    // Exactly one node may carry it (`normalizeActiveOutput`), and a TARGETED
    // one never should — a copied flag would make the election ambiguous and
    // hand a targeted node the module's top-level channels.
    const o = output('o1', [{ meshTargets: ['Glass'] }], { activeOutput: true });
    const [first, sibling] = outs(unfoldOutputMaterials([o], []).nodes);
    expect(dataOf(first).activeOutput).toBe(true);
    expect('activeOutput' in dataOf(sibling)).toBe(false);
  });

  it('siblings get deterministic, zero-padded ids and do not stack', () => {
    const o = output('o1', Array.from({ length: 11 }, (_, k) => ({ meshTargets: [`m${k}`] })));
    const nodes = outs(unfoldOutputMaterials([o], []).nodes);
    expect(nodes.map((n) => n.id)).toEqual([
      'o1', 'o1#m01', 'o1#m02', 'o1#m03', 'o1#m04', 'o1#m05',
      'o1#m06', 'o1#m07', 'o1#m08', 'o1#m09', 'o1#m10', 'o1#m11',
    ]);
    // Non-stacked: a shared position hides every sibling but the last behind
    // one card, which reads as the unfold having dropped them.
    const ys = nodes.map((n) => n.position.y);
    expect(new Set(ys).size).toBe(ys.length);
    expect(nodes.every((n) => n.position.x === 100)).toBe(true);
  });

  it('a sibling id never collides with a node already in the document', () => {
    // Node ids come out of a `.fastshader`, so a file may name a node exactly
    // what the unfold is about to mint. Two nodes with one id is a graph React
    // Flow cannot render.
    const o = output('o1', [{ meshTargets: ['Glass'] }, { meshTargets: ['Trim'] }]);
    const squatter = makeNode('o1#m01', 'add');
    const ids = unfoldOutputMaterials([o, squatter], []).nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('o1#m01#2');
  });
});

describe('unfoldOutputMaterials — the edges', () => {
  const doc = () => {
    const o = output('o1', [{ meshTargets: ['Glass'] }, { meshTargets: ['Trim'] }]);
    const edges = [
      makeEdge('a', 'out', 'o1', 'color'),
      makeEdge('b', 'out', 'o1', 'm1:color'),
      makeEdge('c', 'out', 'o1', 'm1:opacity'),
      makeEdge('d', 'out', 'o1', 'm2:emissive'),
      makeEdge('e', 'out', 'other', 'in'),
    ];
    return { nodes: [o, makeNode('other', 'add')], edges };
  };

  it('the edge count is invariant and every wire lands on its own material', () => {
    const { nodes, edges } = doc();
    const r = unfoldOutputMaterials(nodes, edges);
    expect(r.edges).toHaveLength(edges.length);
    const landing = r.edges.map((e) => [e.source, e.target, e.targetHandle]);
    expect(landing).toEqual([
      ['a', 'o1', 'color'],       // material 0 stays where it already is
      ['b', 'o1#m01', 'color'],
      ['c', 'o1#m01', 'opacity'],
      ['d', 'o1#m02', 'emissive'],
      ['e', 'other', 'in'],       // untouched
    ]);
  });

  it('a moved edge is RE-DERIVED, never re-labelled', () => {
    // The id is a function of the endpoints. A stale one collides with the
    // next edge that really does connect that pair, and any dedupe keyed on it
    // then drops one of the two.
    const { nodes, edges } = doc();
    const r = unfoldOutputMaterials(nodes, edges);
    for (const e of r.edges) {
      expect(e.id).toBe(generateEdgeId(e.source, e.sourceHandle ?? 'out', e.target, e.targetHandle ?? ''));
    }
    expect(r.edges.map((e) => e.id)).toContain('e-b-out-o1#m01-color');
    // …and the untouched ones keep the identity they arrived with.
    expect(r.edges[0]).toBe(edges[0]);
    expect(r.edges[4]).toBe(edges[4]);
  });

  it('a tampered handle cannot mint a port no node has', () => {
    // `parseChannelHandle` returns `{ index: 0, channel: <the whole string> }`
    // for anything it does not match, so without the port-list check `m1:zzz`
    // would land on a sibling wearing a bare handle that is in the store,
    // emits nothing, and can never be drawn or hit-tested.
    const o = output('o1', [{ meshTargets: ['Glass'] }]);
    const bad = [
      makeEdge('a', 'out', 'o1', 'm1:zzz'),          // real material, no such port
      makeEdge('b', 'out', 'o1', 'm9:color'),        // material that does not exist
      makeEdge('c', 'out', 'o1', 'm1:__proto__'),    // a prototype key is not a port
      makeEdge('d', 'out', 'o1', 'm1:constructor'),
    ];
    const kept = [
      makeEdge('e', 'out', 'o1', 'm0:color'),        // index 0 by the parse: node 0's own
      makeEdge('f', 'out', 'o1', 'not-a-handle'),
      makeEdge('g', 'out', 'o1', 'color'),
    ];
    const r = unfoldOutputMaterials([o], [...bad, ...kept]);
    // The bogus ones are dropped; the index-0 ones are left EXACTLY as they
    // arrived — they already sit on node 0, and pruning them is
    // `pruneOrphanMaterialEdges`' job, not the unfold's.
    expect(r.edges).toEqual(kept);
    for (const e of r.edges) expect(e.target).toBe('o1');
    // Every handle that survived onto a SIBLING is a real Output port.
    const ports = new Set(['color', 'emissive', 'roughness', 'metalness', 'opacity', 'discard', 'normal', 'env', 'position']);
    for (const e of r.edges) {
      if (e.target !== 'o1') expect(ports.has(String(e.targetHandle))).toBe(true);
    }
  });

  it('every one of the nine channels round-trips onto its sibling', () => {
    const o = output('o1', [{ meshTargets: ['Glass'] }]);
    // The registry's own list, so a channel added to the Output def joins this
    // sweep instead of being quietly untested.
    const channels = (NODE_REGISTRY.get('output')?.inputs ?? []).map((p) => p.id);
    expect(channels).toHaveLength(9);
    const edges = channels.map((c) => makeEdge('a', 'out', 'o1', `m1:${c}`));
    const r = unfoldOutputMaterials([o], edges);
    expect(r.edges.map((e) => e.targetHandle)).toEqual(channels);
    expect(r.edges.every((e) => e.target === 'o1#m01')).toBe(true);
  });
});

describe('unfoldOutputMaterials — emitOrder and the model fields', () => {
  it('emitOrder is seeded from the material index', () => {
    const o = output('o1', [{ meshTargets: ['A'] }, { meshTargets: ['B'] }, { meshTargets: ['C'] }]);
    expect(outs(unfoldOutputMaterials([o], []).nodes).map(emitRank)).toEqual([0, 1, 2, 3]);
  });

  it('emitRank refuses anything that is not an integer', () => {
    // A `.fastshader` may claim any value at all, and a reorder here rewrites
    // the module's `parts` key order — first-claim-wins flips on a duplicate
    // mesh name, with `errors: []` and nothing on screen to explain it.
    expect(emitRank(output('o', undefined, { emitOrder: 4 }))).toBe(4);
    expect(emitRank(output('o', undefined, { emitOrder: -3 }))).toBe(-3);
    for (const v of ['2', 2.5, Number.NaN, Infinity, null, true, [], {}, undefined]) {
      expect(emitRank(output('o', undefined, { emitOrder: v })), String(v)).toBe(0);
    }
    // Absent on every document written before the split.
    expect(emitRank(output('o'))).toBe(0);
  });

  it('modelSignature is REPLICATED on index nodes and dropped elsewhere', () => {
    const sig = { materials: ['A', 'B'] };
    const o = output('o1', [{ gltfMaterialIndex: 0 }, { meshTargets: ['Body'] }, { gltfMaterialIndex: 1 }], {
      modelSignature: sig,
    });
    const [zero, i0, named, i1] = outs(unfoldOutputMaterials([o], []).nodes);
    // Dormancy is per node, so every index node needs its own copy…
    expect(dataOf(i0).modelSignature).toEqual(sig);
    expect(dataOf(i1).modelSignature).toEqual(sig);
    // …and a node holding no index section has nothing for one to describe
    // (`sanitizeOutputMaterialsReport` strips exactly this).
    expect('modelSignature' in dataOf(zero)).toBe(false);
    expect('modelSignature' in dataOf(named)).toBe(false);
  });

  it('modelMeshes stays ONE WHOLE LIST on the lowest-emitRank index node', () => {
    // B5: gltfSectionBuilder fills it in first-scene-appearance order, which
    // INTERLEAVES materials, and `materialPartsMirrorPlan` walks that stored
    // order straight into module TEXT. Regrouping it by material would
    // silently reorder the mirror keys of every distributed single-GLB export.
    const meshes = [
      { name: 'Hull', material: 0 },
      { name: 'Glass', material: 1 },
      { name: 'Hull_1', material: 0 },
    ];
    const o = output('o1', [{ meshTargets: ['X'] }, { gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }], {
      modelSignature: { materials: ['A', 'B'] },
      modelMeshes: meshes,
    });
    const nodes = outs(unfoldOutputMaterials([o], []).nodes);
    const holders = nodes.filter((n) => 'modelMeshes' in dataOf(n));
    expect(holders).toHaveLength(1);
    expect(holders[0].id).toBe('o1#m02');              // the first INDEX material
    expect(emitRank(holders[0])).toBe(2);
    expect(dataOf(holders[0]).modelMeshes).toEqual(meshes);
  });

  it('a document with no index section keeps neither model field', () => {
    const o = output('o1', [{ meshTargets: ['Body'] }], {
      modelSignature: { materials: ['A'] },
      modelMeshes: [{ name: 'Hull', material: 0 }],
    });
    for (const n of outs(unfoldOutputMaterials([o], []).nodes)) {
      expect('modelSignature' in dataOf(n)).toBe(false);
      expect('modelMeshes' in dataOf(n)).toBe(false);
    }
  });
});

describe('unfoldOutputMaterials — identity and idempotence', () => {
  it('a document with no `materials` key is returned BY REFERENCE', () => {
    // The autosave subscriber and `selectionOnlyGraphChange` compare by
    // reference: a new array on a clean document rewrites `fs:graph` on every
    // boot and marks an untouched session dirty.
    const nodes = [output('o1'), makeNode('a', 'add')];
    const edges = [makeEdge('a', 'out', 'o1', 'color')];
    const r = unfoldOutputMaterials(nodes, edges);
    expect(r.nodes).toBe(nodes);
    expect(r.edges).toBe(edges);
    // A graph with no Output at all, likewise.
    const bare = [makeNode('a', 'add')];
    expect(unfoldOutputMaterials(bare, []).nodes).toBe(bare);
  });

  it('unfold ∘ unfold is the identity, by reference', () => {
    const o = output('o1', [{ meshTargets: ['Glass'] }, { gltfMaterialIndex: 0 }], {
      modelSignature: { materials: ['A'] },
    });
    const once = unfoldOutputMaterials([o, makeNode('a', 'add')], [makeEdge('a', 'out', 'o1', 'm1:color')]);
    const twice = unfoldOutputMaterials(once.nodes, once.edges);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
  });

  it('two calls on the same document mint the same ids and positions', () => {
    // One `.fastshader` must open the same way every time, or a saved group
    // re-lays out on every `instantiateSavedGroup`.
    const build = () => output('o1', [{ meshTargets: ['Glass'] }, { gltfMaterialIndex: 1 }], {
      modelSignature: { materials: ['A', 'B'] },
    });
    const a = unfoldOutputMaterials([build()], [makeEdge('x', 'out', 'o1', 'm2:color')]);
    const b = unfoldOutputMaterials([build()], [makeEdge('x', 'out', 'o1', 'm2:color')]);
    expect(a.nodes.map((n) => [n.id, n.position])).toEqual(b.nodes.map((n) => [n.id, n.position]));
    expect(a.edges.map((e) => [e.id, e.target, e.targetHandle]))
      .toEqual(b.edges.map((e) => [e.id, e.target, e.targetHandle]));
  });

  it('an empty `materials: []` loses the key — the split retires it', () => {
    // Not a clean document: the key itself is what goes. It costs one new
    // array, which is why the app never writes an empty list in the first
    // place (`foldExtraOutputs` only assigns a non-empty one).
    const o = output('o1', []);
    const r = unfoldOutputMaterials([o], []);
    expect(outs(r.nodes)).toHaveLength(1);
    expect('materials' in dataOf(r.nodes[0])).toBe(false);
    expect(emitRank(r.nodes[0])).toBe(0);
  });

  it('several folded Outputs unfold independently, each keeping its own place', () => {
    const a = output('a', [{ meshTargets: ['A1'] }], {}, { x: 0, y: 0 });
    const b = output('b', [{ meshTargets: ['B1'] }, { meshTargets: ['B2'] }], {}, { x: 500, y: 0 });
    const mid = makeNode('mid', 'add');
    const r = unfoldOutputMaterials([a, mid, b], [
      makeEdge('f', 'out', 'a', 'm1:color'),
      makeEdge('g', 'out', 'b', 'm2:color'),
    ]);
    // Array ORDER puts each node's siblings where it was; emitted order is
    // `emitRank` plus the node-id tie-break, never this.
    expect(r.nodes.map((n) => n.id)).toEqual(['a', 'a#m01', 'mid', 'b', 'b#m01', 'b#m02']);
    expect(r.edges.map((e) => e.target)).toEqual(['a#m01', 'b#m02']);
    expect(r.nodes.filter((n) => n.id.startsWith('b')).every((n) => n.position.x === 500)).toBe(true);
  });
});

/* ── a folded Output inside a GROUP ───────────────────────────────────────── */

/**
 * A sibling inherits `parentId` through the `{ ...out }` spread and is stacked
 * `i * UNFOLD_DY` below its original in the PARENT's space. `extent: 'parent'`
 * is stripped on load and never re-attached, so React Flow draws the overflow
 * OUTSIDE the frame rather than clamping it — and nothing in this app resizes a
 * frame after nodes are added to it programmatically.
 */
describe('a folded Output inside a group', () => {
  /** `output()`'s `extra` lands in node.DATA; `parentId` is a NODE field. */
  const inGroup = (n: AppNode, parentId: string) => ({ ...n, parentId }) as AppNode;
  const groupNode = (id: string, w: number, h: number, extra: Record<string, unknown> = {}) => ({
    ...makeNode(id, 'color'),
    type: 'group',
    position: { x: 0, y: 0 },
    width: w,
    height: h,
    data: { registryType: 'group', label: 'G', cost: 0, width: w, height: h, ...extra },
  }) as unknown as AppNode;

  it('grows the frame to hold the siblings, and only in height', () => {
    const g = groupNode('g', 300, 200);
    const out = inGroup(output('o1', [{ meshTargets: ['B'] }, { meshTargets: ['C'] }], {}, { x: 20, y: 20 }), 'g');
    const r = unfoldOutputMaterials([g, out], []);
    const grown = r.nodes.find((n) => n.id === 'g')!;
    // Siblings at y = 20 + 180 and 20 + 360; the lowest needs 380 + UNFOLD_DY.
    expect(groupFrameSize(grown)).toEqual({ w: 300, h: 20 + 2 * UNFOLD_DY + UNFOLD_DY });
    // Membership is kept — they are the same material stack, in the same frame.
    for (const n of outs(r.nodes)) expect((n as { parentId?: string }).parentId).toBe('g');
  });

  it('a frame that already holds them comes back BY REFERENCE', () => {
    const g = groupNode('g', 300, 900);
    const out = inGroup(output('o1', [{ meshTargets: ['B'] }], {}, { x: 20, y: 20 }), 'g');
    const r = unfoldOutputMaterials([g, out], []);
    expect(r.nodes.find((n) => n.id === 'g')).toBe(g);
  });

  it('a PRE-EXISTING overflow by another member is NOT repaired', () => {
    // Vacuous against the current code ON PURPOSE: this is the assertion that
    // fails against the two obvious wrong fixes — fitting every member, and any
    // padded variant. Both resize a document that needed no change, and the
    // autosave compares the node array BY REFERENCE, so a new array on a clean
    // document rewrites `fs:graph` on every boot.
    const g = groupNode('g', 300, 200);
    const stray = { ...makeNode('c1', 'color'), position: { x: 10, y: 5000 }, parentId: 'g' } as AppNode;
    const out = inGroup(output('o1', [{ meshTargets: ['B'] }], {}, { x: 20, y: 0 }), 'g');
    const r = unfoldOutputMaterials([g, stray, out], []);
    // Only the minted sibling is fitted (it needs 0 + 180 + 180 = 360).
    expect(groupFrameSize(r.nodes.find((n) => n.id === 'g')!)).toEqual({ w: 300, h: 360 });
  });

  it('a COLLAPSED group is never grown', () => {
    const g = groupNode('g', 130, 78, { collapsed: true });
    const out = inGroup(output('o1', [{ meshTargets: ['B'] }, { meshTargets: ['C'] }], {}, { x: 4, y: 4 }), 'g');
    const r = unfoldOutputMaterials([g, out], []);
    expect(r.nodes.find((n) => n.id === 'g')).toBe(g);
  });

  it('a document whose folded Outputs are at ROOT keeps its group nodes by reference', () => {
    const g = groupNode('g', 300, 200);
    const out = output('o1', [{ meshTargets: ['B'] }], {}, { x: 900, y: 900 });
    const r = unfoldOutputMaterials([g, out], []);
    expect(r.nodes.find((n) => n.id === 'g')).toBe(g);
  });
});
