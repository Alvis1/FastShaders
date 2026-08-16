import { describe, it, expect, afterAll } from 'vitest';
import * as TSL from 'three/tsl';
import {
  DataTexture,
  RGBAFormat,
  RedFormat,
  HalfFloatType,
  FloatType,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
  Texture,
} from 'three';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';
import { makeDataNodeData } from '@/utils/dataNode';
import { buildColormapLut, getColormap, LUT_SIZE } from '@/utils/colormaps';
import { srgbToLinear01 } from '@/utils/colorUtils';

/**
 * EXECUTE the generated module, instead of only reading it.
 *
 * Every other emission test compares generated source to expected source, which
 * proves the emitter agrees with itself. What it cannot prove is that the
 * module RUNS: a wrong `DataTexture` argument order, a constant that does not
 * exist on the THREE global, a `.rgb` that is not a real accessor — all produce
 * source that passes every string assertion and then throws inside the preview
 * iframe, where the only symptom the user gets is a blank pane.
 *
 * So this file does what the shaderloader does: rewrite the `three/tsl` import
 * into a destructure of the real namespace, supply a `globalThis.THREE` holding
 * the real classes, and run it. The GPU is not involved — this checks module
 * construction, which is where the emitter's mistakes live.
 */

/**
 * Run the module AND invoke its shader, which is what forces the whole TSL node
 * tree to be built — the emitter's real failure mode is a body expression with
 * the wrong arity (`vec2(<vec3>, 0.5)`), and that only throws on invocation.
 */
function buildsShader(code: string): boolean {
  const { shader } = runModule(code);
  if (typeof shader !== 'function') return false;
  return (shader as () => unknown)() != null;
}

/** Just the THREE surface the generated setup lines touch. */
const THREE_STUB = {
  DataTexture,
  Texture,
  RGBAFormat,
  RedFormat,
  HalfFloatType,
  FloatType,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
};

const priorThree = (globalThis as Record<string, unknown>).THREE;
afterAll(() => {
  (globalThis as Record<string, unknown>).THREE = priorThree;
});

/**
 * Run a generated module and return its default export. Mirrors shaderloader
 * 0.5's rewrite (`import … from 'three/tsl'` → the THREE.TSL namespace) rather
 * than inventing a different one.
 */
function runModule(code: string): { shader: unknown; scope: Record<string, unknown> } {
  (globalThis as Record<string, unknown>).THREE = THREE_STUB;

  const body = code
    .replace(/^import\s*\{([^}]*)\}\s*from\s*'three\/tsl';\s*$/m, 'const {$1} = __TSL;')
    .replace(/^export default (\w+);\s*$/m, '__captured.shader = $1;');

  const captured: Record<string, unknown> = {};
  // Same technique (and the same reason) as tslCodeProcessor.fixes.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function('__TSL', '__captured', `${body}\nreturn { lut: typeof _colormap1_lut !== 'undefined' ? _colormap1_lut : null };`);
  const scope = fn(TSL, captured) as Record<string, unknown>;
  return { shader: captured.shader, scope };
}

