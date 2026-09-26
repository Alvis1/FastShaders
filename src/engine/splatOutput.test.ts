import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { tslToShaderModule } from './tslToShaderModule';
import { buildShaderModule } from './tslCodeProcessor';
import { scriptToTSL } from './scriptToTSL';
import { REPO, evalLoader, loaderAvailable, loaderPath, loaderText, type FastShadersApi } from '@/shaderloaderHarness';
import { makeNode, makeEdge, canonicalSrc, makeRealPng } from '@/test-utils';
import { SPLAT_FN_PARAMS, SPLAT_SCOPES, drivingSplatOutput, implicitRootOf, scopeRootTypes } from '@/utils/sdfPartition';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeDataNodeData } from '@/utils/dataNode';
import type { AppNode, AppEdge } from '@/types';

/**
 * The Splat Output — the Gaussian-splat sink. Its module return is NOT a
 * material: `{ splat: { shade, shape, size, feather, invert } }`, where shade
 * and shape are `Fn(([p, pw, n, c]) => …)` returning `vec4(rgb, opacity)` and
 * `vec4(move, cut)`, which loader 0.8 calls ONCE PER SPLAT inside the splat
 * renderer's own vertex stage (utils/sdfPartition.ts, SPLAT_SCOPES). What is
 * pinned here: the emitted text per socket combination, that nothing ever
 * emits a `Discard(`, byte-identical `graphToCode → codeToGraph → graphToCode`
 * round trips with `errors: []`, and the MODULE pass-through (the `splat` key
 * on a whitelist, hostile keys stripped, no `__pixel`) as the loader receives
 * it.
 */

interface Graph { nodes: AppNode[]; edges: AppEdge[] }

/** A Splat Output carrying `values` exactly as given (booleans included). */
function splat(values: Record<string, unknown> = {}, id = 'sp'): AppNode {
  const n = makeNode(id, 'splatOutput');
  return { ...n, data: { ...n.data, values } } as AppNode;
}
const flag = (n: AppNode): AppNode => ({ ...n, data: { ...n.data, activeOutput: true } }) as AppNode;
const code = ({ nodes, edges }: Graph): string => graphToCode(nodes, edges).code;

const pos = () => makeNode('pos', 'positionLocal');
const sd = () => makeNode('sd', 'sdCircle');
/** Local Position → sdCircle → Cut. */
const cutBySphere = (values: Record<string, unknown> = {}): Graph => ({
  nodes: [pos(), sd(), splat(values)],
  edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut')],
});

/** Every socket combination the round-trip block walks, by name. */
function cases(): Record<string, Graph> {
  return {
    'identity (flagged, nothing wired)': { nodes: [flag(splat())], edges: [] },
    'stored colour': { nodes: [flag(splat({ color: '#2d6cdf' }))], edges: [] },
    'stored opacity': { nodes: [flag(splat({ opacity: 0.35 }))], edges: [] },
    'stored colour + opacity': { nodes: [flag(splat({ color: '#102030', opacity: 0.5 }))], edges: [] },
    'wired colour (captured)': {
      nodes: [makeNode('c', 'color', { hex: '#ff0000' }), splat()],
      edges: [makeEdge('c', 'out', 'sp', 'color')],
    },
    'scalar colour (widened)': {
      nodes: [makeNode('f', 'float', { value: 0.4 }), splat()],
      edges: [makeEdge('f', 'out', 'sp', 'color')],
    },
    'the splat colour through c (a vec4, truncated)': {
      nodes: [makeNode('vc', 'vertexColor'), makeNode('m', 'oneMinus'), splat()],
      edges: [makeEdge('vc', 'out', 'm', 'x'), makeEdge('m', 'out', 'sp', 'color')],
    },
    'opacity by world position': {
      nodes: [makeNode('pw', 'positionWorld'), makeNode('len', 'length'), splat()],
      edges: [makeEdge('pw', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'opacity')],
    },
    'colour and opacity from one feeder': {
      nodes: [pos(), makeNode('len', 'length'), splat()],
      edges: [makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'color'), makeEdge('len', 'out', 'sp', 'opacity')],
    },
    'facing direction': {
      nodes: [makeNode('nw', 'normalWorld'), makeNode('ab', 'abs'), splat()],
      edges: [makeEdge('nw', 'out', 'ab', 'x'), makeEdge('ab', 'out', 'sp', 'color')],
    },
    'cut by a distance field': cutBySphere(),
    'cut, feathered and inverted': cutBySphere({ feather: 0.1, invert: true }),
    'move by a field': {
      nodes: [pos(), makeNode('nz', 'perlinVec3'), splat()],
      edges: [makeEdge('pos', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'move')],
    },
    'scalar move (widened) + cut': {
      nodes: [pos(), sd(), makeNode('t', 'time'), splat()],
      edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('t', 'out', 'sp', 'move')],
    },
    'size by a field (its own Fn)': {
      nodes: [pos(), makeNode('len', 'length'), splat()],
      edges: [makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'size')],
    },
    'size wired to a constant (captured)': {
      nodes: [makeNode('f', 'float', { value: 2 }), splat()],
      edges: [makeEdge('f', 'out', 'sp', 'size')],
    },
    'stored size + feather': { nodes: [flag(splat({ size: 1.5, feather: 0.25 }))], edges: [] },
    'stored size only': { nodes: [flag(splat({ size: 2 }))], edges: [] },
    'wired feather': {
      nodes: [pos(), sd(), makeNode('f', 'float', { value: 0.05 }), splat()],
      edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('f', 'out', 'sp', 'feather')],
    },
    'feather only, wired to a constant (flagged)': {
      nodes: [makeNode('t', 'time'), flag(splat())],
      edges: [makeEdge('t', 'out', 'sp', 'feather')],
    },
    // Feather is read by the loader's per-vertex cut test, so a Feather that
    // depends on the splat is a per-SPLAT Fn of its own, exactly like Size.
    'feather by a field (its own Fn)': {
      nodes: [pos(), sd(), makeNode('len', 'length'), splat()],
      edges: [
        makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'),
        makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'feather'),
      ],
    },
    'a cell-noise feather, position unwired (read at the splat centre)': {
      nodes: [pos(), sd(), makeNode('nz', 'cellNoise'), splat()],
      edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('nz', 'out', 'sp', 'feather')],
    },
    'feather only, by a field (flagged)': {
      nodes: [pos(), makeNode('len', 'length'), flag(splat())],
      edges: [makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'feather')],
    },
    'a uv chain (bound to the splat centre)': {
      nodes: [makeNode('uv', 'uv'), makeNode('nz', 'perlin'), splat()],
      edges: [makeEdge('uv', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'opacity')],
    },
    // The IMPLICIT reads (utils/sdfPartition.ts implicitRootOf): a noise whose
    // position is unwired reads the splat centre `p`, never the quad corner.
    'noise on Cut, position unwired (read at the splat centre)': {
      nodes: [makeNode('nz', 'perlin'), splat()],
      edges: [makeEdge('nz', 'out', 'sp', 'cut')],
    },
    'noise scaled, position unwired': {
      nodes: [makeNode('nz', 'perlin', { pos: 'positionGeometry', scale: 3 }), splat()],
      edges: [makeEdge('nz', 'out', 'sp', 'cut')],
    },
    'unsigned noise on Opacity, position unwired': {
      nodes: [makeNode('nz', 'perlin', { pos: 'positionGeometry', scale: 1, signed: 0 }), splat()],
      edges: [makeEdge('nz', 'out', 'sp', 'opacity')],
    },
    'a noise shared between a Fn and the flat body': {
      nodes: [makeNode('nz', 'perlin'), makeNode('ab', 'abs'), splat()],
      edges: [makeEdge('nz', 'out', 'sp', 'cut'), makeEdge('nz', 'out', 'ab', 'x')],
    },
    'a noise on Cut and Feather (read in both Fns)': {
      nodes: [makeNode('nz', 'perlin'), splat()],
      edges: [makeEdge('nz', 'out', 'sp', 'cut'), makeEdge('nz', 'out', 'sp', 'feather')],
    },
    // A FLAT copy (a member also read outside every Fn) brings its in-scope
    // ancestors with it — the implicit-root noise at depth 1, a real root's
    // chain at depth 2 — or the flat line names a Fn-only variable.
    'noise → remap → Cut, remap also dangling': {
      nodes: [makeNode('nz', 'perlin'), makeNode('r', 'remap'), makeNode('s', 'sin'), splat()],
      edges: [makeEdge('nz', 'out', 'r', 'x'), makeEdge('r', 'out', 'sp', 'cut'), makeEdge('r', 'out', 's', 'x')],
    },
    'noise → remap → Cut + Feather': {
      nodes: [makeNode('nz', 'perlin'), makeNode('r', 'remap'), splat()],
      edges: [makeEdge('nz', 'out', 'r', 'x'), makeEdge('r', 'out', 'sp', 'cut'), makeEdge('r', 'out', 'sp', 'feather')],
    },
    'Local Position → Length → Mul → Cut, Mul also dangling': {
      nodes: [pos(), makeNode('len', 'length'), makeNode('m', 'mul'), makeNode('s', 'sin'), splat()],
      edges: [
        makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'm', 'a'),
        makeEdge('m', 'out', 'sp', 'cut'), makeEdge('m', 'out', 's', 'x'),
      ],
    },
    'one noise in two Fns (Opacity and Cut)': {
      nodes: [makeNode('nz', 'perlin'), splat()],
      edges: [makeEdge('nz', 'out', 'sp', 'opacity'), makeEdge('nz', 'out', 'sp', 'cut')],
    },
    'a vec3 noise at the WORLD centre (stored positionWorld) on Move and Color': {
      nodes: [makeNode('nz', 'fbmVec3', { pos: 'positionWorld', scale: 2 }), splat()],
      edges: [makeEdge('nz', 'out', 'sp', 'move'), makeEdge('nz', 'out', 'sp', 'color')],
    },
    // Position-derived ROOTS other than the parameters, restated over the
    // centre (SPLAT_CONSTANTS): view position / direction, world direction,
    // and the Ray Direction helper.
    'cut by distance from the camera (View Position)': {
      nodes: [makeNode('pv', 'positionView'), makeNode('len', 'length'), splat()],
      edges: [makeEdge('pv', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'cut')],
    },
    'colour by the view direction and the ray': {
      nodes: [makeNode('vd', 'positionViewDirection'), makeNode('rd', 'rayDirection'), makeNode('mx', 'mul'), splat()],
      edges: [makeEdge('vd', 'out', 'mx', 'a'), makeEdge('rd', 'out', 'mx', 'b'), makeEdge('mx', 'out', 'sp', 'color')],
    },
    'move along the world direction': {
      nodes: [makeNode('wd', 'positionWorldDirection'), splat()],
      edges: [makeEdge('wd', 'out', 'sp', 'move')],
    },
    'a Cut feeder on an Sdf of the centre AND an unwired noise': {
      nodes: [pos(), sd(), makeNode('nz', 'perlin'), makeNode('ad', 'add'), splat({ feather: 0.1 })],
      edges: [
        makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'ad', 'a'), makeEdge('nz', 'out', 'ad', 'b'),
        makeEdge('ad', 'out', 'sp', 'cut'),
      ],
    },
    'everything at once': {
      nodes: [
        pos(), sd(), makeNode('c', 'color', { hex: '#ffcc88' }), makeNode('pw', 'positionWorld'),
        makeNode('len', 'length'), makeNode('nz', 'perlinVec3'), makeNode('f', 'float', { value: 0.5 }),
        splat({ feather: 0.2, invert: true }),
      ],
      edges: [
        makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'),
        makeEdge('c', 'out', 'sp', 'color'), makeEdge('pw', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'opacity'),
        makeEdge('pw', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'move'), makeEdge('f', 'out', 'sp', 'size'),
      ],
    },
  };
}

