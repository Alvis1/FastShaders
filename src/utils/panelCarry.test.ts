import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppEdge, AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { makeEdge, makeNode } from '@/test-utils';
import { codeToGraph } from '@/engine/codeToGraph';
import { panelCodegen } from '@/engine/panelCode';
import { activeSink } from './sdfPartition';
import { unwrapCollapsedGroupEdges } from './edgeUtils';
import { pairResyncNodes } from './resyncPairing';
import { COLLAPSED_MEMBER_CLASS } from './groupFrame';
import { carryPanelHidden, inOldOrder, panelCarryIds, panelFeederResolver } from './panelCarry';
import { graphToCode } from '@/engine/graphToCode';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

/**
 * The Apply half of the connected-only code panel (utils/panelCarry.ts): the
 * panel's text holds only the nodes that feed an Output, so an Apply must
 * carry every node outside its emitted set — or it deletes all of them.
 */

const frame = (id: string, extra: Record<string, unknown> = {}): AppNode =>
  ({ id, type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: id, color: '#888888', width: 200, height: 100, ...extra } }) as unknown as AppNode;
const note = (id: string): AppNode =>
  ({ id, type: 'note', position: { x: 0, y: 0 }, data: { registryType: 'note', title: '', body: 'a note' } }) as unknown as AppNode;
const tuple = (e: AppEdge) => `${e.source}.${e.sourceHandle} → ${e.target}.${e.targetHandle}`;
/** A feeder resolver that keeps exactly these old ids (the parse kept them). */
const kept = (...ids: string[]) => (id: string) => (ids.includes(id) ? id : null);
/** A node as the palette makes it: labelled with its type's label, not its id —
 *  so pairing really reaches its type-only pass (review 2026-10-27). */
const palette = (id: string, type: string, values: Record<string, string | number> = {}): AppNode => {
  const n = makeNode(id, type, values);
  return { ...n, data: { ...n.data, label: NODE_REGISTRY.get(type)?.label ?? type } } as AppNode;
};

/** f1 → add1 → out, add1 → deadM ← deadP, a lone Perlin and a note. */
function board(): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [
      makeNode('f1', 'float', { value: 0.5 }),
      makeNode('add1', 'add'),
      makeNode('out', 'output'),
      makeNode('deadP', 'property_float', { name: 'knob', value: 2 }),
      makeNode('deadM', 'mul'),
      makeNode('lonely', 'perlin'),
      note('memo'),
    ],
    edges: [
      makeEdge('f1', 'out', 'add1', 'a'),
      makeEdge('add1', 'out', 'out', 'color'),
      // From an EMITTED node into a hidden one: kept across the Apply.
      makeEdge('add1', 'out', 'deadM', 'a'),
      makeEdge('deadP', 'out', 'deadM', 'b'),
    ],
  };
}

/** The scope a pass leaves in the store: `codeEmitted` and `codeNames`. */
interface Scope {
  emitted: ReadonlySet<string> | null;
  names: ReadonlyMap<string, string> | null;
}

/** The panel's text and the scope it leaves, as the graph→code pass writes them. */
function panel(g: { nodes: AppNode[]; edges: AppEdge[] }): { code: string } & Scope {
  const { result, emitted } = panelCodegen(g.nodes, g.edges, false);
  return { code: result.code, emitted, names: emitted ? result.varNames : null };
}

/**
 * doCodeSync's pairing and carry, reduced to what this rule touches and in its
 * order: pair (carried ids excluded, names first), keep the old id, remap the
 * parse's wires, carry the hidden nodes with their wires resolved BY NAME, put
 * the array back in its old order, and hand back the scope the next Apply reads.
 */
function apply(old: { nodes: AppNode[]; edges: AppEdge[] }, code: string, scope: Scope) {
  const parsed = codeToGraph(code);
  expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
  const realOldEdges = unwrapCollapsedGroupEdges(old.nodes, old.edges);
  const carriedIds = panelCarryIds(old.nodes, scope.emitted);
  const names = scope.emitted !== null ? scope.names : null;
  const pairing = pairResyncNodes(old.nodes, parsed.nodes, activeSink(old.nodes, realOldEdges)?.id ?? null, carriedIds, names);
  const idMap = new Map<string, string>();
  const positioned: AppNode[] = [];
  for (const { node, match } of pairing.paired) {
    idMap.set(node.id, match.id);
    positioned.push({ ...node, id: match.id, position: { ...match.position } } as AppNode);
  }
  const unpositioned = [...pairing.unpaired];
  const edges = parsed.edges.map((e) => ({ ...e, source: idMap.get(e.source) ?? e.source, target: idMap.get(e.target) ?? e.target }));
  const parseIds = new Set([...positioned, ...unpositioned].map((n) => n.id));
  const feederOf = panelFeederResolver(old.nodes, [...positioned, ...unpositioned], names);
  const hidden = carryPanelHidden(old.nodes, realOldEdges, carriedIds, feederOf, unpositioned.length > 0);
  let nodes = [...positioned, ...unpositioned, ...hidden.nodes];
  if (scope.emitted !== null) nodes = inOldOrder(nodes, old.nodes);
  return {
    nodes,
    edges: [...edges, ...hidden.edges],
    relayout: unpositioned.length > 0,
    scope: scope.emitted === null
      ? { emitted: null, names: null }
      : { emitted: parseIds as ReadonlySet<string>, names: new Map([...positioned, ...unpositioned].map((n) => [n.id, String(n.data.label)] as const)) },
  };
}