describe('the generated Colormap module actually runs', () => {
  const gen = graphToCode(
    [makeNode('c1', 'colormap', { map: 'viridis' }), makeNode('out', 'output', {})],
    [makeEdge('c1', 'out', 'out', 'color')],
  );

  it('executes, exports a shader function, and builds its node tree', () => {
    expect(buildsShader(gen.code)).toBe(true);
  });

  it('builds a real DataTexture whose texels are the linear-light LUT', () => {
    // The claim under test is the one that is invisible on screen: the baked
    // table is in LINEAR light, not the sRGB the catalogue publishes.
    const { scope } = runModule(gen.code);
    const lut = scope.lut as InstanceType<typeof DataTexture>;
    expect(lut).toBeInstanceOf(DataTexture);
    expect(lut.image.width).toBe(LUT_SIZE);
    expect(lut.image.height).toBe(1);
    expect(lut.format).toBe(RGBAFormat);
    expect(lut.type).toBe(HalfFloatType);
    expect(lut.magFilter).toBe(LinearFilter);
    expect(lut.wrapS).toBe(ClampToEdgeWrapping);

    const expected = buildColormapLut(getColormap('viridis'));
    const data = lut.image.data as Uint16Array;
    expect(data).toHaveLength(LUT_SIZE * 4);

    // Decode a few half-floats back and compare against the CPU table. Half
    // gives ~3 decimal digits, hence the tolerance.
    const fromHalf = (h: number) => {
      const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
      if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
      if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
      return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    for (const i of [0, 1, 64, 128, 200, LUT_SIZE - 1]) {
      for (let c = 0; c < 4; c++) {
        expect(fromHalf(data[i * 4 + c]), `texel ${i} channel ${c}`).toBeCloseTo(
          expected[i * 4 + c],
          3,
        );
      }
    }

    // Texel 0 IS viridis' first colour, converted out of sRGB.
    expect(fromHalf(data[0])).toBeCloseTo(srgbToLinear01(0x44 / 255), 3);
    expect(fromHalf(data[1])).toBeCloseTo(srgbToLinear01(0x01 / 255), 3);
    expect(fromHalf(data[2])).toBeCloseTo(srgbToLinear01(0x54 / 255), 3);
    expect(fromHalf(data[3])).toBe(1);
  });
});

describe('the generated Data Range / Isolines / Stripes modules actually run', () => {
  function dataNodeValues() {
    return makeDataNodeData(
      { columnNames: ['a'], columns: [[0, 1, 2, 3, 4]], rowCount: 5 },
      2,
    ).values;
  }

  it('runs the full Data → Data Range → Colormap → Output pipeline', () => {
    const gen = graphToCode(
      [
        makeNode('d1', 'dataNode', dataNodeValues()),
        makeNode('n1', 'dataRange', { mode: 'robust' }),
        makeNode('c1', 'colormap', { map: 'batlow', levels: 6 }),
        makeNode('out', 'output', {}),
      ],
      [
        makeEdge('d1', 'col0', 'n1', 'value'),
        makeEdge('n1', 'out', 'c1', 'value'),
        makeEdge('c1', 'out', 'out', 'color'),
      ],
    );
    expect(buildsShader(gen.code)).toBe(true);
  });

  it('runs every Data Range mode', () => {
    for (const mode of ['minmax', 'robust', 'symmetric', 'zscore', 'log', 'symlog', 'manual']) {
      const gen = graphToCode(
        [
          makeNode('d1', 'dataNode', dataNodeValues()),
          makeNode('n1', 'dataRange', { mode, domainMin: -1, domainMax: 2 }),
          makeNode('out', 'output', {}),
        ],
        [makeEdge('d1', 'col0', 'n1', 'value'), makeEdge('n1', 'out', 'out', 'opacity')],
      );
      expect(buildsShader(gen.code), mode).toBe(true);
    }
  });

  /**
   * Custom formulas, actually EXECUTED. A chain-existence test cannot catch a
   * wrong arity — `smoothstep(a, b)` looks fine as text and only throws when the
   * node tree is built — and this emitter writes free-function calls whose arity
   * comes from its own table.
   */
  it('runs a custom formula using every function in the grammar', () => {
    const run = (formula: string) => {
      const gen = graphToCode(
        [
          makeNode('d1', 'dataNode', dataNodeValues()),
          makeNode('n1', 'dataRange', { mode: 'minmax', formula }),
          makeNode('out', 'output', {}),
        ],
        [makeEdge('d1', 'col0', 'n1', 'value'), makeEdge('n1', 'out', 'out', 'opacity')],
      );
      return buildsShader(gen.code);
    };

    // Arity 1 — every unary in the table, each wrapping `v` so it cannot fold.
    for (const f of [
      'abs', 'sign', 'floor', 'ceil', 'round', 'fract', 'sqrt', 'exp', 'exp2',
      'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'saturate',
    ]) {
      expect(run(`${f}(v)`), f).toBe(true);
    }
    // Arity 2 and 3.
    for (const f of ['min', 'max', 'pow', 'step']) {
      expect(run(`${f}(v, 0.5)`), f).toBe(true);
    }
    for (const f of ['clamp', 'mix', 'smoothstep']) {
      expect(run(`${f}(v, 0.25, 0.75)`), f).toBe(true);
    }
    // Operators, including the reciprocal rewrite and a runtime divisor.
    for (const e of ['v + 1', 'v - 1', 'v * 2', 'v / 4', '4 / v', '1 - v', '-v', 'v ^ 2', '2 ^ v']) {
      expect(run(e), e).toBe(true);
    }
    // A constant-only formula must still produce a NODE, or the clamp suffix
    // would be applied to a bare number.
    expect(run('0.25 + 0.25')).toBe(true);
  });

  it('still builds a working shader when the formula is REJECTED', () => {
    // The property that matters for a shared file: every rejection path falls
    // back to the built-in chain, so a hostile .fastshader can never produce a
    // module that fails to compile.
    for (const formula of [
      '0); globalThis.__x=1; float(0',
      'v.mul(2)',
      'zzz',
      'v / 0',
      'log2(0)',
      'min(1)',
      'аbs(v)',
    ]) {
      const gen = graphToCode(
        [
          makeNode('d1', 'dataNode', dataNodeValues()),
          makeNode('n1', 'dataRange', { mode: 'minmax', formula }),
          makeNode('out', 'output', {}),
        ],
        [makeEdge('d1', 'col0', 'n1', 'value'), makeEdge('n1', 'out', 'out', 'opacity')],
      );
      expect(buildsShader(gen.code), formula).toBe(true);
    }
  });

  it('runs Isolines, including with a wired parameter', () => {
    const plain = graphToCode(
      [makeNode('i1', 'isolines', { levels: 12 }), makeNode('out', 'output', {})],
      [makeEdge('i1', 'out', 'out', 'opacity')],
    );
    expect(buildsShader(plain.code)).toBe(true);

    const wired = graphToCode(
      [
        makeNode('f1', 'float', { value: 6 }),
        makeNode('i1', 'isolines', {}),
        makeNode('out', 'output', {}),
      ],
      [makeEdge('f1', 'out', 'i1', 'levels'), makeEdge('i1', 'out', 'out', 'opacity')],
    );
    expect(buildsShader(wired.code)).toBe(true);
  });

  it('runs Data Stripes and Data Viz after the colour-space change', () => {
    // color(0x…) replaced vec3(hex/255, …) in both ramps — that is a change to
    // what the module CONSTRUCTS, so it deserves an execution check.
    for (const type of ['stripes', 'dataviz']) {
      const gen = graphToCode(
        [
          makeNode('d1', 'dataNode', dataNodeValues()),
          makeNode('v1', type, { lowColor: '#1b2a4a', highColor: '#ffd24d' }),
          makeNode('out', 'output', {}),
        ],
        [makeEdge('d1', 'col0', 'v1', 'signal'), makeEdge('v1', 'out', 'out', 'color')],
      );
      expect(buildsShader(gen.code), type).toBe(true);
    }
  });
});
