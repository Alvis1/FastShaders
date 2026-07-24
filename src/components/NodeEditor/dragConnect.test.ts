import { describe, it, expect } from 'vitest';
import {
  pickDropTargetNode,
  nearestByCy,
  wouldCreateCycle,
  planDragConnect,
  type ConnectHandle,
  type DragConnectEndpoints,
} from './dragConnect';

const h = (id: string, cy: number, occupied?: boolean): ConnectHandle => ({
  id,
  cx: 0,
  cy,
  ...(occupied !== undefined ? { occupied } : {}),
});

/** Endpoint fixture: dragged "d" left of hover "t" unless overridden. */
function ep(overrides: Partial<DragConnectEndpoints> = {}): DragConnectEndpoints {
  return {
    draggedId: 'd',
    hoverId: 't',
    draggedCenterX: 0,
    hoverCenterX: 100,
    draggedInputs: [h('in', 10)],
    draggedOutputs: [h('out', 10)],
    hoverInputs: [h('a', 0), h('b', 20)],
    hoverOutputs: [h('out', 10)],
    ...overrides,
  };
}

describe('pickDropTargetNode', () => {
  const boxes = [
    { id: 'big', x: 0, y: 0, w: 200, h: 200 },
    { id: 'small', x: 50, y: 50, w: 40, h: 40 },
    { id: 'off', x: 500, y: 500, w: 40, h: 40 },
  ];

  it('returns null when the point is outside every box', () => {
    expect(pickDropTargetNode(400, 400, boxes)).toBeNull();
    expect(pickDropTargetNode(0, 0, [])).toBeNull();
  });

  it('returns the containing box', () => {
    expect(pickDropTargetNode(150, 150, boxes)).toBe('big');
    expect(pickDropTargetNode(510, 510, boxes)).toBe('off');
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
    expect(nearestByCy(0, [])).toBeNull();
  });

  it('picks the handle with the closest center Y', () => {
    const handles = [h('a', 0), h('b', 20), h('c', 40)];
    expect(nearestByCy(-5, handles)?.id).toBe('a');
    expect(nearestByCy(19, handles)?.id).toBe('b');
    expect(nearestByCy(100, handles)?.id).toBe('c');
  });

  it('first handle wins an exact tie (visual top-to-bottom order)', () => {
    expect(nearestByCy(10, [h('a', 0), h('b', 20)])?.id).toBe('a');
  });
});

describe('wouldCreateCycle', () => {
  const chain = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
  ];

  it('self-connection is a cycle', () => {
    expect(wouldCreateCycle([], 'A', 'A')).toBe(true);
  });

  it('detects a cycle when the target already reaches the source', () => {
    expect(wouldCreateCycle(chain, 'C', 'A')).toBe(true);
    expect(wouldCreateCycle(chain, 'B', 'A')).toBe(true);
  });

  it('allows forward and unrelated connections', () => {
    expect(wouldCreateCycle(chain, 'A', 'C')).toBe(false);
    expect(wouldCreateCycle(chain, 'A', 'X')).toBe(false);
    expect(wouldCreateCycle(chain, 'X', 'Y')).toBe(false);
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
    const low = planDragConnect(ep({ draggedOutputs: [h('out', 25)] }), []);
    const high = planDragConnect(ep({ draggedOutputs: [h('out', -5)] }), []);
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
    // free port, mirroring tryInsertOnEdge's first-port convention.
    const plan = planDragConnect(
      ep({
        draggedCenterX: 200,
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
