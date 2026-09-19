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
import { MAX_PARTS, MAX_ADDED_MATERIALS } from '@/utils/outputMaterials';
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
    const out = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    expect((out.data as { materials?: { meshTargets?: string[] }[] }).materials?.map((m) => m.meshTargets))
      .toEqual([names('a', 5), names('b', 5)]);
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
    expect(src).toContain('planNamedParts(materials).entries');
    expect(src).not.toContain('parts.length >= MAX_PARTS');
    expect(src).not.toMatch(/\bMAX_PARTS\b/);
  });
});
