import { describe, it, expect } from 'vitest';
import {
  isNavigable,
  nodeCentre,
  tabOrder,
  nextInTabOrder,
  traverseGraph,
  arrowDelta,
  arrowDirection,
  nextPane,
  PANES,
  ARROW_STEP,
  ARROW_SHIFT_FACTOR,
} from './keyboardNav';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

const at = (id: string, x: number, y: number, extra: Partial<AppNode> = {}): AppNode =>
  ({ ...makeNode(id, 'mul'), position: { x, y }, width: 100, height: 40, ...extra }) as AppNode;

describe('isNavigable', () => {
  it('skips members of a collapsed group', () => {
    // They stay in the `nodes` array with display:none so their rAF loops keep
    // running, so native tab order skips them but an array-derived cycle does
    // not — the cursor would land on an invisible node.
    expect(isNavigable(at('a', 0, 0))).toBe(true);
    expect(isNavigable(at('b', 0, 0, { className: 'fs-collapsed-member' } as Partial<AppNode>))).toBe(false);
    expect(isNavigable(at('c', 0, 0, { hidden: true } as Partial<AppNode>))).toBe(false);
  });
});

describe('nodeCentre', () => {
  it('resolves parent offsets', () => {
    const parent = at('g', 100, 200);
    const child = { ...at('c', 10, 20), parentId: 'g' } as AppNode;
    expect(nodeCentre(child, [parent, child])).toEqual({ x: 160, y: 240 });
  });

  it('survives a parent CYCLE, which is legal bytes in a tampered file', () => {
    const a = { ...at('a', 10, 10), parentId: 'b' } as AppNode;
    const b = { ...at('b', 20, 20), parentId: 'a' } as AppNode;
    expect(() => nodeCentre(a, [a, b])).not.toThrow();
  });
});

describe('tabOrder', () => {
  it('reads left-to-right then top-to-bottom, not array order', () => {
    // Array order is CREATION order, so on any real graph a Tab cycle built
    // from it jumps around the canvas at random. A shader graph reads inputs →
    // Output, so the cursor should too.
    const nodes = [at('z', 300, 0), at('a', 0, 0), at('m', 150, 0), at('low', 0, 200)];
    expect(tabOrder(nodes).map((n) => n.id)).toEqual(['a', 'm', 'z', 'low']);
  });

  it('bands rows so a few px of vertical jitter does not reorder a row', () => {
    const nodes = [at('right', 200, 6), at('left', 0, 0)];
    expect(tabOrder(nodes).map((n) => n.id)).toEqual(['left', 'right']);
  });

  it('is a total order, so the cycle cannot flicker between renders', () => {
    const nodes = [at('b', 0, 0), at('a', 0, 0)];
    expect(tabOrder(nodes).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('nextInTabOrder', () => {
  const nodes = [at('a', 0, 0), at('b', 150, 0), at('c', 300, 0)];

  it('wraps at both ends', () => {
    expect(nextInTabOrder(nodes, 'c', 1)).toBe('a');
    expect(nextInTabOrder(nodes, 'a', -1)).toBe('c');
  });

  it('starts at the appropriate end when nothing is focused', () => {
    expect(nextInTabOrder(nodes, null, 1)).toBe('a');
    expect(nextInTabOrder(nodes, null, -1)).toBe('c');
  });

  it('returns null on an empty canvas rather than throwing', () => {
    expect(nextInTabOrder([], null, 1)).toBeNull();
  });
});

describe('traverseGraph', () => {
  //  a ──▶ b ──▶ out
  //  d (below b, unwired)
  const nodes = [at('a', 0, 0), at('b', 200, 0), at('out', 400, 0), at('d', 200, 200)];
  const edges = [makeEdge('a', 'out', 'b', 'x'), makeEdge('b', 'out', 'out', 'color')];

  it('right follows the wire downstream, left follows it back', () => {
    expect(traverseGraph(nodes, edges, 'a', 'right')).toBe('b');
    expect(traverseGraph(nodes, edges, 'b', 'right')).toBe('out');
    expect(traverseGraph(nodes, edges, 'out', 'left')).toBe('b');
    expect(traverseGraph(nodes, edges, 'b', 'left')).toBe('a');
  });

  it('falls back to spatial when no wire leads that way', () => {
    // A modifier that silently does nothing reads as the app being broken —
    // the same rule the Output singleton and the WGSL toggle follow.
    expect(traverseGraph(nodes, edges, 'out', 'right')).toBeNull(); // nothing further right
    expect(traverseGraph(nodes, edges, 'd', 'left')).toBe('a');
  });

  it('up and down are spatial, since a graph has no vertical wires', () => {
    expect(traverseGraph(nodes, edges, 'b', 'down')).toBe('d');
    expect(traverseGraph(nodes, edges, 'd', 'up')).toBe('b');
  });

  it('picks the branch closest in Y when several wires leave one node', () => {
    const fan = [at('src', 0, 100), at('near', 200, 110), at('far', 200, 400)];
    const fanEdges = [makeEdge('src', 'out', 'near', 'x'), makeEdge('src', 'out', 'far', 'x')];
    expect(traverseGraph(fan, fanEdges, 'src', 'right')).toBe('near');
  });

  it('never returns a collapsed member', () => {
    const hidden = [
      at('a', 0, 0),
      at('h', 200, 0, { className: 'fs-collapsed-member' } as Partial<AppNode>),
      at('c', 400, 0),
    ];
    expect(traverseGraph(hidden, [], 'a', 'right')).toBe('c');
  });
});

describe('arrow helpers', () => {
  it('matches React Flow’s own velocity so replacing its handler changes nothing visible', () => {
    expect(arrowDelta('ArrowRight', false)).toEqual({ dx: ARROW_STEP, dy: 0 });
    expect(arrowDelta('ArrowUp', true)).toEqual({ dx: 0, dy: -ARROW_STEP * ARROW_SHIFT_FACTOR });
    expect(arrowDelta('Enter', false)).toBeNull();
  });

  it('maps keys to directions', () => {
    expect(arrowDirection('ArrowLeft')).toBe('left');
    expect(arrowDirection('x')).toBeNull();
  });
});

describe('nextPane', () => {
  const all = () => true;

  it('cycles in reading order and wraps', () => {
    expect(nextPane('toolbar', 1, all)?.id).toBe('canvas');
    expect(nextPane(PANES[PANES.length - 1].id, 1, all)?.id).toBe('toolbar');
    expect(nextPane('toolbar', -1, all)?.id).toBe(PANES[PANES.length - 1].id);
  });

  it('skips panes that are not on screen', () => {
    // The code panel is lazy, the asset bar can be collapsed, and the desktop
    // build hides controls the web build shows.
    const without = (ids: string[]) => (p: { id: string }) => !ids.includes(p.id);
    expect(nextPane('toolbar', 1, without(['canvas']))?.id).toBe('assets');
    expect(nextPane('toolbar', 1, without(['canvas', 'assets']))?.id).toBe('preview');
  });

  it('returns null when nothing is present rather than looping forever', () => {
    expect(nextPane('toolbar', 1, () => false)).toBeNull();
  });

  it('never points the preview at the sandboxed iframe itself', () => {
    // Once focus enters that cross-origin document no parent keydown fires at
    // all — including the Alt+Arrow meant to leave it again.
    const preview = PANES.find((p) => p.id === 'preview');
    expect(preview?.selector).not.toContain('iframe');
  });
});
