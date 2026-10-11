import { describe, it, expect } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import {
  countSampledTextures,
  maxMaterialSampledTextures,
  textureBudgetLine,
  TEXTURE_BUDGET_MARK,
  SAMPLED_TEXTURE_STAGE_LIMIT,
  THREE_RESERVED_TEXTURES,
} from './textureBudget';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * The sampled-texture budget (engine/textureBudget.ts): each distinct Color
 * Ramp / RGB Curves table spends one binding, shared with Image / Colormap /
 * Data / env, against 16 per stage — and three binds one more of its own on a
 * lit material (its DFG lookup table: 16 module textures bind 17). Past it the
 * preview failed to compile with only the raw error overlay; now the module
 * says so — counted PER MATERIAL, from what each material reads, and ONLY at
 * the budget, so no module under it moves a byte.
 */

const stops = (k: number) => `0 #${k.toString(16).padStart(6, '0')} 1,1 #ffffff 1`;

/** `n` Color Ramps (ids `<p>0`…), each with its own stops (or all the same), summed into `target`'s `handle`. */
function ramps(
  n: number,
  distinct = true,
  opts: { prefix?: string; first?: number; target?: string; handle?: string } = {},
): { nodes: AppNode[]; edges: AppEdge[] } {
  const { prefix = 'r', first = 1, target = 'out', handle = 'color' } = opts;
  const nodes: AppNode[] = opts.target ? [] : [makeNode('out', 'output')];
  const edges: AppEdge[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    nodes.push(makeNode(`${prefix}${i}`, 'colorRamp', { stops: stops(distinct ? first + i : first) }));
    if (prev === null) prev = `${prefix}${i}`;
    else {
      nodes.push(makeNode(`${prefix}a${i}`, 'add'));
      edges.push(makeEdge(prev, 'out', `${prefix}a${i}`, 'a'), makeEdge(`${prefix}${i}`, 'out', `${prefix}a${i}`, 'b'));
      prev = `${prefix}a${i}`;
    }
  }
  if (prev) edges.push(makeEdge(prev, 'out', target, handle));
  return { nodes, edges };
}

/** The first module count that breaks a stage: 16 module textures + three's own = 17 > 16. */
const AT_BUDGET = SAMPLED_TEXTURE_STAGE_LIMIT - THREE_RESERVED_TEXTURES + 1;

describe('textureBudget — the count', () => {
  it('counts DISTINCT texture identifiers read in the body, plus the LUT tables; comments are not reads', () => {
    expect(
      countSampledTextures(
        [
          '  const a = texture(tex1, uv()).rgb;',
          '  const b = texture( tex1, vec2(0.5)).x;',
          '  const c = texture(_image1_tex, uv()).rgb.add(texture(lut2, vec2(c, 0.5)).rgb);',
          '  // texture(notCounted, uv())',
        ],
        3,
      ),
    ).toBe(6);
  });

  it('a comment from 16 module textures: three binds its own DFG table beside them on a lit material', () => {
    expect(THREE_RESERVED_TEXTURES).toBe(1);
    expect(textureBudgetLine(AT_BUDGET - 1)).toBeNull();
    expect(textureBudgetLine(AT_BUDGET)).toMatch(new RegExp(`^${TEXTURE_BUDGET_MARK} 16 textures in one material`));
  });

  it('per material: only what a material READS, through the body definitions — an unconnected node binds nothing', () => {
    const body = [
      '  const a = texture(t1, uv()).rgb;',
      '  const b = a.mul(texture(t2, uv()).rgb);',
      '  const c = texture(t3, uv()).rgb;',
      '  const r = fsColorRamp(b.x, "0 #000000 1,1 #ffffff 1", "linear");',
      '  // texture(t9, uv())',
    ];
    const lut = new Map([['r', 'ramp linear 0 #000000 1,1 #ffffff 1']]);
    expect(maxMaterialSampledTextures(body, [['b']], lut)).toBe(2);
    expect(maxMaterialSampledTextures(body, [['r']], lut)).toBe(3);
    // Two materials are compiled apart: the busiest one counts, never the sum.
    expect(maxMaterialSampledTextures(body, [['b'], ['c']], lut)).toBe(2);
    // A channel that IS a texture (the Environment socket) counts too.
    expect(maxMaterialSampledTextures(body, [['texture(_env_tex)']], lut)).toBe(1);
    expect(maxMaterialSampledTextures(body, [['vec3(1, 0, 0)']], lut)).toBe(0);
    expect(maxMaterialSampledTextures(body, [], lut)).toBe(0);
  });

  it('a member name, a number or a string names no variable', () => {
    const body = ['  const rgb = texture(t1, uv()).rgb;', '  const x1 = vec3(1).rgb;', '  const e1 = vec3(1e1);'];
    expect(maxMaterialSampledTextures(body, [['x1']], new Map())).toBe(0);
    expect(maxMaterialSampledTextures(body, [['fsColorRamp(f, "rgb", "linear")']], new Map())).toBe(0);
    expect(maxMaterialSampledTextures(body, [['e1']], new Map())).toBe(0);
    expect(maxMaterialSampledTextures(body, [['rgb']], new Map())).toBe(1);
  });

  it('a multi-line definition is one statement, and a top-level statement that defines nothing counts for every material', () => {
    const body = [
      '  const f = Fn(() => {',
      '    const q = texture(t1, uv());',
      '    return q;',
      '  })();',
      '  Discard(texture(t2, uv()).x.lessThan(0.5));',
    ];
    expect(maxMaterialSampledTextures(body, [['vec3(0)']], new Map())).toBe(1);
    expect(maxMaterialSampledTextures(body, [['f']], new Map())).toBe(2);
  });
});

