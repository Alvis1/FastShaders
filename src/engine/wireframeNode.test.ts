import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import {
  NODE_REGISTRY,
  getEditorDefinitions,
  getFlowNodeType,
  searchNodes,
} from '@/registry/nodeRegistry';
import { nodeCostPoints } from '@/utils/nodeCost';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * The Wireframe node: Isolines' derivative-AA construction run on a vec2, so
 * one chain draws both axes of the surface parameter.
 *
 * What is worth pinning here is NOT the emitted text — a string comparison
 * proves the emitter agrees with itself and nothing more. It is:
 *   1. that the chain is real TSL (the dataVizTslContract argument: a method
 *      that does not exist produces perfect-looking source and a blank pane),
 *   2. that the vec2 form does not silently collapse to a scalar,
 *   3. that the `construction` sketch shown in the settings menu still
 *      describes what graphToCode emits.
 */

const def = NODE_REGISTRY.get('wireframe')!;

/** Emit one Wireframe node driving Output.color. */
function emit(node?: AppNode): string {
  const n = node ?? makeNode('w', 'wireframe');
  const out = makeNode('out', 'output');
  return graphToCode([n, out], [makeEdge('w', 'out', 'out', 'color')]).code;
}

describe('Wireframe — the emitted chain is real TSL', () => {
  it('builds against the shipped three, unwired', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const T = TSL as any;
    const p = T.uv().mul(10);
    const fw = T.dFdx(p).abs().add(T.dFdy(p).abs()).max(0.00001);
    const hw = fw.mul(1.5).mul(0.5);
    const d = T.vec2(0.5).sub(p.fract().sub(0.5).abs());
    const ln = d.smoothstep(T.vec2(0.0), hw).oneMinus();
    const avg = fw.mul(1.5).clamp(0.0, 1.0);
    const c = T.mix(ln, avg, fw.mul(2.0).sub(1.0).clamp(0.0, 1.0));
    expect(c.x.max(c.y)).toBeTruthy();
  });

  it('imports every symbol it calls as a free function', () => {
    const code = emit();
    for (const name of ['vec2', 'dFdx', 'dFdy', 'mix', 'uv']) {
      expect(code, name).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b`));
    }
  });
});

describe('Wireframe — the vec2 form stays a vec2', () => {
  it('keeps both axes: the phase, half-width and distance are all vec2-shaped', () => {
    const code = emit();
    // The distance line is where a collapse to one axis would show first: a
    // scalar chain has no `.y` to combine at the end.
    expect(code).toMatch(/const _wireframe1_d = vec2\(0\.5\)\.sub\(_wireframe1_p\.fract\(\)/);
    expect(code).toMatch(/_wireframe1_c\.x\.max\(_wireframe1_c\.y\)/);
  });

  it('takes the derivative of the CONTINUOUS phase, never of fract()', () => {
    const code = emit();
    // The whole construction turns on this ordering — dFdx(fract(p)) spikes
    // once per cell and draws a false line through every real one. The
    // derivative is of `d`, which is built from the unwrapped phase.
    expect(code).toMatch(/const _wireframe1_d = vec2\(0\.5\)\.sub\(_wireframe1_p\.fract\(\)/);
    expect(code).toMatch(/dFdx\(_wireframe1_d\)/);
    expect(code).not.toMatch(/dFdx\([^)]*fract/);
    expect(code).not.toMatch(/dFdy\([^)]*fract/);
  });

  it('floors the derivative, so a screen-parallel face cannot divide by zero', () => {
    expect(emit()).toMatch(/\.max\(0\.00001\)/);
  });

  it('combines the two axes with max — a crossing is one line, not a bright junction', () => {
    expect(emit()).toMatch(/\.x\.max\(/);
    expect(emit()).not.toMatch(/_wireframe1_c\.x\.add\(_wireframe1_c\.y\)/);
  });
});

describe('Wireframe — density is the value on the card', () => {
  it('is a real INPUT, so the card renders a live number and not a dead box', () => {
    // An input with no defaultValues entry gets ShaderNode's "inline value for
    // unconnected ports" widget, which this emitter never read — an editable
    // control that did nothing. Reported from the canvas.
    expect(def.inputs.map((i) => i.id)).toEqual(['density']);
    expect(def.defaultValues?.density).toBe(10);
  });

  it('the stored number reaches the emitted phase', () => {
    expect(emit(makeNode('w', 'wireframe', { density: 24 }))).toMatch(/uv\(\)\.mul\(24\)/);
  });

  it('and it can be WIRED, since it is a port', () => {
    const code = graphToCode(
      [makeNode('t', 'time'), makeNode('w', 'wireframe'), makeNode('out', 'output')],
      [makeEdge('t', 'out', 'w', 'density'), makeEdge('w', 'out', 'out', 'color')],
    ).code;
    expect(code).toMatch(/uv\(\)\.mul\(time1\)/);
  });
});

describe('Wireframe — settings', () => {
  it('width stays settings-only — it is not a port', () => {
    expect(def.inputs.map((i) => i.id)).not.toContain('width');
    expect(Object.keys(def.defaultValues ?? {})).toEqual(['density', 'width']);
  });

  it('a stored width reaches the emitted half-width', () => {
    const code = emit(makeNode('w', 'wireframe', { density: 24, width: 4 }));
    expect(code).toMatch(/\.mul\(24\)/);
    expect(code).toMatch(/_wireframe1_fw\.mul\(4\)\.mul\(0\.5\)/);
  });

  it('a junk width from a tampered file never reaches the code as text', () => {
    // values arrive from .fastshader files; numericParam is the coercion point.
    const code = emit(makeNode('w', 'wireframe', { density: '4); evil(', width: NaN }));
    expect(code).not.toContain('evil');
    expect(code).not.toContain('NaN');
  });
});

describe('Wireframe — the settings-menu code line describes the real emission', () => {
  it('is ONE line', () => {
    expect(def.construction).not.toContain('\n');
  });

  it('is a faithful fusion of the lines graphToCode really emits', () => {
    // A static string can drift from the emitter, and this is the only thing
    // that would notice. Every fragment of the one-liner is checked against
    // the emission with the emitter's own `_wireframe1_` prefixes dropped and
    // `width` resolved to the value it emits — the two differences between a
    // readable line and a transcript.
    const emitted = emit().replace(/_wireframe1_/g, '');
    const width = String(def.defaultValues!.width);
    const expr = def.construction!.split('//')[0];

    // The emitter splits the fused line across three consts: d, hw and ln.
    expect(emitted).toContain('const d = vec2(0.5).sub(p.fract().sub(0.5).abs());');
    expect(emitted).toContain(`const hw = fw.mul(${width}).mul(0.5);`);
    expect(emitted).toContain('const ln = d.smoothstep(vec2(0.0), hw).oneMinus();');

    // ...and every fragment of the line is one of those, so the line cannot
    // claim an operation the emitter does not perform.
    for (const part of ['.smoothstep(', `fw.mul(${width}).mul(0.5)`, '.oneMinus()']) {
      expect(emitted, part).toContain(part);
      expect(expr.replace('width', width), part).toContain(part.trim());
    }
  });

  it('names every function it claims, and the emission uses them', () => {
    const sketch = def.construction!;
    for (const op of ['fract', 'smoothstep', 'oneMinus', 'dFdx', 'dFdy']) {
      expect(sketch, `line names ${op}`).toContain(op);
      expect(emit(), `emission uses ${op}`).toContain(op);
    }
    // The comment names both modes' distance, so it stays true in each.
    expect(sketch).toContain('bary');
  });

  it('names both settings, so the sketch explains the controls beside it', () => {
    for (const key of Object.keys(def.defaultValues ?? {})) {
      expect(def.construction).toContain(key);
    }
  });

  it('is not in the search corpus (it is full of other nodes’ names)', () => {
    expect(def.description).not.toContain(def.construction!.slice(0, 20));
  });
});

describe('Wireframe — it is actually reachable in the editor', () => {
  it('is offered by default: dataviz is not one of the optional categories', () => {
    expect(getEditorDefinitions().map((d) => d.type)).toContain('wireframe');
  });

  it('renders as a ShaderNode, which is what its glyph and settings assume', () => {
    expect(getFlowNodeType(def)).toBe('shader');
    expect(CUSTOM_GLYPHS.wireframe?.svg, 'a glyphless node is a bare titled box').toBeTruthy();
  });

  it('is found by name and by the words people actually search for', () => {
    for (const q of ['wireframe', 'wiref', 'mesh', 'cage', 'lattice']) {
      expect(searchNodes(q).map((d) => d.type), q).toContain('wireframe');
    }
    // Its own name outranks everything else for its own query.
    expect(searchNodes('wireframe')[0].type).toBe('wireframe');
  });

  it('is priced — an unpriced node clumps at the head of the cost-sorted strip', () => {
    const cost = nodeCostPoints(makeNode('w', 'wireframe'), []);
    expect(cost).toBeGreaterThan(0);
    // Roughly two Isolines chains (one per axis) plus the combine — derived,
    // NOT measured, and the ShaderCarousel bench is what would settle it.
    expect(cost).toBe(26);
  });
});

describe('Wireframe — the known limit: it is ONE-WAY through codeToGraph', () => {
  // The whole hand-emitted family behaves this way (isolines, stripes,
  // colormap, dataRange): the node emits a construction rather than a call, so
  // a code-panel Apply reads that construction back as the nodes it is made of
  // and the single Wireframe node is gone. Pinned, not fixed — what matters is
  // that it degrades PREDICTABLY and never blocks the Apply.
  const applied = codeToGraph(
    graphToCode(
      [makeNode('w', 'wireframe'), makeNode('out', 'output')],
      [makeEdge('w', 'out', 'out', 'color')],
    ).code,
  );

  it('decomposes into its parts instead of surviving as one node', () => {
    const types = applied.nodes.map((n) => n.data.registryType);
    expect(types).not.toContain('wireframe');
    expect(types).toContain('fract');
    expect(types).toContain('smoothstep');
  });

  it('the two derivative calls degrade to WARNINGS, so the Apply still lands', () => {
    // A 'warning' lets the code→graph sync proceed; an 'error' would block it,
    // which would make the code panel unusable on any graph holding this node.
    const messages = applied.errors.map((e) => e.message);
    expect(messages).toEqual(['Unknown function: dFdx', 'Unknown function: dFdy']);
    for (const e of applied.errors) expect(e.severity).toBe('warning');
  });
});

describe('Wireframe — EDGES mode draws the real triangle edges', () => {
  const edgeNode = () => makeNode('w', 'wireframe', { edges: 1 });

  it('reads the per-corner barycentric attribute', () => {
    // Neither backend exposes barycentrics (WGSL has none, the GLSL extension
    // is desktop-only) and an indexed mesh shares corners between triangles, so
    // the geometry has to carry them. The loader injects the attribute.
    expect(emit(edgeNode())).toContain(`const _wireframe1_p = attribute('bary', 'vec3');`);
  });

  it('runs the SAME construction as grid — only the distance differs', () => {
    const grid = emit().replace(/vec2/g, 'V').replace(/uv\(\)\.mul\(10\)/, 'P');
    const edge = emit(edgeNode()).replace(/vec3/g, 'V').replace(/attribute\('bary', 'V'\)/, 'P');
    for (const shared of [
      '_fw = dFdx(', '.abs().add(dFdy(', ').abs()).max(0.00001);',
      '_hw = _wireframe1_fw.mul(1.5).mul(0.5);',
      '.smoothstep(V(0.0), _wireframe1_hw).oneMinus();',
      '_avg = _wireframe1_fw.mul(1.5).clamp(0.0, 1.0);',
      '_c = mix(_wireframe1_ln, _wireframe1_avg, _wireframe1_fw.mul(2.0).sub(1.0).clamp(0.0, 1.0));',
    ]) {
      expect(grid, `grid: ${shared}`).toContain(shared);
      expect(edge, `edges: ${shared}`).toContain(shared);
    }
  });

  it('combines all THREE edges with max — a corner is one line, not a bright spot', () => {
    expect(emit(edgeNode())).toMatch(/_c\.x\.max\(_wireframe1_c\.y\)\.max\(_wireframe1_c\.z\)/);
  });

  it('guards the missing-attribute case so an export cannot flood the surface', () => {
    // three warns and generates a CONST for an absent attribute — vec3(0),
    // which reads as "on all three edges". Real barycentrics sum to exactly 1
    // and the const sums to 0, so clamping the sum is 1 or 0 with no branch.
    expect(emit(edgeNode())).toMatch(
      /_g = _wireframe1_p\.x\.add\(_wireframe1_p\.y\)\.add\(_wireframe1_p\.z\)\.clamp\(0\.0, 1\.0\);/,
    );
    expect(emit(edgeNode())).toMatch(/\.mul\(_wireframe1_g\);/);
  });

  it('does not read uv at all — density is meaningless on real edges', () => {
    const code = emit(makeNode('w', 'wireframe', { edges: 1, density: 24 }));
    expect(code).not.toContain('uv()');
    expect(code).not.toContain('mul(24)');
  });

  it('an ABSENT flag is grid, so every graph saved before it is byte-identical', () => {
    const bare = emit();
    for (const junk of [undefined, null, 0, '', false, [], 0.9, 'true']) {
      expect(emit(makeNode('w', 'wireframe', { edges: junk as never })), String(junk)).toBe(bare);
    }
  });
});
