import { describe, it, expect } from 'vitest';
import { buildCodeGroup, type CodeGroupEntry } from './codeGroupBuilder';
import { graphToCode } from '@/engine/graphToCode';
import type { AppNode, AppEdge } from '@/types';

/**
 * Geometry + inertness of the optional explainer note that ships inside a
 * code-defined asset group. The note is an ordinary group member, so the
 * builder has to clear a band for it WITHOUT disturbing the LR graph layout
 * underneath, and it must stay invisible to every engine path.
 */

const CODE = `import { color, Fn, mix, uniform, uv } from "three/tsl";

const shader = Fn(() => {
  const a = uniform(color(0x112233));
  const b = uniform(color(0x445566));
  const u = uv();
  const result = mix(a, b, u.y);
  return result;
});
export default shader;`;

const base: CodeGroupEntry = {
  id: 'fixture',
  name: 'Fixture',
  color: '#43A047',
  code: CODE,
  description: 'test fixture',
};

const withNote: CodeGroupEntry = {
  ...base,
  note: { heading: 'UV.y drives the Mix', text: 'The vertical coordinate is used directly as the blend factor.' },
};

const frameSize = (group: AppNode) => {
  // TOP-LEVEL width/height, the shape `groupSelection` writes and the one
  // `toggleGroupCollapsed` reads. It was `style: { width, height }` — which
  // React Flow renders identically and which therefore hid the fact that the
  // collapse/expand round-trip could not see the frame's size at all.
  const m = group as AppNode & { width?: number; height?: number; style?: object };
  expect(m.style, 'the size must not live in `style` any more').toBeUndefined();
  return { w: m.width ?? 0, h: m.height ?? 0 };
};
const sizeOf = (n: AppNode) => {
  const m = n as AppNode & { width?: number; height?: number };
  return { w: m.width ?? 0, h: m.height ?? 0 };
};

describe('buildCodeGroup — explainer note', () => {
  it('adds no note member when the entry has none', () => {
    const built = buildCodeGroup(base, 'test-');
    expect(built.nodes.filter((n) => n.type === 'note')).toHaveLength(0);
  });

  it('adds exactly one note member, parented to the group', () => {
    const built = buildCodeGroup(withNote, 'test-');
    const notes = built.nodes.filter((n) => n.type === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0].parentId).toBe(built.nodes[0].id);
    expect(notes[0].data.heading).toBe(withNote.note!.heading);
    expect(notes[0].data.text).toBe(withNote.note!.text);
  });

  it('keeps the group container first (React Flow parent-before-child)', () => {
    const built = buildCodeGroup(withNote, 'test-');
    expect(built.nodes[0].type).toBe('group');
  });

  it('fits the note fully inside the frame', () => {
    const built = buildCodeGroup(withNote, 'test-');
    const [group] = built.nodes;
    const note = built.nodes.find((n) => n.type === 'note')!;
    const frame = frameSize(group);
    const { w, h } = sizeOf(note);
    expect(note.position.x).toBeGreaterThanOrEqual(0);
    expect(note.position.y).toBeGreaterThanOrEqual(0);
    expect(note.position.x + w).toBeLessThanOrEqual(frame.w);
    expect(note.position.y + h).toBeLessThanOrEqual(frame.h);
  });

  it('clears the header band — the note never overlaps the title bar', () => {
    const built = buildCodeGroup(withNote, 'test-');
    const note = built.nodes.find((n) => n.type === 'note')!;
    // GroupNode.css draws a 22px header INSIDE the frame box.
    expect(note.position.y).toBeGreaterThanOrEqual(22);
  });

  it('pushes the graph BELOW the note instead of overlapping it', () => {
    const built = buildCodeGroup(withNote, 'test-');
    const note = built.nodes.find((n) => n.type === 'note')!;
    const noteBottom = note.position.y + sizeOf(note).h;
    const graph = built.nodes.filter((n) => n.type !== 'group' && n.type !== 'note');
    expect(graph.length).toBeGreaterThan(0);
    for (const n of graph) expect(n.position.y).toBeGreaterThan(noteBottom);
  });

  it('shifts the graph down by exactly the note band, leaving x untouched', () => {
    const plain = buildCodeGroup(base, 'test-');
    const noted = buildCodeGroup(withNote, 'test-');
    const byVar = (b: typeof plain) =>
      new Map(
        b.nodes
          .filter((n) => n.type !== 'group' && n.type !== 'note')
          .map((n) => [String(n.data.label ?? n.id), n.position]),
      );
    const a = byVar(plain);
    const b = byVar(noted);
    expect(b.size).toBe(a.size);
    const deltas = new Set<number>();
    for (const [k, posA] of a) {
      const posB = b.get(k);
      expect(posB, `missing ${k}`).toBeDefined();
      expect(posB!.x).toBe(posA.x); // the LR layout is untouched
      deltas.add(posB!.y - posA.y);
    }
    // One uniform downward shift for every node — not a re-layout.
    expect(deltas.size).toBe(1);
    expect([...deltas][0]).toBeGreaterThan(0);
  });

  it('grows the frame to fit the note rather than clipping it', () => {
    const plain = frameSize(buildCodeGroup(base, 'test-').nodes[0]);
    const noted = frameSize(buildCodeGroup(withNote, 'test-').nodes[0]);
    expect(noted.h).toBeGreaterThan(plain.h);
    expect(noted.w).toBeGreaterThanOrEqual(plain.w);
  });

  it('is inert for codegen — identical output with and without the note', () => {
    const plain = buildCodeGroup(base, 'test-');
    const noted = buildCodeGroup(withNote, 'test-');
    const emit = (b: typeof plain) =>
      graphToCode(b.nodes.filter((n) => n.type !== 'group'), b.edges).code;
    expect(emit(noted)).toBe(emit(plain));
    // …and it carries no wires.
    for (const e of noted.edges) {
      const note = noted.nodes.find((n) => n.type === 'note')!;
      expect(e.source).not.toBe(note.id);
      expect(e.target).not.toBe(note.id);
    }
  });
});

