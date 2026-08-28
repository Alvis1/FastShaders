import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave, groupFrameSize, MIN_GROUP_W, MIN_GROUP_H } from '@/store/useAppStore';

// isolate: false shares this worker's globals with later files — restore the
// real requestAnimationFrame and leave no armed autosave timer behind.
afterAll(() => {
  cancelPendingGraphSave();
  vi.unstubAllGlobals();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [] });
});
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

/**
 * Expanding must never produce a frame the size of the pill.
 *
 * The remembered size is written by the COLLAPSE, so a collapsed group whose
 * `expandedWidth` is missing — a hand-edited `fs:graph`, a group from a build
 * that stored it differently, or any future path that rewrites group data
 * without carrying it — used to expand to `currentWidth`, which at that point
 * IS the pill. The result reads as the expand silently failing, and it cannot
 * be fixed with the mouse: the corner grip only exists on an expanded frame,
 * and React Flow's resizer refuses to shrink a parent below its children, so
 * there is no gesture that gets a sane size back.
 */
describe('toggleGroupCollapsed: expand can never come back pill-sized', () => {
  /** Collapse, then strip the remembered size the way a lossy path would. */
  function collapseAndForget(keys: Array<'expandedWidth' | 'expandedHeight'>) {
    useAppStore.getState().toggleGroupCollapsed('g');
    useAppStore.setState((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id !== 'g') return n;
        const data = { ...(n.data as Record<string, unknown>) };
        for (const k of keys) delete data[k];
        return { ...n, data } as AppNode;
      }),
    }));
    useAppStore.getState().toggleGroupCollapsed('g');
    return group() as AppNode & { width?: number; height?: number };
  }

  it('falls back to a frame that CONTAINS the members', () => {
    const g = collapseAndForget(['expandedWidth', 'expandedHeight']);
    // Members sit at (20,40) and (160,40); makeNode carries no measured box, so
    // the fallback uses the 160x60 default plus 24px of padding.
    expect(g.width).toBe(160 + 160 + 24);
    expect(g.height).toBe(40 + 60 + 24);
    // Every member is inside the frame — the property that actually matters.
    for (const m of useAppStore.getState().nodes) {
      if (m.parentId !== 'g') continue;
      expect(m.position.x).toBeLessThan(g.width!);
      expect(m.position.y).toBeLessThan(g.height!);
    }
  });

  it('never returns anything below the resize grip\'s own minimum', () => {
    // A group with no members at all still has to come back draggable-sized.
    useAppStore.setState((s) => ({ nodes: s.nodes.filter((n) => n.parentId !== 'g') }));
    const g = collapseAndForget(['expandedWidth', 'expandedHeight']);
    expect(g.width).toBeGreaterThanOrEqual(MIN_GROUP_W);
    expect(g.height).toBeGreaterThanOrEqual(MIN_GROUP_H);
  });

  it('rejects a remembered value the grip could not have produced', () => {
    // Junk out of a hand-edited file: NaN, a string, or a number smaller than
    // the grip's floor is not a size the user ever chose.
    for (const junk of [Number.NaN, '300' as unknown as number, 4, -300, Infinity]) {
      useAppStore.getState().toggleGroupCollapsed('g');
      useAppStore.setState((s) => ({
        nodes: s.nodes.map((n) => (n.id === 'g'
          ? { ...n, data: { ...(n.data as object), expandedWidth: junk } } as AppNode
          : n)),
      }));
      useAppStore.getState().toggleGroupCollapsed('g');
      const g = group() as AppNode & { width?: number };
      expect(g.width, String(junk)).toBeGreaterThanOrEqual(MIN_GROUP_W);
      expect(g.width, String(junk)).not.toBe(COLLAPSED_W);
    }
  });

  it('still prefers a REMEMBERED size over the member fit', () => {
    // The fallback is a floor for the broken case, not a re-fit: a user who
    // sized their frame generously keeps that frame.
    useAppStore.getState().toggleGroupCollapsed('g');
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group() as AppNode & { width?: number; height?: number };
    expect(g.width).toBe(300);
    expect(g.height).toBe(200);
  });
});

/**
 * The bug this file was written for: a built-in PRESET or TEXTURE group
 * collapsed and expanded came back as a 200x120 stub with its whole graph
 * outside the frame.
 *
 * `codeGroupBuilder` wrote the frame size as `style: { width, height }` while
 * `groupSelection` writes top-level `width`/`height`. React Flow renders both
 * identically (`node.width ?? node.style?.width`), so the two shapes were
 * indistinguishable on screen — right up until something ASKED the node how big
 * it was. `toggleGroupCollapsed` asks, found neither field, and recorded the
 * `?? 200` fallback as the remembered expanded size.
 *
 * MEASURED in Chromium before the fix: a dropped preset rendered 300x428,
 * collapsed to the pill, and expanded to 200x120.
 */
