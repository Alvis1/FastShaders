import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { placementObstacles } from '@/utils/libraryAutoWire';
import {
  evaluateStep, reconcileBindings, wantedNodeType, stepTargets, valueMatches, channelExposed, planAddPosition,
} from './tutorialRun';
import { graphIsBlank } from './tutorialTypes';
import type { TutorialStep, TutorialRun } from './tutorialTypes';
import { TUTORIALS } from './tutorialDefs';

const out = (): AppNode => ({
  id: 'out1', type: 'output', position: { x: 400, y: 100 },
  data: { registryType: 'output', label: 'Output', cost: 0 },
} as unknown as AppNode);

const B = { out: 'out1' } as const;

describe('evaluateStep', () => {
  const add: TutorialStep = { id: 'a', kind: 'add', role: 'noise', type: 'perlin', caption: '' };

  it('look is always satisfied', () => {
    expect(evaluateStep({ id: 'l', kind: 'look', caption: '' }, B, [out()], [])).toEqual({ status: 'satisfied' });
  });

  it('add: pending until a node of the type appears; the NEWEST unbound one binds', () => {
    expect(evaluateStep(add, B, [out()], []).status).toBe('pending');
    const r = evaluateStep(add, B, [out(), makeNode('p1', 'perlin'), makeNode('p2', 'perlin')], []);
    expect(r).toEqual({ status: 'satisfied', bind: ['noise', 'p2'] });
  });

  it('add: a node already bound to another role is not re-bound; a bound node of the type satisfies without a bind', () => {
    const nodes = [out(), makeNode('p1', 'perlin')];
    expect(evaluateStep(add, { ...B, other: 'p1' }, nodes, []).status).toBe('pending');
    expect(evaluateStep(add, { ...B, noise: 'p1' }, nodes, [])).toEqual({ status: 'satisfied' });
  });

  it('add: reports the type of a wrong newest node as a hint; groups and notes are not candidates', () => {
    const group = { id: 'g', type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: 'G', color: '#fff', width: 1, height: 1 } } as unknown as AppNode;
    const r = evaluateStep(add, B, [out(), makeNode('m1', 'mul'), group], []);
    expect(r).toEqual({ status: 'pending', wrongType: 'mul' });
  });

  it('wire: needs both roles bound (else broken naming the missing one) and the exact handles', () => {
    const w: TutorialStep = { id: 'w', kind: 'wire', from: ['noise', 'out'], to: ['out', 'color'], caption: '' };
    const nodes = [out(), makeNode('p1', 'perlin')];
    expect(evaluateStep(w, B, nodes, [])).toEqual({ status: 'broken', missingRole: 'noise' });
    const bound = { ...B, noise: 'p1' };
    expect(evaluateStep(w, bound, nodes, []).status).toBe('pending');
    expect(evaluateStep(w, bound, nodes, [makeEdge('p1', 'out', 'out1', 'roughness')]).status).toBe('pending');
    expect(evaluateStep(w, bound, nodes, [makeEdge('p1', 'out', 'out1', 'color')]).status).toBe('satisfied');
  });

  it('wire: a wire drawn from a collapsed group\'s pill counts through the unwrapped graph', () => {
    const w: TutorialStep = { id: 'w', kind: 'wire', from: ['noise', 'out'], to: ['out', 'color'], caption: '' };
    const group = {
      id: 'g', type: 'group', position: { x: 0, y: 0 },
      data: { registryType: 'group', label: 'G', color: '#fff', width: 1, height: 1, collapsed: true,
        collapsedOutputs: [{ socketId: 's1', originalNodeId: 'p1', originalHandleId: 'out' }], collapsedInputs: [] },
    } as unknown as AppNode;
    const member = { ...makeNode('p1', 'perlin'), parentId: 'g', hidden: true } as AppNode;
    const edge = { ...makeEdge('g', 's1', 'out1', 'color') };
    expect(evaluateStep(w, { ...B, noise: 'p1' }, [out(), group, member], [edge]).status).toBe('satisfied');
  });

  it('set: compares numbers within tolerance, hex case-free, other strings exactly; the Output through its own values', () => {
    const s: TutorialStep = { id: 's', kind: 'set', role: 'noise', key: 'scale', value: 3, caption: '' };
    expect(evaluateStep(s, { ...B, noise: 'p1' }, [out(), makeNode('p1', 'perlin', { scale: 1 })], []).status).toBe('pending');
    expect(evaluateStep(s, { ...B, noise: 'p1' }, [out(), makeNode('p1', 'perlin', { scale: '3' })], []).status).toBe('satisfied');
    expect(evaluateStep(s, { ...B, noise: 'p1' }, [out(), makeNode('p1', 'perlin', { scale: 3 + 1e-9 })], []).status).toBe('satisfied');
    expect(evaluateStep(s, B, [out()], [])).toEqual({ status: 'broken', missingRole: 'noise' });
    expect(valueMatches('#FFC107', '#ffc107')).toBe(true);
    expect(valueMatches('constant', 'constant')).toBe(true);
    expect(valueMatches('linear', 'constant')).toBe(false);
    expect(valueMatches({ toString: 1 }, 3)).toBe(false);
    const o = { ...out(), data: { ...out().data, values: { roughness: 0.1 } } } as AppNode;
    const so: TutorialStep = { id: 's', kind: 'set', role: 'out', key: 'roughness', value: 0.1, caption: '' };
    expect(evaluateStep(so, B, [o], []).status).toBe('satisfied');
    expect(evaluateStep(so, B, [out()], []).status).toBe('pending');
  });

  it('expose: a default channel is exposed; a hidden one needs the list; opacity also needs Transparent', () => {
    const e: TutorialStep = { id: 'e', kind: 'expose', role: 'out', handle: 'emissive', caption: '' };
    expect(evaluateStep({ ...e, handle: 'color' }, B, [out()], []).status).toBe('satisfied');
    expect(evaluateStep(e, B, [out()], []).status).toBe('pending');
    const exposed = { ...out(), data: { ...out().data, exposedPorts: ['color', 'emissive'] } } as AppNode;
    expect(evaluateStep(e, B, [exposed], []).status).toBe('satisfied');
    const opacityOnly = { ...out(), data: { ...out().data, exposedPorts: ['color', 'opacity'] } } as AppNode;
    expect(channelExposed(opacityOnly, 'opacity')).toBe(false);
    const transparent = { ...opacityOnly, data: { ...opacityOnly.data, materialSettings: { transparent: true } } } as AppNode;
    expect(channelExposed(transparent, 'opacity')).toBe(true);
    const clipped = { ...opacityOnly, data: { ...opacityOnly.data, materialSettings: { alphaTest: 0.5 } } } as AppNode;
    expect(channelExposed(clipped, 'opacity')).toBe(true);
  });
});