/** The node feeding `target.handle`, with its values. */
function feeder(g: { nodes: AppNode[]; edges: AppEdge[] }, target: string, handle: string): AppNode | undefined {
  const e = g.edges.find((x) => x.target === target && x.targetHandle === handle);
  return e ? g.nodes.find((n) => n.id === e.source) : undefined;
}

describe('panelCarryIds', () => {
  it('everything the text did not emit, except frames and sinks', () => {
    const { nodes, edges } = board();
    const all = [frame('g'), makeNode('parked', 'output'), ...nodes];
    const { emitted } = panelCodegen(all, edges, false);
    expect([...panelCarryIds(all, emitted)].sort()).toEqual(['deadM', 'deadP', 'lonely', 'memo']);
  });

  it('a null scope (study, no sink, a bare-script import) carries nothing: today’s Apply', () => {
    expect(panelCarryIds(board().nodes, null).size).toBe(0);
  });
});

describe('carryPanelHidden', () => {
  const carried = new Set(['deadM', 'deadP']);

  it('keeps a wire from a parsed node or a carried one; drops one whose feeder left the code', () => {
    const { nodes, edges } = board();
    const both = carryPanelHidden(nodes, edges, carried, kept('f1', 'add1', 'out'), false);
    expect(both.nodes.map((n) => n.id)).toEqual(['deadP', 'deadM']);
    expect(both.edges.map(tuple)).toEqual(['add1.out → deadM.a', 'deadP.out → deadM.b']);
    // add1 was deleted from the code: deadM's socket is left unwired, not spliced.
    const gone = carryPanelHidden(nodes, edges, carried, kept('f1', 'out'), false);
    expect(gone.edges.map(tuple)).toEqual(['deadP.out → deadM.b']);
  });

  it('one wire per socket, ids minted by generateEdgeId', () => {
    const { nodes, edges } = board();
    const twice = [...edges, { ...makeEdge('f1', 'out', 'deadM', 'a'), id: 'dup' }];
    const r = carryPanelHidden(nodes, twice, carried, kept('f1', 'add1', 'out'), false);
    expect(r.edges.map(tuple)).toEqual(['add1.out → deadM.a', 'deadP.out → deadM.b']);
    expect(r.edges[0].id).toBe('e-add1-out-deadM-a');
  });

  it('without a relayout a carried node comes back as it was, frame and all', () => {
    const inFrame = { ...makeNode('deadM', 'mul'), parentId: 'g', extent: 'parent' } as AppNode;
    const r = carryPanelHidden([frame('g'), inFrame], [], new Set(['deadM']), kept(), false);
    expect(r.nodes[0]).toBe(inFrame);
  });

  it('under a relayout it loses its frame and its collapsed-member class (positions are absolute then)', () => {
    const member = { ...makeNode('deadM', 'mul'), parentId: 'g', extent: 'parent', className: `other ${COLLAPSED_MEMBER_CLASS}` } as AppNode;
    const bare = { ...makeNode('deadP', 'mul'), parentId: 'g', className: COLLAPSED_MEMBER_CLASS } as AppNode;
    const wire = { ...makeEdge('deadP', 'out', 'deadM', 'a'), className: 'fs-collapsed-edge' } as AppEdge;
    const r = carryPanelHidden([frame('g', { collapsed: true }), member, bare], [wire], new Set(['deadM', 'deadP']), kept(), true);
    const [m, b] = r.nodes as (AppNode & { extent?: unknown })[];
    expect(m.parentId).toBeUndefined();
    expect(m.extent).toBeUndefined();
    expect(m.className).toBe('other');
    expect('className' in b).toBe(false);
    expect('className' in r.edges[0]).toBe(false);
  });

  it('reads a collapsed group’s boundary wire UNWRAPPED, onto the member it really enters', () => {
    const g = frame('g', {
      collapsed: true,
      collapsedInputs: [{ socketId: 'in-0', originalNodeId: 'deadM', originalHandleId: 'a', dataType: 'float' }],
    });
    const member = { ...makeNode('deadM', 'mul'), parentId: 'g' } as AppNode;
    const nodes = [g, makeNode('add1', 'add'), member];
    const stored = [makeEdge('add1', 'out', 'g', 'in-0')];
    const r = carryPanelHidden(nodes, unwrapCollapsedGroupEdges(nodes, stored), new Set(['deadM']), kept('add1'), false);
    expect(r.edges.map(tuple)).toEqual(['add1.out → deadM.a']);
  });
});