describe('toggleGroupCollapsed: a group sized the OTHER way round-trips too', () => {
  /** The shape `codeGroupBuilder` used to write: size in `style` only. */
  function styleSizedGroup(): AppNode {
    return {
      id: 'g',
      type: 'group',
      position: { x: 100, y: 50 },
      style: { width: 300, height: 428 },
      data: { label: 'g', color: '#dde', collapsed: false },
    } as unknown as AppNode;
  }

  beforeEach(() => {
    useAppStore.setState({
      nodes: [
        styleSizedGroup(),
        member(makeNode('a', 'mul'), 'g', 20, 40),
        member(makeNode('b', 'mul'), 'g', 160, 40),
      ],
      edges: [],
      past: [],
      future: [],
    });
  });

  it('remembers the size that is actually on screen', () => {
    useAppStore.getState().toggleGroupCollapsed('g');
    const data = group().data as { expandedWidth?: number; expandedHeight?: number };
    expect(data.expandedWidth).toBe(300);
    expect(data.expandedHeight).toBe(428);
  });

  it('expands back to it, not to the 200x120 fallback', () => {
    useAppStore.getState().toggleGroupCollapsed('g');
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group() as AppNode & { width?: number; height?: number };
    expect(g.width).toBe(300);
    expect(g.height).toBe(428);
    // …and the top-right anchor still holds: right edge was 100 + 300 = 400.
    expect(g.position.x + 300).toBe(400);
    expect(g.position.y).toBe(50);
  });
});

describe('groupFrameSize', () => {
  const g = (patch: object) => ({ id: 'g', type: 'group', position: { x: 0, y: 0 }, data: {}, ...patch }) as unknown as AppNode;

  it('reads every shape a group frame has ever been written in', () => {
    expect(groupFrameSize(g({ width: 300, height: 200 }))).toEqual({ w: 300, h: 200 });
    expect(groupFrameSize(g({ style: { width: 300, height: 428 } }))).toEqual({ w: 300, h: 428 });
    expect(groupFrameSize(g({ data: { width: 240, height: 160 } }))).toEqual({ w: 240, h: 160 });
    expect(groupFrameSize(g({ measured: { width: 111, height: 222 } }))).toEqual({ w: 111, h: 222 });
  });

  it('prefers the canonical field, then style, then data, then measured', () => {
    expect(groupFrameSize(g({
      width: 1, height: 2, style: { width: 3, height: 4 },
      data: { width: 5, height: 6 }, measured: { width: 7, height: 8 },
    }))).toEqual({ w: 1, h: 2 });
    expect(groupFrameSize(g({
      style: { width: 3, height: 4 }, data: { width: 5, height: 6 },
    }))).toEqual({ w: 3, h: 4 });
  });

  it('falls through junk instead of trusting it', () => {
    // The value can come from a hand-edited fs:graph, and a NaN or a '300px'
    // string propagates into the node's inline style as garbage.
    expect(groupFrameSize(g({
      width: Number.NaN, style: { width: '300px' }, data: { width: 0 }, measured: { width: 260 },
    })).w).toBe(260);
    expect(groupFrameSize(g({})) ).toEqual({ w: 200, h: 120 });
  });
});

/**
 * The rescue for a group ALREADY damaged by the `style`-only bug: its stale
 * `expandedWidth: 200` is a perfectly plausible number, so the shape check
 * above cannot reject it. What can is the members themselves — a 200px frame
 * that cannot hold a 300px graph is wrong whatever it claims to remember.
 */
