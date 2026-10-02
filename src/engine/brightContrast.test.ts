import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateNodeOutput, evaluateNodeRange } from './cpuEvaluator';
import { MODULE_HELPERS } from './moduleHelpers';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';
import { formatNodeLabel, nodeDescription, portLabel } from '@/i18n';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * Brightness/Contrast — Blender's node, maths and defaults verbatim.
 *
 * The formula lives in THREE places that can drift apart silently: the
 * module-scope helper the shader runs (engine/moduleHelpers.ts), the CPU twin
 * behind the card's numbers (cpuEvaluator.ts), and the `construction` line the
 * settings menu shows the user. A string comparison of any one against itself
 * proves nothing, so each is EXECUTED here and held to Blender's reference:
 * the helper's text through a numeric stand-in for the six TSL functions it
 * calls, the construction line as the expression it spells.
 */

const def = NODE_REGISTRY.get('brightContrast')!;

/** Blender's Cycles `svm_brightness_contrast`, transcribed. */
function blender(rgb: readonly number[], brightness: number, contrast: number): number[] {
  const a = 1 + contrast;
  const b = brightness - contrast * 0.5;
  return rgb.map((c) => Math.max(a * c + b, 0));
}

const SAMPLES: Array<[number[], number, number]> = [
  [[1, 1, 1], 0, 0], // the defaults: identity on Blender's white
  [[0.2, 0.5, 0.9], 0, 0],
  [[0.2, 0.5, 0.9], 0.3, 0],
  [[0.2, 0.5, 0.9], 0, 1],
  [[0.2, 0.5, 0.9], -0.2, 2.5],
  [[0.2, 0.5, 0.9], 0.1, -0.6],
  [[0, 0.25, 1], 0, -1], // contrast −1 flattens everything to mid-grey
  [[0.9, 0.95, 1], 0.5, 1], // no TOP clamp — Blender lets it pass 1
];