describe('Splat Output — emission', () => {
  it('an active sink with nothing to say is the identity program: `return { splat: {} };` and nothing else', () => {
    const c = code({ nodes: [flag(splat())], edges: [] });
    expect(c).toContain('  return { splat: {} };');
    expect(c).not.toMatch(/sp1(Shade|Shape|Size)/);
    expect(c.split('\n')[0]).toBe("import { Fn } from 'three/tsl';");
    // The plain "nothing wired" sentinel is computed beside it but never
    // emitted — and neither is its `vec3` import.
    expect(c).not.toContain('vec3');
  });

  it('an UNFLAGGED Splat Output with nothing wired does not drive (like an unwired march)', () => {
    const nodes = [splat()];
    expect(drivingSplatOutput(nodes, [])).toBeNull();
    expect(code({ nodes, edges: [] })).toContain('  return vec3(1, 0, 0);');
  });

  it('a wired Color drives, and a captured chain is closed over: `vec4(color1, 1)`', () => {
    const c = code(cases()['wired colour (captured)']);
    expect(c).toContain('  const color1 = color(0xff0000);');
    expect(c).toContain('  const sp1Shade = Fn(([p, pw, n, c]) => {\n    return vec4(color1, 1);\n  });');
    expect(c).toContain('  return { splat: { shade: sp1Shade } };');
    expect(c).toMatch(/^import \{ Fn, color, vec4 \} from 'three\/tsl';/);
  });

  it('an unwired Color is the splat\'s own `c.rgb`, a stored swatch is `color(0x…)`, a stored Opacity its number', () => {
    expect(code(cases()['stored colour'])).toContain('    return vec4(color(0x2d6cdf), 1);');
    expect(code(cases()['stored opacity'])).toContain('    return vec4(c.rgb, 0.35);');
    expect(code(cases()['stored colour + opacity'])).toContain('    return vec4(color(0x102030), 0.5);');
    // Opacity 1 and no colour is the identity: no shade Fn at all.
    expect(code({ nodes: [flag(splat({ opacity: 1 }))], edges: [] })).toContain('  return { splat: {} };');
    // A non-hex colour and a non-numeric opacity are untouched, never guessed.
    const junk = code({ nodes: [flag(splat({ color: 'red', opacity: '' }))], edges: [] });
    expect(junk).toContain('  return { splat: {} };');
  });

  it('a colour that is not three channels is widened with vec3(): a scalar broadcasts, a vec4 truncates', () => {
    expect(code(cases()['scalar colour (widened)'])).toContain('    return vec4(vec3(float1), 1);');
    const c = code(cases()['the splat colour through c (a vec4, truncated)']);
    expect(c).toContain('    const vertexColor1 = c;');
    expect(c).toContain('    return vec4(vec3(oneMinus1), 1);');
  });

  it('roots bind to the Fn parameters: `p` the centre, `pw` world, `n` the facing direction, `c` the colour', () => {
    const o = code(cases()['opacity by world position']);
    expect(o).toContain('  const positionWorld1 = positionWorld;'); // the flat body keeps the real root
    expect(o).toContain('  const sp1Shade = Fn(([p, pw, n, c]) => {\n    const positionWorld1 = pw;\n    const length1 = length(positionWorld1);\n    return vec4(c.rgb, length1);\n  });');
    expect(code(cases()['facing direction'])).toContain('    const normalWorld1 = n;');
    expect(code(cases()['cut by a distance field'])).toContain('    const positionLocal1 = p;');
    expect([...SPLAT_FN_PARAMS]).toEqual(['p', 'pw', 'n', 'c']);
  });

  it('a feeder of BOTH Color and Opacity is emitted ONCE, inside sp1Shade', () => {
    const c = code(cases()['colour and opacity from one feeder']);
    expect(c.match(/const length1 = /g)).toHaveLength(1);
    expect(c).toContain('    return vec4(vec3(length1), length1);');
  });

  it('Cut and Move are the shape Fn: `vec4(0, 0, 0, cut)` unmoved, `vec4(move, cut)` moved', () => {
    const c = code(cases()['cut by a distance field']);
    expect(c).toContain('  const sp1Shape = Fn(([p, pw, n, c]) => {\n    const positionLocal1 = p;\n    const sdCircle1 = sdCircle(positionLocal1, 0.5);\n    return vec4(0, 0, 0, sdCircle1);\n  });');
    expect(c).toContain('  return { splat: { shape: sp1Shape } };');
    const m = code(cases()['move by a field']);
    expect(m).toMatch(/return vec4\(noise\w*1, 0\);/);
    expect(code(cases()['scalar move (widened) + cut'])).toContain('    return vec4(vec3(time1), sdCircle1);');
  });

  it('Size: its own Fn when it depends on the splat, the captured node when not, the number when stored', () => {
    const f = code(cases()['size by a field (its own Fn)']);
    expect(f).toContain('  const sp1Size = Fn(([p, pw, n, c]) => {\n    const positionLocal1 = p;\n    const length1 = length(positionLocal1);\n    return length1;\n  });');
    expect(f).toContain('  return { splat: { size: sp1Size } };');
    const k = code(cases()['size wired to a constant (captured)']);
    expect(k).not.toContain('sp1Size');
    expect(k).toContain('  return { splat: { size: float1 } };');
    expect(code(cases()['stored size + feather'])).toContain('  return { splat: { size: 1.5, feather: 0.25 } };');
    expect(code({ nodes: [flag(splat({ size: 1, feather: 0 }))], edges: [] })).toContain('  return { splat: {} };');
  });

  it('Feather and Invert ride the return line as values; only the literal `true` inverts', () => {
    expect(code(cases()['cut, feathered and inverted'])).toContain('  return { splat: { shape: sp1Shape, feather: 0.1, invert: true } };');
    for (const junk of ['true', 1, 'yes']) {
      expect(code(cutBySphere({ invert: junk })), String(junk)).toContain('  return { splat: { shape: sp1Shape } };');
    }
    // A Feather that does not depend on the splat is the captured node.
    expect(code(cases()['wired feather'])).toContain('  return { splat: { shape: sp1Shape, feather: float1 } };');
    expect(code(cases()['wired feather'])).not.toContain('sp1Feather');
  });

  it('Feather: its own Fn when it depends on the splat — read per SPLAT, like Size, never at the quad corner', () => {
    const f = code(cases()['feather by a field (its own Fn)']);
    expect(f).toContain('  const sp1Feather = Fn(([p, pw, n, c]) => {\n    const positionLocal1 = p;\n    const length1 = length(positionLocal1);\n    return length1;\n  });');
    expect(f).toContain('  return { splat: { shape: sp1Shape, feather: sp1Feather } };');
    // The flat body keeps the root and nothing else of the chain.
    expect(f).not.toMatch(/^ {2}const length1 = /m);
    // An unwired noise position is the splat's own centre inside the Fn.
    const nz = code(cases()['a cell-noise feather, position unwired (read at the splat centre)']);
    expect(nz).toContain('  const sp1Feather = Fn(([p, pw, n, c]) => {\n    const cell_noise1 = mx_cell_noise_float(p);\n    return cell_noise1;\n  });');
    expect(nz).not.toContain('positionGeometry');
    // The Fns come in the return's order: shade, shape, size, feather.
    const all = code({
      nodes: [pos(), sd(), makeNode('len', 'length'), makeNode('ab', 'abs'), splat()],
      edges: [
        makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('pos', 'out', 'len', 'v'),
        makeEdge('len', 'out', 'sp', 'feather'), makeEdge('pos', 'out', 'ab', 'x'), makeEdge('ab', 'out', 'sp', 'size'),
      ],
    });
    expect(all.indexOf('const sp1Shape')).toBeLessThan(all.indexOf('const sp1Size'));
    expect(all.indexOf('const sp1Size')).toBeLessThan(all.indexOf('const sp1Feather'));
    expect(all).toContain('  return { splat: { shape: sp1Shape, size: sp1Size, feather: sp1Feather } };');
  });

  it('a node feeding Cut AND Feather is emitted in BOTH Fns and never in the flat body', () => {
    const nodes = [pos(), sd(), splat()];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('sd', 'out', 'sp', 'feather')];
    const c = code({ nodes, edges });
    expect(c).not.toMatch(/^ {2}const sdCircle1 = /m); // not flat
    expect(c.match(/ {4}const sdCircle1 = sdCircle\(positionLocal1, 0\.5\);\n/g)).toHaveLength(2); // sp1Shape + sp1Feather
    expect(c).toContain('feather: sp1Feather');
  });

  it('a flat copy brings its in-scope ancestors: noise → remap → Cut with remap also dangling', () => {
    const c = code(cases()['noise → remap → Cut, remap also dangling']);
    // The flat copy of the noise keeps today's text; the Fn's copy is bound.
    expect(c).toContain('  const noise1 = mx_noise_float(positionGeometry);\n  const remap1 = remap(noise1, 0, 1, 0, 1);\n  const sin1 = sin(remap1);\n');
    expect(c).toContain('    const noise1 = mx_noise_float(p);\n    const remap1 = remap(noise1, 0, 1, 0, 1);\n');
    const d = code(cases()['Local Position → Length → Mul → Cut, Mul also dangling']);
    expect(d).toContain('  const positionLocal1 = positionLocal;\n  const length1 = length(positionLocal1);\n  const mul1 = mul(length1, 1);\n  const sin1 = sin(mul1);\n');
  });

  it('the keys come in the contract\'s fixed order: shade, shape, size, feather, invert', () => {
    const c = code(cases()['everything at once']);
    expect(c).toContain('  return { splat: { shade: sp1Shade, shape: sp1Shape, size: float1, feather: 0.2, invert: true } };');
  });

  it('a uv / screen-UV source is bound to the splat centre inside a Fn, never read per quad corner', () => {
    const c = code(cases()['a uv chain (bound to the splat centre)']);
    expect(c).toContain('  const uv1 = uv();'); // the flat body keeps the real node
    expect(c).toContain('    const uv1 = vec2(0.5);');
    expect(c).toMatch(/^import \{[^}]*\bvec2\b[^}]*\} from 'three\/tsl';/);
    const s = code({
      nodes: [makeNode('su', 'screenUV'), makeNode('len', 'length'), splat()],
      edges: [makeEdge('su', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'opacity')],
    });
    expect(s).toContain('    const screenUV1 = vec2(0.5);');
  });

  it('NEVER a `Discard(` — in any combination (extractDiscards would lift it out of the Fn)', () => {
    for (const [name, g] of Object.entries(cases())) {
      const c = code(g);
      expect(c, name).not.toContain('Discard');
      expect(c, name).not.toContain('__pixel');
    }
  });

  it('a property named like a Fn parameter is renamed in a splat document, and only there', () => {
    const prop = makeNode('pr', 'property_float', { name: 'c', value: 0.5 });
    const withSplat = code({ nodes: [prop, splat()], edges: [makeEdge('pr', 'out', 'sp', 'opacity')] });
    expect(withSplat).toContain('const c2 = uniform(0.5);');
    expect(withSplat).toContain('return vec4(c.rgb, c2);');
    const plain = code({ nodes: [prop, makeNode('out', 'output')], edges: [makeEdge('pr', 'out', 'out', 'opacity')] });
    expect(plain).toContain('const c = uniform(0.5);');
  });

  it('a PARKED Splat Output renames nothing: a mesh shader\'s public property keeps its name, byte for byte', () => {
    // The names are reserved only while the splat DRIVES — its Fns exist only
    // then. A property's name is its schema key, its A-Frame attribute and its
    // persisted-uniform key, so merely dropping a Splat Output on the canvas
    // must not move any of them.
    for (const name of [...SPLAT_FN_PARAMS]) {
      const prop = makeNode('pr', 'property_float', { name, value: 3 });
      const mesh: Graph = { nodes: [prop, makeNode('out', 'output')], edges: [makeEdge('pr', 'out', 'out', 'roughness')] };
      const before = code(mesh);
      expect(before, name).toContain(`const ${name} = uniform(3);`);
      // Unwired, and parked behind a flagged plain Output while wired.
      expect(code({ nodes: [...mesh.nodes, splat()], edges: mesh.edges }), name).toBe(before);
      const parked: Graph = {
        nodes: [prop, flag(makeNode('out', 'output')), makeNode('col', 'color'), splat()],
        edges: [...mesh.edges, makeEdge('col', 'out', 'sp', 'color')],
      };
      expect(code(parked), name).toContain(`const ${name} = uniform(3);`);
      // …and the moment it drives, the parameter wins and the property moves.
      expect(code({ nodes: [prop, splat()], edges: [makeEdge('pr', 'out', 'sp', 'opacity')] }), name).toContain(`const ${name}2 = uniform(3);`);
    }
  });

  it('a driving Splat Output silences every plain Output; a flagged plain Output silences it back', () => {
    const colour = makeNode('col', 'color', { hex: '#00ff00' });
    const nodes = [...cutBySphere().nodes, makeNode('out', 'output'), colour];
    const edges = [...cutBySphere().edges, makeEdge('col', 'out', 'out', 'color')];
    const driving = code({ nodes, edges });
    expect(driving).toContain('return { splat: { shape: sp1Shape } };');
    expect(driving).not.toContain('return color1;');
    const flagged = nodes.map((n) => (n.id === 'out' ? flag(n) : n));
    const silenced = code({ nodes: flagged, edges });
    expect(silenced).not.toContain('splat');
    expect(silenced).toContain('return color1;');
    // The parked sink's feeders still emit as ordinary consts, so the carry can
    // keep its wiring across an Apply.
    expect(silenced).toContain('const sdCircle1 = sdCircle(positionLocal1, 0.5);');
  });

  it('beside a wired march, the FLAG decides which custom sink drives; the other emits nothing of its own', () => {
    const rm = makeNode('rm', 'raymarchOutput');
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), makeEdge('sd', 'out', 'sp', 'cut')];
    const splatActive = code({ nodes: [pos(), sd(), rm, flag(splat())], edges });
    expect(splatActive).toContain('return { splat: { shape: sp1Shape } };');
    expect(splatActive).not.toContain('rm1');
    const marchActive = code({ nodes: [pos(), sd(), flag(rm), splat()], edges });
    expect(marchActive).toContain('const rm1 = Fn(');
    expect(marchActive).not.toContain('splat');
  });
});

