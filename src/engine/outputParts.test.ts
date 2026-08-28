/**
 * Per-mesh materials: the `parts` key, from graph to code and back.
 *
 * The invariants here are the ones that fail SILENTLY. In rough order of how
 * expensive they are to discover in the wild:
 *
 *  - A graph with no mesh target must emit the SAME BYTES it always did. Every
 *    built-in snapshot depends on it, and so does every shader anyone has
 *    already exported.
 *  - Emission and the parse must land together. Emission alone is byte-stable,
 *    node-count-stable and error-free while silently deleting every secondary
 *    binding on the first code-panel Apply — no existing round-trip invariant
 *    can fail on that, which is precisely why it needs its own assertions.
 *  - A targeted Output with nothing wired must still emit its entry, or the
 *    parse cannot re-create the node and the Output plus its edges disappear.
 *  - Mesh names come from a dropped file. They reach generated code, and the
 *    generated module is executed at the app's real origin by the XR popup.
 */

import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

/** The ONE Output node, carrying the given added materials. */
function outputWith(id: string, ...meshes: string[]): AppNode {
  const node = makeNode(id, 'output');
  if (meshes.length > 0) {
    (node.data as Record<string, unknown>).materials = meshes.map((name) => ({
      meshTarget: { name },
    }));
  }
  return node;
}

/**
 * color1 → the default material, color2 → a material shading `Glass`.
 *
 * Both live on ONE Output node: the default is its own fields (bare handles),
 * the added material is `materials[0]` wired through `m1:` handles.
 */
function twoMaterialGraph() {
  const base = makeNode('color1', 'color', { hex: '#22cc22' });
  const part = makeNode('color2', 'color', { hex: '#cc2222' });
  const out = outputWith('out1', 'Glass');
  return {
    nodes: [base, part, out],
    edges: [
      makeEdge('color1', 'out', 'out1', 'color'),
      makeEdge('color2', 'out', 'out1', 'm1:color'),
    ],
  };
}

