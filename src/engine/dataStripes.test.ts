import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { graphToCode } from './graphToCode';
import { buildShaderModule } from './tslCodeProcessor';
import { makeNode, makeEdge } from '@/test-utils';
import { makeDataNodeData } from '@/utils/dataNode';

/** Assert a string parses as a valid ES module (throws on syntax error). */
function expectValidModule(code: string) {
  expect(() => parse(code, { sourceType: 'module' })).not.toThrow();
}

function dataNodeValues() {
  return makeDataNodeData(
    {
      columnNames: ['x [m]', 'y [m]'],
      columns: [
        [0, 1, 2, 3, 4],
        [0.1, 0.5, 0.2, 0.9, 0.4],
      ],
      rowCount: 5,
    },
    2,
  ).values;
}

describe('graphToCode: Data → Stripes → Output', () => {
  const data = makeNode('d1', 'dataNode', dataNodeValues());
  const stripes = makeNode('s1', 'stripes', {
    baseFrequency: 40,
    density: 1.5,
    lowColor: '#000000',
    highColor: '#ffffff',
  });
  const output = makeNode('out', 'output', {});
  const edges = [
    makeEdge('d1', 'col1', 's1', 'signal'),
    makeEdge('s1', 'out', 'out', 'color'),
  ];
  const gen = graphToCode([data, stripes, output], edges);

  it('emits a syntactically valid module', () => {
    expectValidModule(gen.code);
  });

  it('bakes a half-float phase texture and a float column texture at module scope', () => {
    expect(gen.code).toContain('globalThis.THREE.DataTexture');
    expect(gen.code).toContain('globalThis.THREE.HalfFloatType'); // phase ramp
    expect(gen.code).toContain('globalThis.THREE.FloatType'); // raw column
    expect(gen.code).toContain('LinearFilter'); // phase needs filtering
    // Texture construction precedes the shader Fn (module scope, not in body).
    expect(gen.code.indexOf('DataTexture')).toBeLessThan(gen.code.indexOf('Fn(() => {'));
  });

  it('imports the TSL symbols the stripe shader needs', () => {
    const importLine = gen.code.split('\n').find((l) => l.includes("from 'three/tsl'")) ?? '';
    for (const sym of ['texture', 'uv', 'vec2', 'vec3', 'float', 'dFdx', 'dFdy']) {
      expect(importLine).toContain(sym);
    }
  });

  it('references the data column for color and never emits a stripes() call', () => {
    expect(gen.code).toContain('data1_col1'); // the y column, sampled at uv.x
    expect(gen.code).not.toMatch(/\bstripes\s*\(/); // custom emission, not a function call
    expect(gen.code).toContain('return stripes1;');
  });

  it('takes the derivative of continuous phase, not fract(phase)', () => {
    // dFdx must wrap the raw phase var (_stripes1_p), never the fract result.
    expect(gen.code).toMatch(/dFdx\(_stripes1_p\)/);
    expect(gen.code).not.toMatch(/dFdx\([^)]*fract/);
  });

  it('survives buildShaderModule into a valid shaderloader module', () => {
    const mod = buildShaderModule(gen.code, {});
    expectValidModule(mod);
    expect(mod).toContain('export default function');
    // The DataTexture preamble is preserved at module scope (before the export).
    expect(mod.indexOf('DataTexture')).toBeLessThan(mod.indexOf('export default function'));
  });
});

describe('graphToCode: Stripes fallback (signal not from a Data column)', () => {
  const stripes = makeNode('s1', 'stripes', { baseFrequency: 24 });
  const output = makeNode('out', 'output', {});
  const gen = graphToCode([stripes, output], [makeEdge('s1', 'out', 'out', 'color')]);

  it('emits a uv-based stripe with no texture and stays valid', () => {
    expectValidModule(gen.code);
    expect(gen.code).not.toContain('DataTexture');
    expect(gen.code).toContain('uv().x.mul(24)');
    expectValidModule(buildShaderModule(gen.code, {}));
  });
});
