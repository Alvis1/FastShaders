import { describe, it, expect } from 'vitest';
import {
  pickDropTargetNode,
  nearestByCy,
  wouldCreateCycle,
  planDragConnect,
  MIN_BAND_PX,
  type ConnectHandle,
  type DragConnectEndpoints,
} from './dragConnect';

const h = (id: string, cy: number, occupied?: boolean): ConnectHandle => ({
  id,
  cx: 0,
  cy,
  ...(occupied !== undefined ? { occupied } : {}),
});

/** Endpoint fixture: dragged "d" left of hover "t" unless overridden. The
 *  hover box [-10, 30] contains its two inputs (0, 20) and the dragged node's
 *  centre (10) — a physically consistent picture, so the reachability sweep
 *  finds every socket and the physical rule applies unless a test says
 *  otherwise. */
function ep(overrides: Partial<DragConnectEndpoints> = {}): DragConnectEndpoints {
  return {
    draggedId: 'd',
    hoverId: 't',
    draggedCenterX: 0,
    hoverCenterX: 100,
    draggedCenterY: 10,
    hoverTop: -10,
    hoverHeight: 40,
    draggedInputs: [h('in', 10)],
    draggedOutputs: [h('out', 10)],
    hoverInputs: [h('a', 0), h('b', 20)],
    hoverOutputs: [h('out', 10)],
    ...overrides,
  };
}

/** Every input the gesture can reach as the dragged centre sweeps the hover
 *  box (1px steps), with the dragged handles riding along — the invariant the
 *  planner exists to keep. */
function sweep(base: DragConnectEndpoints, step = 1): Set<string> {
  const reached = new Set<string>();
  const shift = (hs: ConnectHandle[], dy: number) => hs.map((x) => ({ ...x, cy: x.cy + dy }));
  for (let cy = base.hoverTop; cy <= base.hoverTop + base.hoverHeight; cy += step) {
    const dy = cy - base.draggedCenterY;
    const plan = planDragConnect(
      {
        ...base,
        draggedCenterY: cy,
        draggedInputs: shift(base.draggedInputs, dy),
        draggedOutputs: shift(base.draggedOutputs, dy),
      },
      [],
    );
    if (plan) reached.add(plan.targetHandle);
  }
  return reached;
}

describe('pickDropTargetNode', () => {
  const boxes = [
    { id: 'big', x: 0, y: 0, w: 200, h: 200 },
    { id: 'small', x: 50, y: 50, w: 20, h: 20 },
  ];

  it('returns null when the point is outside every box', () => {
    expect(pickDropTargetNode(300, 300, boxes)).toBeNull();
    expect(pickDropTargetNode(-1, 10, boxes)).toBeNull();
  });

  it('returns the containing box', () => {
    expect(pickDropTargetNode(150, 150, boxes)).toBe('big');
    expect(pickDropTargetNode(10, 10, boxes)).toBe('big');
  });

  it('prefers the smallest box when several contain the point', () => {
    expect(pickDropTargetNode(60, 60, boxes)).toBe('small');
  });

  it('treats box edges as inside', () => {
    expect(pickDropTargetNode(0, 0, boxes)).toBe('big');
    expect(pickDropTargetNode(200, 200, boxes)).toBe('big');
  });
});

describe('nearestByCy', () => {
  it('returns null for no handles', () => {
    expect(nearestByCy(10, [])).toBeNull();
  });

  it('picks the handle with the closest center Y', () => {
    const hs = [h('a', 0), h('b', 20), h('c', 40)];
    expect(nearestByCy(18, hs)?.id).toBe('b');
    expect(nearestByCy(-100, hs)?.id).toBe('a');
    expect(nearestByCy(35, hs)?.id).toBe('c');
  });

  it('first handle wins an exact tie (visual top-to-bottom order)', () => {
    expect(nearestByCy(10, [h('a', 0), h('b', 20)])?.id).toBe('a');
  });
});

