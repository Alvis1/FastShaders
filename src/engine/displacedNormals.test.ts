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
import { POSITION_ROOTS, REBOUND, VERTEX_UNSAFE, planDisplacedNormal, stripDisplacedNormals } from './displacedNormals';
import { TSL_EXPORT_NAMES } from './tslExportNames';
import { computeReachableCost, getCost } from '@/utils/nodeCost';
import { DISPLACED_NORMAL_ROOTS, displacedNormalOverhead, FACES_HINT_KEY } from '@/utils/displacedNormalCost';

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

  it('re-emits ONLY the chain, in order, with every position read moved by the step __d', () => {
    const plan = planDisplacedNormal('mul1', lines, 'normal', 0, 'positionLocal.add(normalLocal.mul(mul1))')!;
    const text = plan.lines.join('\n');
    expect(text).toContain('const __fsDisp0 = Fn(([__d, __n]) => {');
    expect(text).toContain('const noise1 = mx_noise_float(positionGeometry.add(__d).mul(3));');
    expect(text.indexOf('const noise1')).toBeLessThan(text.indexOf('const mul1'));
    expect(text).not.toContain('tint');
    expect(text).toContain('return positionLocal.add(__d).add(__n.mul(mul1));');
    expect(plan.expr).toBe('__fsDisplaced0(positionLocal.add(normalLocal.mul(mul1)))');
  });

  it('writes the normal back with assign, after capturing the displaced point', () => {
    const text = planDisplacedNormal('mul1', lines, 'normal', 0, 'X')!.lines.join('\n');
    expect(text.indexOf('const __q = __fsDisp0(vec3(0), __n).toVar();')).toBeGreaterThan(-1);
    expect(text.indexOf('const __q = __fsDisp0(vec3(0), __n).toVar();')).toBeLessThan(text.indexOf('normalLocal.assign('));
    expect(text).toContain('const __q1 = __fsDisp0(__t.mul(0.001), __n);');
    expect(text).toContain('const __q2 = __fsDisp0(__b.mul(0.001), __n);');
    expect(text.indexOf('const __n = normalLocal.toVar();')).toBeLessThan(text.indexOf('normalLocal.assign('));
    expect(text).toContain('normalLocal.assign(cross(__q1.sub(__q), __q2.sub(__q)).normalize());');
  });

  it('never builds today\'s expression: the vertex\'s own point is D(0), and a normal read takes the held __n', () => {
    // Fresnel in the chain read three's normalWorld, which three r184 builds
    // wrongly inside a positionNode: the Fresnel-driven sphere lost its
    // lighting under Along normal (2026-11-12).
    const fres = [
      'const fresnel1 = fsFresnel(1.5, normalWorld, positionWorld);',
      'const mul1 = mul(fresnel1.x, 0.01);',
    ];
    for (const recompute of [true, false]) {
      const text = planDisplacedNormal('mul1', fres, 'normal', 0, 'X', recompute)!.lines.join('\n');
      expect(text).not.toMatch(/__q0\b(?!\])/);
      expect(text).toContain(
        'fsFresnel(1.5, transformNormalToView(__n).transformDirection(cameraViewMatrix), modelWorldMatrix.mul(vec4(positionLocal.add(__d), 1)).xyz)',
      );
    }
  });

  it('positionGeometry stays the attribute at the vertex itself (a skinned model\'s bind pose)', () => {
    const text = planDisplacedNormal('mul1', lines, 'normal', 0, 'X')!.lines.join('\n');
    // D(0): `positionGeometry.add(vec3(0))`, never the deformed positionLocal.
    expect(text).toContain('__fsDisp0(vec3(0), __n)');
    expect(text).not.toMatch(/__fsDisp0\(positionLocal\b/);
  });

  it('spells every normal as three builds a smooth vertex normal, and leaves normalGeometry and positionWorldDirection to three', () => {
    const text = planDisplacedNormal('h', [
      'const h = add(normalWorld.y, normalView.x, normalLocal.z, normalGeometry.z, positionWorldDirection.y, positionGeometry.x);',
    ], 'normal', 0, 'X')!.lines.join('\n');
    expect(text).toContain(
      'add(transformNormalToView(__n).transformDirection(cameraViewMatrix).y, transformNormalToView(__n).x, __n.z, normalGeometry.z, positionWorldDirection.y, positionGeometry.add(__d).x)',
    );
  });

  it('a chain reading an accessor three cannot build in a positionNode is wrapped on EVERY material', () => {
    for (const body of [
      ['const h = normalWorld.y;'],
      ['const h = normalView.x;'],
      ['const h = positionViewDirection.z;'],
      ['const n1 = normalWorldGeometry;', 'const h = mul(n1.y, 0.1);'],
    ]) {
      for (const recompute of [true, false]) {
        const text = planDisplacedNormal('h', body, 'normal', 0, 'X', recompute)?.lines.join('\n');
        // None of these reads a position ROOT, so nothing is recomputed: the
        // wrapper evaluates D(0) once and writes no normal.
        expect(text).toContain('return __fsDisp0(vec3(0), normalLocal);');
        expect(text).not.toContain('normalLocal.assign');
      }
    }
    // The view position IS a root: recomputed where the material allows it,
    // and still wrapped where it does not.
    const view = ['const h = positionView.z;'];
    expect(planDisplacedNormal('h', view, 'normal', 0, 'X', true)!.lines.join('\n')).toContain('normalLocal.assign(');
    const flatView = planDisplacedNormal('h', view, 'normal', 0, 'X', false)!.lines.join('\n');
    expect(flatView).toContain('return __fsDisp0(vec3(0), normalLocal);');
    expect(flatView).toContain('modelViewMatrix.mul(vec4(positionLocal.add(__d), 1)).xyz.z');
  });

  it('a material with no recompute keeps today\'s positionNode when every read is safe', () => {
    expect(planDisplacedNormal('mul1', lines, 'normal', 0, 'X', false)).toBeNull();
    expect(planDisplacedNormal('h', ['const h = normalLocal.y.add(positionWorld.x);'], 'normal', 0, 'X', false)).toBeNull();
  });

  it('offset mode adds the raw displacement', () => {
    const text = planDisplacedNormal('mul1', lines, 'offset', 0, 'X')!.lines.join('\n');
    expect(text).toContain('return positionLocal.add(__d).add(mul1);');
  });

  it('re-binds world and view position through the model matrices', () => {
    const text = planDisplacedNormal('h', ['const h = positionWorld.y.add(positionView.x);'], 'normal', 0, 'X')!.lines.join('\n');
    expect(text).toContain('modelWorldMatrix.mul(vec4(positionLocal.add(__d), 1)).xyz.y');
    expect(text).toContain('modelViewMatrix.mul(vec4(positionLocal.add(__d), 1)).xyz.x');
  });

  it('never touches a member or a longer name, a string or a comment', () => {
    const text = planDisplacedNormal('h', [
      "const h = mul(positionGeometry.x, 2); // positionGeometry",
    ], 'normal', 0, 'X')!.lines.join('\n');
    expect(text).toContain('mul(positionGeometry.add(__d).x, 2); // positionGeometry');
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

  const NORMAL_DRIVEN = NOISE
    .replace("import { Fn, color, float, mul, mx_noise_float, positionGeometry } from 'three/tsl';", "import { Fn, color, float, mul, normalWorld } from 'three/tsl';")
    .replace('const noise1 = mx_noise_float(positionGeometry.mul(3));', 'const noise1 = normalWorld.y;');

  it('a FLAT or UNLIT material whose displacement reads a normal is wrapped, never handed three\'s normalWorld', () => {
    // On Flat that was "Recursion detected" and a vertex shader that did not
    // compile; on Smooth and Unlit a NaN normal made the shape vanish (2026-11-12).
    for (const materialSettings of [{ flatShading: true }, { unlit: true }, { unlit: true, flatShading: true }, {}]) {
      const out = buildShaderModule(NORMAL_DRIVEN, { materialSettings });
      expect(out).toContain('positionNode: __fsDisplaced0(positionLocal.add(normalLocal.mul(mul1)))');
      expect(out).toContain('const noise1 = transformNormalToView(__n).transformDirection(cameraViewMatrix).y;');
      expect(out).toContain('return __fsDisp0(vec3(0), normalLocal);');
      expect(out).not.toContain('normalLocal.assign');
      expect(out).toMatch(/import \{[^}]*\btransformNormalToView\b[^}]*\} from 'three\/tsl';/);
      expect(out).toMatch(/import \{[^}]*\bcameraViewMatrix\b[^}]*\} from 'three\/tsl';/);
      parsesAsModule(out);
    }
  });

  it('a flat PART whose displacement reads a normal is wrapped too', () => {
    const parts = NORMAL_DRIVEN.replace(
      'return { color: tint, position: mul1, roughness: float(0.5) };',
      'return { parts: { "A": { color: tint, position: mul1, flatShading: true } } };',
    );
    const out = buildShaderModule(parts, {});
    expect(out).toMatch(/"A": \{ colorNode: tint, positionNode: __fsDisplaced0\(positionLocal\.add\(normalLocal\.mul\(mul1\)\)\)/);
    expect(out).not.toContain('normalLocal.assign');
    parsesAsModule(out);
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

  it('reads a flat material\'s wrapper back the same way, dropping what it imported', () => {
    const flat = NOISE
      .replace("import { Fn, color, float, mul, mx_noise_float, positionGeometry } from 'three/tsl';", "import { Fn, color, float, mul, normalWorld } from 'three/tsl';")
      .replace('const noise1 = mx_noise_float(positionGeometry.mul(3));', 'const noise1 = normalWorld.y;');
    const back = scriptToTSL(buildShaderModule(flat, { materialSettings: { flatShading: true } }));
    expect(back).toContain('const noise1 = normalWorld.y;');
    expect(back).toContain('position: mul1');
    expect(back).not.toMatch(/__fsDisp|__d\b|transformNormalToView|cameraViewMatrix/);
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
    expect(out).toMatch(/mx_noise_float\(positionGeometry\.add\(__d\)/);
    parsesAsModule(out);
  });

  it('a Fresnel wired to Position on a FLAT material compiles: its normal is the held one', () => {
    // The 2026-11-12 report: Fresnel → Position. three's normalWorld inside
    // the positionNode recursed through the flat (pixel-derivative) normal.
    const fres = makeNode('f', 'fresnel');
    const amp = makeNode('m', 'mul', { b: 0.01 });
    const out = makeNode('out', 'output');
    (out.data as { exposedPorts?: string[] }).exposedPorts = ['position'];
    (out.data as { materialSettings?: object }).materialSettings = { flatShading: true };
    const code = graphToCode([fres, amp, out], [makeEdge('f', 'out', 'm', 'a'), makeEdge('m', 'out', 'out', 'position')]).code;
    const mod = buildShaderModule(code, { materialSettings: { flatShading: true } });
    expect(mod).toMatch(/fsFresnel\([^;]*transformNormalToView\(__n\)\.transformDirection\(cameraViewMatrix\), modelWorldMatrix\.mul\(vec4\(positionLocal\.add\(__d\), 1\)\)\.xyz\)/);
    expect(mod).toContain('positionNode: __fsDisplaced0(');
    expect(mod).not.toContain('normalLocal.assign');
    parsesAsModule(mod);
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

describe('the name tables', () => {
  it('the recompute and its price decide on ONE root set', () => {
    expect(new Set(POSITION_ROOTS)).toEqual(DISPLACED_NORMAL_ROOTS);
  });

  it('every unsafe read is re-bound, and every name either side spells is a three/tsl export', () => {
    for (const name of VERTEX_UNSAFE) expect(REBOUND.has(name)).toBe(true);
    for (const [name, spelled] of REBOUND) {
      expect(TSL_EXPORT_NAMES.has(name)).toBe(true);
      for (const id of spelled.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? []) {
        if (id !== '__d' && id !== '__n') expect(TSL_EXPORT_NAMES.has(id), id).toBe(true);
      }
    }
  });
});

describe('the Faces tooltip', () => {
  it('carries its Latvian', () => {
    const LV = JSON.parse(readFileSync(resolve(__dirname, '../i18n/lv.json'), 'utf8')) as { ui?: Record<string, string> };
    expect(LV.ui?.[FACES_HINT_KEY]).toBeTruthy();
  });
});