/**
 * `graphToCode → codeToGraph → graphToCode`, with the ONE thing the resync adds
 * that the code cannot carry: the active flag, copied from the old node onto
 * its partner (useSyncEngine's `mergeMatch`). Without it a flagged sink with
 * nothing wired would stop driving after an Apply — in the model, not the app.
 */
const isFlagged = (g: Graph): boolean =>
  g.nodes.some((n) => n.data.registryType === 'splatOutput' && (n.data as { activeOutput?: unknown }).activeOutput === true);

/** Parse `text` and re-emit it, carrying the flag onto the parsed Splat Output when the source graph had one. */
function reparse(text: string, flagged: boolean): { parsed: ReturnType<typeof codeToGraph>; second: string } {
  const parsed = codeToGraph(text);
  const nodes = parsed.nodes.map((n) => (flagged && n.data.registryType === 'splatOutput' ? flag(n) : n));
  return { parsed, second: graphToCode(nodes, parsed.edges).code };
}

function roundTrip(g: Graph): { first: string; parsed: ReturnType<typeof codeToGraph>; second: string } {
  const first = code(g);
  return { first, ...reparse(first, isFlagged(g)) };
}

describe('Splat Output — round trips (graph → code → graph → code)', () => {
  for (const [name, g] of Object.entries(cases())) {
    it(`is byte-identical with errors [] — ${name}`, () => {
      const { first, parsed: r, second } = roundTrip(g);
      expect(r.errors).toEqual([]);
      expect(r.nodes.filter((n) => n.data.registryType === 'splatOutput')).toHaveLength(1);
      // The splat return is the node itself — no plain Output is minted.
      expect(r.nodes.some((n) => n.data.registryType === 'output')).toBe(false);
      expect(second).toBe(first);
    });
  }

  /**
   * A FRESH parse — no resync, so no old node to carry the flag from: pasted
   * text, Load Script, a hand-written `.js` with no project embed. A program
   * with no primary socket wired can only have come from a FLAGGED sink (an
   * unflagged one would not drive), so the parse flags it — otherwise the
   * next graph → code pass replaces it with the red "nothing wired" sentinel.
   */
  it('a fresh parse of a program with no primary socket wired comes back ACTIVE, and re-emits itself', () => {
    for (const name of [
      'identity (flagged, nothing wired)', 'stored colour', 'stored opacity', 'stored colour + opacity',
      'stored size + feather', 'stored size only', 'feather only, wired to a constant (flagged)', 'feather only, by a field (flagged)',
    ]) {
      const first = code(cases()[name]);
      const parsed = codeToGraph(first);
      expect(parsed.errors, name).toEqual([]);
      const sp = parsed.nodes.filter((n) => n.data.registryType === 'splatOutput');
      expect(sp, name).toHaveLength(1);
      expect((sp[0].data as { activeOutput?: unknown }).activeOutput, name).toBe(true);
      expect(graphToCode(parsed.nodes, parsed.edges).code, name).toBe(first);
    }
  });

  it('…while a program with a primary socket wired stays UNFLAGGED — the parse never stamps a choice nobody made', () => {
    for (const [name, g] of Object.entries(cases())) {
      if (isFlagged(g)) continue;
      const parsed = codeToGraph(code(g));
      const sp = parsed.nodes.find((n) => n.data.registryType === 'splatOutput')!;
      expect('activeOutput' in (sp.data as object), name).toBe(false);
    }
  });

  it('the stored values come back as values, Invert as the literal true', () => {
    const everything = codeToGraph(code(cases()['everything at once']));
    const sp = everything.nodes.find((n) => n.data.registryType === 'splatOutput')!;
    expect((sp.data as { values: Record<string, unknown> }).values).toMatchObject({ feather: 0.2, invert: true });
    const stored = codeToGraph(code(cases()['stored colour + opacity']));
    const sp2 = stored.nodes.find((n) => n.data.registryType === 'splatOutput')!;
    expect((sp2.data as { values: Record<string, unknown> }).values).toMatchObject({ color: '#102030', opacity: 0.5 });
    // …and the roots come back as ONE node each, not a second copy per Fn.
    expect(everything.nodes.filter((n) => n.data.registryType === 'positionWorld')).toHaveLength(1);
    expect(everything.nodes.filter((n) => n.data.registryType === 'positionLocal')).toHaveLength(1);
  });

  it('a ROTATED uv (which the parse expands into its math) still reads the splat centre after an Apply', () => {
    // The UV node's rotation form does not come back as one UV node — a
    // pre-existing limit of the parse — so the name `uv1` is bound to the
    // expanded chain, not to a `uv` node. The Fn's `const uv1 = vec2(0.5);`
    // must still be read as the ROOT binding, never as a fresh vec2 node that
    // every consumer would then silently read (it would parse as (0.5, 0)).
    const g: Graph = {
      nodes: [makeNode('uv', 'uv', { channel: 0, tilingU: 1, tilingV: 1, rotation: 0.5 }), makeNode('nz', 'perlin'), splat()],
      edges: [makeEdge('uv', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'opacity')],
    };
    const once = roundTrip(g);
    expect(once.parsed.errors).toEqual([]);
    expect(once.second).toContain('    const uv1 = vec2(0.5);');
    expect(once.second).not.toMatch(/const vec2\d+ = vec2\(0\.5, 0\);/);
    // …and from there an Apply is a fixed point.
    expect(reparse(once.second, false).second).toBe(once.second);
  });

  it('a hand-edited return says what it dropped, as warnings — never a blocking error', () => {
    const c1 = code(cutBySphere()).replace(
      'return { splat: { shape: sp1Shape } };',
      'return { splat: { shape: sp1Shape, evil: 1, invert: 1 }, color: color1 };',
    );
    const r = codeToGraph(c1);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.every((e) => e.severity === 'warning')).toBe(true);
    const sp = r.nodes.find((n) => n.data.registryType === 'splatOutput')!;
    expect((sp.data as { values: Record<string, unknown> }).values.invert).toBeUndefined();
    expect(r.nodes.some((n) => n.data.registryType === 'output')).toBe(false);
  });
});

