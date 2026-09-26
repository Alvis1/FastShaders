import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';
import { resolveWireTargets } from './previewWires';

/**
 * The preview-wire set's CUSTOM-SINK half. A driving Raymarch or Splat Output
 * collapses the set to itself (it silences every plain Output), and the
 * module-scope memo must notice when the drive moves onto one — including the
 * click that flags a custom sink on a document where NO plain Output carried
 * the flag, which changes neither `outputBindingsKey` (plain Outputs only) nor
 * the edges array.
 */

const flag = (n: AppNode): AppNode => ({ ...n, data: { ...n.data, activeOutput: true } }) as AppNode;
const ids = (nodes: AppNode[], edges: AppEdge[]) => resolveWireTargets({ nodes, edges }).map((w) => w.id);

describe('resolveWireTargets — custom sinks', () => {
  it('a driving Splat Output is the one wire, under the DEFAULT label', () => {
    const nodes = [makeNode('c', 'color'), makeNode('sp', 'splatOutput'), makeNode('o1', 'output')];
    const edges = [makeEdge('c', 'out', 'sp', 'color')];
    const wires = resolveWireTargets({ nodes, edges });
    expect(wires).toEqual([{ id: 'sp', label: { kind: 'default' } }]);
  });

  for (const type of ['splatOutput', 'raymarchOutput']) {
    it(`flagging an UNWIRED ${type} moves the wire although no key the plain Outputs fold changed`, () => {
      const edges: AppEdge[] = [];
      const before = [makeNode('o1', 'output'), makeNode('sink', type)];
      expect(ids(before, edges)).toEqual(['o1']);
      // A new nodes array (what setActiveOutput writes), the SAME edges array.
      const after = [before[0], flag(before[1])];
      expect(ids(after, edges)).toEqual(['sink']);
      // …and back, when the plain Output is chosen again.
      const back = [flag(before[0]), before[1]];
      expect(ids(back, edges)).toEqual(['o1']);
    });
  }
});
