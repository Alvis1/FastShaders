/**
 * The per-material Output SPLIT, on the card's side — what changed when one
 * Output node stopped holding a stack of materials and became exactly one.
 *
 * Everything here is EXECUTABLE. The vitest env is `node`, so the component
 * itself cannot be rendered (its pins live in outputTargetChip / the two
 * `.pins` files); what is driven here is the store and the pure rules the card
 * reads, because each of these fails SILENTLY on the canvas:
 *
 *  - a cross-node mesh move that leaves two Outputs claiming one mesh is legal
 *    for the store and resolved quietly at emission;
 *  - a wire-drop pin that loses its handle TYPE authors an edge out of an
 *    input, which React Flow draws as nothing while graphToCode still emits it;
 *  - dormancy that never fires leaves a stale node looking live, and dormancy
 *    that fires on the DEFAULT hides the module's own channels.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { HISTORY_IDLE, makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  assignMeshTargetsAcross,
  defaultOutput,
  defaultSectionUnusedAcross,
  dormantIndicesForPreview,
  firstNamedOutputId,
  indexSectionCoverageAcross,
  moduleSignatureOf,
  outputEdgeIsDormant,
  outputMaterials,
  outputNodes,
  planNamedPartsAcross,
  materialTargetNames,
} from '@/utils/outputMaterials';

/** An Output node carrying `extra` on its data. */
function out(id: string, extra: Record<string, unknown> = {}): AppNode {
  const n = makeNode(id, 'output');
  Object.assign(n.data as Record<string, unknown>, extra);
  return n;
}

const names = (n: AppNode) => materialTargetNames(outputMaterials(n)[0]);

/* ============================================================
 * assignMeshTargetsAcross — a mesh belongs to exactly one NODE
 * ============================================================ */

describe('assignMeshTargetsAcross', () => {
  it('MOVES a mesh: ticking it on B takes it from A', () => {
    const nodes = [out('a', { meshTargets: ['Body', 'Glass'] }), out('b', { meshTargets: ['Trim'] })];
    const next = assignMeshTargetsAcross(nodes, 'b', ['Trim', 'Body']);
    expect(names(next[0])).toEqual(['Glass']);
    expect(names(next[1])).toEqual(['Trim', 'Body']);
  });

  it('leaves a node EMPTY rather than deleting it — the state a swap passes through', () => {
    const nodes = [out('a', { meshTargets: ['Body'] }), out('b', { meshTargets: ['Glass'] })];
    const next = assignMeshTargetsAcross(nodes, 'b', ['Glass', 'Body']);
    expect(next).toHaveLength(2);
    expect(names(next[0])).toEqual([]);
    // An empty list DROPS the key, so an untargeted node is JSON-identical to
    // one that was never targeted — the autosave must not grow a `[]`.
    expect('meshTargets' in (next[0].data as object)).toBe(false);
  });

  it('never re-targets or strips an INDEX-bound node', () => {
    const nodes = [
      out('idx', { gltfMaterialIndex: 1, modelSignature: { materials: ['A', 'B'] } }),
      out('n', { meshTargets: ['Body'] }),
    ];
    // Targeting one is refused outright…
    expect(assignMeshTargetsAcross(nodes, 'idx', ['Body'])).toBe(nodes);
    // …and it is never stripped when another node claims a mesh.
    const next = assignMeshTargetsAcross(nodes, 'n', ['Glass']);
    expect(next[0]).toBe(nodes[0]);
    expect(names(next[1])).toEqual(['Glass']);
  });

  it('returns the SAME array when nothing changed (the autosave compares by identity)', () => {
    const nodes = [out('a', { meshTargets: ['Body'] }), out('b')];
    expect(assignMeshTargetsAcross(nodes, 'a', ['Body'])).toBe(nodes);
    expect(assignMeshTargetsAcross(nodes, 'b', [])).toBe(nodes);
    // An unknown id changes nothing either.
    expect(assignMeshTargetsAcross(nodes, 'nope', ['Body'])).toBe(nodes);
  });

  it('drops the legacy single-target key on any edit', () => {
    const nodes = [out('a', { meshTarget: { name: 'Old' } })];
    const next = assignMeshTargetsAcross(nodes, 'a', ['New']);
    expect(names(next[0])).toEqual(['New']);
    expect('meshTarget' in (next[0].data as object)).toBe(false);
  });

  it('refuses junk names, so a tick can never write one emission drops on read', () => {
    const nodes = [out('a')];
    const next = assignMeshTargetsAcross(nodes, 'a', ['Body', '', '__proto__', 'Body', 'a\u0000b'] as string[]);
    expect(names(next[0])).toEqual(['Body']);
  });

  it('leaves NON-Output nodes untouched, by reference', () => {
    const mul = makeNode('m', 'mul');
    const nodes = [mul, out('a', { meshTargets: ['Body'] })];
    const next = assignMeshTargetsAcross(nodes, 'a', ['Glass']);
    expect(next[0]).toBe(mul);
  });
});