describe('bindings and marks', () => {
  it('reconcileBindings drops the roles whose node left and keeps identity otherwise', () => {
    const b = { out: 'out1', noise: 'p1' };
    const same = reconcileBindings(b, [out(), makeNode('p1', 'perlin')]);
    expect(same.bindings).toBe(b);
    expect(same.dropped).toEqual([]);
    const gone = reconcileBindings(b, [out()]);
    expect(gone.bindings).toEqual({ out: 'out1' });
    expect(gone.dropped).toEqual(['noise']);
  });

  it('wantedNodeType answers the current add step of a RUNNING lesson only', () => {
    const mix = TUTORIALS.find((d) => d.id === 'tut-mix')!;
    const addIndex = mix.steps.findIndex((s) => s.kind === 'add');
    const run: TutorialRun = { id: 'tut-mix', phase: 'run', step: addIndex, reached: addIndex, bindings: B };
    expect(wantedNodeType(run)).toBe('perlin');
    expect(wantedNodeType({ ...run, step: 0 })).toBeNull();
    expect(wantedNodeType({ ...run, phase: 'ask' })).toBeNull();
    expect(wantedNodeType(null)).toBeNull();
    expect(wantedNodeType({ ...run, id: 'tut-nope' })).toBeNull();
  });

  it('stepTargets names the two sockets of a wire and the node of a set/expose; an add marks nothing', () => {
    const b = { out: 'out1', noise: 'p1' };
    expect(stepTargets({ id: 'w', kind: 'wire', from: ['noise', 'out'], to: ['out', 'color'], caption: '' }, b)).toEqual({
      nodes: ['p1', 'out1'],
      handles: [['p1', 'source', 'out'], ['out1', 'target', 'color']],
    });
    expect(stepTargets({ id: 's', kind: 'set', role: 'noise', key: 'scale', value: 1, caption: '' }, b).nodes).toEqual(['p1']);
    expect(stepTargets({ id: 'a', kind: 'add', role: 'x', type: 'mul', caption: '' }, b)).toEqual({ nodes: [], handles: [] });
    // An unbound role marks nothing rather than a bogus id.
    expect(stepTargets({ id: 'w', kind: 'wire', from: ['ghost', 'out'], to: ['out', 'color'], caption: '' }, b).handles).toEqual([['out1', 'target', 'color']]);
  });

  it('graphIsBlank: at most a lone Output, no wire, no stroke', () => {
    expect(graphIsBlank([out()], [], [])).toBe(true);
    expect(graphIsBlank([], [], [])).toBe(true);
    expect(graphIsBlank([out(), makeNode('p', 'perlin')], [], [])).toBe(false);
    expect(graphIsBlank([out()], [makeEdge('a', 'out', 'out1', 'color')], [])).toBe(false);
    expect(graphIsBlank([out()], [], [{}])).toBe(false);
  });
});