describe('wouldCreateCycle', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ];

  it('self-connection is a cycle', () => {
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true);
  });

  it('detects a cycle when the target already reaches the source', () => {
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true);
    expect(wouldCreateCycle(edges, 'b', 'a')).toBe(true);
  });

  it('allows forward and unrelated connections', () => {
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false);
    expect(wouldCreateCycle(edges, 'c', 'x')).toBe(false);
    expect(wouldCreateCycle(edges, 'x', 'a')).toBe(false);
  });
});

describe('planDragConnect', () => {
  it('left approach: dragged output feeds the hover input aligned by Y', () => {
    const plan = planDragConnect(ep({ draggedOutputs: [h('out', 18)] }), []);
    expect(plan).toMatchObject({
      mode: 'feed-hover',
      source: 'd',
      sourceHandle: 'out',
      target: 't',
      targetHandle: 'b',
    });
  });

  it('vertical movement changes the chosen socket', () => {
    // The whole dragged node moves: its centre and its output together.
    const low = planDragConnect(ep({ draggedCenterY: 25, draggedOutputs: [h('out', 25)] }), []);
    const high = planDragConnect(ep({ draggedCenterY: -5, draggedOutputs: [h('out', -5)] }), []);
    expect(low?.targetHandle).toBe('b');
    expect(high?.targetHandle).toBe('a');
  });

  it('right approach: hover output feeds the dragged input', () => {
    const plan = planDragConnect(
      ep({ draggedCenterX: 200, draggedInputs: [h('x', 5), h('y', 30)] }),
      [],
    );
    expect(plan).toMatchObject({
      mode: 'feed-dragged',
      source: 't',
      sourceHandle: 'out',
      target: 'd',
      targetHandle: 'x',
    });
  });

  it('targets the nearest input by alignment even when it is occupied (drop replaces its edge)', () => {
    const plan = planDragConnect(
      ep({
        draggedCenterY: 0,
        draggedOutputs: [h('out', 0)],
        hoverInputs: [h('a', 0, true), h('b', 20, false)],
      }),
      [],
    );
    expect(plan?.targetHandle).toBe('a');
  });

  it('breaks an EXACT free/occupied vertical tie toward the free input', () => {
    const plan = planDragConnect(
      ep({
        draggedCenterY: 0,
        draggedOutputs: [h('out', 0)],
        hoverInputs: [h('a', 0, true), h('b', 0, false)],
      }),
      [],
    );
    expect(plan?.targetHandle).toBe('b');
  });

  it('replaces the nearest occupied input when nothing is free', () => {
    const plan = planDragConnect(
      ep({
        draggedCenterY: 0,
        draggedOutputs: [h('out', 0)],
        hoverInputs: [h('a', 0, true), h('b', 20, true)],
      }),
      [],
    );
    expect(plan?.targetHandle).toBe('a');
  });

  it('falls back to the other direction when the preferred side has no sockets', () => {
    // Right approach but dragged has no inputs (e.g. a value node) → feed-hover.
    const plan = planDragConnect(ep({ draggedCenterX: 200, draggedInputs: [] }), []);
    expect(plan?.mode).toBe('feed-hover');
    // Left approach but hover has no inputs (value node) → feed-dragged.
    const plan2 = planDragConnect(ep({ hoverInputs: [] }), []);
    expect(plan2?.mode).toBe('feed-dragged');
  });

  it('falls back when the preferred direction would create a cycle', () => {
    // d already feeds t via an intermediate node; dragging from the right
    // prefers t.out → d.in, which would cycle → falls back to d.out → t.in.
    const edges = [
      { source: 'd', target: 'm' },
      { source: 'm', target: 't' },
    ];
    const plan = planDragConnect(ep({ draggedCenterX: 200 }), edges);
    expect(plan?.mode).toBe('feed-hover');
    expect(plan).toMatchObject({ source: 'd', target: 't' });
  });

  it('returns null when no direction is possible', () => {
    // Two pure input nodes side by side: no outputs anywhere.
    expect(
      planDragConnect(
        ep({ draggedOutputs: [], hoverOutputs: [] }),
        [],
      ),
    ).toBeNull();
    // Both directions cyclic (mutual paths can't exist in a DAG, so simulate
    // with sockets missing on one side and a cycle on the other).
    const edges = [{ source: 'd', target: 't' }];
    expect(
      planDragConnect(
        ep({ draggedCenterX: 200, draggedOutputs: [], hoverInputs: [] }),
        edges,
      ),
    ).toBeNull();
  });

  it('a multi-output source picks its output by pair alignment (Data node columns)', () => {
    const plan = planDragConnect(
      ep({
        draggedCenterY: 40,
        hoverTop: 20,
        hoverHeight: 80,
        draggedOutputs: [h('col1', 0), h('col2', 40)],
        hoverInputs: [h('a', 38), h('b', 80)],
      }),
      [],
    );
    expect(plan?.sourceHandle).toBe('col2');
    expect(plan?.targetHandle).toBe('a');
  });

  it('phantom tile handles (all at the cursor Y) pick the first free input deterministically', () => {
    // Palette-tile planning synthesizes the not-yet-created node's ports all
    // at the cursor position — exact ties must resolve to the first (top)
    // free port, which for a fresh node is what a drop-on-edge splice of the
    // same tile picks too (edgeSplice.ts).
    const plan = planDragConnect(
      ep({
        draggedCenterX: 200,
        draggedCenterY: 50,
        hoverTop: 30,
        hoverHeight: 40,
        draggedInputs: [h('a', 50), h('b', 50)],
        hoverOutputs: [h('out', 10)],
      }),
      [],
    );
    expect(plan?.mode).toBe('feed-dragged');
    expect(plan?.targetHandle).toBe('a');
  });

  it('an existing parallel edge does not block re-planning the same connection', () => {
    const edges = [{ source: 'd', target: 't' }];
    const plan = planDragConnect(ep(), edges);
    expect(plan).toMatchObject({ mode: 'feed-hover', source: 'd', target: 't' });
  });
});

