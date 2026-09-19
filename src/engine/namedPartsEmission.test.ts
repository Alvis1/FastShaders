/**
 * Emission's name-entry cap (GLB Phase 5 Step 4).
 *
 * graphToCode used to stop at `MAX_PARTS` (9) name entries IN TOTAL, below
 * what the node lets you author (9 sections of 9 names each), so the tenth
 * mesh of a shader silently rendered on its authored material while the node
 * showed it assigned. The loop now goes through `planNamedParts`, capped at
 * `MAX_PART_ENTRIES` (90). This is the step's one BYTE CHANGE, and it is
 * scoped: only graphs with more than 9 name entries emit anything new (they
 * now emit what the node shows); the byte-stability and outputParts suites
 * pin every other graph unchanged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import {
  MAX_PARTS,
  MAX_PART_ENTRIES,
  MAX_ADDED_MATERIALS,
  materialTargetNames,
  outputMaterials,
  outputsInEmitOrder,
} from '@/utils/outputMaterials';
import type { AppNode } from '@/types';

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function outputWith(material0: string[], sections: string[][]): AppNode {
  const node = makeNode('out1', 'output');
  const d = node.data as Record<string, unknown>;
  if (material0.length > 0) d.meshTargets = material0;
  if (sections.length > 0) d.materials = sections.map((meshTargets) => ({ meshTargets }));
  return node;
}

const keyCount = (code: string, prefix: string) =>
  (code.match(new RegExp(`"${prefix}\\d+": \\{`, 'g')) ?? []).length;

describe('the name-entry cap is every name the node can show', () => {
  it('two sections of five meshes emit all ten (the old cap dropped the tenth)', () => {
    const nodes = [
      makeNode('c1', 'color', { hex: '#22cc22' }),
      makeNode('c2', 'color', { hex: '#cc2222' }),
      outputWith([], [names('a', 5), names('b', 5)]),
    ];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color'), makeEdge('c2', 'out', 'out1', 'm2:color')];
    const { code } = graphToCode(nodes, edges);
    expect(keyCount(code, 'a')).toBe(5);
    expect(keyCount(code, 'b')).toBe(5);
    expect(code).toContain('"b4": { color: color2 }');
  });

  it('survives an Apply: the parse merges each section back, and re-emits the same bytes', () => {
    const nodes = [
      makeNode('c1', 'color', { hex: '#22cc22' }),
      makeNode('c2', 'color', { hex: '#cc2222' }),
      outputWith([], [names('a', 5), names('b', 5)]),
    ];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color'), makeEdge('c2', 'out', 'out1', 'm2:color')];
    const first = graphToCode(nodes, edges).code;
    const parsed = codeToGraph(first);
    // One Output NODE per material since the split, so the two five-mesh
    // sections come back as two siblings after the untargeted default — the
    // same merge, read off the sibling list instead of off `data.materials`.
    const outs = outputsInEmitOrder(parsed.nodes.filter((n) => n.data.registryType === 'output'));
    expect(outs.map((n) => materialTargetNames(outputMaterials(n)[0])))
      .toEqual([[], names('a', 5), names('b', 5)]);
    expect(graphToCode(parsed.nodes, parsed.edges).code).toBe(first);
  });

  it('nine full sections emit all 81 entries', () => {
    const node = outputWith(
      names('z', MAX_PARTS),
      Array.from({ length: MAX_ADDED_MATERIALS }, (_, s) => names(`s${s}x`, MAX_PARTS)),
    );
    const { code } = graphToCode([node], []);
    let total = keyCount(code, 'z');
    for (let s = 0; s < MAX_ADDED_MATERIALS; s++) total += keyCount(code, `s${s}x`);
    expect(total).toBe(MAX_PARTS * MAX_PARTS);
  });

  it('a shader with nine entries or fewer is unaffected (the old cap never bit it)', () => {
    const node = outputWith([], [names('a', 4), names('b', 5)]);
    const { code } = graphToCode([node], []);
    expect(keyCount(code, 'a') + keyCount(code, 'b')).toBe(9);
  });
});

describe('source pins', () => {
  const src = readFileSync(resolve(__dirname, 'graphToCode.ts'), 'utf8');

  it('graphToCode reads the ONE first-claim loop and carries no cap of its own', () => {
    // The CROSS-NODE form since the plans took the Output SET: one claim set
    // and one `MAX_PART_ENTRIES` counter for the whole module, over
    // `contributingOutputs` rather than one node's material list.
    expect(src).toContain('planNamedPartsAcross(outputs).entries');
    expect(src).not.toContain('planNamedParts(materials)');
    expect(src).not.toContain('parts.length >= MAX_PARTS');
    expect(src).not.toMatch(/\bMAX_PARTS\b/);
  });

  it('the Output set comes from the ONE resolver, never from a local find', () => {
    // `contributingOutputs` is where the set widens when per-material Output
    // nodes land; a local `nodes.filter(...)` here is how emission and the cost
    // walk drift apart (B2).
    expect(src).toContain('const outputs = marchNode ? [] : contributingOutputs(nodes);');
  });
});

/* ── the PARSE's budget is EMISSION's budget ──────────────────────────────── */