describe('built-in assets land with as few crossing wires as their layouts allow', () => {
  // dagre knows nothing about SOCKETS: the Ghost recipe stacked its Opacity
  // feeder above its Color one, Mix Two Colors put the Fresnel feeding Mix's
  // bottom socket above the Colors feeding A and B, and the wires crossed
  // (owner, 2026-10-20). buildCodeGroup now also tries the socket-ordered
  // layout and keeps whichever crosses less.
  const load = async () => {
    const { getBuiltinPresets, isRecipe } = await import('./builtinPresets');
    const { getBuiltinTextures } = await import('./builtinTextures');
    const { NODE_REGISTRY } = await import('./nodeRegistry');
    const { codeToGraph } = await import('@/engine/codeToGraph');
    const { autoLayout, wireInversions } = await import('@/engine/layoutEngine');
    const rankFor = (nodes: AppNode[], outputIds: Set<string>) => {
      const rowsOf = (type: string) => new Map((NODE_REGISTRY.get(type)?.inputs ?? []).map((p, i) => [p.id, i] as const));
      const rows = new Map<string, Map<string, number>>();
      for (const n of nodes) rows.set(n.id, rowsOf(String(n.data.registryType)));
      for (const id of outputIds) rows.set(id, rowsOf('output'));
      return (t: string, h?: string | null) => rows.get(t)?.get(h ?? '') ?? 99;
    };
    /** Crossings as SHIPPED, and as the plain (socket-blind) layout would have them. */
    const crossings = (asset: { code: string; nodes: AppNode[]; edges: AppEdge[]; outputEdges: AppEdge[] }) => {
      // Shipped: the asset's OWN members, wires and Output wires — a fresh
      // parse mints new ids, so it cannot be compared with these positions.
      const members = asset.nodes.filter((n) => n.type !== 'group' && n.type !== 'note');
      const shipped = wireInversions(
        members,
        [...asset.edges, ...asset.outputEdges],
        rankFor(members, new Set(asset.outputEdges.map((e) => e.target))),
      );
      // Plain: a fresh parse laid out socket-blind, measured on ITS ids.
      const raw = codeToGraph(asset.code);
      const outputIds = new Set(raw.nodes.filter((n) => n.data.registryType === 'output').map((n) => n.id));
      const parsed = raw.nodes.filter((n) => !outputIds.has(n.id));
      const ids = new Set(parsed.map((n) => n.id));
      const inner = raw.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      const toOut = raw.edges.filter((e) => ids.has(e.source) && outputIds.has(e.target));
      const plain = wireInversions(
        autoLayout(parsed, inner, { nodesep: 10, ranksep: 30 }),
        [...inner, ...toOut],
        rankFor(parsed, outputIds),
      );
      return { shipped, plain };
    };
    return { assets: [...getBuiltinPresets(), ...getBuiltinTextures()], isRecipe, crossings };
  };

  it('a beginner recipe crosses NO wire, into the Output or into any node', async () => {
    const { assets, isRecipe, crossings } = await load();
    const recipes = assets.filter((a) => 'tier' in a && isRecipe(a as { tier: number }));
    expect(recipes.length).toBeGreaterThan(10);
    for (const r of recipes) expect(crossings(r).shipped, r.id).toBe(0);
    // Teeth: the count does see crossings — Mix Two Colors laid out
    // socket-blind crosses two wires into its Mix.
    expect(crossings(recipes.find((r) => r.id === 'recipe-mix')!).plain).toBe(2);
  });

  it('every other built-in keeps its socket-blind layout — the wired node stays on the top row', async () => {
    // The ordering is opt-in for the recipes only: it moves the wired node off
    // the top row, which a press's top-right reveal and the intro's budget
    // slide (Gas Giant) rely on. Presets 2 and the Textures are untouched.
    const { assets, isRecipe, crossings } = await load();
    const others = assets.filter((a) => !('tier' in a) || !isRecipe(a as { tier: number }));
    expect(others.length).toBeGreaterThan(30);
    for (const a of others) {
      const { shipped, plain } = crossings(a);
      expect(shipped, a.id).toBe(plain);
    }
  });
});
