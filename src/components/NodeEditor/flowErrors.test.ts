/**
 * The React Flow 008 suppression, end to end: the REAL library message →
 * `edgeIdFromError008` → `outputEdgeIsDormant`.
 *
 * Every message here is FORMATTED by `@xyflow/system`'s own `errorMessages`
 * table rather than transcribed, because the whole mechanism rests on a string
 * shape the app does not own. Transcribing it would leave this suite green
 * through a React Flow bump that renamed a word — and the failure that bump
 * causes is silent in the other direction too: the swallow simply stops
 * matching and a sleeping section warns at pan frame rate again.
 *
 * The second half is the scope. A suppression that is too WIDE hides the
 * missing-`useUpdateNodeInternals` bug class NodeEditor's comment refuses to
 * hide, and nothing fails when it does: the wires just stop being drawn.
 */
import { describe, it, expect } from 'vitest';
import { errorMessages } from '@xyflow/system';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge, OutputMaterial } from '@/types';
import { edgeIdFromError008 } from './flowErrors';
import { outputEdgeIsDormant } from '@/utils/outputMaterials';

/** The message React Flow really emits for an edge it could not place. */
function message(side: 'source' | 'target', edge: AppEdge): string {
  return errorMessages['error008'](side, {
    id: edge.id,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  });
}

/** An Output whose added materials are `materials`, material 0 untargeted. */
function output(id: string, materials: OutputMaterial[]): AppNode {
  const node = makeNode(id, 'output');
  (node.data as Record<string, unknown>).materials = materials;
  // Material 0 emits something, so the 0.6 single-mesh exemption (which would
  // wake the first NAMED section) is not what these cases are measuring.
  (node.data as Record<string, unknown>).values = { color: '#ff0000' };
  (node.data as Record<string, unknown>).exposedPorts = ['color'];
  return node;
}

/** The store shape the swallow reads, with a reported two-mesh model. */
function state(nodes: AppNode[], edges: AppEdge[], meshes: string[]) {
  return {
    nodes,
    edges,
    previewMesh: { kind: 'obj' },
    previewMeshInventory: { meshes: meshes.map((name) => ({ name })) },
  };
}

describe('edgeIdFromError008', () => {
  it('reads the edge id out of the real message', () => {
    const e = makeEdge('n1', 'out', 'o1', 'm2:color');
    expect(message('target', e)).toBe(
      `Couldn't create edge for target handle id: "m2:color", edge id: ${e.id}.`,
    );
    expect(edgeIdFromError008(message('target', e))).toBe(e.id);
  });

  it('refuses a message about the SOURCE side', () => {
    // An absent SOURCE handle is always the missing-useUpdateNodeInternals
    // bug — even on an edge that happens to end on a dormant Output, which the
    // dormancy predicate would otherwise excuse. `getEdgePosition` reports
    // `source` whenever that is the side it could not resolve, so the side is
    // the only thing that tells the two apart.
    const e = makeEdge('n1', 'out', 'o1', 'm2:color');
    expect(edgeIdFromError008(message('source', e))).toBeNull();
  });

  it('survives an id whose own handles carry dots and separators', () => {
    // `generateEdgeId` splices the handles straight into the id, and a handle
    // can spell a mesh name (`Body.001`). Taking the id up to the FIRST dot,
    // or the first `, edge id: `, would truncate it and silently stop matching.
    const e = makeEdge('n1', 'out', 'o1', 'm1:Body.001');
    expect(e.id.endsWith('.001')).toBe(true);
    expect(edgeIdFromError008(message('target', e))).toBe(e.id);
  });

  it('ignores every other React Flow message', () => {
    for (const m of [
      errorMessages['error006'](),
      errorMessages['error007']('e1'),
      errorMessages['error010'](),
      '',
      "Couldn't create edge for target handle id: \"color\"",
    ]) {
      expect(edgeIdFromError008(m), m.slice(0, 40)).toBeNull();
    }
  });
});

describe('outputEdgeIsDormant — the scope', () => {
  const sleeping: OutputMaterial[] = [{ meshTargets: ['Gone'] }];
  const awake: OutputMaterial[] = [{ meshTargets: ['Body'] }];
  const meshes = ['Body', 'Glass'];

  it('swallows only the edge into the sleeping section', () => {
    const out = output('o1', sleeping);
    const wire = makeEdge('n1', 'out', 'o1', 'm1:color');
    const s = state([out], [wire], meshes);
    expect(outputEdgeIsDormant(s, wire.id)).toBe(true);
    expect(edgeIdFromError008(message('target', wire))).toBe(wire.id);

    // The very same node, section awake: the missing handle is a bug again.
    const live = state([output('o1', awake)], [wire], meshes);
    expect(outputEdgeIsDormant(live, wire.id)).toBe(false);
  });

  it('asks the node the wire lands on, not "any Output with this index"', () => {
    // THE defect the handle-keyed form could not avoid: two Outputs, each with
    // a material 1. One sleeps, the other is awake — and the awake one's
    // missing handle is a real 008 that the old rule excused, because it could
    // only see the string "m1:" and asked whether ANY Output's material 1 was
    // dormant.
    const asleep = output('sleeper', sleeping);
    const live = output('live', awake);
    const intoSleeper = makeEdge('n1', 'out', 'sleeper', 'm1:color');
    const intoLive = makeEdge('n1', 'out', 'live', 'm1:color');
    const s = state([asleep, live], [intoSleeper, intoLive], meshes);
    expect(outputEdgeIsDormant(s, intoSleeper.id)).toBe(true);
    expect(outputEdgeIsDormant(s, intoLive.id)).toBe(false);
  });

  it('material 0 is never dormant, so a BARE channel handle always warns', () => {
    // `dormantIndicesForPreview` starts every loop at 1. That is what keeps a
    // genuine missing bare handle — the common missing-useUpdateNodeInternals
    // symptom — reported on a node whose added sections happen to sleep.
    const out = output('o1', sleeping);
    const bare = makeEdge('n1', 'out', 'o1', 'color');
    expect(outputEdgeIsDormant(state([out], [bare], meshes), bare.id)).toBe(false);
  });

  it('an unknown id, a non-Output target and a handle-less edge all warn', () => {
    const out = output('o1', sleeping);
    const wire = makeEdge('n1', 'out', 'o1', 'm1:color');
    const s = state([out], [wire], meshes);
    // An id naming no edge: the parse read something else (a crafted handle
    // can spell the separator), and the safe direction is to print.
    expect(outputEdgeIsDormant(s, 'e-nothing')).toBe(false);
    // A collapsed GROUP's boundary handle: its target is not an Output, and a
    // 008 there really is the unmounted-handle bug.
    const grp = makeNode('g1', 'group');
    const intoGroup = makeEdge('n1', 'out', 'g1', 'm1:color');
    expect(outputEdgeIsDormant(state([out, grp], [intoGroup], meshes), intoGroup.id)).toBe(false);
    // An edge with no string handle cannot name a material.
    const loose = { ...wire, id: 'e-loose', targetHandle: null } as unknown as AppEdge;
    expect(outputEdgeIsDormant(state([out], [loose], meshes), 'e-loose')).toBe(false);
  });
});