describe('the node commits that move as ONE history entry', () => {
  beforeEach(() => {
    useAppStore.setState({
      nodes: [out('a', { meshTargets: ['Body'] }), out('b', { meshTargets: ['Glass'] })],
      edges: [],
      past: [],
      future: [],
      ...HISTORY_IDLE,
    });
  });

  it('one undo step puts BOTH nodes back', () => {
    // This is what the node's `setMeshTargets` does: the no-op guard, then one
    // `setNodes` inside one `asOneHistoryEntry`. Driven here rather than
    // source-pinned, because "two writes" is indistinguishable from "one" until
    // someone presses Cmd+Z and lands in a state where both nodes claim Body.
    const s = useAppStore.getState();
    const next = assignMeshTargetsAcross(s.nodes, 'b', ['Glass', 'Body']);
    expect(next).not.toBe(s.nodes);
    s.beginInteraction();
    useAppStore.getState().setNodes(next);
    useAppStore.getState().endInteraction();

    expect(useAppStore.getState().past).toHaveLength(1);
    expect(names(useAppStore.getState().nodes[0])).toEqual([]);

    useAppStore.getState().undo();
    const back = useAppStore.getState().nodes;
    expect(names(back[0]), 'A got its mesh back').toEqual(['Body']);
    expect(names(back[1]), 'B is back to its own').toEqual(['Glass']);
  });
});

/* ============================================================
 * The wire-drop pin — the argument that renders as nothing
 * ============================================================ */

describe('openContextMenu carries the wire-drop pin', () => {
  beforeEach(() => useAppStore.getState().closeContextMenu());

  it('keeps the handle TYPE, which decides which way the menu connects', () => {
    // `materialIndex` used to sit between `sourceHandleId` and
    // `sourceHandleType`. Shifting the arguments instead of naming them would
    // have put the handle type in the retired slot and left it undefined —
    // and a wire dropped from an INPUT would then connect backwards, which
    // React Flow draws as NO EDGE while the store keeps it and graphToCode
    // still emits it.
    useAppStore.getState().openContextMenu(10, 20, 'canvas', undefined, undefined, {
      sourceNodeId: 'n1',
      sourceHandleId: 'b',
      sourceHandleType: 'target',
    });
    expect(useAppStore.getState().contextMenu).toMatchObject({
      open: true, x: 10, y: 20, type: 'canvas',
      sourceNodeId: 'n1', sourceHandleId: 'b', sourceHandleType: 'target',
    });
  });

  it('the other direction survives too, and a node menu carries no pin at all', () => {
    useAppStore.getState().openContextMenu(1, 2, 'canvas', undefined, undefined, {
      sourceNodeId: 'n1', sourceHandleId: 'out', sourceHandleType: 'source',
    });
    expect(useAppStore.getState().contextMenu.sourceHandleType).toBe('source');

    useAppStore.getState().openContextMenu(3, 4, 'node', 'n9');
    const cm = useAppStore.getState().contextMenu;
    expect(cm).toMatchObject({ type: 'node', nodeId: 'n9' });
    expect(cm.sourceHandleType).toBeUndefined();
    expect(cm.sourceNodeId).toBeUndefined();
  });

  it('an edge menu still takes its id in the 5th slot', () => {
    useAppStore.getState().openContextMenu(5, 6, 'canvas', undefined, 'e-1');
    expect(useAppStore.getState().contextMenu).toMatchObject({ edgeId: 'e-1' });
    expect(useAppStore.getState().contextMenu.nodeId).toBeUndefined();
  });
});

