import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * toggleGroupCollapsed anchors at the group's TOP-RIGHT corner: the collapsed
 * pill appears where the frame's top-right was, and expanding grows the frame
 * leftward from the pill's top-right — so an untouched collapse/expand
 * round-trip restores the exact pre-collapse position (and with it every
 * hidden member's absolute spot).
 */

const COLLAPSED_W = 130; // mirrors the constant in toggleGroupCollapsed

function makeGroup(id: string, x: number, y: number, width: number, height: number): AppNode {
  return {
    id,
    type: 'group',
    position: { x, y },
    width,
    height,
    data: { label: id, color: '#dde', collapsed: false, width, height },
  } as unknown as AppNode;
}

function member(node: AppNode, parentId: string, x: number, y: number): AppNode {
  return { ...node, parentId, position: { x, y } } as AppNode;
}

function group(): AppNode {
  const g = useAppStore.getState().nodes.find((n) => n.id === 'g');
  if (!g) throw new Error('group missing');
  return g;
}

beforeEach(() => {
  // Phase 2 of the collapse rewires edges on the next animation frame; run it
  // synchronously in the node test env.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  useAppStore.setState({
    nodes: [
      makeGroup('g', 100, 50, 300, 200),
      member(makeNode('a', 'mul'), 'g', 20, 40),
      member(makeNode('b', 'mul'), 'g', 160, 40),
    ],
    edges: [makeEdge('a', 'out', 'b', 'a')],
    past: [],
    future: [],
    isUndoRedo: false,
    coalescingHistory: false,
  });
});

describe('toggleGroupCollapsed: top-right anchor', () => {
  it('collapse pins the top-right corner (x shifts by the width delta, y stays)', () => {
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group();
    // Old top-right: 100 + 300 = 400. Pill top-right must also be 400.
    expect(g.position.x + COLLAPSED_W).toBe(400);
    expect(g.position.x).toBe(100 + (300 - COLLAPSED_W));
    expect(g.position.y).toBe(50);
  });

  it('collapse → expand round-trips the exact position and size', () => {
    const before = group();
    useAppStore.getState().toggleGroupCollapsed('g');
    useAppStore.getState().toggleGroupCollapsed('g');
    const after = group();
    expect(after.position).toEqual(before.position);
    expect((after as AppNode & { width?: number }).width).toBe(300);
    expect((after as AppNode & { height?: number }).height).toBe(200);
    // Members keep their group-relative positions untouched throughout.
    const a = useAppStore.getState().nodes.find((n) => n.id === 'a');
    expect(a?.position).toEqual({ x: 20, y: 40 });
  });

  it('expand grows leftward from wherever the pill was dragged', () => {
    useAppStore.getState().toggleGroupCollapsed('g');
    // Simulate the user dragging the pill to a new spot.
    useAppStore.setState((s) => ({
      nodes: s.nodes.map((n) => (n.id === 'g' ? { ...n, position: { x: 600, y: 90 } } : n)),
    }));
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group();
    // Pill top-right was 600 + 130 = 730 → expanded frame's right edge stays 730.
    expect(g.position.x + 300).toBe(730);
    expect(g.position.y).toBe(90);
  });
});
