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

/** An Output node bound to a mesh. */
function targetedOutput(id: string, name: string): AppNode {
  const node = makeNode(id, 'output');
  (node.data as Record<string, unknown>).meshTarget = { name };
  return node;
}

/** color → default Output, color2 → an Output targeting `Glass`. */
function twoMaterialGraph() {
  const base = makeNode('color1', 'color', { hex: '#22cc22' });
  const part = makeNode('color2', 'color', { hex: '#cc2222' });
  const def = makeNode('out1', 'output');
  const glass = targetedOutput('out2', 'Glass');
  return {
    nodes: [base, part, def, glass],
    edges: [
      makeEdge('color1', 'out', 'out1', 'color'),
      makeEdge('color2', 'out', 'out2', 'color'),
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

  it('keeps a real default channel even when the default Output is empty', () => {
    // A parts-ONLY return would fail the loader's "is this the object API?"
    // test and be assigned wholesale as a node — a failure that surfaces deep
    // in the renderer with no usable error.
    const part = makeNode('color2', 'color', { hex: '#cc2222' });
    const nodes = [part, makeNode('out1', 'output'), targetedOutput('out2', 'Glass')];
    const { code } = graphToCode(nodes, [makeEdge('color2', 'out', 'out2', 'color')]);
    expect(code).toContain('color: vec3(1, 0, 0)');
    // Var names are assigned per TYPE, so the graph's only colour node is
    // `color1` regardless of its node id.
    expect(code).toContain('parts: { "Glass": { color: color1 } }');
  });

  it('emits an entry for a targeted Output with nothing wired', () => {
    // Without the entry the parse never mints the node, so the Output — and
    // any edges the user had already drawn to it — vanish on the next Apply.
    const base = makeNode('color1', 'color', { hex: '#22cc22' });
    const nodes = [base, makeNode('out1', 'output'), targetedOutput('out2', 'Glass')];
    const { code } = graphToCode(nodes, [makeEdge('color1', 'out', 'out1', 'color')]);
    expect(code).toContain('parts: { "Glass": {  } }');
  });

  it('emits a part discard as a KEY, never as a statement', () => {
    // A bare `Discard()` statement belongs to the whole module: it cannot be
    // attributed to one mesh, so a part carries its condition instead.
    const cond = makeNode('float1', 'float', { value: 1 });
    const nodes = [cond, makeNode('out1', 'output'), targetedOutput('out2', 'Glass')];
    const { code } = graphToCode(nodes, [makeEdge('float1', 'out', 'out2', 'discard')]);
    expect(code).toContain('discard: float1');
    // The default output has no discard, so no statement is emitted at all.
    expect(code).not.toMatch(/^\s*Discard\(/m);
  });

  it('ignores an extra UNTARGETED Output rather than blending two defaults', () => {
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

  it('lets the first claim win when two Outputs target one mesh', () => {
    // A mesh has one material, so the second claim is unrenderable. First-wins
    // matches the restore-path sanitizer, so a live graph and a reloaded one
    // emit the same module.
    const a = makeNode('color1', 'color', { hex: '#22cc22' });
    const b = makeNode('color2', 'color', { hex: '#cc2222' });
    const nodes = [a, b, makeNode('out1', 'output'), targetedOutput('out2', 'Glass'), targetedOutput('out3', 'Glass')];
    const { code } = graphToCode(nodes, [
      makeEdge('color1', 'out', 'out2', 'color'),
      makeEdge('color2', 'out', 'out3', 'color'),
    ]);
    expect((code.match(/"Glass":/g) ?? [])).toHaveLength(1);
    expect(code).toContain('"Glass": { color: color1 }');
  });
});

describe('adversarial mesh names', () => {
  const emitWithTarget = (name: string) => {
    const part = makeNode('color2', 'color', { hex: '#cc2222' });
    const nodes = [part, makeNode('out1', 'output'), targetedOutput('out2', name)];
    return graphToCode(nodes, [makeEdge('color2', 'out', 'out2', 'color')]).code;
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
  it('parses parts back into targeted Output nodes', () => {
    const { nodes, edges } = twoMaterialGraph();
    const { code } = graphToCode(nodes, edges);
    const parsed = codeToGraph(code);
    const outputs = parsed.nodes.filter((n) => n.data.registryType === 'output');
    expect(outputs).toHaveLength(2);
    const targets = outputs.map((n) => (n.data as Record<string, unknown>).meshTarget);
    expect(targets).toContainEqual({ name: 'Glass' });
    expect(targets).toContainEqual(undefined);
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

  it('keeps a wired part edge attached to its own Output', () => {
    const { nodes, edges } = twoMaterialGraph();
    const parsed = codeToGraph(graphToCode(nodes, edges).code);
    const glass = parsed.nodes.find(
      (n) => (n.data as Record<string, unknown>).meshTarget !== undefined,
    );
    expect(glass).toBeDefined();
    const intoGlass = parsed.edges.filter((e) => e.target === glass!.id);
    expect(intoGlass).toHaveLength(1);
    expect(intoGlass[0].targetHandle).toBe('color');
  });
});
