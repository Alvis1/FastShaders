import { describe, it, expect } from 'vitest';
import {
  pickDropTargetNode,
  nearestByCy,
  wouldCreateCycle,
  planDragConnect,
  pickMainInput,
  type ConnectHandle,
  type DragConnectEndpoints,
} from './dragConnect';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { primaryInputId } from '@/utils/primaryInput';

const h = (id: string, cy: number, occupied?: boolean, primary?: boolean): ConnectHandle => ({
  id,
  cx: 0,
  cy,
  ...(occupied !== undefined ? { occupied } : {}),
  ...(primary ? { primary } : {}),
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

  it('an Image TILE feeds Color: its phantom ports share one cy, and the tie goes to `out`', () => {
    // A palette tile plans every output at the cursor (phantomPorts), so all
    // five tie; the strict `<` keeps the first — `out`, i.e. RGB. A REAL Image
    // node dragged onto another pairs by vertical alignment instead and may
    // pick R/G/B/Alpha — the Data-node precedent.
    const outs = NODE_REGISTRY.get('imageNode')!.outputs.map((p) => h(p.id, 12));
    expect(outs.map((o) => o.id)).toEqual(['out', 'r', 'g', 'b', 'alpha']);
    expect(nearestByCy(12, outs)?.id).toBe('out');
    expect(nearestByCy(-500, outs)?.id).toBe('out');
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

describe('pickMainInput', () => {
  const spare = (x: ConnectHandle): ConnectHandle => ({ ...x, spare: true });

  it('is the first input when none is flagged, and null for no inputs', () => {
    expect(pickMainInput([h('a', 0), h('b', 20)])?.id).toBe('a');
    expect(pickMainInput([])).toBeNull();
  });

  it('is the FLAGGED input wherever it sits (Mix: the factor is last)', () => {
    expect(pickMainInput([h('a', 0), h('b', 20), h('t', 40, undefined, true)])?.id).toBe('t');
  });

  it('a fed main input is REPLACED on a node whose inputs are different channels (Output)', () => {
    // color fed, position free: the drop replaces color, it never slips onto
    // the displacement channel.
    expect(pickMainInput([h('color', 0, true), h('position', 20, false)])?.id).toBe('color');
    expect(pickMainInput([h('a', 0), h('b', 20), h('t', 40, true, true)])?.id).toBe('t');
  });

  it('a fed main input yields to the next free OPERAND slot (Add: two drops build a + b)', () => {
    expect(pickMainInput([spare(h('a', 0, true)), spare(h('b', 20, false))])?.id).toBe('b');
    expect(pickMainInput([spare(h('a', 0, true)), spare(h('b', 20, true))])?.id).toBe('a');
  });
});

describe('planDragConnect', () => {
  it('left approach: the dragged output feeds the hover node\'s MAIN input', () => {
    const plan = planDragConnect(ep(), []);
    expect(plan).toMatchObject({
      mode: 'feed-hover',
      source: 'd',
      sourceHandle: 'out',
      target: 't',
      targetHandle: 'a',
    });
  });

  it('vertical position does NOT change the chosen input', () => {
    // The whole dragged node moves, level with b, with a, below, above.
    for (const y of [-40, -5, 0, 10, 20, 25, 90]) {
      const plan = planDragConnect(ep({ draggedOutputs: [h('out', y)] }), []);
      expect(plan?.targetHandle, `y=${y}`).toBe('a');
    }
  });

  it('a node dropped dead-centre on a three-input node lands on the main one, not the middle', () => {
    // Mix-shaped: a, b, t with t the main input; the dragged output level with b.
    const plan = planDragConnect(
      ep({
        draggedOutputs: [h('out', 20)],
        hoverInputs: [h('a', 0), h('b', 20), h('t', 40, false, true)],
      }),
      [],
    );
    expect(plan?.targetHandle).toBe('t');
  });

  it('right approach: the hover output feeds the dragged node\'s main input', () => {
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

  it('replaces a fed main input — unless the node is an operand fold, which takes its next free slot', () => {
    const channels = planDragConnect(ep({ hoverInputs: [h('a', 0, true), h('b', 20, false)] }), []);
    expect(channels?.targetHandle).toBe('a');
    const fold = planDragConnect(
      ep({ hoverInputs: [{ ...h('a', 0, true), spare: true }, { ...h('b', 20, false), spare: true }] }),
      [],
    );
    expect(fold?.targetHandle).toBe('b');
  });

  it('replaces the main input when nothing is free', () => {
    const plan = planDragConnect(ep({ hoverInputs: [h('a', 0, true), h('b', 20, true)] }), []);
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
    expect(planDragConnect(ep({ draggedOutputs: [], hoverOutputs: [] }), [])).toBeNull();
    // Both directions cyclic (mutual paths can't exist in a DAG, so simulate
    // with sockets missing on one side and a cycle on the other).
    const edges = [{ source: 'd', target: 't' }];
    expect(
      planDragConnect(ep({ draggedCenterX: 200, draggedOutputs: [], hoverInputs: [] }), edges),
    ).toBeNull();
  });

  it('a multi-output source still picks its output by alignment (Data node columns)', () => {
    // The main input sits at 38; col2 (40) is level with it, col1 (0) is not.
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

  it('phantom tile handles (all at the cursor Y) pick the main input deterministically', () => {
    // Palette-tile planning synthesizes the not-yet-created node's ports all at
    // the cursor position. A tile of Mix lands on its Factor; of anything with
    // no flagged port, its first.
    const mix = planDragConnect(
      ep({
        draggedCenterX: 200,
        draggedInputs: [h('a', 50), h('b', 50), h('t', 50, false, true)],
      }),
      [],
    );
    expect(mix?.mode).toBe('feed-dragged');
    expect(mix?.targetHandle).toBe('t');
    const plain = planDragConnect(ep({ draggedCenterX: 200, draggedInputs: [h('a', 50), h('b', 50)] }), []);
    expect(plain?.targetHandle).toBe('a');
  });

  it('an existing parallel edge does not block re-planning the same connection', () => {
    const edges = [{ source: 'd', target: 't' }];
    const plan = planDragConnect(ep(), edges);
    expect(plan).toMatchObject({ mode: 'feed-hover', source: 'd', target: 't' });
  });
});

describe('the main input of the shipped registry', () => {
  it('is the top input everywhere except Mix (Factor) and Smoothstep (X)', () => {
    const exceptions = new Map([['mix', 't'], ['smoothstep', 'x']]);
    for (const def of NODE_REGISTRY.values()) {
      if (def.inputs.length === 0) {
        expect(primaryInputId(def)).toBeNull();
        continue;
      }
      expect(primaryInputId(def), def.type).toBe(exceptions.get(def.type) ?? def.inputs[0].id);
    }
  });
});
