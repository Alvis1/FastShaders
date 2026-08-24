import { describe, it, expect } from 'vitest';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import { NODE_REGISTRY, getEditorDefinitions, searchNodes } from '@/registry/nodeRegistry';

const gen = (n: unknown[], e: unknown[]) => graphToCode(n as never, e as never).code;
const out = makeNode('out1', 'output');
const toColor = [makeEdge('vc1', 'out', 'out1', 'color')];

/**
 * The Vertex Color node is shaped unlike every other zero-input source in the
 * registry, and the reason is not obvious from the def alone — so it is pinned
 * here. `vertexColor` is a FUNCTION in three/tsl, not a node OBJECT like
 * positionGeometry/normalLocal/time, and graphToCode's bare-reference branch is
 * gated on `!def.defaultValues`. Land on that branch and the emitted module is
 * `const vertexColor1 = vertexColor;` — an uncalled function reference that does
 * NOT throw, compiles to a black vec4(0,0,0,0) on both backends, and turns any
 * downstream method chain into `vertexColor1.mul is not a function`.
 *
 * The `index` key is what keeps it off that branch. These tests fail loudly if
 * anyone "tidies" it away.
 */
describe('vertexColor — the def shape is load-bearing', () => {
  const def = NODE_REGISTRY.get('vertexColor')!;

  it('has the exact shape that reaches the CALL branch, not the bare-reference one', () => {
    expect(def.inputs.length).toBe(0);
    expect(def.category).toBe('input');
    // The load-bearing bit: removing this makes the module emit a bare
    // function reference and render black, silently.
    expect(def.defaultValues).toBeTruthy();
    // Positional key-order contract — graphToCode emits Object.keys(...)[0].
    expect(Object.keys(def.defaultValues!)[0]).toBe('index');
  });

  it('declares vec4 so the Output alpha-widen rule fires', () => {
    // VertexColorNode is `super(null, 'vec4')` whatever the file's itemSize, so
    // declaring vec3 here would skip the widen and hand the attribute's `w`
    // straight to pixel alpha.
    expect(def.outputs[0].dataType).toBe('vec4');
  });

  it('keeps `index` a stored value, never a wireable port', () => {
    // A wired vertexColor(<node>) silently evaluates `node > 0` as false and
    // reads `color`, ignoring the wire — so the index must stay a widget.
    expect(def.inputs.find((i) => i.id === 'index')).toBeUndefined();
  });
});

describe('vertexColor — emission', () => {
  it('emits a CALL and widens into an alpha-bearing channel', () => {
    const code = gen([makeNode('vc1', 'vertexColor'), out], toColor);
    expect(code).toContain('const vertexColor1 = vertexColor(0);');
    expect(code).not.toContain('const vertexColor1 = vertexColor;');
    expect(code).toContain('vec3(vertexColor1)');
    expect(code).toMatch(/import \{[^}]*\bvertexColor\b[^}]*\} from 'three\/tsl'/);
  });

  it('emits the FUNCTION form downstream, never a method chain', () => {
    // `vertexColor1.mul(2)` is a module-killing TypeError, because the variable
    // holds a Node only by virtue of having been CALLED above.
    const code = gen(
      [makeNode('vc1', 'vertexColor'), makeNode('m1', 'mul'), out],
      [makeEdge('vc1', 'out', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'emissive')],
    );
    expect(code).toContain('mul(vertexColor1, 1)');
    expect(code).not.toMatch(/vertexColor1\.\w+\(/);
  });

  it('re-emits a tampered index as a number, never as text', () => {
    const bad = makeNode('vc1', 'vertexColor', { index: '0); evil(); vertexColor(0' });
    const code = gen([bad, out], toColor);
    expect(code).toContain('const vertexColor1 = vertexColor(0);');
    expect(code).not.toContain('evil');
  });
});

describe('vertexColor — round trip', () => {
  it('parses back to one node and is byte-stable over repeated Applies', () => {
    const code = gen([makeNode('vc1', 'vertexColor'), out], toColor);
    const p1 = codeToGraph(code);
    expect(p1.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(p1.nodes.map((n) => n.data.registryType).sort()).toEqual(['output', 'vertexColor']);

    const again = gen(p1.nodes, p1.edges);
    expect(again).toBe(code);

    // A second Apply must not GROW the graph — the failure mode a wrapper call
    // would have introduced (a Float node spliced in on every pass).
    const p2 = codeToGraph(again);
    expect(p2.nodes.length).toBe(2);
    expect(gen(p2.nodes, p2.edges)).toBe(code);
  });

  it('carries a non-default index across the round trip', () => {
    const code = gen([makeNode('vc1', 'vertexColor', { index: 1 }), out], toColor);
    expect(code).toContain('vertexColor(1)');
    const n = codeToGraph(code).nodes.find((x) => x.data.registryType === 'vertexColor')!;
    expect((n.data as { values: Record<string, unknown> }).values.index).toBe(1);
  });
});

describe('vertexColor — reachable in the editor', () => {
  it('is offered in the palette and findable by name', () => {
    expect(getEditorDefinitions().some((d) => d.type === 'vertexColor')).toBe(true);
    expect(searchNodes('vertex color')[0]?.type).toBe('vertexColor');
  });
});
