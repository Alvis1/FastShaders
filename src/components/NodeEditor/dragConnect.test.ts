import { describe, it, expect } from 'vitest';
import {
  pickDropTargetNode,
  nearestByCy,
  wouldCreateCycle,
  planDragConnect,
  pickMainInput,
  type ConnectHandle,
  type DragConnectEndpoints,
  type DragConnectPlan,
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
    draggedCenterY: 10,
    hoverCenterY: 10,
    hoverHeight: 40,
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

  it('where a hover BEGINS does not change the chosen input — its first frame is the main input', () => {
    // The whole dragged node enters level with b, with a, below, above.
    for (const y of [-40, -5, 0, 10, 20, 25, 90]) {
      const plan = planDragConnect(ep({ draggedCenterY: y, draggedOutputs: [h('out', y)] }), []);
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

/** Drive one hover frame by frame: the dragged centre visits each Y in turn,
 *  every frame handed the previous frame's plan, as NodeEditor does. Returns
 *  the input ringed at each Y. */
function drive(base: Partial<DragConnectEndpoints>, ys: number[]): Array<string | undefined> {
  let prev: DragConnectPlan | null = null;
  return ys.map((y) => {
    prev = planDragConnect(ep({ ...base, draggedCenterY: y }), [], prev);
    return prev?.targetHandle;
  });
}

/** Every integer Y from `a` to `b` inclusive, either direction. */
const path = (...stops: number[]): number[] => {
  const ys: number[] = [];
  for (let k = 0; k + 1 < stops.length; k++) {
    const [a, b] = [stops[k], stops[k + 1]];
    const s = Math.sign(b - a);
    for (let y = a; y !== b; y += s) ys.push(y);
  }
  ys.push(stops[stops.length - 1]);
  return ys;
};

describe('vertical travel steps the input (owner, 2026-11-13)', () => {
  // A three-input hover node 120 tall, centred on 60, inputs 24 apart.
  const three = {
    hoverCenterY: 60,
    hoverHeight: 120,
    hoverInputs: [h('a', 36), h('b', 60), h('c', 84)],
  };

  it('starts on the main input and steps one socket per socket pitch of travel, downwards', () => {
    // Entered level with b (the old alignment rule's pick); main is a. Half a
    // pitch (12px) is the switch point, plus the hysteresis on either side.
    const seen = drive(three, [60, 70, 73, 85, 97, 101, 109]);
    expect(seen).toEqual(['a', 'a', 'a', 'b', 'b', 'c', 'c']);
  });

  it('steps back up the same way', () => {
    expect(drive(three, [60, 108, 100, 80, 60, 50, 30])).toEqual(['a', 'c', 'c', 'b', 'a', 'a', 'a']);
  });

  it('clamps at an end and steps back at once on reversal (the anchor slides with the overshoot)', () => {
    // Up from a overshoots by 50px; coming back down 24px reaches b, not a.
    const seen = drive(three, [60, 10, 22, 36]);
    expect(seen).toEqual(['a', 'a', 'a', 'b']);
  });

  it('a pointer resting between two sockets does not flicker the ring', () => {
    // Jitter around the a/b midpoint (12px of travel from the a anchor).
    const seen = drive(three, [60, 72, 73, 71, 72, 74, 72, 70]);
    expect(new Set(seen.slice(1))).toEqual(new Set(['a']));
  });

  it('starts from a Mix-like MAIN input that is not the top one, and travels both ways from it', () => {
    const mix = { ...three, hoverInputs: [h('a', 36), h('b', 60), h('t', 84, false, true)] };
    expect(drive(mix, [10])).toEqual(['t']);
    // Entered low (y 100), then up: t → b → a.
    expect(drive(mix, [100, 90, 74, 50])).toEqual(['t', 't', 'b', 'a']);
  });

  it('the dragged node\'s OWN inputs step the physical way: moving it UP rings a lower socket', () => {
    // Right approach: the hover output feeds the dragged node's input. Its
    // inputs travel with it, 24px apart around its centre.
    const base = { draggedCenterX: 200, hoverCenterY: 60, hoverHeight: 120 };
    let prev: DragConnectPlan | null = null;
    const seen: string[] = [];
    for (const y of [60, 40, 12, 84]) {
      prev = planDragConnect(
        ep({ ...base, draggedCenterY: y, draggedInputs: [h('x', y - 24), h('y', y), h('z', y + 24)] }),
        [],
        prev,
      );
      seen.push(prev!.targetHandle);
    }
    expect(seen).toEqual(['x', 'y', 'z', 'x']);
  });

  it('a new hover node, or the other side, starts over on the main input', () => {
    const first = planDragConnect(ep({ ...three, draggedCenterY: 60 }), []);
    const moved = planDragConnect(ep({ ...three, draggedCenterY: 85 }), [], first);
    expect(moved?.targetHandle).toBe('b');
    const elsewhere = planDragConnect(ep({ ...three, hoverId: 'u', draggedCenterY: 85 }), [], moved);
    expect(elsewhere?.targetHandle).toBe('a');
  });

  it('every input is reachable inside the hover box, however tall the input span', () => {
    // Enter anywhere, sweep to one edge of the hover box, then the other, then
    // back — the dragged centre never leaves the box. Covers a dragged node
    // whose own inputs span far more than the hover is tall (an Output dropped
    // on a Float), from both sides.
    for (const n of [1, 2, 3, 5, 9, 14]) {
      for (const hoverHeight of [30, 60, 120, 400]) {
        const top = 0;
        const bottom = hoverHeight;
        const centre = hoverHeight / 2;
        const ids = Array.from({ length: n }, (_, i) => `i${i}`);
        for (const entry of [top, centre, bottom]) {
          for (const main of [0, n - 1]) {
            // Left approach: the hover's own inputs, inside its box.
            const pitch = hoverHeight / (n + 1);
            const hoverInputs = ids.map((id, i) => h(id, top + pitch * (i + 1), false, i === main));
            const left = new Set(drive({ hoverCenterY: centre, hoverHeight, hoverInputs }, path(entry, top, bottom, top)));
            expect([...left].sort(), `left n=${n} h=${hoverHeight} entry=${entry} main=${main}`).toEqual([...ids].sort());
            // Right approach: the dragged node's inputs, 28px apart, riding with it.
            let prev: DragConnectPlan | null = null;
            const right = new Set<string>();
            for (const y of path(entry, top, bottom, top)) {
              const draggedInputs = ids.map((id, i) => h(id, y + 28 * (i - (n - 1) / 2), false, i === main));
              prev = planDragConnect(
                ep({ draggedCenterX: 200, draggedCenterY: y, hoverCenterY: centre, hoverHeight, draggedInputs }),
                [],
                prev,
              );
              if (prev) right.add(prev.targetHandle);
            }
            expect([...right].sort(), `right n=${n} h=${hoverHeight} entry=${entry} main=${main}`).toEqual([...ids].sort());
          }
        }
      }
    }
  });

  it('phantom tile ports (all at one Y) never step off the main input', () => {
    let prev: DragConnectPlan | null = null;
    for (const y of [0, 20, 40, -20]) {
      prev = planDragConnect(
        ep({
          draggedCenterX: 200,
          draggedCenterY: y,
          draggedInputs: [h('a', y), h('b', y), h('t', y, false, true)],
        }),
        [],
        prev,
      );
      expect(prev?.targetHandle, `y=${y}`).toBe('t');
    }
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