describe('textureBudget — in the generated module', () => {
  it('15 distinct ramps: no comment (the module is byte-identical to before)', () => {
    expect(graphToCode(ramps(15).nodes, ramps(15).edges).code).not.toContain(TEXTURE_BUDGET_MARK);
  });

  it('16 distinct ramps: the comment sits right above the shader Fn, and the module still round-trips', () => {
    const g = ramps(16);
    const code = graphToCode(g.nodes, g.edges).code;
    expect(code).toContain(
      `${TEXTURE_BUDGET_MARK} 16 textures in one material, and three.js may add one for lighting; a stage can read at most 16, so the preview may fail to compile\nconst shader = Fn(() => {`,
    );
    const r = codeToGraph(code);
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('equal ramps share ONE table, as fsLut.make does: 20 identical ramps are one texture', () => {
    const g = ramps(20, false);
    expect(graphToCode(g.nodes, g.edges).code).not.toContain(TEXTURE_BUDGET_MARK);
  });

  it('identity RGB Curves bake nothing and count nothing; bent ones count once per curve set', () => {
    const g = ramps(15);
    g.nodes.push(makeNode('c0', 'rgbCurves'), makeNode('aC', 'add'));
    const last = g.edges.pop()!;
    g.edges.push(makeEdge(last.source, 'out', 'aC', 'a'), makeEdge('c0', 'out', 'aC', 'b'), makeEdge('aC', 'out', 'out', 'color'));
    expect(graphToCode(g.nodes, g.edges).code).not.toContain(TEXTURE_BUDGET_MARK);
    g.nodes = g.nodes.map((n) => (n.id === 'c0' ? makeNode('c0', 'rgbCurves', { curveC: '0 0.1,1 0.9' }) : n));
    expect(graphToCode(g.nodes, g.edges).code).toContain(`${TEXTURE_BUDGET_MARK} 16 textures`);
  });

  it('an UNCONNECTED ramp is emitted but bound by no material, so it counts nothing', () => {
    // One wired ramp plus 16 unconnected ones used to read "17 textures in one shader".
    const g = ramps(1);
    for (let i = 0; i < 16; i++) g.nodes.push(makeNode(`loose${i}`, 'colorRamp', { stops: stops(100 + i) }));
    const code = graphToCode(g.nodes, g.edges).code;
    expect(code.match(/fsColorRamp\(/g)!.length).toBeGreaterThan(16);
    expect(code).not.toContain(TEXTURE_BUDGET_MARK);
  });

  it('two materials never add up: 10 tables each is 10 in either material, however many the module holds', () => {
    const out = makeNode('out', 'output');
    (out.data as Record<string, unknown>).materials = [{ meshTargets: ['Glass'] }];
    const a = ramps(10, true, { prefix: 'p', first: 1, target: 'out', handle: 'color' });
    const b = ramps(10, true, { prefix: 'q', first: 50, target: 'out', handle: 'm1:color' });
    const code = graphToCode([out, ...a.nodes, ...b.nodes], [...a.edges, ...b.edges]).code;
    expect(code).toContain('parts: { "Glass": {');
    expect(code).not.toContain(TEXTURE_BUDGET_MARK);
    // …while 16 in ONE of them is still announced.
    const c = ramps(16, true, { prefix: 'q', first: 50, target: 'out', handle: 'm1:color' });
    expect(graphToCode([out, ...a.nodes, ...c.nodes], [...a.edges, ...c.edges]).code).toContain(`${TEXTURE_BUDGET_MARK} 16 textures`);
  });
});