/** Run the helper's own source with plain numbers standing in for TSL nodes. */
function runHelperText(rgb: number[], brightness: number, contrast: number): number[] {
  const lines = MODULE_HELPERS.get('brightContrast')!.lines.join('\n');
  type V = number[];
  const zip = (f: (x: number, y: number) => number) => (x: V, y: V): V => {
    const n = Math.max(x.length, y.length);
    return Array.from({ length: n }, (_, i) => f(x[i % x.length], y[i % y.length]));
  };
  const shim = {
    Fn: (body: (args: V[]) => V) => (...args: V[]) => body(args),
    float: (x: number): V => [x],
    // TSL's conversion: scalar broadcasts, vec2 pads with 0, vec4 truncates.
    vec3: (v: V): V => (v.length === 1 ? [v[0], v[0], v[0]] : [v[0], v[1] ?? 0, v[2] ?? 0]),
    add: zip((x, y) => x + y),
    sub: zip((x, y) => x - y),
    mul: zip((x, y) => x * y),
    max: zip((x, y) => Math.max(x, y)),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const helper = new Function(...Object.keys(shim), `${lines}\nreturn brightContrast;`)(...Object.values(shim));
  return helper(rgb, [brightness], [contrast]);
}

/** Wire a Vec3 constant through the node into Output.color. */
function graph(rgb: number[], bright: number, contrast: number) {
  const src = makeNode('src', 'vec3', { x: rgb[0], y: rgb[1], z: rgb[2] });
  const n = makeNode('bc', 'brightContrast', { bright, contrast });
  const out = makeNode('out', 'output');
  return {
    nodes: [src, n, out],
    edges: [makeEdge('src', 'out', 'bc', 'color'), makeEdge('bc', 'out', 'out', 'color')],
  };
}

describe('Brightness/Contrast — the definition is Blender’s', () => {
  it('has Blender’s sockets and defaults', () => {
    expect(def.inputs.map((p) => [p.id, p.dataType])).toEqual([
      ['color', 'vec3'],
      ['bright', 'float'],
      ['contrast', 'float'],
    ]);
    expect(def.outputs).toEqual([{ id: 'out', label: 'Color', dataType: 'vec3' }]);
    // White in, brightness 0, contrast 0: the node is the identity when dropped.
    expect(def.defaultValues).toEqual({ color: 1, bright: 0, contrast: 0 });
  });
});

describe('Brightness/Contrast — the shipped helper computes Blender’s formula', () => {
  it.each(SAMPLES)('helper text: %j, bright %s, contrast %s', (rgb, b, k) => {
    const got = runHelperText(rgb, b, k);
    blender(rgb, b, k).forEach((v, i) => expect(got[i]).toBeCloseTo(v, 12));
  });

  it('reads a scalar, a vec2 and a vec4 the way TSL’s vec3() converts them', () => {
    expect(runHelperText([0.4], 0, 1)).toEqual(blender([0.4, 0.4, 0.4], 0, 1));
    expect(runHelperText([0.4, 0.6], 0, 1)).toEqual(blender([0.4, 0.6, 0], 0, 1));
    expect(runHelperText([0.4, 0.6, 0.8, 0.1], 0, 1)).toEqual(blender([0.4, 0.6, 0.8], 0, 1));
  });

  it('calls only real three/tsl functions', () => {
    for (const name of MODULE_HELPERS.get('brightContrast')!.imports) {
      expect(typeof (TSL as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('Brightness/Contrast — the CPU twin agrees', () => {
  it.each(SAMPLES)('evaluateNodeOutput: %j, bright %s, contrast %s', (rgb, b, k) => {
    const { nodes, edges } = graph(rgb, b, k);
    const got = evaluateNodeOutput('bc', nodes, edges, 0)!;
    expect(got).toHaveLength(3);
    blender(rgb, b, k).forEach((v, i) => expect(got[i]).toBeCloseTo(v, 12));
  });

  it('a freshly dropped node reads Blender’s white, unchanged', () => {
    const n = makeNode('bc', 'brightContrast');
    expect(evaluateNodeOutput('bc', [n], [], 0)).toEqual([1, 1, 1]);
  });

  it('the range bounds every sample, clamps at 0 and is exact for a constant', () => {
    const { nodes, edges } = graph([0.2, 0.5, 0.9], 0.1, 1.5);
    const r = evaluateNodeRange('bc', nodes, edges, 0)!;
    const v = blender([0.2, 0.5, 0.9], 0.1, 1.5);
    v.forEach((x, i) => {
      expect(r.min[i]).toBeCloseTo(x, 12);
      expect(r.max[i]).toBeCloseTo(x, 12);
    });

    // A uv wire is a field: 0…1 per channel. Contrast 1 maps 0 → −0.5, cut to 0,
    // and 1 → 1.5 — no top clamp.
    const uv = makeNode('uv', 'uv');
    const bc = makeNode('bc', 'brightContrast', { contrast: 1 });
    const fr = evaluateNodeRange('bc', [uv, bc], [makeEdge('uv', 'out', 'bc', 'color')], 0)!;
    expect(fr.min[0]).toBe(0);
    expect(fr.max[0]).toBeCloseTo(1.5, 12);
    expect(fr.min.every((x) => x >= 0)).toBe(true);
  });
});

describe('Brightness/Contrast — the formula the settings menu shows', () => {
  it('is one line', () => {
    expect(def.construction).toBeTruthy();
    expect(def.construction).not.toContain('\n');
  });

  it.each(SAMPLES)('evaluates to Blender’s result: %j, bright %s, contrast %s', (rgb, b, k) => {
    // The line is shown to be READ, so it is held to what it says: strip the
    // `out =`, give `max` its meaning, and run it per channel with the
    // def's own port ids as the variable names.
    const expr = def.construction!.replace(/^\s*out\s*=\s*/, '');
    const ids = def.inputs.map((p) => p.id);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const f = new Function(...ids, `const max = Math.max; return ${expr};`) as (...a: number[]) => number;
    const want = blender(rgb, b, k);
    rgb.forEach((c, i) => expect(f(c, b, k)).toBeCloseTo(want[i], 12));
  });

  it('names exactly the node’s own inputs, so it reads against the card', () => {
    const idents = new Set(def.construction!.match(/[A-Za-z_]\w*/g));
    idents.delete('out');
    idents.delete('max');
    expect([...idents].sort()).toEqual(def.inputs.map((p) => p.id).sort());
  });
});

describe('Brightness/Contrast — emission and the round trip', () => {
  it('emits the helper once for two nodes, and parses back with nothing from its body', () => {
    const src = makeNode('src', 'vec3', { x: 0.2, y: 0.5, z: 0.9 });
    const a = makeNode('a', 'brightContrast', { bright: 0.1, contrast: 0.5 });
    const b = makeNode('b', 'brightContrast', { bright: -0.2, contrast: 2 });
    const out = makeNode('out', 'output');
    const code = graphToCode(
      [src, a, b, out],
      [
        makeEdge('src', 'out', 'a', 'color'),
        makeEdge('a', 'out', 'b', 'color'),
        makeEdge('b', 'out', 'out', 'color'),
      ],
    ).code;
    expect(code.split('const brightContrast = Fn(')).toHaveLength(2);
    expect(code).toMatch(/brightContrast\(\w+, 0\.1, 0\.5\)/);

    const r = codeToGraph(code);
    expect(r.errors.filter((e) => e.severity !== 'warning')).toHaveLength(0);
    expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(['brightContrast', 'brightContrast', 'output', 'vec3']);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('a tampered values map neither throws nor reaches the emitted code', () => {
    // `.fastshader` values are adversarial: an uncoercible entry must not
    // throw (no error boundary — autosave would write the blank screen back),
    // and a string must not be spliced into the module.
    const n = makeNode('bc', 'brightContrast', {
      color: { toString: 1 } as unknown as number,
      bright: '0); alert(1); (0' as unknown as number,
      contrast: Symbol('x') as unknown as number,
    });
    const out = makeNode('out', 'output');
    const edges = [makeEdge('bc', 'out', 'out', 'color')];
    const code = graphToCode([n, out], edges).code;
    expect(code).toMatch(/= brightContrast\(1, 0, 0\);/);
    expect(code).not.toContain('alert');
    expect(() => evaluateNodeOutput('bc', [n, out], edges, 0)).not.toThrow();
    expect(() => evaluateNodeRange('bc', [n, out], edges, 0)).not.toThrow();
  });

  it('a dropped node emits Blender’s defaults as bare numbers', () => {
    const n = makeNode('bc', 'brightContrast');
    const out = makeNode('out', 'output');
    const code = graphToCode([n, out], [makeEdge('bc', 'out', 'out', 'color')]).code;
    expect(code).toMatch(/= brightContrast\(1, 0, 0\);/);
  });
});

describe('Brightness/Contrast — the surfaces that name it', () => {
  it('carries a glyph', () => {
    expect(CUSTOM_GLYPHS.brightContrast?.svg).toBeTruthy();
  });

  it('is translated: label, description and every port', () => {
    expect(formatNodeLabel(def.label, def.type, 'lv')).toMatch(/Spilgtums/);
    expect(nodeDescription(def.description, def.type, 'lv')).toMatch(/Blenderī/);
    for (const p of [...def.inputs, ...def.outputs]) {
      expect(portLabel(p.label, 'lv'), p.label).not.toBe(p.label);
    }
  });
});
