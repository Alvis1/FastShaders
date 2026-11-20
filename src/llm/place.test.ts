/**
 * Placement end to end against the store, the shaderDropFlow.test.ts shape: a
 * generated group lands as ONE group — the gate's graph minus its Output — in
 * ONE undo entry, wired into the live Output's Color when that socket is
 * EMPTY and parked unwired otherwise, and it never replaces a wire.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { codeToGraph } from '@/engine/codeToGraph';
import { DEFAULT_OPTIONAL_CATEGORIES } from '@/registry/optionalCategories';
import { HISTORY_IDLE, makeEdge, makeNode } from '@/test-utils';
import { getNodeValues, type AppNode } from '@/types';
import { buildCatalogue } from './catalogue';
import { gateProgram } from './gate';
import { addGeneratedGroup, generatedStem, MAX_GENERATED_LABEL } from './place';

const catalogue = buildCatalogue(DEFAULT_OPTIONAL_CATEGORIES);
const PROGRAM = `import { Fn } from "three/tsl";
const shader = Fn(() => {
  const speed = uniform(1.5);
  const tint = uniform(color(0xFF5500));
  const t = time.mul(speed);
  const n = mx_noise_float(positionGeometry.mul(4));
  const w = sin(add(n, t));
  const c = mul(tint, w);
  return c;
});
export default shader;`;

function at(id: string, type: string, values: Record<string, string | number> = {}): AppNode {
  const n = makeNode(id, type, values);
  n.position = { x: 0, y: 0 };
  return n;
}

beforeEach(() => {
  useAppStore.setState({
    nodes: [at('live-speed', 'property_float', { name: 'speed', value: 3 }), at('live-out', 'output')],
    edges: [makeEdge('live-speed', 'out', 'live-out', 'roughness')],
    drawings: [],
    shaderPalettes: [],
    shaderName: 'My Shader',
    past: [],
    future: [],
    ...HISTORY_IDLE,
    pendingLimitNotices: [],
    pendingShaderImports: [],
    previewMesh: null,
    importNote: null,
  });
});

afterAll(() => cancelPendingGraphSave());

describe('addGeneratedGroup', () => {
  it('adds the gated graph as one group, minus its Output, wired into the empty Color, in one undo entry', async () => {
    const gate = gateProgram(PROGRAM, '', { catalogue, takenNames: new Set(['speed']) });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    const before = useAppStore.getState();
    const r = await addGeneratedGroup(gate.tsl, 'glowing orange waves', () => false);
    expect(r).toMatchObject({ ok: true, groupLabel: 'glowing orange waves' });

    const s = useAppStore.getState();
    expect(s.past).toHaveLength(1);
    const group = s.nodes.find((n) => n.type === 'group');
    expect(group).toBeDefined();
    const members = s.nodes.filter((n) => n.parentId === group!.id);
    const expected = codeToGraph(gate.tsl).nodes.filter((n) => n.data.registryType !== 'output').map((n) => n.data.registryType).sort();
    expect(members.map((n) => n.data.registryType).sort()).toEqual(expected);
    expect(members.some((n) => n.data.registryType === 'output')).toBe(false);
    // The live graph is untouched — its own `speed` and its own wire included.
    expect(s.nodes.find((n) => n.id === 'live-speed')).toBe(before.nodes[0]);
    expect(s.edges.some((e) => e.target === 'live-out' && e.source === 'live-speed' && e.targetHandle === 'roughness')).toBe(true);
    // The group's end feeds the live Output's Color — the one socket the
    // program's `return` named, and it was empty.
    const into = s.edges.filter((e) => e.target === 'live-out' && e.source !== 'live-speed');
    expect(into.map((e) => e.targetHandle)).toEqual(['color']);
    expect(members.some((n) => n.id === into[0].source)).toBe(true);
    expect(r).toMatchObject({ wired: 1 });
    // …and the frame sits LEFT of that Output, clear of it.
    const frameRight = group!.position.x + (group!.width ?? 0);
    expect(frameRight).toBeLessThanOrEqual(s.nodes.find((n) => n.id === 'live-out')!.position.x);
    // The generated uniform was renamed off the live one.
    const names = members.filter((n) => n.data.registryType === 'property_float').map((n) => getNodeValues(n).name);
    expect(names).toEqual(['speed2']);
    // It says what happened.
    expect(s.importNote?.lines).toEqual([{ kind: 'generated-added', name: 'glowing orange waves', nodes: members.length, wired: 1 }]);

    // ONE undo takes the group and its wire back.
    useAppStore.getState().undo();
    const undone = useAppStore.getState();
    expect(undone.nodes.some((n) => n.type === 'group')).toBe(false);
    expect(undone.edges).toHaveLength(1);
  });

  it('never replaces a wire: with Color already fed, the group is parked unwired', async () => {
    useAppStore.setState((s) => ({
      edges: [...s.edges, makeEdge('live-speed', 'out', 'live-out', 'color')],
    }));
    const gate = gateProgram(PROGRAM, '', { catalogue, takenNames: new Set(['speed']) });
    if (!gate.ok) throw new Error('gate');
    const before = useAppStore.getState();
    const r = await addGeneratedGroup(gate.tsl, 'second try', () => false);
    expect(r).toMatchObject({ ok: true, wired: 0 });
    const s = useAppStore.getState();
    expect(s.edges.filter((e) => e.target === 'live-out')).toEqual(before.edges);
    expect(s.nodes.find((n) => n.id === 'live-out')).toBe(before.nodes[1]);
    expect(s.importNote?.lines).toMatchObject([{ kind: 'generated-added', wired: 0 }]);
  });

  it('with no Output on the canvas it is parked unwired — at the asked spot when one was given', async () => {
    useAppStore.setState({ nodes: [at('live-speed', 'property_float', { name: 'speed', value: 3 })], edges: [] });
    const gate = gateProgram(PROGRAM, '', { catalogue, takenNames: new Set(['speed']) });
    if (!gate.ok) throw new Error('gate');
    const r = await addGeneratedGroup(gate.tsl, 'no output', () => false, { x: 4000, y: -2500 });
    expect(r).toMatchObject({ ok: true, wired: 0 });
    const s = useAppStore.getState();
    const group = s.nodes.find((n) => n.type === 'group')!;
    expect(group.position).toEqual({ x: 4000, y: -2500 });
    expect(s.edges.every((e) => e.target !== 'live-speed')).toBe(true);
  });

  it('refuses in a study session and changes nothing', async () => {
    const gate = gateProgram(PROGRAM, '', { catalogue, takenNames: new Set() });
    if (!gate.ok) throw new Error('gate');
    const before = useAppStore.getState().nodes;
    expect(await addGeneratedGroup(gate.tsl, 'x', () => true)).toEqual({ ok: false, reason: 'study' });
    expect(useAppStore.getState().nodes).toBe(before);
    expect(useAppStore.getState().past).toHaveLength(0);
  });
});

describe('generatedStem', () => {
  it('takes the first line, turns slashes and control characters into spaces, and shortens at a word', () => {
    expect(generatedStem('red/blue stripes\nand more')).toBe('red blue stripes');
    expect(generatedStem('  \n\t\n')).toBe('Generated');
    const long = generatedStem('a very long request that goes on and on about lava and rock and fire');
    expect(long.length).toBeLessThanOrEqual(MAX_GENERATED_LABEL + 1);
    expect(long.endsWith('…')).toBe(true);
    expect(generatedStem('ugunīgs plazmas efekts')).toBe('ugunīgs plazmas efekts');
  });
});
