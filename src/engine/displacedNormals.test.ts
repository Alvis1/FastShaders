/**
 * Normals that follow a displacement — the module pass (engine/displacedNormals.ts),
 * its inverse in scriptToTSL, and its price (utils/displacedNormalCost.ts).
 * See docs/dev/preview-and-runtime.md, "Normals follow the displacement".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import { buildShaderModule } from './tslCodeProcessor';
import { graphToCode } from './graphToCode';
import { scriptToTSL } from './scriptToTSL';
import { planDisplacedNormal, stripDisplacedNormals } from './displacedNormals';
import { computeReachableCost, getCost } from '@/utils/nodeCost';
import { displacedNormalOverhead, FACES_HINT_KEY } from '@/utils/displacedNormalCost';

const NOISE = `import { Fn, color, float, mul, mx_noise_float, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const tint = color(0xd0d0d0);
  const noise1 = mx_noise_float(positionGeometry.mul(3));
  const mul1 = mul(noise1, 0.15);

  return { color: tint, position: mul1, roughness: float(0.5) };
});

export default shader;
`;

const parsesAsModule = (src: string): void => {
  parse(src, { sourceType: 'module' });
};

describe('planDisplacedNormal', () => {
  const lines = [
    'const tint = color(0xd0d0d0);',
    'const noise1 = mx_noise_float(positionGeometry.mul(3));',
    'const mul1 = mul(noise1, 0.15);',
  ];

  it('re-emits ONLY the chain, in order, with every position read moved to __p', () => {
    const plan = planDisplacedNormal('mul1', lines, 'normal', 0, 'positionLocal.add(normalLocal.mul(mul1))')!;
    const text = plan.lines.join('\n');
    expect(text).toContain('const noise1 = mx_noise_float(__p.mul(3));');
    expect(text.indexOf('const noise1')).toBeLessThan(text.indexOf('const mul1'));
    expect(text).not.toContain('tint');
    expect(text).toContain('return __p.add(__n.mul(mul1));');
    expect(plan.expr).toBe('__fsDisplaced0(positionLocal.add(normalLocal.mul(mul1)))');
  });

  it('writes the normal back with assign, after capturing the displaced point', () => {
    const text = planDisplacedNormal('mul1', lines, 'normal', 0, 'X')!.lines.join('\n');
    expect(text.indexOf('const __q = __q0.toVar();')).toBeLessThan(text.indexOf('normalLocal.assign('));
    expect(text.indexOf('const __n = normalLocal.toVar();')).toBeLessThan(text.indexOf('normalLocal.assign('));
    expect(text).toContain('normalLocal.assign(cross(__q1.sub(__q), __q2.sub(__q)).normalize());');
  });

  it('offset mode adds the raw displacement', () => {
    const text = planDisplacedNormal('mul1', lines, 'offset', 0, 'X')!.lines.join('\n');
    expect(text).toContain('return __p.add(mul1);');
  });

  it('re-binds world and view position through the model matrices', () => {
    const text = planDisplacedNormal('h', ['const h = positionWorld.y.add(positionView.x);'], 'normal', 0, 'X')!.lines.join('\n');
    expect(text).toContain('modelWorldMatrix.mul(vec4(__p, 1)).xyz.y');
    expect(text).toContain('modelViewMatrix.mul(vec4(__p, 1)).xyz.x');
  });

  it('never touches a member or a longer name, a string or a comment', () => {
    const text = planDisplacedNormal('h', [
      "const h = mul(positionGeometry.x, 2); // positionGeometry",
    ], 'normal', 0, 'X')!.lines.join('\n');
    expect(text).toContain('mul(__p.x, 2); // positionGeometry');
    expect(planDisplacedNormal('h', ['const h = positionWorldDirection.y;'], 'normal', 0, 'X')).toBeNull();
    expect(planDisplacedNormal('h', ["const h = fsLut('positionLocal');"], 'normal', 0, 'X')).toBeNull();
  });

  it('plans nothing for a displacement that reads no position', () => {
    for (const body of [
      ['const h = float(0.2);'],
      ['const h = params.amount;'],
      ['const h = uv().x.mul(0.1);'],
      ['const h = sin(time);'],
    ]) expect(planDisplacedNormal('h', body, 'normal', 0, 'X')).toBeNull();
  });

  it('falls back when the chain reaches a multi-line statement it cannot re-run', () => {
    const body = [
      'const loop1 = Fn(() => {',
      '  const acc = float(0).toVar();',
      '  return acc.add(positionGeometry.x);',
      '})();',
      'const h = mul(loop1, 0.1);',
    ];
    expect(planDisplacedNormal('h', body, 'normal', 0, 'X')).toBeNull();
    // …but an unrelated block does not block a chain that never reaches it.
    expect(planDisplacedNormal('g', [...body, 'const g = positionGeometry.y;'], 'normal', 0, 'X')).not.toBeNull();
  });
});

describe('buildShaderModule', () => {
  it('a SMOOTH material whose displacement reads the position gets the recompute', () => {
    const out = buildShaderModule(NOISE, {});
    expect(out).toContain('positionNode: __fsDisplaced0(positionLocal.add(normalLocal.mul(mul1)))');
    expect(out).toMatch(/import \{[^}]*\bcross\b[^}]*\} from 'three\/tsl';/);
    expect(out).toMatch(/import \{[^}]*\bnormalLocal\b[^}]*\} from 'three\/tsl';/);
    parsesAsModule(out);
  });

  it('a FLAT material keeps today’s positionNode — the pixel derivatives already follow the shape', () => {
    const out = buildShaderModule(NOISE, { materialSettings: { flatShading: true } });
    expect(out).toContain('positionNode: positionLocal.add(normalLocal.mul(mul1))');
    expect(out).not.toContain('__fsDisp');
  });

  it('a constant displacement keeps today’s module byte for byte', () => {
    const constant = NOISE.replace('const mul1 = mul(noise1, 0.15);', 'const mul1 = float(0.15);');
    expect(buildShaderModule(constant, {})).not.toContain('__fsDisp');
  });

  it('each part decides by its OWN Faces setting', () => {
    const parts = NOISE.replace(
      'return { color: tint, position: mul1, roughness: float(0.5) };',
      'return { parts: { "A": { color: tint, position: mul1 }, "B": { color: tint, position: mul1, flatShading: true } } };',
    );
    const out = buildShaderModule(parts, {});
    expect(out).toContain('"A": { colorNode: tint, positionNode: __fsDisplaced0(positionLocal.add(normalLocal.mul(mul1))) }');
    expect(out).toMatch(/"B": \{ colorNode: tint, positionNode: positionLocal\.add\(normalLocal\.mul\(mul1\)\)/);
    expect(out).not.toContain('__fsDisplaced1');
    parsesAsModule(out);
  });
});

describe('the inverse (scriptToTSL)', () => {
  it('reads the module back to the panel’s own position channel, imports and all', () => {
    const back = scriptToTSL(buildShaderModule(NOISE, {}));
    expect(back).toContain('position: mul1');
    expect(back).not.toMatch(/__fsDisp|normalLocal\.assign/);
    expect(back).not.toMatch(/\b(?:cross|select|abs)\b/);
  });

  it('keeps an import the shader itself still uses', () => {
    const own = NOISE.replace('const tint = color(0xd0d0d0);', 'const tint = abs(color(0xd0d0d0));')
      .replace("import { Fn,", "import { Fn, abs,");
    expect(scriptToTSL(buildShaderModule(own, {}))).toMatch(/import \{[^}]*\babs\b/);
  });

  it('leaves a module without the names untouched', () => {
    const src = 'export default function() {\n  return { colorNode: vec3(1) };\n}\n';
    expect(stripDisplacedNormals(src)).toBe(src);
  });
});

describe('from the graph', () => {
  const graph = (flat: boolean): { nodes: AppNode[]; edges: ReturnType<typeof makeEdge>[] } => {
    const noise = makeNode('n', 'perlin');
    const amp = makeNode('m', 'mul', { b: 0.15 });
    const out = makeNode('out', 'output');
    (out.data as { exposedPorts?: string[] }).exposedPorts = ['color', 'position'];
    if (flat) (out.data as { materialSettings?: object }).materialSettings = { flatShading: true };
    return {
      nodes: [noise, amp, out],
      edges: [makeEdge('n', 'out', 'm', 'a'), makeEdge('m', 'out', 'out', 'position')],
    };
  };

  it('an unwired noise reads positionGeometry, so its displacement recomputes', () => {
    const { nodes, edges } = graph(false);
    const out = buildShaderModule(graphToCode(nodes, edges).code, {});
    expect(out).toContain('__fsDisplaced0(');
    expect(out).toMatch(/mx_noise_float\(__p/);
    parsesAsModule(out);
  });

  it('prices the recompute at full price: the chain twice more plus the fixed maths', () => {
    const smooth = graph(false);
    const flat = graph(true);
    const chain = computeReachableCost(flat.nodes, flat.edges);
    expect(chain).toBeGreaterThan(0);
    expect(computeReachableCost(smooth.nodes, smooth.edges)).toBe(3 * chain + displacedNormalOverhead());
  });

  it('the fixed maths is 45 under the authored table, and moves with a profile', () => {
    expect(displacedNormalOverhead()).toBe(
      3 * getCost('cross') + 2 * getCost('normalize') + getCost('abs') + getCost('greaterThan')
        + getCost('select') + 4 * getCost('mul') + 4 * getCost('add') + 2 * getCost('sub'),
    );
    expect(displacedNormalOverhead()).toBe(45);
  });

  it('a displacement that reads no position costs nothing extra', () => {
    const build = (flat: boolean): { nodes: AppNode[]; edges: ReturnType<typeof makeEdge>[] } => {
      const f = makeNode('f', 'float', { value: 0.2 });
      const out = makeNode('out', 'output');
      (out.data as { exposedPorts?: string[] }).exposedPorts = ['position'];
      if (flat) (out.data as { materialSettings?: object }).materialSettings = { flatShading: true };
      return { nodes: [f, out], edges: [makeEdge('f', 'out', 'out', 'position')] };
    };
    const smooth = build(false);
    const flat = build(true);
    expect(computeReachableCost(smooth.nodes, smooth.edges)).toBe(computeReachableCost(flat.nodes, flat.edges));
    expect(buildShaderModule(graphToCode(smooth.nodes, smooth.edges).code, {})).not.toContain('__fsDisp');
  });
});

describe('the Faces tooltip', () => {
  it('carries its Latvian', () => {
    const LV = JSON.parse(readFileSync(resolve(__dirname, '../i18n/lv.json'), 'utf8')) as { ui?: Record<string, string> };
    expect(LV.ui?.[FACES_HINT_KEY]).toBeTruthy();
  });
});