describe('planAddPosition', () => {
  const steps: TutorialStep[] = [
    { id: 'a', kind: 'add', role: 'noise', type: 'perlin', caption: '' },
    { id: 'b', kind: 'add', role: 'pick', type: 'round', caption: '' },
    { id: 'w', kind: 'wire', from: ['noise', 'out'], to: ['pick', 'x'], caption: '' },
    { id: 'w2', kind: 'wire', from: ['pick', 'out'], to: ['out', 'color'], caption: '' },
  ];

  it('lands LEFT of the node the role will feed, level with it, overlapping nothing drawn', () => {
    const nodes = [out()];
    const at = planAddPosition(NODE_REGISTRY.get('round')!, 1, steps, B, nodes);
    expect(at.x).toBeLessThan(400);
    expect(Math.abs(at.y - 100)).toBeLessThan(60);
    // A second node for the same spot slides to a free one.
    const pick = { ...makeNode('r1', 'round'), position: at } as AppNode;
    const second = planAddPosition(NODE_REGISTRY.get('perlin')!, 0, steps, { ...B, pick: 'r1' }, [...nodes, pick]);
    const box = { x: second.x, y: second.y, w: 111, h: 127 };
    for (const o of placementObstacles([...nodes, pick])) {
      const apart = box.x + box.w <= o.x || o.x + o.w <= box.x || box.y + box.h <= o.y || o.y + o.h <= box.y;
      expect(apart, `overlaps ${JSON.stringify(o)}`).toBe(true);
    }
  });

  it('falls back to the Output when the role feeds nothing yet, and to 0,0 with no anchor at all', () => {
    const at = planAddPosition(NODE_REGISTRY.get('perlin')!, 0, [steps[0]], B, [out()]);
    expect(at.x).toBeLessThan(400);
    expect(planAddPosition(NODE_REGISTRY.get('perlin')!, 0, [steps[0]], {}, [])).toEqual({ x: 0, y: 0 });
  });
});