describe('Splat Output — the module the loader receives', () => {
  const everything = () => code(cases()['everything at once']);

  it('passes `splat` through with no __pixel and no Discard, and parses as a module', () => {
    const m = tslToShaderModule(everything());
    expect(m).toContain('  return { splat: { shade: sp1Shade, shape: sp1Shape, size: float1, feather: 0.2, invert: true } };');
    expect(m).not.toContain('__pixel');
    expect(m).not.toContain('Discard');
    expect(m).not.toContain('colorNode');
    expect(() => parse(m, { sourceType: 'module' })).not.toThrow();
    expect(tslToShaderModule(code(cases()['identity (flagged, nothing wired)']))).toContain('  return { splat: {} };');
  });

  it('re-emits `splat` on a whitelist: hostile keys, calls and non-literal flags are stripped', () => {
    const hostile = everything().replace(
      'return { splat: { shade: sp1Shade, shape: sp1Shape, size: float1, feather: 0.2, invert: true } };',
      'return { splat: { invert: 1, evil: alert(1), shade: sp1Shade, size: foo(), feather: 1e999, "shape": sp1Shape, __proto__: x } };',
    );
    const m = buildShaderModule(hostile);
    expect(m).toContain('  return { splat: { shade: sp1Shade, shape: sp1Shape } };');
    expect(m).not.toContain('alert');
    expect(m).not.toContain('foo()');
    expect(m).not.toContain('1e999');
    // Not an object literal at all: the key is dropped whole.
    expect(buildShaderModule(everything().replace(/return \{ splat: \{.*\} \};/, 'return { splat: window.spec };'))).not.toContain('splat:');
    // A string `true` is not `true`.
    expect(buildShaderModule(everything().replace('invert: true', "invert: 'true'"))).not.toContain('invert');
  });

  it('scriptToTSL echoes the key, and the round trip back to the graph is byte-identical', () => {
    for (const name of [
      'everything at once', 'size by a field (its own Fn)', 'identity (flagged, nothing wired)', 'cut, feathered and inverted', 'stored colour + opacity',
      'noise on Cut, position unwired (read at the splat centre)', 'a noise shared between a Fn and the flat body',
      'one noise in two Fns (Opacity and Cut)', 'cut by distance from the camera (View Position)',
      'feather by a field (its own Fn)', 'feather only, by a field (flagged)', 'noise → remap → Cut, remap also dangling',
    ]) {
      const c1 = code(cases()[name]);
      const back = scriptToTSL(tslToShaderModule(c1));
      expect(back, name).toContain(c1.split('\n').find((l) => l.includes('return { splat:'))!);
      // The scope Fns come back too — they are graph content, not wrapper
      // artifacts for the nested-Fn skip to drop.
      for (const fn of ['sp1Shade', 'sp1Shape', 'sp1Size', 'sp1Feather']) {
        expect(back.includes(`const ${fn} = Fn(`), `${name}: ${fn}`).toBe(c1.includes(`const ${fn} = Fn(`));
      }
      const { parsed: r, second } = reparse(back, isFlagged(cases()[name]));
      expect(r.errors, name).toEqual([]);
      expect(second, name).toBe(c1);
    }
  });

  it('the Fn parameter names are not three/tsl exports, so no loader can auto-import one over them', () => {
    for (const name of [...SPLAT_FN_PARAMS, 'splat', 'shade', 'shape', 'size', 'feather', 'invert']) {
      expect(name in THREE.TSL, name).toBe(false);
    }
  });

  describe.skipIf(!loaderAvailable('0.8'))('loader 0.8 prepareSource', () => {
    it('leaves a splat module untouched apart from the import line', () => {
      const api = evalLoader('0.8', { THREE }).FastShaders as FastShadersApi;
      for (const [name, g] of Object.entries(cases())) {
        // The editor TSL itself: nothing to inject, nothing to un-shadow.
        const editor = code(g);
        expect(api.transforms.autoInjectTSLImports(editor), name).toBe(editor);
        expect(api.transforms.fixTSLShadowing(editor), name).toBe(editor);
        const m = tslToShaderModule(editor);
        // Nothing to inject, nothing to un-shadow…
        expect(api.transforms.autoInjectTSLImports(m), name).toBe(m);
        expect(api.transforms.fixTSLShadowing(m), name).toBe(m);
        // …so the whole of prepareSource is the import rewrite.
        const prepared: string = api.prepareSource(m, 'https://example.test/shader.js');
        const before = m.split('\n');
        const after = prepared.split('\n');
        expect(after.length, name).toBe(before.length);
        const changed = before.flatMap((l, i) => (l === after[i] ? [] : [l]));
        // One line at most — the identity module imports nothing at all.
        expect(changed.length, name).toBeLessThanOrEqual(1);
        for (const l of changed) expect(l, name).toMatch(/^import \{[^}]*\} from 'three\/tsl';$/);
      }
    });
  });
});