/* ============================================================
 * Dormancy at NODE scale
 * ============================================================ */

const AWAKE = { indexSectionsAwake: true } as const;

describe('a split Output node sleeps', () => {
  const dormant = (n: AppNode, opts: Partial<Parameters<typeof dormantIndicesForPreview>[1]> = {}) =>
    dormantIndicesForPreview(outputMaterials(n), {
      meshNames: [], inventoryKnown: true, defaultContributes: true, ...AWAKE, ...opts,
    });

  it('a TARGETED node whose meshes are all absent is dormant', () => {
    // The loops used to start at index 1, so a split node — whose binding IS
    // material 0's — could never sleep at all: dormancy was dead in the shape
    // the app now always runs in.
    expect(dormant(out('n', { meshTargets: ['Gone'] }))).toEqual(new Set([0]));
    expect(dormant(out('n', { meshTargets: ['Body'] }), { meshNames: ['Body'] })).toEqual(new Set());
  });

  it('an INDEX-bound node sleeps on the wrong model', () => {
    const n = out('i', { gltfMaterialIndex: 0, modelSignature: { materials: ['A'] } });
    expect(dormant(n, { indexSectionsAwake: false })).toEqual(new Set([0]));
    expect(dormant(n)).toEqual(new Set());
  });

  it('the DEFAULT never sleeps — it names nothing to be missing', () => {
    expect(dormant(out('d'))).toEqual(new Set());
    expect(dormant(out('d'), { indexSectionsAwake: false })).toEqual(new Set());
  });

  it('rule 2 exempts the MODULE’s first named part, not every node', () => {
    // A parts-only module on a one-mesh model (or a primitive) is painted by
    // loader 0.6's single-mesh fallback, which takes the FIRST part — that node
    // is shading the screen and hiding it would be a lie. Per node, every
    // targeted Output would claim the exemption and none would ever sleep.
    const a = out('a', { meshTargets: ['Gone'], emitOrder: 0 });
    const b = out('b', { meshTargets: ['AlsoGone'], emitOrder: 1 });
    const opts = { meshNames: [], inventoryKnown: true, defaultContributes: false, ...AWAKE };
    expect(firstNamedOutputId([a, b])).toBe('a');
    expect(dormantIndicesForPreview(outputMaterials(a), { ...opts, firstNamedHere: true })).toEqual(new Set());
    expect(dormantIndicesForPreview(outputMaterials(b), { ...opts, firstNamedHere: false })).toEqual(new Set([0]));
    // `firstNamedOutputId` follows emitRank, never array order — the nodes
    // array is re-ordered by an ordinary drag-into-a-group.
    expect(firstNamedOutputId([b, a])).toBe('a');
    // An untargeted node is never the first NAMED one.
    expect(firstNamedOutputId([out('d'), a])).toBe('a');
    expect(firstNamedOutputId([out('d')])).toBeNull();
  });
});

