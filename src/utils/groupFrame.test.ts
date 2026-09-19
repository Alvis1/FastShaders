/**
 * `utils/groupFrame.ts` must stay a LEAF.
 *
 * It exists so `utils/outputMaterials.ts` can read a group frame's size without
 * importing the store: that module sits inside the store's import cycle
 * (`nodeCost → outputMaterials → exposedPorts → edgeUtils → useAppStore`), and
 * a second edge back into the store from inside it is the costTable TDZ class —
 * harmless until something evaluates across the cycle during initialisation,
 * which `useAppStore`'s module-scope `sanitizeCostMap`/`setCostOverrides` calls
 * do. A leaf can never be caught mid-init, so the cycle stays benign.
 *
 * Modelled on `costTable.test.ts`, which pins the same property for the same
 * reason and after the same class of measured flake.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  MIN_GROUP_H,
  absoluteNodePosition,
  groupFrameSize,
  growGroupFrames,
} from './groupFrame';
import { groupFrameSize as storeGroupFrameSize } from '@/store/useAppStore';

const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('the leaf stays a leaf', () => {
  it('imports nothing that could suspend it mid-initialisation', () => {
    const s = src('./groupFrame.ts');
    const imports = [...s.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const m of imports) {
      // `import type` is erased at compile time — a runtime edge is not.
      expect(m[1], `runtime import of ${m[2]}`).toBeTruthy();
    }
  });

  it('the store RE-EXPORTS rather than redeclaring, so there is one reader', () => {
    const store = src('../store/useAppStore.ts');
    expect(store).toContain('export { MIN_GROUP_W, MIN_GROUP_H, groupFrameSize };');
    expect(store).not.toMatch(/^export function groupFrameSize/m);
    expect(store).not.toMatch(/^export const MIN_GROUP_W/m);
    // Same function object, not a copy — the re-export is what keeps
    // GroupNode.tsx and groupCollapse.test.ts on one import site.
    expect(storeGroupFrameSize).toBe(groupFrameSize);
  });

  it('outputMaterials reads the leaf, never the store', () => {
    expect(src('./outputMaterials.ts')).not.toContain("from '@/store/useAppStore'");
    expect(src('./outputMaterials.ts')).toContain("from './groupFrame'");
  });
});

describe('absoluteNodePosition', () => {
  const at = (id: string, x: number, y: number, parentId?: string) => ({
    ...makeNode(id, 'color'),
    position: { x, y },
    ...(parentId ? { parentId } : {}),
  }) as AppNode;

  it('a root node is its own position', () => {
    const n = at('a', 5, 7);
    expect(absoluteNodePosition(n, new Map([[n.id, n]]))).toEqual({ x: 5, y: 7 });
  });

  it('sums a nested chain', () => {
    const outer = at('outer', 100, 100);
    const inner = at('inner', 50, 50, 'outer');
    const leaf = at('leaf', 10, 10, 'inner');
    const byId = new Map([outer, inner, leaf].map((n) => [n.id, n]));
    expect(absoluteNodePosition(leaf, byId)).toEqual({ x: 160, y: 160 });
  });

  it('reads the chain from `byId`, so a parentId-stripped copy still resolves', () => {
    // The resync's case exactly: `mergeMatch` keeps the position and drops the
    // parentId, and the frame is only in the OLD graph.
    const g = at('g', 1000, 600);
    const real = at('a', 20, 40, 'g');
    const stripped = at('a', 20, 40);
    const byId = new Map([g, real].map((n) => [n.id, n]));
    expect(absoluteNodePosition(stripped, byId)).toEqual({ x: 1020, y: 640 });
  });

  it('terminates on a cycle and on a missing parent', () => {
    const g1 = at('g1', 10, 10, 'g2');
    const g2 = at('g2', 20, 20, 'g1');
    const byId = new Map([g1, g2].map((n) => [n.id, n]));
    expect(Number.isFinite(absoluteNodePosition(g1, byId).y)).toBe(true);
    expect(absoluteNodePosition(at('x', 1, 2, 'nope'), new Map())).toEqual({ x: 1, y: 2 });
  });
});

describe('growGroupFrames', () => {
  const group = (id: string, w: number, h: number, data: Record<string, unknown> = {}) => ({
    ...makeNode(id, 'color'),
    type: 'group',
    position: { x: 0, y: 0 },
    width: w,
    height: h,
    data: { registryType: 'group', label: 'G', cost: 0, width: w, height: h, ...data },
  }) as unknown as AppNode;
  const child = (id: string, y: number, parentId?: string) => ({
    ...makeNode(id, 'color'),
    position: { x: 0, y },
    ...(parentId ? { parentId } : {}),
  }) as AppNode;

  it('returns the SAME array when there is nothing to add', () => {
    const nodes = [group('g', 300, 200), child('a', 10, 'g')];
    expect(growGroupFrames(nodes, new Set(), 180)).toBe(nodes);
    expect(growGroupFrames(nodes, new Set(['nope']), 180)).toBe(nodes);
  });

  it('returns the SAME array when the frame already holds the addition', () => {
    const nodes = [group('g', 300, 900), child('a', 10, 'g')];
    expect(growGroupFrames(nodes, new Set(['a']), 180)).toBe(nodes);
  });

  it('grows HEIGHT only, to the added child’s bottom edge', () => {
    const nodes = [group('g', 300, 200), child('a', 400, 'g')];
    const out = growGroupFrames(nodes, new Set(['a']), 180);
    expect(out).not.toBe(nodes);
    expect(groupFrameSize(out[0])).toEqual({ w: 300, h: 580 });
    // The canonical shape: top level AND the data mirror.
    expect((out[0] as { height?: number }).height).toBe(580);
    expect((out[0].data as { height?: number }).height).toBe(580);
  });

  it('never grows a COLLAPSED group — its size IS the pill’s', () => {
    const nodes = [group('g', 130, 78, { collapsed: true }), child('a', 400, 'g')];
    expect(growGroupFrames(nodes, new Set(['a']), 180)).toBe(nodes);
  });

  it('ignores an added node with no parent', () => {
    const nodes = [group('g', 300, 200), child('a', 4000)];
    expect(growGroupFrames(nodes, new Set(['a']), 180)).toBe(nodes);
  });

  it('floors at MIN_GROUP_H', () => {
    const nodes = [group('g', 300, 10), child('a', 0, 'g')];
    const out = growGroupFrames(nodes, new Set(['a']), 1);
    expect(groupFrameSize(out[0]).h).toBe(MIN_GROUP_H);
  });

  it('takes the LOWEST of several additions', () => {
    const nodes = [group('g', 300, 100), child('a', 200, 'g'), child('b', 500, 'g')];
    const out = growGroupFrames(nodes, new Set(['a', 'b']), 20);
    expect(groupFrameSize(out[0]).h).toBe(520);
  });
});