/**
 * Emission was widened to `MAX_PART_ENTRIES` (90) above; the PARSE was left at
 * `MAX_PARTS` (9), a PER-NODE cap. So `graphToCode → codeToGraph → graphToCode`
 * stopped being a fixed point for any document with more than nine mesh
 * entries — which an ordinary twelve-material GLB import is.
 *
 * The loss is silent and total: the warning is `severity: 'warning'`, which
 * `useSyncEngine` does not treat as blocking, and `carryInactiveSinks`
 * deliberately refuses to carry a TARGETED Output — so the surplus materials
 * and their wiring are gone after one Apply, and the next graph→code pass
 * writes the truncation back over the user's own source.
 */
describe("the parse admits everything emission can write", () => {
  /** N targeted Output NODES (the post-split shape), each with its own colour
   *  so the twelve part bodies differ and nothing merges. */
  function splitDoc(n: number): { nodes: AppNode[]; edges: ReturnType<typeof makeEdge>[] } {
    const nodes: AppNode[] = [];
    const edges: ReturnType<typeof makeEdge>[] = [];
    const def = makeNode('gi_output', 'output');
    (def.data as Record<string, unknown>).emitOrder = 0;
    nodes.push(def);
    for (let i = 0; i < n; i++) {
      const out = makeNode(`out_m${i}`, 'output');
      const d = out.data as Record<string, unknown>;
      d.meshTargets = [`Mesh${i}`];
      d.emitOrder = i + 1;
      nodes.push(out);
      const c = makeNode(`c${i}`, 'color', { hex: `#${(0x111111 * (i + 1)).toString(16).padStart(6, '0').slice(-6)}` });
      nodes.push(c);
      edges.push(makeEdge(`c${i}`, 'out', `out_m${i}`, 'color'));
    }
    return { nodes, edges };
  }

  const targeted = (ns: AppNode[]) =>
    outputsInEmitOrder(ns.filter((n) => n.data.registryType === 'output'))
      .map((n) => materialTargetNames(outputMaterials(n)[0]))
      .filter((t) => t.length > 0);

  it('a twelve-material document survives an Apply, WHOLE', () => {
    const { nodes, edges } = splitDoc(12);
    const code = graphToCode(nodes, edges).code;
    expect(keyCount(code, 'Mesh')).toBe(12);

    const parsed = codeToGraph(code);
    expect(parsed.errors).toEqual([]);
    expect(targeted(parsed.nodes)).toEqual(Array.from({ length: 12 }, (_, i) => [`Mesh${i}`]));
    // The fixed point: re-emitting the parse gives back the same module.
    expect(graphToCode(parsed.nodes, parsed.edges).code).toBe(code);
  });

  it('admits exactly MAX_PART_ENTRIES, and warns past it naming the module cap', () => {
    const full = splitDoc(MAX_PART_ENTRIES);
    const ok = codeToGraph(graphToCode(full.nodes, full.edges).code);
    expect(ok.errors).toEqual([]);
    expect(targeted(ok.nodes)).toHaveLength(MAX_PART_ENTRIES);

    // One over: emission itself stops at the cap, so the over-cap module has to
    // be built by hand — which is the only way to reach the warning at all now.
    const over = splitDoc(MAX_PART_ENTRIES + 1);
    const hand = graphToCode(over.nodes, over.edges).code.replace(
      '"Mesh0": {',
      `"Mesh${MAX_PART_ENTRIES}": { color: color1 }, "Mesh0": {`,
    );
    const parsed = codeToGraph(hand);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].severity).toBe('warning');
    expect(parsed.errors[0].message).toContain(`More than ${MAX_PART_ENTRIES}`);
    // NAMES, not nodes: the hand-inserted entry reuses an emitted body, so it
    // MERGES onto that node — 90 entries admitted across 89 nodes.
    expect(targeted(parsed.nodes).flat()).toHaveLength(MAX_PART_ENTRIES);
  });

  it('byte-identical bodies past a node’s NAME cap start a SIBLING', () => {
    // Twelve meshes wired to ONE colour: emission writes twelve keys with
    // identical bodies, and the parse merges them. It used to merge all twelve
    // onto one node, where `materialTargetNames` reads only the first nine —
    // three meshes stored, shown in the picker, absent from emission, and then
    // counted as trimmed by the next restore path.
    const nodes: AppNode[] = [makeNode('c1', 'color', { hex: '#22cc22' })];
    const def = makeNode('gi_output', 'output');
    (def.data as Record<string, unknown>).emitOrder = 0;
    nodes.push(def);
    const edges: ReturnType<typeof makeEdge>[] = [];
    for (let i = 0; i < 12; i++) {
      const out = makeNode(`out_m${i}`, 'output');
      const d = out.data as Record<string, unknown>;
      d.meshTargets = [`Mesh${i}`];
      d.emitOrder = i + 1;
      nodes.push(out);
      edges.push(makeEdge('c1', 'out', `out_m${i}`, 'color'));
    }
    const code = graphToCode(nodes, edges).code;
    expect(keyCount(code, 'Mesh')).toBe(12);

    const parsed = codeToGraph(code);
    expect(parsed.errors).toEqual([]);
    const lists = targeted(parsed.nodes);
    expect(lists.map((l) => l.length)).toEqual([MAX_PARTS, 3]);
    // Nothing STORED that `materialTargetNames` would silently trim.
    for (const n of parsed.nodes.filter((x) => x.data.registryType === 'output')) {
      const raw = (n.data as { meshTargets?: string[] }).meshTargets ?? [];
      expect(raw.length).toBeLessThanOrEqual(MAX_PARTS);
    }
    // And all twelve meshes still shade.
    expect(keyCount(graphToCode(parsed.nodes, parsed.edges).code, 'Mesh')).toBe(12);
  });
});

describe('source pins: the parse counts ENTRIES against the MODULE cap', () => {
  const parse = readFileSync(resolve(__dirname, 'codeToGraph.ts'), 'utf8');

  it('caps at MAX_PART_ENTRIES, never at the per-node MAX_PARTS', () => {
    expect(parse).toContain('entries >= MAX_PART_ENTRIES');
    // The negative is the load-bearing half: `MAX_PARTS` reads like a module
    // budget and is not one, which is how this was written in the first place.
    expect(parse).not.toContain('named >= MAX_PARTS');
    expect(parse).not.toMatch(/let named = 0;/);
  });

  it('the merge branch respects the per-node NAME cap', () => {
    expect(parse).toMatch(/merged && \(merged\.meshTargets as string\[\]\)\.length < MAX_PARTS/);
  });
});
