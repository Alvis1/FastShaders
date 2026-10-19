/**
 * A PRESSED Preset/Texture wires into every Output socket it feeds that is
 * still EMPTY (owner, 2026-10-16; per socket 2026-10-17). These pin the target,
 * the taken sockets, the edge re-targeting, the free spot and the corner the
 * view reveals; the store suite (store/libraryAutoWire.test.ts) pins the drop.
 */
import { describe, it, expect } from 'vitest';
import {
  exposeWiredChannels,
  freeFrameSpot,
  libraryWireEdges,
  libraryWireOutput,
  LIBRARY_REVEAL_MARGIN,
  placementObstacles,
  revealCornerViewport,
  takenOutputChannels,
} from '@/utils/libraryAutoWire';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import { COLLAPSED_MEMBER_CLASS } from '@/utils/groupFrame';
import { makeEdge, makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

const output = (id = 'out', extra: Record<string, unknown> = {}): AppNode =>
  ({ ...makeNode(id, 'output'), data: { ...makeNode(id, 'output').data, ...extra } }) as AppNode;

describe('libraryWireOutput', () => {
  it('a lone Output is the target', () => {
    const out = output();
    expect(libraryWireOutput([out], [])).toBe(out);
  });

  it('an Output that already has wires is STILL the target — sockets are decided one by one', () => {
    const nodes = [output(), makeNode('f', 'float')];
    expect(libraryWireOutput(nodes, [makeEdge('f', 'out', 'out', 'color')])?.id).toBe('out');
  });

  it('an active Raymarch Output is not a material target', () => {
    const march = { ...makeNode('m', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;
    (march.data as Record<string, unknown>).activeOutput = true;
    expect(libraryWireOutput([output(), march], [])).toBeNull();
  });

  it('the ACTIVE plain Output is asked, not the first one', () => {
    const a = output('a');
    const b = output('b', { activeOutput: true });
    expect(libraryWireOutput([a, b], [])).toBe(b);
  });

  it('an Output hidden inside a collapsed group is skipped', () => {
    const out = { ...output(), className: COLLAPSED_MEMBER_CLASS } as AppNode;
    expect(libraryWireOutput([out], [])).toBeNull();
  });

  it('no Output at all → null', () => {
    expect(libraryWireOutput([makeNode('f', 'float')], [])).toBeNull();
  });
});

describe('takenOutputChannels', () => {
  it('lists the wired sockets of THAT Output only', () => {
    const nodes = [output('a'), output('b'), makeNode('f', 'float'), makeNode('s', 'sin')];
    const edges = [
      makeEdge('f', 'out', 'a', 'color'),
      makeEdge('f', 'out', 'a', 'position'),
      makeEdge('f', 'out', 'b', 'emissive'),
      makeEdge('f', 'out', 's', 'x'),
    ];
    expect([...takenOutputChannels(nodes, edges, 'a')].sort()).toEqual(['color', 'position']);
    expect([...takenOutputChannels(nodes, [], 'a')]).toEqual([]);
  });

  it('a wire arriving from a COLLAPSED group still takes its socket', () => {
    const group = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      data: {
        registryType: 'group',
        label: 'g',
        collapsed: true,
        collapsedOutputs: [{ socketId: 's0', originalNodeId: 'm', originalHandleId: 'out' }],
      },
    } as unknown as AppNode;
    const member = { ...makeNode('m', 'float'), parentId: 'g', className: COLLAPSED_MEMBER_CLASS } as AppNode;
    const nodes = [group, member, output()];
    expect([...takenOutputChannels(nodes, [makeEdge('g', 's0', 'out', 'color')], 'out')]).toEqual(['color']);
  });
});

describe('libraryWireEdges', () => {
  const idMap = new Map([
    ['p1', 'n1'],
    ['p2', 'n2'],
  ]);

  it('re-points each wire from the clone member to the live Output', () => {
    const wires = libraryWireEdges(
      [makeEdge('p1', 'out', 'parsedOut', 'color'), makeEdge('p2', 'out', 'parsedOut', 'emissive')],
      idMap,
      'live',
    );
    expect(wires.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      ['n1', 'out', 'live', 'color'],
      ['n2', 'out', 'live', 'emissive'],
    ]);
    expect(new Set(wires.map((e) => e.id)).size).toBe(2);
    expect(wires.every((e) => e.type === 'typed')).toBe(true);
  });

  it('drops a wire whose source the clone did not mint, and a second wire into one channel', () => {
    const wires = libraryWireEdges(
      [
        makeEdge('ghost', 'out', 'parsedOut', 'color'),
        makeEdge('p1', 'out', 'parsedOut', 'color'),
        makeEdge('p2', 'out', 'parsedOut', 'color'),
      ],
      idMap,
      'live',
    );
    expect(wires.map((e) => e.source)).toEqual(['n1']);
  });

  it('never wires a TAKEN socket: a displacement still goes in when colour is fed', () => {
    const wires = libraryWireEdges(
      [makeEdge('p1', 'out', 'parsedOut', 'color'), makeEdge('p2', 'out', 'parsedOut', 'position')],
      idMap,
      'live',
      new Set(['color']),
    );
    expect(wires.map((e) => e.targetHandle)).toEqual(['position']);
  });
});

describe('exposeWiredChannels', () => {
  it('adds a hidden channel without hiding the defaults, on a FRESH node', () => {
    const out = output();
    const next = exposeWiredChannels(out, ['color', 'discard']);
    expect(next).not.toBe(out);
    expect((next.data as { exposedPorts?: string[] }).exposedPorts).toEqual([...OUTPUT_DEFAULT_EXPOSED, 'discard']);
    expect((out.data as { exposedPorts?: string[] }).exposedPorts).toBeUndefined();
  });

  it('returns the SAME node when every channel already shows', () => {
    const out = output();
    expect(exposeWiredChannels(out, ['color'])).toBe(out);
  });
});

describe('freeFrameSpot', () => {
  const ideal = { x: 0, y: 0, w: 200, h: 100 };
  const hits = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }, pad = 24) =>
    p.x < b.x + b.w + pad && b.x < p.x + ideal.w + pad && p.y < b.y + b.h + pad && b.y < p.y + ideal.h + pad;

  it('keeps the ideal spot when nothing is there', () => {
    expect(freeFrameSpot(ideal, [{ x: 500, y: 500, w: 50, h: 50 }])).toEqual({ x: 0, y: 0 });
  });

  it('slides just below a group sitting on the ideal spot, staying in the column', () => {
    const g = { x: -20, y: -40, w: 300, h: 120 };
    const spot = freeFrameSpot(ideal, [g]);
    expect(spot).toEqual({ x: 0, y: g.y + g.h + 24 });
    expect(hits(spot, g)).toBe(false);
  });

  it('prefers the nearer side: just above a group that reaches far down', () => {
    const g = { x: -20, y: 30, w: 300, h: 900 };
    expect(freeFrameSpot(ideal, [g])).toEqual({ x: 0, y: 30 - 100 - 24 });
  });

  it('a column full of groups pushes it LEFT past them, never right', () => {
    const wall = [{ x: -50, y: -5000, w: 400, h: 10000 }];
    const spot = freeFrameSpot(ideal, wall);
    expect(spot.x).toBeLessThanOrEqual(-50 - 200 - 24);
    expect(hits(spot, wall[0])).toBe(false);
  });

  it('lands on none of many random groups', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let run = 0; run < 50; run++) {
      const obs = Array.from({ length: 12 }, () => ({ x: rnd() * 1200 - 600, y: rnd() * 1200 - 600, w: 50 + rnd() * 400, h: 50 + rnd() * 300 }));
      const spot = freeFrameSpot(ideal, obs);
      expect(spot.x).toBeLessThanOrEqual(ideal.x);
      for (const b of obs) expect(hits(spot, b)).toBe(false);
    }
  });
});

