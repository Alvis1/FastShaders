import { describe, it, expect } from 'vitest';
import { graphToCode } from '@/engine/graphToCode';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * Socket-width pins — the emission for a narrowing socket passed through an
 * `any`-typed op into a width-sensitive Output channel.
 *
 * Before GLB Phase 4 Step 1, `cpuEvaluator.computeShape`'s default broadcast
 * read each source NODE's width, so a float socket on a wider node (toHsl's
 * `h`, dataviz's `value`) counted as that node's full width. A `mul` fed by
 * `toHsl.h` then read as a vec3, the Output node skipped the `vec3()` widen
 * that keeps a scalar out of alpha, and three's `vec4(colorNode)` splatted the
 * float into alpha (Step 0 pinned that: `return mul1;` / `emissive: mul1`).
 *
 * Step 1 made the broadcast read per-SOCKET widths (`portShapeForHandle`, the
 * append branch's rule). The two cases marked STEP 1 were changed BY HAND to
 * the widened form (never `-u`: these are inline strings), so the byte move is
 * attributable in review. The control case feeds the WHOLE vec3 through the
 * same op and did not move.
 */

const shaderBody = (code: string) => code.slice(code.indexOf('const shader = Fn('));
const importLine = (code: string) => code.split('\n')[0];

describe('socket widths through an `any` op (per-socket since GLB Phase 4 Step 1)', () => {
  it('toHsl.h → mul → Output.color', () => {
    // STEP 1 (hand edit): `mul1` is a float, so it is widened — was `return mul1;`.
    const { code } = graphToCode(
      [makeNode('c1', 'color', { hex: '#ff8000' }), makeNode('h1', 'toHsl'), makeNode('m1', 'mul'), makeNode('out1', 'output')],
      [makeEdge('c1', 'out', 'h1', 'rgb'), makeEdge('h1', 'h', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'color')],
    );
    expect(importLine(code)).toBe(
      "import { Fn, abs, add, color, div, equal, float, greaterThan, lessThan, max, min, mul, select, sub, vec3 } from 'three/tsl';",
    );
    expect(shaderBody(code)).toBe(`const shader = Fn(() => {
  const color1 = color(0xff8000);
  const toHsl1 = toHsl(color1);
  const mul1 = mul(toHsl1.x, 1);

  return vec3(mul1);
});

export default shader;
`);
  });

  it('dataviz.value → mul → Output.emissive', () => {
    // STEP 1 (hand edit): `mul1` is a float, so it is widened — was
    // `emissive: mul1`, and `vec3` joins the import line.
    const { code } = graphToCode(
      [makeNode('v1', 'dataviz', { lowColor: '#000000', highColor: '#ffffff' }), makeNode('m1', 'mul'), makeNode('out1', 'output')],
      [makeEdge('v1', 'value', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'emissive')],
    );
    expect(code).toBe(`import { Fn, color, mix, mul, uv, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const _dataviz1_coord = uv().x;
  const _dataviz1_t = _dataviz1_coord.clamp(0.0, 1.0);
  const dataviz1 = mix(color(0x000000), color(0xffffff), _dataviz1_t);
  const mul1 = mul(_dataviz1_t, 1);

  return { emissive: vec3(mul1) };
});

export default shader;
`);
  });

  it('toHsl.h → mul → Output.emissive (added in Step 1)', () => {
    const { code } = graphToCode(
      [makeNode('c1', 'color', { hex: '#ff8000' }), makeNode('h1', 'toHsl'), makeNode('m1', 'mul'), makeNode('out1', 'output')],
      [makeEdge('c1', 'out', 'h1', 'rgb'), makeEdge('h1', 'h', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'emissive')],
    );
    expect(code).toContain('  const mul1 = mul(toHsl1.x, 1);\n');
    expect(code).toContain('  return { emissive: vec3(mul1) };\n');
  });

  it('control: toHsl.out → mul → Output.color stays a bare vec3 (Step 1 must not move it)', () => {
    const { code } = graphToCode(
      [makeNode('c1', 'color', { hex: '#ff8000' }), makeNode('h1', 'toHsl'), makeNode('m1', 'mul'), makeNode('out1', 'output')],
      [makeEdge('c1', 'out', 'h1', 'rgb'), makeEdge('h1', 'out', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'color')],
    );
    expect(shaderBody(code)).toBe(`const shader = Fn(() => {
  const color1 = color(0xff8000);
  const toHsl1 = toHsl(color1);
  const mul1 = mul(toHsl1, 1);

  return mul1;
});

export default shader;
`);
  });
});
