import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { placementObstacles } from '@/utils/libraryAutoWire';
import {
  evaluateStep, reconcileBindings, wantedNodeType, wantedNodeValues, lessonRevealNode, stepTargets, valueMatches,
  channelExposed, planAddPosition, PLANNED_MIN_W,
} from './tutorialRun';
import { drawnCostScale } from '@/engine/layoutEngine';
import { LIBRARY_PLACE_PAD } from '@/utils/libraryAutoWire';
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

  it('add: an Image node counts only once it holds a picture; an empty one is unfinished, not wrong', () => {
    const pic: TutorialStep = { id: 'p', kind: 'add', role: 'sky', type: 'imageNode', caption: '' };
    const image = (id: string, imageB64?: string) =>
      ({ ...makeNode(id, 'imageNode'), data: { registryType: 'imageNode', label: 'Image', cost: 0, values: imageB64 ? { imageB64, width: 1, height: 1 } : {} } }) as unknown as AppNode;
    const PNG = 'data:image/png;base64,iVBORw0KGgo=';
    // A palette press adds an EMPTY Image node: the step waits and says why.
    expect(evaluateStep(pic, B, [out(), image('i1')], [])).toEqual({ status: 'pending', needsPicture: true });
    // A dropped picture — the newest node holding one binds, an empty one beside it does not.
    expect(evaluateStep(pic, B, [out(), image('i1', PNG), image('i2')], [])).toEqual({ status: 'satisfied', bind: ['sky', 'i1'] });
    // A payload that is not a whitelisted picture is no picture.
    expect(evaluateStep(pic, B, [out(), image('i1', 'javascript:alert(1)')], []).status).toBe('pending');
    // Bound and filled: satisfied; bound but emptied: back to pending.
    expect(evaluateStep(pic, { ...B, sky: 'i1' }, [out(), image('i1', PNG)], [])).toEqual({ status: 'satisfied' });
    expect(evaluateStep(pic, { ...B, sky: 'i1' }, [out(), image('i1')], []).status).toBe('pending');
    // Every other type is unchanged: the type alone counts.
    expect(evaluateStep(add, B, [out(), makeNode('p1', 'perlin')], []).status).toBe('satisfied');
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

  it('stepTargets names the two sockets of a wire and the node of a set/expose; an add marks no node and no socket', () => {
    const b = { out: 'out1', noise: 'p1' };
    expect(stepTargets({ id: 'w', kind: 'wire', from: ['noise', 'out'], to: ['out', 'color'], caption: '' }, b)).toEqual({
      nodes: ['p1', 'out1'],
      handles: [['p1', 'source', 'out'], ['out1', 'target', 'color']],
      labels: ['p1'],
    });
    expect(stepTargets({ id: 's', kind: 'set', role: 'noise', key: 'scale', value: 1, caption: '' }, b).nodes).toEqual(['p1']);
    expect(stepTargets({ id: 'a', kind: 'add', role: 'x', type: 'mul', caption: '' }, b)).toEqual({ nodes: [], handles: [], labels: [] });
    // An unbound role marks nothing rather than a bogus id.
    expect(stepTargets({ id: 'w', kind: 'wire', from: ['ghost', 'out'], to: ['out', 'color'], caption: '' }, b).handles).toEqual([['out1', 'target', 'color']]);
  });

  it('stepTargets holds the socket LABELS open on every node the step is about, never on the Output', () => {
    const b = { out: 'out1', noise: 'p1', both: 'm1' };
    const labels = (step: TutorialStep) => stepTargets(step, b).labels;
    // A wire: both ends — "wire Fract into Multiply's A" names a socket on each.
    expect(labels({ id: 'w', kind: 'wire', from: ['noise', 'out'], to: ['both', 'a'], caption: '' })).toEqual(['p1', 'm1']);
    // The Output prints its channel names on its rows: a label there repeats them over the wire.
    expect(labels({ id: 'w', kind: 'wire', from: ['both', 'out'], to: ['out', 'color'], caption: '' })).toEqual(['m1']);
    expect(labels({ id: 's', kind: 'set', role: 'out', key: 'roughness', value: 0.1, caption: '' })).toEqual([]);
    expect(labels({ id: 'e', kind: 'expose', role: 'out', handle: 'emissive', caption: '' })).toEqual([]);
    // A set: the node whose number box the caption names.
    expect(labels({ id: 's', kind: 'set', role: 'both', key: 'b', value: 0.2, caption: '' })).toEqual(['m1']);
    // An add: nothing until the node exists, then the node it made — its caption explains its sockets.
    expect(labels({ id: 'a', kind: 'add', role: 'fresh', type: 'mix', caption: '' })).toEqual([]);
    expect(labels({ id: 'a', kind: 'add', role: 'both', type: 'mul', caption: '' })).toEqual(['m1']);
    // A look: only the roles it lists, each once, the unbound and the Output left out.
    expect(labels({ id: 'l', kind: 'look', caption: '' })).toEqual([]);
    expect(labels({ id: 'l', kind: 'look', caption: '', show: ['both', 'noise', 'both', 'ghost', 'out'] })).toEqual(['m1', 'p1']);
    // …and a look never marks a node or a socket: nothing is being asked for.
    expect(stepTargets({ id: 'l', kind: 'look', caption: '', show: ['both'] }, b)).toEqual({ nodes: [], handles: [], labels: ['m1'] });
  });

  it('wantedNodeValues: the current add step\'s values for ITS type, and nothing anywhere else', () => {
    const noise = TUTORIALS.find((d) => d.id === 'tut-noise')!;
    const rampIndex = noise.steps.findIndex((s) => s.kind === 'add' && s.type === 'colorRamp');
    const run: TutorialRun = { id: 'tut-noise', phase: 'run', step: rampIndex, reached: rampIndex, bindings: B };
    expect(wantedNodeValues(run, 'colorRamp')).toEqual({ stops: '0.4 #1b5e20 1,0.6 #fff9c4 1' });
    // Another type added while the lesson waits for a ramp keeps its own fresh values.
    expect(wantedNodeValues(run, 'perlin')).toBeUndefined();
    // An add step that carries no values, a step of another kind, the ask screen, no lesson, an unknown lesson.
    const perlinIndex = noise.steps.findIndex((s) => s.kind === 'add' && s.type === 'perlin');
    expect(wantedNodeValues({ ...run, step: perlinIndex }, 'perlin')).toBeUndefined();
    expect(wantedNodeValues({ ...run, step: 0 }, 'colorRamp')).toBeUndefined();
    expect(wantedNodeValues({ ...run, phase: 'ask' }, 'colorRamp')).toBeUndefined();
    expect(wantedNodeValues(null, 'colorRamp')).toBeUndefined();
    expect(wantedNodeValues({ ...run, id: 'tut-nope' }, 'colorRamp')).toBeUndefined();
  });

  it('every caption that describes a node\'s look is backed by values a hand-added node also gets', () => {
    // The captions state the stops as facts ("its two stops sit at 0.4 and 0.6"); a ramp
    // added from the palette is black→white unless the add step carries them.
    for (const def of TUTORIALS) {
      def.steps.forEach((s, i) => {
        if (s.kind !== 'add' || s.type !== 'colorRamp') return;
        expect(s.values?.stops, `${def.id}/${s.id}`).toBeTypeOf('string');
        const run: TutorialRun = { id: def.id, phase: 'run', step: i, reached: i, bindings: B };
        expect(wantedNodeValues(run, 'colorRamp'), `${def.id}/${s.id}`).toBe(s.values);
      });
    }
  });

  it('lessonRevealNode: the node a wire step runs INTO, so a noise card can show its hidden sockets', () => {
    const wobble = TUTORIALS.find((d) => d.id === 'tut-wobble')!;
    const posWire = wobble.steps.findIndex((s) => s.kind === 'wire' && s.to[1] === 'pos');
    expect(posWire).toBeGreaterThan(-1);
    const run: TutorialRun = { id: 'tut-wobble', phase: 'run', step: posWire, reached: posWire, bindings: { ...B, moved: 'a1', noise: 'p1' } };
    expect(lessonRevealNode(run)).toBe('p1');
    // The target not on the canvas yet, a step that is not a wire, the ask screen, no lesson.
    expect(lessonRevealNode({ ...run, bindings: B })).toBeNull();
    expect(lessonRevealNode({ ...run, step: 0 })).toBeNull();
    expect(lessonRevealNode({ ...run, phase: 'ask' })).toBeNull();
    expect(lessonRevealNode(null)).toBeNull();
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

  it('plans a card at least as wide as its header draws it, whatever the design\'s exact width says', () => {
    // Smoothstep's design is 25 px wide and Position's 24, but the canvas draws them 67 and 57: the
    // header prints the generated variable name and widens the card. Planned at the design's width,
    // the card sat 40 px inside the neighbour it was placed flush against.
    const feeder = { ...makeNode('p1', 'perlin'), position: { x: 400 - 111 - 80, y: 100 }, measured: { width: 108, height: 117 } } as AppNode;
    const nodes = [out(), feeder];
    // [type, the card's drawn width, its drawn height] — measured on the canvas.
    for (const [type, drawnW, drawnH] of [['smoothstep', 67, 98], ['positionGeometry', 57, 65]] as const) {
      const at = planAddPosition(NODE_REGISTRY.get(type)!, 0, [{ id: 'a', kind: 'add', role: 'x', type, caption: '' }], B, nodes);
      const card = { x: at.x, y: at.y, w: drawnW, h: drawnH };
      expect(PLANNED_MIN_W).toBeGreaterThanOrEqual(drawnW);
      for (const o of placementObstacles(nodes)) {
        const apart = card.x + card.w <= o.x || o.x + o.w <= card.x || card.y + card.h <= o.y || o.y + o.h <= card.y;
        expect(apart, `${type} drawn ${drawnW} wide overlaps ${JSON.stringify(o)}`).toBe(true);
      }
    }
  });

  it('keeps clear of an expensive card at the size it is DRAWN, not the smaller box React Flow measured', () => {
    // A cost-scaled card grows from its top-left corner by a transform: a Voronoi measures 108 x 117
    // and is drawn about a third larger. The spot left of the Output is taken, so the new node slides
    // above or below the noise — and must clear its drawn bottom edge, with the pad.
    const big = { ...makeNode('v1', 'voronoi'), type: 'preview', position: { x: 400 - 150 - 80, y: 100 }, measured: { width: 108, height: 117 } } as AppNode;
    const scale = drawnCostScale(big, []);
    expect(scale).toBeGreaterThan(1.2);
    const nodes = [out(), big];
    const at = planAddPosition(NODE_REGISTRY.get('floor')!, 0, [{ id: 'a', kind: 'add', role: 'x', type: 'floor', caption: '' }], B, nodes);
    const drawn = { x: big.position.x, y: big.position.y, w: 108 * scale, h: 117 * scale };
    const clearX = at.x + PLANNED_MIN_W + LIBRARY_PLACE_PAD <= drawn.x || drawn.x + drawn.w + LIBRARY_PLACE_PAD <= at.x;
    const clearY = at.y >= drawn.y + drawn.h + LIBRARY_PLACE_PAD || at.y + 40 + LIBRARY_PLACE_PAD <= drawn.y;
    expect(clearX || clearY, JSON.stringify({ at, drawn })).toBe(true);
    // …and the obstacle list itself: measured by default (every other caller), drawn when asked.
    expect(placementObstacles(nodes).find((o) => o.x === big.position.x)!.h).toBe(117);
    expect(placementObstacles(nodes, () => scale).find((o) => o.x === big.position.x)!.h).toBeCloseTo(117 * scale);
  });

  it('falls back to the Output when the role feeds nothing yet, and to 0,0 with no anchor at all', () => {
    const at = planAddPosition(NODE_REGISTRY.get('perlin')!, 0, [steps[0]], B, [out()]);
    expect(at.x).toBeLessThan(400);
    expect(planAddPosition(NODE_REGISTRY.get('perlin')!, 0, [steps[0]], {}, [])).toEqual({ x: 0, y: 0 });
  });
});