describe('emission', () => {
  it('emits nothing new when no Output carries a target', () => {
    const base = makeNode('color1', 'color', { hex: '#22cc22' });
    const def = makeNode('out1', 'output');
    const edges = [makeEdge('color1', 'out', 'out1', 'color')];
    const { code } = graphToCode([base, def], edges);
    expect(code).not.toContain('parts');
    // The single-channel colour graph keeps its bare-node return form.
    expect(code).toContain('return color1;');
  });

  it('puts a targeted Output in `parts`, keyed by mesh name', () => {
    const { nodes, edges } = twoMaterialGraph();
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('parts: { "Glass": { color: color2 } }');
    // …and the default keeps shading everything else, from the top level.
    expect(code).toContain('color: color1');
  });

  it('forces the object return form, since a bare node cannot carry parts', () => {
    const { nodes, edges } = twoMaterialGraph();
    const { code } = graphToCode(nodes, edges);
    expect(code).toMatch(/return \{ color: color1, parts: \{/);
  });

  it('emits parts ALONE when the default material is empty', () => {
    // Loader 0.6 then leaves every unclaimed mesh on the material the model was
    // authored with — the whole point of shading one mesh. The red fallback is
    // deliberately not emitted: it is the "nothing is wired yet" sentinel for a
    // shader with nothing else to say, and painting every OTHER mesh red to
    // announce a state visible on the node would throw the model's own
    // materials away.
    const part = makeNode('color2', 'color', { hex: '#cc2222' });
    const nodes = [part, outputWith('out1', 'Glass')];
    const { code } = graphToCode(nodes, [makeEdge('color2', 'out', 'out1', 'm1:color')]);
    expect(code).not.toContain('vec3(1, 0, 0)');
    // Var names are assigned per TYPE, so the graph's only colour node is
    // `color1` regardless of its node id.
    expect(code).toContain('return { parts: { "Glass": { color: color1 } } };');
  });

  it('emits an entry for a targeted Output with nothing wired', () => {
    // Without the entry the parse never mints the node, so the Output — and
    // any edges the user had already drawn to it — vanish on the next Apply.
    const base = makeNode('color1', 'color', { hex: '#22cc22' });
    const nodes = [base, outputWith('out1', 'Glass')];
    const { code } = graphToCode(nodes, [makeEdge('color1', 'out', 'out1', 'color')]);
    expect(code).toContain('parts: { "Glass": {  } }');
  });

  it('emits a part discard as a KEY, never as a statement', () => {
    // A bare `Discard()` statement belongs to the whole module: it cannot be
    // attributed to one mesh, so a part carries its condition instead.
    const cond = makeNode('float1', 'float', { value: 1 });
    const nodes = [cond, outputWith('out1', 'Glass')];
    const { code } = graphToCode(nodes, [makeEdge('float1', 'out', 'out1', 'm1:discard')]);
    expect(code).toContain('discard: float1');
    // The default output has no discard, so no statement is emitted at all.
    expect(code).not.toMatch(/^\s*Discard\(/m);
  });

  it('ignores a stray SECOND Output node rather than blending two defaults', () => {
    const base = makeNode('color1', 'color', { hex: '#22cc22' });
    const stray = makeNode('color2', 'color', { hex: '#cc2222' });
    const nodes = [base, stray, makeNode('out1', 'output'), makeNode('out2', 'output')];
    const { code } = graphToCode(nodes, [
      makeEdge('color1', 'out', 'out1', 'color'),
      makeEdge('color2', 'out', 'out2', 'color'),
    ]);
    expect(code).not.toContain('parts');
    expect(code).toContain('return color1;');
  });

  it('lets the first claim win when two materials target one mesh', () => {
    // A mesh has one material, so the second claim is unrenderable. First-wins
    // matches the restore-path sanitizer, so a live graph and a reloaded one
    // emit the same module.
    const a = makeNode('color1', 'color', { hex: '#22cc22' });
    const b = makeNode('color2', 'color', { hex: '#cc2222' });
    const nodes = [a, b, outputWith('out1', 'Glass', 'Glass')];
    const { code } = graphToCode(nodes, [
      makeEdge('color1', 'out', 'out1', 'm1:color'),
      makeEdge('color2', 'out', 'out1', 'm2:color'),
    ]);
    expect((code.match(/"Glass":/g) ?? [])).toHaveLength(1);
    expect(code).toContain('"Glass": { color: color1 }');
  });
});

describe('adversarial mesh names', () => {
  const emitWithTarget = (name: string) => {
    const part = makeNode('color2', 'color', { hex: '#cc2222' });
    const nodes = [part, outputWith('out1', name)];
    return graphToCode(nodes, [makeEdge('color2', 'out', 'out1', 'm1:color')]).code;
  };

  it('refuses a name that cannot be one, rather than emitting it', () => {
    // Emission is a gate, not a formatter: these never reach code at all.
    for (const name of ['', '__proto__', 'a\u0000b', 'x'.repeat(500)]) {
      expect(emitWithTarget(name)).not.toContain('parts');
    }
  });

  it('carries a non-ASCII name through unharmed', () => {
    // three preserves these, so refusing them would make the app's own primary
    // language untargetable.
    expect(emitWithTarget('Ķermenis_āda_2')).toContain('"Ķermenis_āda_2"');
  });

  it('escapes a comment terminator inside a name', () => {
    // The exported .js carries the project block as a BLOCK comment.
    const code = emitWithTarget('a*/b');
    expect(code).not.toContain('a*/b');
    expect(code).toContain('a*\\u002Fb');
  });
});

describe('round trip', () => {
  it('parses parts back into MATERIALS on the one Output node', () => {
    const { nodes, edges } = twoMaterialGraph();
    const { code } = graphToCode(nodes, edges);
    const parsed = codeToGraph(code);
    const outputs = parsed.nodes.filter((n) => n.data.registryType === 'output');
    expect(outputs).toHaveLength(1);
    expect((outputs[0].data as Record<string, unknown>).materials).toEqual([
      { meshTargets: ['Glass'] },
    ]);
    expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
  });

  it('re-emits the same code — an Apply must not change the shader', () => {
    const { nodes, edges } = twoMaterialGraph();
    const first = graphToCode(nodes, edges).code;
    const parsed = codeToGraph(first);
    const second = graphToCode(parsed.nodes, parsed.edges).code;
    expect(second).toBe(first);
  });

  it('does not grow the graph across TWO successive Applies', () => {
    // Three separate mechanisms in this engine only change the node count on
    // the SECOND pass, so one round trip is not enough to see growth.
    const { nodes, edges } = twoMaterialGraph();
    const one = codeToGraph(graphToCode(nodes, edges).code);
    const two = codeToGraph(graphToCode(one.nodes, one.edges).code);
    expect(two.nodes).toHaveLength(one.nodes.length);
    expect(two.edges).toHaveLength(one.edges.length);
  });

  it('wires a part edge to its own MATERIAL handle, not the default\'s', () => {
    // The whole point of the namespace: material 0 keeps the bare `color`
    // every saved graph already uses, and a material's channel is `m1:color`.
    // Collapse the two and one material silently feeds the other.
    const { nodes, edges } = twoMaterialGraph();
    const parsed = codeToGraph(graphToCode(nodes, edges).code);
    const out = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    const handles = parsed.edges
      .filter((e) => e.target === out.id)
      .map((e) => e.targetHandle)
      .sort();
    expect(handles).toEqual(['color', 'm1:color']);
  });
});