describe('the 008 swallow follows the node to sleep', () => {
  it('excuses a BARE channel handle on a sleeping node, and only there', () => {
    // A dormant node renders header-plus-chip and unmounts every one of its
    // bare channel handles, so React Flow's 008 about a wire into it is the
    // visibility rule's steady state — unscoped it floods the console at pan
    // rate. It stays narrow: the DEFAULT never sleeps, so an 008 about the node
    // holding the module's top-level channels still reports as the
    // missing-`useUpdateNodeInternals` bug it is.
    const sleeper = out('s', { meshTargets: ['Gone'], emitOrder: 1 });
    const def0 = out('d', { emitOrder: 0 });
    const intoSleeper = makeEdge('src', 'out', 's', 'color');
    const intoDefault = makeEdge('src', 'out', 'd', 'color');
    const state = {
      nodes: [def0, sleeper, makeNode('src', 'float')],
      edges: [intoSleeper, intoDefault],
      previewMesh: { kind: 'obj' },
      previewMeshInventory: { meshes: [{ name: 'Body' }] },
    };
    expect(outputEdgeIsDormant(state, intoSleeper.id)).toBe(true);
    expect(outputEdgeIsDormant(state, intoDefault.id)).toBe(false);
    expect(outputEdgeIsDormant(state, 'e-unknown')).toBe(false);
  });
});

/* ============================================================
 * The cross-node questions the card now asks
 * ============================================================ */

describe('the unused DEFAULT is judged on defaultOutput, not on the first node', () => {
  it('marks the untargeted node even when a TARGETED one ranks first', () => {
    // An import-built document's lowest-ranked Output is a targeted index node.
    // Judging the lowest-ranked one read its binding as "material 0 names a
    // mesh" and bailed, so the real default never got the mark.
    const idx = out('i', { emitOrder: 0, gltfMaterialIndex: 0, modelSignature: { materials: ['A'] } });
    const named = out('n', { emitOrder: 1, meshTargets: ['Body'] });
    const dflt = out('d', { emitOrder: 2 });
    const outs = outputNodes([idx, named, dflt]);
    expect(defaultOutput(outs)?.id).toBe('d');
    const plan = planNamedPartsAcross(outs);
    const cov = indexSectionCoverageAcross(outs, moduleSignatureOf(outs), { kind: 'unknown' }, plan);
    expect(defaultSectionUnusedAcross(['Body'], outs, plan, cov)).toBe(true);
    // One mesh left over and it is unmarked again.
    expect(defaultSectionUnusedAcross(['Body', 'Spare'], outs, plan, cov)).toBe(false);
  });

  it('marks it when a NAME-targeted node ranks first', () => {
    // The case the index fixture above CANNOT catch: `materialTargetNames`
    // reports [] for an index section, so the retired "does ordered[0] name a
    // mesh" guard passed it by accident. A NAME-targeted first node is what
    // that guard really read — and it bailed, leaving the real default
    // unmarked on exactly the document the mark was written for.
    const named = out('n', { emitOrder: 0, meshTargets: ['Body'] });
    const dflt = out('d', { emitOrder: 1 });
    const outs = outputNodes([named, dflt]);
    expect(defaultOutput(outs)?.id).toBe('d');
    expect(defaultSectionUnusedAcross(['Body'], outs, planNamedPartsAcross(outs), new Map())).toBe(true);
  });

  it('is false with no default at all — there is no whole-model block to mark', () => {
    const outs = outputNodes([out('n', { meshTargets: ['Body'] })]);
    const plan = planNamedPartsAcross(outs);
    expect(defaultSectionUnusedAcross(['Body'], outs, plan, new Map())).toBe(false);
  });
});

describe('moduleSignatureOf is ONE lookup, shared with emission', () => {
  it('takes the lowest-ranked contributing index node’s copy', () => {
    const dflt = out('d', { emitOrder: 0 });
    const a = out('a', { emitOrder: 1, gltfMaterialIndex: 0, modelSignature: { materials: ['A', 'B'] } });
    const b = out('b', { emitOrder: 2, gltfMaterialIndex: 1, modelSignature: { materials: ['A', 'B'] } });
    expect(moduleSignatureOf([dflt, a, b])).toEqual(['A', 'B']);
    // The untargeted default carries none — reading it THERE is what emitted
    // the red sentinel for every GLB-built shader with `errors: []`.
    expect(moduleSignatureOf([dflt])).toBeNull();
  });
});
