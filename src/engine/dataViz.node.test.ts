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

describe('graphToCode: Data → Data Viz → Output', () => {
  const data = makeNode('d1', 'dataNode', dataNodeValues());
  const viz = makeNode('v1', 'dataviz', {
    lowColor: '#000000',
    highColor: '#ffffff',
  });
  const output = makeNode('out', 'output', {});
  const edges = [
    makeEdge('d1', 'col1', 'v1', 'signal'),
    makeEdge('v1', 'out', 'out', 'color'),
  ];
  const gen = graphToCode([data, viz, output], edges);

  it('emits a syntactically valid module', () => {
    expectValidModule(gen.code);
  });

  it('bakes a half-float (filterable) value texture at module scope', () => {
    expect(gen.code).toContain('globalThis.THREE.DataTexture');
    expect(gen.code).toContain('globalThis.THREE.HalfFloatType');
    expect(gen.code).toContain('_dataviz1_value');
    expect(gen.code).toContain('LinearFilter');
    // Texture construction precedes the shader Fn (module scope, not in body).
    expect(gen.code.indexOf('DataTexture')).toBeLessThan(gen.code.indexOf('Fn(() => {'));
  });

  it('samples the value at uv.x by default and mixes the two colours', () => {
    expect(gen.code).toContain('const _dataviz1_coord = uv().x;');
    expect(gen.code).toContain('texture(_dataviz1_value, vec2(_dataviz1_coord, 0.5))');
    expect(gen.code).toMatch(/vec3\(0, 0, 0\)\.mix\(vec3\(1, 1, 1\), _dataviz1_t\)/);
    expect(gen.code).toContain('return dataviz1;');
    expect(gen.code).not.toMatch(/\bdataviz\s*\(/); // custom emission, not a call
  });

  it('omits every tone stage when settings are identity', () => {
    // No scale/offset/cutoff/gamma/contrast → the value sample flows straight
    // into a single clamp with no mul/pow/sub chains.
    expect(gen.code).not.toContain('.pow(');
    expect(gen.code).toContain(
      'const _dataviz1_t = texture(_dataviz1_value, vec2(_dataviz1_coord, 0.5)).x.clamp(0.0, 1.0);',
    );
  });

  it('survives buildShaderModule into a valid shaderloader module', () => {
    const mod = buildShaderModule(gen.code, {});
    expectValidModule(mod);
    expect(mod.indexOf('DataTexture')).toBeLessThan(mod.indexOf('export default function'));
  });
});

describe('graphToCode: Data Viz tone curve', () => {
  const data = makeNode('d1', 'dataNode', dataNodeValues());
  const viz = makeNode('v1', 'dataviz', {
    lowColor: '#000000',
    highColor: '#ffffff',
    scale: 2,
    offset: 0.1,
    lowCutoff: 0.2,
    highCutoff: 0.8,
    midpoint: 0.25,
    contrast: 1.5,
  });
  const output = makeNode('out', 'output', {});
  const edges = [
    makeEdge('d1', 'col1', 'v1', 'signal'),
    makeEdge('v1', 'out', 'out', 'color'),
  ];
  const gen = graphToCode([data, viz, output], edges);

  it('emits every tone stage in order and stays valid', () => {
    expectValidModule(gen.code);
    // scale/offset
    expect(gen.code).toContain('.mul(2).add(0.1)');
    // input levels: (v - low) / (high - low)
    expect(gen.code).toContain('.sub(0.2).div(0.6000000000000001)');
    // midpoint → gamma = log(0.5)/log(0.25) = 0.5
    expect(gen.code).toContain('.pow(0.5)');
    // contrast around 0.5
    expect(gen.code).toContain('.sub(0.5).mul(1.5).add(0.5)');
    expectValidModule(buildShaderModule(gen.code, {}));
  });
});

describe('graphToCode: Data Viz radial mode', () => {
  const data = makeNode('d1', 'dataNode', dataNodeValues());
  const viz = makeNode('v1', 'dataviz', {
    lowColor: '#000000',
    highColor: '#ffffff',
    radial: 1,
    center_x: 0.25,
    center_y: 0.75,
    radius: 0.6,
  });
  const output = makeNode('out', 'output', {});
  const edges = [
    makeEdge('d1', 'col1', 'v1', 'signal'),
    makeEdge('v1', 'out', 'out', 'color'),
  ];
  const gen = graphToCode([data, viz, output], edges);

  it('indexes the data by radius from the chosen center', () => {
    expectValidModule(gen.code);
    expect(gen.code).toContain(
      'const _dataviz1_coord = uv().sub(vec2(0.25, 0.75)).length().div(0.6).clamp(0.0, 1.0);',
    );
    expect(gen.code).toContain('texture(_dataviz1_value, vec2(_dataviz1_coord, 0.5))');
    expectValidModule(buildShaderModule(gen.code, {}));
  });
});

describe('graphToCode: Data Viz Value output drives displacement (decoupled from colour)', () => {
  const data = makeNode('d1', 'dataNode', dataNodeValues());
  // Pure black→white colours: if displacement read the *colour* it would depend
  // on these; wiring the scalar Value output proves it does not.
  const viz = makeNode('v1', 'dataviz', { lowColor: '#000000', highColor: '#ffffff' });
  const output = makeNode('out', 'output', {});
  const edges = [
    makeEdge('d1', 'col1', 'v1', 'signal'),
    makeEdge('v1', 'out', 'out', 'color'), // colour ramp → surface colour
    makeEdge('v1', 'value', 'out', 'position'), // scalar height → displacement
  ];
  const gen = graphToCode([data, viz, output], edges);

  it('routes the scalar _dataviz1_t (not the colour vec3) into the position channel', () => {
    expectValidModule(gen.code);
    // The return object references the scalar for position and the vec3 for colour.
    expect(gen.code).toMatch(/position:\s*_dataviz1_t/);
    expect(gen.code).toMatch(/color:\s*dataviz1/);
  });

  it('emits normal-mode displacement scaled by the scalar height', () => {
    const mod = buildShaderModule(gen.code, {});
    expectValidModule(mod);
    // Height comes from the data scalar, so full [0,1] contrast regardless of colour.
    expect(mod).toContain('positionLocal.add(normalLocal.mul(_dataviz1_t))');
  });
});

describe('graphToCode: Data Viz fallback (signal not from a Data column)', () => {
  const viz = makeNode('v1', 'dataviz', {});
  const output = makeNode('out', 'output', {});
  const gen = graphToCode([viz, output], [makeEdge('v1', 'out', 'out', 'color')]);

  it('emits a uv-based ramp with no texture and stays valid', () => {
    expectValidModule(gen.code);
    expect(gen.code).not.toContain('DataTexture');
    expect(gen.code).toContain('const _dataviz1_coord = uv().x;');
    expectValidModule(buildShaderModule(gen.code, {}));
  });
});