describe('an Apply of the connected-only panel (pairing + carry over a real parse)', () => {
  it('the unchanged text keeps every node and every wire, and regenerates byte-identically', () => {
    const before = board();
    const p = panel(before);
    expect(p.code).not.toContain('knob');
    const after = apply(before, p.code, p);
    expect(after.relayout).toBe(false);
    expect(after.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
    expect(after.edges.map(tuple).sort()).toEqual(before.edges.map(tuple).sort());
    expect(panel(after).code).toBe(p.code);
  });

  it('a node typed in this Apply and deleted before the next is not carried back', () => {
    const before = board();
    const p = panel(before);
    const typed = p.code.replace('  const add1 =', '  const typed1 = float(7);\n  const add1 =');
    expect(typed).not.toBe(p.code);
    const first = apply(before, typed, p);
    // The newcomer has no partner: a relayout, and every hidden node rides it.
    expect(first.relayout).toBe(true);
    const typedNode = first.nodes.find((n) => !before.nodes.some((b) => b.id === n.id))!;
    expect(typedNode.data.registryType).toBe('float');
    for (const id of ['deadP', 'deadM', 'lonely', 'memo']) expect(first.nodes.some((n) => n.id === id), id).toBe(true);

    // The second Apply reads the scope the FIRST one left (the hook resets
    // `codeEmitted` to the parse's ids), and the typed line is gone again.
    const second = apply(first, p.code, first.scope);
    expect(second.nodes.some((n) => n.id === typedNode.id)).toBe(false);
    for (const id of ['deadP', 'deadM', 'lonely', 'memo']) expect(second.nodes.some((n) => n.id === id), id).toBe(true);
    // With the pre-Apply scope instead, the deleted line would come back.
    const stale = apply(first, p.code, p);
    expect(stale.nodes.some((n) => n.id === typedNode.id)).toBe(true);
  });

  it('a study session (no scope) is today’s Apply: the unemitted nodes are gone', () => {
    const before = board();
    const after = apply(before, panel(before).code, { emitted: null, names: null });
    expect(after.nodes.map((n) => n.id).sort()).toEqual(['add1', 'f1', 'out']);
  });
});

describe('an Apply binds the hidden nodes’ wires by NAME (review 2026-10-27)', () => {
  /** f1 → add1 (b 0.1) → add2 (b 0.2) → out, a hidden Multiply reading add1 —
   *  with add2 FIRST in the array, as an Add dropped onto a wire upstream of
   *  an existing one leaves it. Palette labels, so pairing reaches pass 2. */
  function chain(): { nodes: AppNode[]; edges: AppEdge[] } {
    return {
      nodes: [
        palette('add2', 'add', { b: 0.2 }),
        palette('add1', 'add', { b: 0.1 }),
        palette('f1', 'float', { value: 0.5 }),
        makeNode('out', 'output'),
        palette('deadM', 'mul', { b: 3 }),
      ],
      edges: [
        makeEdge('f1', 'out', 'add1', 'a'),
        makeEdge('add1', 'out', 'add2', 'a'),
        makeEdge('add2', 'out', 'out', 'color'),
        makeEdge('add1', 'out', 'deadM', 'a'),
      ],
    };
  }

  it('a value edit keeps the hidden node on the SAME feeder — two Adds never swap', () => {
    const before = chain();
    const p = panel(before);
    expect(p.code).toContain('const add1 = add(float1, 0.1);');
    const after = apply(before, p.code.replace('float(0.5)', 'float(0.6)'), p);
    expect(after.relayout).toBe(false);
    expect(getNodeValues(feeder(after, 'deadM', 'a')!).b).toBe(0.1);
    // Ids follow the names: each Add kept its own.
    expect(getNodeValues(after.nodes.find((n) => n.id === 'add1')!).b).toBe(0.1);
    expect(graphToCode(after.nodes, after.edges).code).toContain('const mul1 = mul(add1, 3);');
  });

  it('a feeder RETYPED in the panel (add → sub) still feeds it', () => {
    const before = chain();
    const p = panel(before);
    const after = apply(before, p.code.replace('const add1 = add(float1, 0.1);', 'const add1 = sub(float1, 0.1);'), p);
    expect(feeder(after, 'deadM', 'a')?.data.registryType).toBe('sub');
  });

  it('a PASTED shader keeps the hidden nodes but binds no wire of theirs to a stranger', () => {
    const before = {
      nodes: [palette('f1', 'float', { value: 0.5 }), makeNode('out', 'output'), palette('deadM', 'mul', { b: 3 })],
      edges: [makeEdge('f1', 'out', 'out', 'color'), makeEdge('f1', 'out', 'deadM', 'a')],
    };
    const p = panel(before);
    const pasted = [
      "import { Fn, float, sin, vec3 } from 'three/tsl';",
      '',
      'const shader = Fn(() => {',
      '  const myFloat = float(9);',
      '  return vec3(sin(myFloat));',
      '});',
      '',
      'export default shader;',
    ].join('\n');
    const after = apply(before, pasted, p);
    expect(after.nodes.some((n) => n.id === 'deadM')).toBe(true);
    // The pasted Float may take f1's id (type-only pairing) — never its wire:
    // no `float1` is declared in the text the hidden Multiply read.
    expect(feeder(after, 'deadM', 'a')).toBeUndefined();
  });

  it('the array keeps its order, so an unchanged Apply renames nothing on the next pass', () => {
    // A hidden Perlin FIRST in the array is `noise1`; the connected one `noise2`.
    const before = {
      nodes: [palette('A', 'perlin'), palette('B', 'perlin'), makeNode('out', 'output')],
      edges: [makeEdge('B', 'out', 'out', 'roughness')],
    };
    const p = panel(before);
    expect(p.names!.get('A')).toBe('noise1');
    expect(p.code).toContain('roughness: noise2');
    const after = apply(before, p.code, p);
    expect(after.nodes.map((n) => n.id)).toEqual(['A', 'B', 'out']);
    expect(panel(after).code).toBe(p.code);
  });
});

describe('inOldOrder', () => {
  it('old nodes at their old places, a new one right after the node it follows', () => {
    const n = (id: string) => makeNode(id, 'float');
    const old = [n('a'), n('b'), n('c')];
    expect(inOldOrder([n('c'), n('x'), n('a'), n('y'), n('b')], old).map((x) => x.id)).toEqual(['a', 'y', 'b', 'c', 'x']);
    expect(inOldOrder([n('z'), n('b')], old).map((x) => x.id)).toEqual(['z', 'b']);
  });
});

describe('useSyncEngine wiring (source pins)', () => {
  // A React hook in a node env: what CAN be pinned is where each piece sits.
  const src = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');

  it('the graph→code pass is the panel’s codegen, whole in a study, and writes the emitted set WITH the code', () => {
    expect(src).toContain('const { result, emitted } = panelCodegen(nodes, edges, isEvalMode());');
    expect(src).toContain("setCode(result.code, 'graph', previewText, { emitted, names: result.varNames, nodeSpans: result.nodeSpans })");
    expect(src).not.toMatch(/\bgraphToCode\(/);
  });

  it('the carry reads the scope, excludes it from pairing and lands BEFORE the layout decision', () => {
    const sync = src.slice(src.indexOf('const doCodeSync'));
    const scope = sync.indexOf('const scope = useAppStore.getState().codeEmitted;');
    const pair = sync.indexOf('pairResyncNodes(oldNodes, result.nodes, oldActive?.id ?? null, carriedIds, textNames)');
    const carry = sync.indexOf('carryPanelHidden(oldNodes, realOldEdges, carriedIds, feederOf, unpositioned.length > 0)');
    const layout = sync.indexOf('autoLayout([...positioned, ...unpositioned, ...hidden.nodes], remappedEdges)');
    expect(scope).toBeGreaterThan(-1);
    expect(pair).toBeGreaterThan(scope);
    expect(carry).toBeGreaterThan(pair);
    expect(layout).toBeGreaterThan(carry);
    expect(sync).toContain('finalNodes = [...positioned, ...hidden.nodes];');
  });

  it('a successful Apply resets the scope to what it parsed, after the graph write', () => {
    const sync = src.slice(src.indexOf('const doCodeSync'));
    const write = sync.indexOf("setEdges(remappedEdges, 'code');");
    const reset = sync.indexOf('codeEmitted: parseIds,');
    expect(reset).toBeGreaterThan(write);
    expect(sync.indexOf('codeScopes: [],', reset)).toBeGreaterThan(reset);
  });

  it('the array goes back to its old order before the group block, whenever there is a scope', () => {
    const sync = src.slice(src.indexOf('const doCodeSync'));
    const order = sync.indexOf('if (scope !== null) finalNodes = inOldOrder(finalNodes, oldNodes);');
    expect(order).toBeGreaterThan(-1);
    expect(sync.indexOf('const oldGroups =')).toBeGreaterThan(order);
  });

  it('a paired node keeps its selection — outside a study', () => {
    expect(src).toContain('...(match.selected === true && !isEvalMode() ? { selected: true } : {}),');
  });
});