describe('every socket is reachable', () => {
  // Measured shapes from the shipped registry (flow px, node-local): the hover
  // box is [0, h] and its inputs sit inside it; the dragged node's handles are
  // given relative to ITS centre, which the sweep places anywhere in the box.
  const rel = (draggedCenterY: number, handles: ConnectHandle[]) =>
    handles.map((x) => ({ ...x, cy: draggedCenterY + x.cy }));

  it('feed-hover: an output socket far above the dragged centre (uv onto add) still reaches the lower input', () => {
    // uv: `out` 46px above its centre. add: a at 23, b at 47 in a 57px box.
    // Pure alignment never brings uv's socket level with b — measured, b was
    // unreachable — so the stretched sweep takes over.
    const base = ep({
      hoverTop: 0,
      hoverHeight: 57,
      draggedCenterY: 28,
      draggedOutputs: rel(28, [h('out', -46)]),
      hoverInputs: [h('a', 23), h('b', 47)],
    });
    expect(sweep(base)).toEqual(new Set(['a', 'b']));
    // Top half of the box → a, bottom half → b: the choice still follows the drag.
    expect(planDragConnect({ ...base, draggedCenterY: 10, draggedOutputs: rel(10, [h('out', -46)]) }, [])?.targetHandle).toBe('a');
    expect(planDragConnect({ ...base, draggedCenterY: 50, draggedOutputs: rel(50, [h('out', -46)]) }, [])?.targetHandle).toBe('b');
  });

  it('feed-dragged: a dragged node taller than the hover node (Output onto Float) reaches every row, in the physical direction', () => {
    // Output rows at -42, -24, +17 from its centre (color, emissive,
    // position); Float box 43px tall with its output at mid-height.
    const rows = [h('color', -42), h('emissive', -24), h('position', 17)];
    const at = (cy: number) =>
      ep({
        draggedCenterX: 200,
        hoverTop: 0,
        hoverHeight: 43,
        draggedCenterY: cy,
        draggedInputs: rel(cy, rows),
        hoverOutputs: [h('out', 21.5)],
      });
    expect(sweep(at(21))).toEqual(new Set(['color', 'emissive', 'position']));
    // Moving the dragged node DOWN brings its UPPER rows level with the
    // hover's output — the same direction physical alignment moves.
    expect(planDragConnect(at(0), [])?.targetHandle).toBe('position');
    expect(planDragConnect(at(43), [])?.targetHandle).toBe('color');
    expect(planDragConnect(at(21.5), [])?.targetHandle).toBe('emissive');
  });

  it('keeps PHYSICAL alignment whenever it already reaches every socket (rows clustered in the top of a tall node)', () => {
    // Output node hovered by a Float: rows at 45, 63, 104 in a 116px box; the
    // Float's output sits at its centre. The physical sweep reaches all three
    // (bands 54 / 29 / 33px), so a Float aimed level with `color` gets `color`
    // — a proportional stretch would hand the top 39% of the box to the
    // second row and misfire on the most common drop there is.
    const base = ep({
      hoverTop: 0,
      hoverHeight: 116,
      draggedCenterY: 39,
      draggedOutputs: rel(39, [h('out', 0)]),
      hoverInputs: [h('color', 45), h('emissive', 63), h('position', 104)],
    });
    expect(sweep(base)).toEqual(new Set(['color', 'emissive', 'position']));
    expect(planDragConnect(base, [])?.targetHandle).toBe('color');
    // ...and exactly level with the third row picks the third row.
    expect(planDragConnect({ ...base, draggedCenterY: 104, draggedOutputs: rel(104, [h('out', 0)]) }, [])?.targetHandle).toBe('position');
  });

  it('a socket whose physical band is thinner than MIN_BAND_PX counts as unreachable (select onto mul)', () => {
    // select: `out` 35px below its centre; mul: a at 23, b at 47 in a 57px
    // box. Alignment CAN reach a, but only in the top ~2px of the box — the
    // stretch gives it the top half instead.
    const base = ep({
      hoverTop: 0,
      hoverHeight: 57,
      draggedCenterY: 28,
      draggedOutputs: rel(28, [h('out', 35)]),
      hoverInputs: [h('a', 23), h('b', 47)],
    });
    expect(MIN_BAND_PX).toBeGreaterThan(2);
    expect(planDragConnect({ ...base, draggedCenterY: 14, draggedOutputs: rel(14, [h('out', 35)]) }, [])?.targetHandle).toBe('a');
    expect(planDragConnect({ ...base, draggedCenterY: 43, draggedOutputs: rel(43, [h('out', 35)]) }, [])?.targetHandle).toBe('b');
  });

  it('the stretched sweep still pairs a multi-output source by physical alignment', () => {
    // A tall consumer (5 rows) dragged onto a Data node with three columns:
    // the row is chosen by the stretch, the column by which one is level
    // with that row.
    const rows = [h('r1', -40), h('r2', -20), h('r3', 0), h('r4', 20), h('r5', 40)];
    const at = (cy: number) =>
      ep({
        draggedCenterX: 200,
        hoverTop: 0,
        hoverHeight: 60,
        draggedCenterY: cy,
        draggedInputs: rel(cy, rows),
        hoverOutputs: [h('col1', 15), h('col2', 30), h('col3', 45)],
      });
    expect(sweep(at(30))).toEqual(new Set(['r1', 'r2', 'r3', 'r4', 'r5']));
    const top = planDragConnect(at(58), []);
    expect(top?.targetHandle).toBe('r1');
    // r1 sits at 58 - 40 = 18 → col1 (15) is the column level with it.
    expect(top?.sourceHandle).toBe('col1');
  });

  it('an unmeasured hover box (height 0) still yields a plan', () => {
    const plan = planDragConnect(ep({ hoverHeight: 0, hoverTop: 10, hoverInputs: [h('a', 0), h('b', 20)] }), []);
    expect(plan).not.toBeNull();
  });
});