/**
 * IMPLICIT READS. An input left unwired normally emits a number, the same in
 * every stage. A few emit a GEOMETRY read instead — a noise's position
 * (`positionGeometry`), `uv()` for the image, the value-ramps and the samplers
 * (utils/sdfPartition.ts implicitRootOf lists them all). The splat Fns run in
 * the splat renderer's VERTEX stage, where the geometry is the instanced quad:
 * `positionGeometry` is its corner (±2 — the same for every splat, different
 * per corner) and `uv()` does not exist. So inside a splat Fn such a default
 * is bound exactly like a wired root — `p` for a position, `vec2(0.5)` for a
 * uv — while a flat-body copy of the same node keeps today's text. The GLSL
 * proof that the built vertex shader then reads the noise at the splat centre
 * is in src/splatRouteW.test.ts.
 */
describe('Splat Output — an unwired input never reads the quad (implicit reads)', () => {
  /** The body of scope Fn `name` (`sp1Shape`), or '' when it is not emitted. */
  const fnBody = (c: string, name: string): string => {
    const start = c.indexOf(`  const ${name} = Fn(([p, pw, n, c]) => {\n`);
    if (start < 0) return '';
    return c.slice(start, c.indexOf('\n  });\n', start));
  };
  /** The shader body with every scope Fn cut out — what runs outside them. */
  const flatBody = (c: string): string => {
    let body = c.slice(c.indexOf('const shader = Fn(() => {'));
    for (const name of ['sp1Shade', 'sp1Shape', 'sp1Size', 'sp1Feather']) {
      const f = fnBody(body, name);
      if (f) body = body.replace(f, '');
    }
    return body;
  };
  const cut = (n: AppNode, handle = 'out'): Graph => ({ nodes: [n, splat()], edges: [makeEdge(n.id, handle, 'sp', 'cut')] });
  const PNG = canonicalSrc('image/png', makeRealPng(2, 2, [200, 10, 10, 255]));
  const image = (id = 'img', extra: Record<string, string | number> = {}) =>
    makeNode(id, 'imageNode', { imageB64: PNG, width: 2, height: 2, fileName: `${id}.png`, ...extra });
  /** A geometry read spelled anywhere in emitted TSL. */
  const GEOMETRY_READ = /\b(positionGeometry|positionLocal|positionWorld|positionView|normalLocal|normalWorld|screenUV|tangentLocal)\b|\buv\(/;

  it('a noise on Cut with its position unwired is emitted INSIDE the shape Fn, at the splat centre `p`', () => {
    const c = code(cases()['noise on Cut, position unwired (read at the splat centre)']);
    expect(c).toContain('  const sp1Shape = Fn(([p, pw, n, c]) => {\n    const noise1 = mx_noise_float(p);\n    return vec4(0, 0, 0, noise1);\n  });');
    // Nothing reads the quad corner, and nothing imports it.
    expect(c).not.toContain('positionGeometry');
    expect(c).toMatch(/^import \{ Fn, mx_noise_float, vec4 \} from 'three\/tsl';$/m);
  });

  it('the scale and the 0–1 remap ride the bound position exactly as they ride the flat one', () => {
    expect(fnBody(code(cases()['noise scaled, position unwired']), 'sp1Shape')).toContain('    const noise1 = mx_noise_float(p.mul(3));');
    expect(fnBody(code(cases()['unsigned noise on Opacity, position unwired']), 'sp1Shade'))
      .toContain('    const noise1 = mx_noise_float(p).mul(0.5).add(0.5);');
  });

  it('a stored identifier binds to ITS parameter: world centre `pw`, facing `n`, a screen uv the per-splat constant', () => {
    const at = (posId: string) => fnBody(code(cut(makeNode('nz', 'perlin', { pos: posId, scale: 1 }))), 'sp1Shape');
    expect(at('positionWorld')).toContain('mx_noise_float(pw)');
    expect(at('positionLocal')).toContain('mx_noise_float(p)');
    expect(at('normalWorld')).toContain('mx_noise_float(n)');
    expect(at('screenUV')).toContain('mx_noise_float(vec2(0.5))');
    // A uniform is the same at every corner: captured from the flat body, not scoped.
    const cam = code(cut(makeNode('nz', 'perlin', { pos: 'cameraPosition', scale: 1 })));
    expect(flatBody(cam)).toContain('  const noise1 = mx_noise_float(cameraPosition);');
    expect(fnBody(cam, 'sp1Shape')).not.toContain('mx_noise_float');
  });

  it('position-derived ROOTS read the centre too: view position and direction, world direction, the ray', () => {
    const view = code(cases()['cut by distance from the camera (View Position)']);
    expect(fnBody(view, 'sp1Shape')).toContain('    const positionView1 = modelViewMatrix.mul(vec4(p, 1)).xyz;');
    expect(flatBody(view)).toContain('  const positionView1 = positionView;'); // the flat body keeps the real root
    const shade = fnBody(code(cases()['colour by the view direction and the ray']), 'sp1Shade');
    expect(shade).toContain('    const positionViewDirection1 = modelViewMatrix.mul(vec4(p, 1)).xyz.negate().normalize();');
    expect(shade).toContain('    const rayDirection1 = n.negate();');
    expect(fnBody(code(cases()['move along the world direction']), 'sp1Shape'))
      .toContain('    const positionWorldDirection1 = p.transformDirection(modelWorldMatrix);');
  });

  it('a WIRED position is the wire, never the binding — a constant stays captured', () => {
    const c = code({
      nodes: [makeNode('f', 'float', { value: 2 }), makeNode('nz', 'perlin'), splat()],
      edges: [makeEdge('f', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'cut')],
    });
    expect(flatBody(c)).toContain('  const noise1 = mx_noise_float(float1);');
    expect(fnBody(c, 'sp1Shape')).toBe('  const sp1Shape = Fn(([p, pw, n, c]) => {\n    return vec4(0, 0, 0, noise1);');
  });

  it('a node ALSO read outside every Fn keeps today\'s text in the flat body; its Fn copy is bound', () => {
    for (const name of ['a noise shared between a Fn and the flat body', 'noise → remap → Cut, remap also dangling']) {
      const c = code(cases()[name]);
      expect(flatBody(c), name).toContain('  const noise1 = mx_noise_float(positionGeometry);');
      expect(fnBody(c, 'sp1Shape'), name).toContain('    const noise1 = mx_noise_float(p);');
      expect(c, name).toMatch(/^import \{[^}]*\bpositionGeometry\b[^}]*\} from 'three\/tsl';$/m);
    }
  });

  it('a noise on Cut AND Feather is bound to the centre in BOTH Fns, and never read at the corner', () => {
    const c = code(cases()['a noise on Cut and Feather (read in both Fns)']);
    expect(fnBody(c, 'sp1Shape')).toContain('    const noise1 = mx_noise_float(p);');
    expect(fnBody(c, 'sp1Feather')).toContain('    const noise1 = mx_noise_float(p);');
    expect(flatBody(c)).not.toContain('noise1 =');
    expect(c).not.toContain('positionGeometry');
    expect(c).toContain('  return { splat: { shape: sp1Shape, feather: sp1Feather } };');
  });

  it('the MARCH is untouched: an unwired-position noise on a Field is captured flat, as before', () => {
    const c = code({ nodes: [makeNode('nz', 'perlin'), makeNode('rm', 'raymarchOutput')], edges: [makeEdge('nz', 'out', 'rm', 'field')] });
    expect(c).toContain('  const noise1 = mx_noise_float(positionGeometry);');
    expect(c).not.toContain('mx_noise_float(p)');
  });

  it('an Image with UV unwired samples at the splat\'s own point; a wired Direction still replaces the uv path', () => {
    const c = code({ nodes: [image(), splat()], edges: [makeEdge('img', 'out', 'sp', 'color')] });
    const shade = fnBody(c, 'sp1Shade');
    expect(shade).toMatch(/const image1 = texture\(_image1_tex, vec2\(0\.5\)[^;]*\)\.rgb;/);
    expect(c).not.toContain('uv(');
    expect(c).not.toMatch(/^import \{[^}]*\buv\b[^}]*\} from 'three\/tsl';$/m);
    // The module-scope decode is emitted once, outside every Fn.
    expect(c.match(/const _image1_img = /g)).toHaveLength(1);
    const sky = code({
      nodes: [makeNode('nw', 'normalWorld'), image(), splat()],
      edges: [makeEdge('nw', 'out', 'img', 'dir'), makeEdge('img', 'out', 'sp', 'color')],
    });
    expect(fnBody(sky, 'sp1Shade')).toContain('texture(_image1_tex, equirectUV(normalWorld1)).rgb');
    // A flat copy (the image also feeds a dangling node) keeps its uv().
    const shared = code({
      nodes: [image(), makeNode('ab', 'abs'), splat()],
      edges: [makeEdge('img', 'out', 'sp', 'color'), makeEdge('img', 'out', 'ab', 'x')],
    });
    expect(flatBody(shared)).toMatch(/const image1 = texture\(_image1_tex, uv\(\)/);
    expect(fnBody(shared, 'sp1Shade')).toMatch(/const image1 = texture\(_image1_tex, vec2\(0\.5\)/);
  });

  it('the value-ramps and samplers read `vec2(0.5)` in place of uv() inside a Fn', () => {
    for (const type of ['colormap', 'dataRange', 'isolines', 'stripes', 'dataviz', 'wireframe']) {
      const c = code(cut(makeNode('x', type)));
      expect(c, type).not.toContain('uv(');
      expect(c, type).toContain('vec2(0.5)');
      expect(flatBody(c).replace(/const shader = Fn\(\(\) => \{\n/, ''), type).not.toMatch(/^ {2}const (?!sp1)/m);
    }
  });

  it('a Data column feeding a Data Viz on Color samples its row at the splat, and bakes its texture ONCE', () => {
    const data = makeNode('d', 'dataNode', makeDataNodeData(
      { columnNames: ['x', 'y'], columns: [[0, 1, 2, 3], [0.1, 0.5, 0.2, 0.9]], rowCount: 4 }, 2,
    ).values as Record<string, string | number>);
    const viz = makeNode('v', 'dataviz', { lowColor: '#000000', highColor: '#ffffff' });
    const ab = makeNode('ab', 'abs');
    const c = code({
      nodes: [data, viz, ab, splat()],
      // The column also feeds a dangling node, so the Data node is emitted flat
      // AND inside the Fn — its DataTexture must still be declared once.
      edges: [makeEdge('d', 'col1', 'v', 'signal'), makeEdge('v', 'out', 'sp', 'color'), makeEdge('d', 'col1', 'ab', 'x')],
    });
    const shade = fnBody(c, 'sp1Shade');
    expect(shade).toMatch(/texture\(_\w+_tex1, vec2\(vec2\(0\.5\)\.x, 0\.5\)\)\.x/);
    expect(shade).toContain('vec2(0.5).x');
    expect(shade).not.toContain('uv(');
    expect(flatBody(c)).toMatch(/texture\(_\w+_tex1, vec2\(uv\(\)\.x, 0\.5\)\)\.x/);
    expect(c.match(/^const _\w+_tex1 = new globalThis\.THREE\.DataTexture\(/gm)).toHaveLength(1);
    expect(c.match(/^const _\w+_value = new globalThis\.THREE\.DataTexture\(/gm)).toHaveLength(1);
    expect(() => parse(tslToShaderModule(c), { sourceType: 'module' })).not.toThrow();
  });

  it('a baked lookup emitted into TWO Fns declares its texture once, and the module parses', () => {
    const c = code({
      nodes: [makeNode('cm', 'colormap'), splat()],
      edges: [makeEdge('cm', 'out', 'sp', 'color'), makeEdge('cm', 'out', 'sp', 'cut')],
    });
    expect(fnBody(c, 'sp1Shade')).toContain('const colormap1 = texture(_colormap1_lut,');
    expect(fnBody(c, 'sp1Shape')).toContain('const colormap1 = texture(_colormap1_lut,');
    expect(c.match(/^const _colormap1_lut = /gm)).toHaveLength(1);
    expect(() => parse(tslToShaderModule(c), { sourceType: 'module' })).not.toThrow();
  });

  /**
   * The drift guard, both halves. Every node that TAKES inputs (the roots and
   * constants are other classes), alone and unwired, wired into Cut: nothing
   * in the emitted module may read the geometry. And wired into a plain
   * Output, its flat text reads the geometry ONLY IF implicitRootOf says so —
   * so a node whose unwired default starts reading an attribute fails here
   * until the classifier lists it.
   */
  it('SWEEP: no node with an unwired input emits a geometry read anywhere in a splat program', () => {
    const roots = scopeRootTypes(SPLAT_SCOPES[0]);
    let swept = 0;
    for (const def of NODE_REGISTRY.values()) {
      if (def.category === 'output' || def.type === 'unknown' || def.type === 'split' || roots.has(def.type)) continue;
      if (def.inputs.length === 0 && def.category !== 'noise') continue;
      const n = def.type === 'imageNode' ? image('x') : makeNode('x', def.type);
      const splatCode = code(cut(n));
      expect(GEOMETRY_READ.test(splatCode), `${def.type} in a splat Fn`).toBe(false);
      const flat = code({ nodes: [n, makeNode('out', 'output')], edges: [makeEdge('x', 'out', 'out', 'color')] });
      if (GEOMETRY_READ.test(flat)) expect(implicitRootOf(n, () => false), `${def.type} reads geometry flat`).not.toBeNull();
      swept++;
    }
    expect(swept).toBeGreaterThan(60);
  });

  describe('the parse back', () => {
    const noiseValues = (c: string) =>
      codeToGraph(c).nodes.filter((n) => n.data.registryType === 'perlin').map((n) => (n.data as { values: Record<string, unknown> }).values);

    it('`mx_noise_float(p)` inside a Fn is an UNWIRED position — stored as the default, never as `p`', () => {
      const vals = noiseValues(code(cases()['noise on Cut, position unwired (read at the splat centre)']));
      expect(vals).toEqual([{ pos: 'positionGeometry', scale: 1 }]);
      // A position the parse cannot bind stays what it always was.
      const flatP = noiseValues("import { Fn, mx_noise_float } from 'three/tsl';\n\nconst shader = Fn(() => {\n  const noise1 = mx_noise_float(p);\n  return noise1;\n});\n\nexport default shader;\n");
      expect(flatP).toEqual([{ pos: 'p', scale: 1 }]);
    });

    it('a stored world-centre / screen-uv position comes back as that identifier', () => {
      const world = code(cut(makeNode('nz', 'perlin', { pos: 'positionWorld', scale: 1 })));
      expect(noiseValues(world)).toEqual([{ pos: 'positionWorld', scale: 1 }]);
      const screen = code(cut(makeNode('nz', 'perlin', { pos: 'screenUV', scale: 1 })));
      expect(noiseValues(screen)).toEqual([{ pos: 'screenUV', scale: 1 }]);
      expect(reparse(screen, false).second).toBe(screen);
    });

    it('a node emitted flat AND in a Fn (or in two Fns) comes back as ONE node', () => {
      for (const name of [
        'a noise shared between a Fn and the flat body',
        'a noise on Cut and Feather (read in both Fns)',
        'one noise in two Fns (Opacity and Cut)',
        'noise → remap → Cut, remap also dangling',
      ]) {
        expect(noiseValues(code(cases()[name])), name).toHaveLength(1);
      }
      // …the same for an ordinary scoped feeder read in two Fns (Cut and Feather).
      const nodes = [pos(), sd(), splat()];
      const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('sd', 'out', 'sp', 'feather')];
      const { first, parsed, second } = roundTrip({ nodes, edges });
      expect(parsed.nodes.filter((n) => n.data.registryType === 'sdCircle')).toHaveLength(1);
      expect(second).toBe(first);
    });

    it('a hand-written SHADOW with a different expression is its own node, as before', () => {
      const c = code(cases()['a noise shared between a Fn and the flat body']).replace(
        '    const noise1 = mx_noise_float(p);',
        '    const noise1 = mx_noise_float(p.mul(2));',
      );
      const vals = noiseValues(c);
      expect(vals).toHaveLength(2);
      expect(vals[1]).toEqual({ pos: 'positionGeometry', scale: 2 });
    });

    it('a hand-written inline noise in a Fn\'s return reads its position the same way', () => {
      const c = code(cases()['noise on Cut, position unwired (read at the splat centre)']).replace(
        '    const noise1 = mx_noise_float(p);\n    return vec4(0, 0, 0, noise1);',
        '    return vec4(0, 0, 0, mx_noise_float(p));',
      );
      const r = codeToGraph(c);
      expect(r.errors).toEqual([]);
      expect(noiseValues(c)).toEqual([{ pos: 'positionGeometry', scale: 1 }]);
      const nz = r.nodes.find((n) => n.data.registryType === 'perlin')!;
      expect(r.edges.some((e) => e.source === nz.id && e.targetHandle === 'cut')).toBe(true);
    });

    it('the parse never leaves a `p` behind: re-emitting the parsed graph with the splat PARKED is a loadable flat module', () => {
      const parsed = codeToGraph(code(cases()['one noise in two Fns (Opacity and Cut)']));
      // A flagged plain Output silences the splat: every node lands flat.
      const out = { ...makeNode('out', 'output'), data: { ...makeNode('out', 'output').data, activeOutput: true } } as AppNode;
      const flat = graphToCode([...parsed.nodes, out], parsed.edges).code;
      expect(flat).toContain('mx_noise_float(positionGeometry)');
      expect(flat).not.toMatch(/mx_noise_float\(p\b/);
    });
  });
});

/**
 * EXECUTION, not text. Two failures no string assertion above can see:
 *  - the FLAT body runs when the loader calls the module's default export, so
 *    a flat line naming a variable declared only inside a scope Fn is a
 *    ReferenceError that fails the whole shader (and parses back with its
 *    edge silently dropped, errors []);
 *  - the Fn BODIES run only when the splat's vertex stage is BUILT, inside
 *    loader 0.8's wrapper — which is also where a value the wrapper reads per
 *    VERTEX (Feather) shows whether it was taken at the splat centre or at the
 *    quad corner.
 * So each module is evaluated against the real three/tsl, its `splat` handed
 * to the loader's own `wrapSplats` on a real GaussianSplat from the shipped
 * runtime, and the vertex stage built to GLSL the way a WebGL frame builds it
 * (splatRouteW.test.ts's page, trimmed to what this needs).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const SPLAT_RUNTIME = path.join(REPO, 'public/js/fs-splat-0.1.js');
const canExecute = loaderAvailable('0.8') && existsSync(SPLAT_RUNTIME);

/** The module's default export, CALLED — the one `three/tsl` import becomes a
 *  destructure of the real namespace (materialPartsModule.test.ts's recipe). */
function runModule(text: string): Record<string, Any> {
  expect(text).not.toMatch(/from 'three\/webgpu'/);
  const body = text
    .replace(/^import \{([^}]*)\} from 'three\/tsl';$/m, 'const {$1} = TSL;')
    .replace(/^export const /gm, 'const ')
    .replace(/^export default function/m, 'return function');
  return (new Function('TSL', body)(THREE.TSL) as () => Record<string, Any>)();
}

/** Wrap one small GaussianSplat with `spec` (loader 0.8 + the splat runtime in
 *  one vm page) and build its vertex stage to GLSL; the loader's warnings too. */
function buildOnSplat(spec: unknown): { vs: string; warns: string[] } {
  const warns: string[] = [];
  const sandbox: Record<string, unknown> = {
    THREE, window: { THREE }, URL, Blob, DecompressionStream, TextDecoder,
    ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
    console: { log() {}, error() {}, warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')) },
    location: { href: 'https://example.test/index.html' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SPLAT_RUNTIME, 'utf8'), sandbox, { filename: SPLAT_RUNTIME });
  vm.runInContext(loaderText('0.8'), sandbox, { filename: loaderPath('0.8') });
  const F = sandbox.FastShadersSplat as Any;
  const n = 8;
  const centers = new Float32Array(n * 3).map((_, i) => ((i * 7) % 11) * 0.1 - 0.5);
  const cov = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) { cov[i * 6] = 0.01; cov[i * 6 + 3] = 0.01; cov[i * 6 + 5] = 0.01; }
  const s = new F.GaussianSplat(F.createGaussianSplatGeometry(centers, cov, new Uint8ClampedArray(n * 4).fill(200)), { autoSort: false });
  expect((sandbox.FastShaders as Any).internals.wrapSplats({}, s, spec)).toBe(1);
  for (const k of ['centerRead', 'covarianceARead', 'covarianceBRead', 'colorRead']) s._buffers[k].setPBO(true);
  s._sort.orderRead.setPBO(true);
  const renderer = {
    contextNode: THREE.TSL.context(),
    library: { fromMaterial: (m: unknown) => m },
    backend: {
      isWebGLBackend: true, isWebGPUBackend: false,
      capabilities: { getUniformBufferLimit: () => 65536 },
      extensions: { has: () => false }, has: () => false, get: () => ({}),
    },
    getRenderTarget: () => null, getMRT: () => null,
    debug: { diagnostics: { keywords: false } },
    lighting: { enabled: false },
    _currentRenderContext: null,
  };
  const builder = new (THREE as Any).GLSLNodeBuilder(s, renderer);
  Object.assign(builder, {
    scene: new THREE.Scene(), material: s.material, camera: new THREE.PerspectiveCamera(),
    lightsNode: null, environmentNode: null, fogNode: null, clippingContext: null,
  });
  builder.build();
  return { vs: builder.vertexShader as string, warns };
}

describe.skipIf(!canExecute)('Splat Output — the emitted module RUNS (the flat body, then the Fn bodies built)', () => {
  it('every case: the default export runs, the loader wraps the splat without a warning, the vertex stage builds', () => {
    for (const [name, g] of Object.entries(cases())) {
      const spec = runModule(tslToShaderModule(code(g))).splat;
      expect(spec, name).toBeTypeOf('object');
      expect(buildOnSplat(spec).warns, name).toEqual([]);
    }
  });

  it('a flat copy with an in-scope ancestor runs: noise → remap → Cut + remap → dangling / Feather / a plain Output; a root chain at depth 2', () => {
    const plainOutput: Graph = {
      nodes: [makeNode('nz', 'perlin'), makeNode('r', 'remap'), makeNode('out', 'output'), splat()],
      edges: [makeEdge('nz', 'out', 'r', 'x'), makeEdge('r', 'out', 'sp', 'cut'), makeEdge('r', 'out', 'out', 'color')],
    };
    const graphs: [string, Graph][] = [
      ...['noise → remap → Cut, remap also dangling', 'noise → remap → Cut + Feather', 'Local Position → Length → Mul → Cut, Mul also dangling']
        .map((name): [string, Graph] => [name, cases()[name]]),
      ['noise → remap → Cut + remap → a (silenced) plain Output', plainOutput],
    ];
    for (const [name, g] of graphs) {
      const c = code(g);
      let result: Record<string, Any> = {};
      expect(() => { result = runModule(tslToShaderModule(c)); }, `${name}\n${c}`).not.toThrow();
      expect(buildOnSplat(result.splat).warns, name).toEqual([]);
    }
  });

  it('the march\'s depth-2 flat copy runs too (the same hole, older)', () => {
    const c = code({
      nodes: [pos(), makeNode('len', 'length'), makeNode('m', 'mul'), makeNode('s', 'sin'), makeNode('rm', 'raymarchOutput')],
      edges: [
        makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'm', 'a'),
        makeEdge('m', 'out', 'rm', 'field'), makeEdge('m', 'out', 's', 'x'),
      ],
    });
    expect(c).toMatch(/^ {2}const length1 = length\(positionLocal1\);$/m);
    expect(() => runModule(tslToShaderModule(c)), c).not.toThrow();
  });

  it('a splat-dependent Feather is taken at the splat CENTRE in the built shader, never at the quad corner', () => {
    const { vs } = buildOnSplat(runModule(tslToShaderModule(code(cases()['a cell-noise feather, position unwired (read at the splat centre)']))).splat);
    // The loader's cut test and fade read Feather per vertex; the cell noise
    // in them must be sampled at the wrapper's per-splat centre `fsP`, never
    // at the quad's `position` attribute (a different cell per corner tears
    // the quad).
    const cutTest = vs.split('\n').filter((l) => /\bfsKeep = |if \( \( fsShape\.w > /.test(l));
    expect(cutTest).toHaveLength(2);
    for (const l of cutTest) expect(l).not.toMatch(/\bposition\b/);
    expect(vs).toMatch(/mx_cell_noise_float\w*\( fsP \)/);
  });
});