describe('toggleGroupCollapsed: the remembered size never wins over the members', () => {
  /** Members WITH measured boxes — the state a real canvas is always in. */
  function measured(node: AppNode, parentId: string, x: number, y: number, w: number, h: number) {
    return { ...member(node, parentId, x, y), measured: { width: w, height: h } } as AppNode;
  }

  it('grows a stale frame back around its graph', () => {
    useAppStore.setState({
      nodes: [
        { ...makeGroup('g', 100, 50, 200, 120), data: {
          label: 'g', color: '#dde', collapsed: true, width: 130, height: 60,
          expandedWidth: 200, expandedHeight: 120,
        } } as unknown as AppNode,
        measured(makeNode('a', 'mul'), 'g', 20, 40, 90, 60),
        measured(makeNode('b', 'mul'), 'g', 190, 300, 90, 60),
      ],
      edges: [], past: [], future: [],
    });
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group() as AppNode & { width?: number; height?: number };
    expect(g.width).toBe(190 + 90);   // the far member's right edge
    expect(g.height).toBe(300 + 60);
  });

  it('leaves a TIGHT frame alone — the floor is unpadded on purpose', () => {
    // A member flush against the edge is a real layout (React Flow's resizer
    // refuses to shrink a parent below its children). A padded floor would grow
    // such a frame by 24px on every single expand.
    useAppStore.setState({
      nodes: [
        makeGroup('g', 100, 50, 300, 200),
        measured(makeNode('a', 'mul'), 'g', 210, 140, 90, 60),
      ],
      edges: [], past: [], future: [],
    });
    useAppStore.getState().toggleGroupCollapsed('g');
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group() as AppNode & { width?: number; height?: number };
    expect(g.width).toBe(300);
    expect(g.height).toBe(200);
  });

  it('does NOT use an UNMEASURED member as a floor', () => {
    // Right after a load React Flow has not measured anything yet, and the
    // 160x60 guess overestimates a real node badly enough to inflate a correct
    // frame on every expand. Unknown boxes disable the floor entirely.
    useAppStore.setState({
      nodes: [
        makeGroup('g', 100, 50, 300, 200),
        member(makeNode('a', 'mul'), 'g', 250, 150),   // no measured box
      ],
      edges: [], past: [], future: [],
    });
    useAppStore.getState().toggleGroupCollapsed('g');
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group() as AppNode & { width?: number };
    expect(g.width).toBe(300);
  });
});

/**
 * The one-shot repair for a group ALREADY collapsed by the pre-fix build.
 *
 * Such a group's `expandedWidth` is the old `?? 200` fallback and nothing else
 * could have produced it: `style` is written only by `codeGroupBuilder`, at
 * build time, and neither the collapse nor the resizer touches it — so a
 * `style` size sitting beside exactly 200x120 means the collapse had nothing
 * else to read. (Its members are `display: none` and therefore unmeasured after
 * a reload, so the member floor above cannot rescue this one.)
 */
describe('toggleGroupCollapsed: repairs a group collapsed by the old code', () => {
  const damaged = (patch: object = {}) => ({
    id: 'g', type: 'group', position: { x: 200, y: 120 },
    width: 130, height: 60,
    style: { width: 300, height: 428 },
    data: {
      label: 'g', color: '#dde', collapsed: true, width: 130, height: 60,
      expandedWidth: 200, expandedHeight: 120, collapsedInputs: [], collapsedOutputs: [],
      ...patch,
    },
  }) as unknown as AppNode;

  const plant = (node: AppNode) => useAppStore.setState({
    nodes: [node, member(makeNode('a', 'mul'), 'g', 20, 40)],
    edges: [], past: [], future: [],
  });

  it('expands to the size the group was BUILT at, not the fallback', () => {
    plant(damaged());
    useAppStore.getState().toggleGroupCollapsed('g');
    const g = group() as AppNode & { width?: number; height?: number; style?: object };
    expect(g.width).toBe(300);
    expect(g.height).toBe(428);
    // …and the pre-canonical shape is gone, so ONE shape survives.
    expect(g.style).toBeUndefined();
  });

  it('is a one-shot: the next round-trip uses the real remembered size', () => {
    plant(damaged());
    useAppStore.getState().toggleGroupCollapsed('g');            // repaired to 300x428
    useAppStore.getState().toggleGroupCollapsed('g');            // collapse
    expect((group().data as { expandedWidth?: number }).expandedWidth).toBe(300);
    useAppStore.getState().toggleGroupCollapsed('g');            // expand
    expect((group() as AppNode & { width?: number }).width).toBe(300);
  });

  it('leaves a RESIZED-then-collapsed group alone', () => {
    // Resizing before collapsing wrote a real `width`, so the old code read it
    // and the remembered pair is NOT 200x120 — the repair must not fire and
    // overwrite the user's size with the preset's authored one.
    plant(damaged({ expandedWidth: 560, expandedHeight: 300 }));
    useAppStore.getState().toggleGroupCollapsed('g');
    expect((group() as AppNode & { width?: number }).width).toBe(560);
  });

  it('needs BOTH halves of the signature', () => {
    // No `style` at all — an ordinary group that really is 200x120.
    plant({ ...damaged(), style: undefined } as AppNode);
    useAppStore.getState().toggleGroupCollapsed('g');
    expect((group() as AppNode & { width?: number }).width).toBe(200);
  });
});