describe('placementObstacles', () => {
  it('a group by its frame, a member at its ABSOLUTE spot, a collapsed member not at all', () => {
    const g = { id: 'g', type: 'group', position: { x: 100, y: 50 }, width: 300, height: 200, data: { registryType: 'group', label: 'g', collapsed: false } } as unknown as AppNode;
    const m = { ...makeNode('m', 'float'), parentId: 'g', position: { x: 10, y: 20 }, measured: { width: 40, height: 30 } } as AppNode;
    const hidden = { ...makeNode('h', 'float'), className: COLLAPSED_MEMBER_CLASS } as AppNode;
    expect(placementObstacles([g, m, hidden])).toEqual([
      { x: 100, y: 50, w: 300, h: 200 },
      { x: 110, y: 70, w: 40, h: 30 },
    ]);
  });
});

describe('revealCornerViewport — the placed frame\'s top-right corner shows', () => {
  const canvas = { w: 1000, h: 600 };
  const view = { x: 0, y: 0, zoom: 1 };
  const onScreen = (c: { x: number; y: number }, v: { x: number; y: number; zoom: number }) => ({
    x: c.x * v.zoom + v.x,
    y: c.y * v.zoom + v.y,
  });

  it('a corner already in view moves nothing', () => {
    expect(revealCornerViewport({ x: 500, y: 300 }, view, canvas)).toBeNull();
    expect(revealCornerViewport({ x: LIBRARY_REVEAL_MARGIN, y: LIBRARY_REVEAL_MARGIN }, view, canvas)).toBeNull();
  });

  it('a corner off screen is panned into view, the zoom kept', () => {
    for (const corner of [{ x: 2400, y: 300 }, { x: -800, y: 300 }, { x: 500, y: -900 }, { x: 500, y: 2000 }]) {
      for (const zoom of [0.5, 1, 1.5]) {
        const next = revealCornerViewport(corner, { x: 30, y: -20, zoom }, canvas)!;
        expect(next.zoom).toBe(zoom);
        const p = onScreen(corner, next);
        expect(p.x).toBeGreaterThan(LIBRARY_REVEAL_MARGIN);
        expect(p.x).toBeLessThan(canvas.w - LIBRARY_REVEAL_MARGIN);
        expect(p.y).toBeGreaterThan(LIBRARY_REVEAL_MARGIN);
        expect(p.y).toBeLessThan(canvas.h - LIBRARY_REVEAL_MARGIN);
        // …and once there, it stays put.
        expect(revealCornerViewport(corner, next, canvas)).toBeNull();
      }
    }
  });

  it('a corner under the chrome (the cost pill) does not count as shown, and is not panned under it', () => {
    const pill = { x: 400, y: 12, w: 588, h: 140 };
    const next = revealCornerViewport({ x: 900, y: 60 }, view, canvas, [pill])!;
    expect(next).not.toBeNull();
    const p = onScreen({ x: 900, y: 60 }, next);
    const clear = p.x < pill.x || p.x > pill.x + pill.w || p.y < pill.y || p.y > pill.y + pill.h;
    expect(clear).toBe(true);
    expect(revealCornerViewport({ x: 900, y: 60 }, next, canvas, [pill])).toBeNull();
  });
});
