import { describe, it, expect } from 'vitest';
import { marchPartition } from './sdfPartition';
import { makeNode, makeEdge } from '@/test-utils';

const part = (nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[], id: string) => {
  const p = marchPartition(nodes, edges, id);
  return { field: p.scopes.get('field')!, color: p.scopes.get('color')!, mainAlso: p.mainAlso };
};

describe('marchPartition', () => {
  const nodes = [
    makeNode('pos', 'positionLocal'),
    makeNode('r', 'property_float'),
    makeNode('sd', 'sdCircle'),
    makeNode('col', 'color'),
    makeNode('sdf', 'raymarchOutput'),
  ];
  const edges = [
    makeEdge('pos', 'out', 'sd', 'p'),
    makeEdge('r', 'out', 'sd', 'r'),
    makeEdge('sd', 'out', 'sdf', 'field'),
    makeEdge('col', 'out', 'sdf', 'color'),
  ];

  it('field = the position-dependent ancestors of the field socket, roots included', () => {
    const p = part(nodes, edges, 'sdf');
    expect([...p.field].sort()).toEqual(['pos', 'sd']);
  });

  it('a uniform feeding the field is NOT in the set (captured by closure instead)', () => {
    expect(part(nodes, edges, 'sdf').field.has('r')).toBe(false);
  });

  it('a constant colour is not position-dependent, so the colour set is empty', () => {
    expect(part(nodes, edges, 'sdf').color.size).toBe(0);
  });

  it('roots are always emitted in the flat body too', () => {
    expect(part(nodes, edges, 'sdf').mainAlso.has('pos')).toBe(true);
  });

  it('a set member with a consumer outside the sets is emitted in the flat body too', () => {
    const n2 = [...nodes, makeNode('dangle', 'abs')];
    const e2 = [...edges, makeEdge('sd', 'out', 'dangle', 'x')];
    const p = part(n2, e2, 'sdf');
    expect(p.field.has('sd')).toBe(true);
    expect(p.mainAlso.has('sd')).toBe(true);
    expect(p.field.has('dangle')).toBe(false);
  });

  it('a position-dependent colour chain lands in the colour set', () => {
    const n2 = [...nodes, makeNode('len', 'length')];
    const e2 = [
      makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sdf', 'field'),
      makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'sdf', 'color'),
    ];
    const p = part(n2, e2, 'sdf');
    expect([...p.color].sort()).toEqual(['len', 'pos']);
    expect(p.field.has('len')).toBe(false);
  });
});

describe('drivingMarchOutput', () => {
  it('a Raymarch Output drives only when Field or Density is wired', async () => {
    const { drivingMarchOutput } = await import('./sdfPartition');
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('sdf', 'raymarchOutput'), makeNode('out', 'output')];
    const unwired = [makeEdge('pos', 'out', 'sd', 'p')];
    // `drivingMarchOutput` is the ONE predicate every surface asks (CLAUDE.md);
    // the `!== null` wrapper that used to sit beside it had no caller outside
    // this line and is gone.
    expect(drivingMarchOutput(nodes, unwired)).toBeNull();
    const wired = [...unwired, makeEdge('sd', 'out', 'sdf', 'field')];
    expect(drivingMarchOutput(nodes, wired)?.id).toBe('sdf');
  });
});

describe('the ScopeSpec generalisation', () => {
  it('restates every march scope as ONE socket and ONE parameter — the shape its emission was pinned in', async () => {
    const { MARCH_SCOPES, MARCH_ROOT_TYPES, DIR_ROOT_TYPES, paramOfRoot, scopeRootTypes } = await import('./sdfPartition');
    expect(MARCH_SCOPES.map((s) => s.handle)).toEqual(['field', 'density', 'color', 'emissive', 'glow', 'background']);
    for (const s of MARCH_SCOPES) {
      expect(s.sockets, s.handle).toEqual([s.handle]);
      expect(s.params, s.handle).toHaveLength(1);
      expect(s.constants, s.handle).toBeUndefined();
    }
    const field = MARCH_SCOPES[0];
    const background = MARCH_SCOPES[5];
    expect(paramOfRoot(field, 'positionLocal')).toBe('p');
    expect(paramOfRoot(field, 'positionGeometry')).toBe('p');
    expect(paramOfRoot(field, 'rayDirection')).toBeNull();
    expect(paramOfRoot(background, 'rayDirection')).toBe('dir');
    expect(scopeRootTypes(field)).toEqual(new Set(MARCH_ROOT_TYPES));
    expect(scopeRootTypes(background)).toEqual(new Set(DIR_ROOT_TYPES));
  });

  it('the splat has four scopes over the SAME four parameters and one per-corner constant', async () => {
    const { SPLAT_SCOPES, SPLAT_PARAMS, SPLAT_FN_PARAMS, SPLAT_PRIMARY_SOCKETS, bindingOfRoot, paramOfRoot } = await import('./sdfPartition');
    expect(SPLAT_SCOPES.map((s) => [s.handle, s.sockets])).toEqual([
      ['shade', ['color', 'opacity']],
      ['shape', ['move', 'cut']],
      ['size', ['size']],
      // Feather is read per vertex by the loader's cut test, so a
      // splat-dependent one must be a per-SPLAT Fn like Size.
      ['feather', ['feather']],
    ]);
    // …but it refines a cut, it is not one: wiring it alone does not drive.
    expect(SPLAT_PRIMARY_SOCKETS).not.toContain('feather');
    for (const s of SPLAT_SCOPES) expect(s.params).toBe(SPLAT_PARAMS);
    expect(SPLAT_FN_PARAMS).toEqual(['p', 'pw', 'n', 'c']);
    const shade = SPLAT_SCOPES[0];
    const roots: [string, string][] = [
      ['positionLocal', 'p'], ['positionGeometry', 'p'], ['positionWorld', 'pw'],
      ['normalLocal', 'n'], ['normalWorld', 'n'], ['vertexColor', 'c'],
    ];
    for (const [type, param] of roots) expect(paramOfRoot(shade, type), type).toBe(param);
    // A per-corner source is a constant, not a parameter.
    expect(paramOfRoot(shade, 'uv')).toBeNull();
    expect(bindingOfRoot(shade, 'uv')).toEqual({ expr: 'vec2(0.5)', imports: ['vec2'] });
    expect(bindingOfRoot(shade, 'screenUV')?.expr).toBe('vec2(0.5)');
    expect(bindingOfRoot(shade, 'positionWorld')).toEqual({ expr: 'pw', imports: [] });
    expect(bindingOfRoot(shade, 'time')).toBeNull();
  });
});

describe('marchPartition over SPLAT_SCOPES', () => {
  const splatPart = async (nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[]) => {
    const { SPLAT_SCOPES } = await import('./sdfPartition');
    return marchPartition(nodes, edges, 'sp', SPLAT_SCOPES);
  };

  it('shade holds the root-dependent feeders of Color AND Opacity; a constant is captured, not scoped', async () => {
    const nodes = [makeNode('pw', 'positionWorld'), makeNode('len', 'length'), makeNode('col', 'color'), makeNode('sp', 'splatOutput')];
    const edges = [makeEdge('pw', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'opacity'), makeEdge('col', 'out', 'sp', 'color')];
    const p = await splatPart(nodes, edges);
    expect([...p.scopes.get('shade')!].sort()).toEqual(['len', 'pw']);
    expect(p.scopes.get('shape')!.size).toBe(0);
    expect(p.scopes.get('size')!.size).toBe(0);
    expect(p.mainAlso.has('pw')).toBe(true); // a root stays in the flat body too
    expect(p.mainAlso.has('len')).toBe(false);
  });

  it('one feeder of Color and Opacity is ONE member of ONE scope; Move and Cut share the shape scope', async () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('len', 'length'), makeNode('sd', 'sdCircle'), makeNode('sp', 'splatOutput')];
    const edges = [
      makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'color'), makeEdge('len', 'out', 'sp', 'opacity'),
      makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('pos', 'out', 'sp', 'move'),
    ];
    const p = await splatPart(nodes, edges);
    expect([...p.scopes.get('shade')!].sort()).toEqual(['len', 'pos']);
    expect([...p.scopes.get('shape')!].sort()).toEqual(['pos', 'sd']);
    expect(p.mainAlso.has('len')).toBe(false);
    expect(p.mainAlso.has('sd')).toBe(false);
  });

  it('the Vertex Color root (`c`) and a uv constant root both scope their chains', async () => {
    const nodes = [makeNode('vc', 'vertexColor'), makeNode('uv', 'uv'), makeNode('nz', 'perlin'), makeNode('m', 'oneMinus'), makeNode('sp', 'splatOutput')];
    const edges = [makeEdge('vc', 'out', 'm', 'x'), makeEdge('m', 'out', 'sp', 'color'), makeEdge('uv', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'size')];
    const p = await splatPart(nodes, edges);
    expect([...p.scopes.get('shade')!].sort()).toEqual(['m', 'vc']);
    expect([...p.scopes.get('size')!].sort()).toEqual(['nz', 'uv']);
    expect(p.mainAlso.has('uv')).toBe(true);
  });

  it('Feather is a scope of its own: a splat-dependent Feather feeder is read inside it, with no flat copy', async () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('sp', 'splatOutput')];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('sd', 'out', 'sp', 'feather')];
    const p = await splatPart(nodes, edges);
    expect(p.scopes.get('shape')!.has('sd')).toBe(true);
    expect([...p.scopes.get('feather')!].sort()).toEqual(['pos', 'sd']);
    // Read per splat in both Fns, never outside them — so no flat copy.
    expect(p.mainAlso.has('sd')).toBe(false);
    // A Feather that does not depend on the splat is captured, not scoped.
    const k = await splatPart(
      [...nodes, makeNode('f', 'float', { value: 0.1 })],
      [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut'), makeEdge('f', 'out', 'sp', 'feather')],
    );
    expect(k.scopes.get('feather')!.size).toBe(0);
  });
});

/**
 * A FLAT COPY must bring its in-scope ANCESTORS with it. A scope member with a
 * consumer outside every Fn is emitted in the flat body too (`mainAlso`); if
 * one of ITS inputs is a member that is not also flat, the flat line names a
 * variable declared only inside a Fn — a ReferenceError the moment the module
 * runs, which kills the whole shader. Roots are always flat, so the hole is a
 * member at depth ≥ 1 above an implicit-root noise, or ≥ 2 above a real root.
 */
describe('marchPartition — a flat copy is closed over its in-scope ancestors', () => {
  const splatPart = async (nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[]) => {
    const { SPLAT_SCOPES } = await import('./sdfPartition');
    return marchPartition(nodes, edges, 'sp', SPLAT_SCOPES);
  };
  /** Perlin (position unwired) → Remap → Cut, plus Remap → `extra`. */
  const noiseRemap = (extra: ReturnType<typeof makeEdge>, more: ReturnType<typeof makeNode>[] = []) => splatPart(
    [makeNode('nz', 'perlin'), makeNode('r', 'remap'), makeNode('sp', 'splatOutput'), ...more],
    [makeEdge('nz', 'out', 'r', 'x'), makeEdge('r', 'out', 'sp', 'cut'), extra],
  );

  it('noise → remap → Cut, remap also read by a dangling node: the noise is flat too', async () => {
    const p = await noiseRemap(makeEdge('r', 'out', 's', 'x'), [makeNode('s', 'sin')]);
    expect([...p.scopes.get('shape')!].sort()).toEqual(['nz', 'r']);
    expect([...p.mainAlso].sort()).toEqual(['nz', 'r']);
  });

  it('noise → remap → Cut, remap also wired to a (silenced) plain Output: the noise is flat too', async () => {
    const p = await noiseRemap(makeEdge('r', 'out', 'out1', 'color'), [makeNode('out1', 'output')]);
    expect([...p.mainAlso].sort()).toEqual(['nz', 'r']);
  });

  it('noise → remap → Cut + Feather: both Fns read it, nothing is flat', async () => {
    const p = await noiseRemap(makeEdge('r', 'out', 'sp', 'feather'));
    expect([...p.scopes.get('feather')!].sort()).toEqual(['nz', 'r']);
    expect(p.mainAlso.size).toBe(0);
  });

  it('Local Position → Length → Mul → Cut, Mul also dangling: the whole chain is flat, root included', async () => {
    const p = await splatPart(
      [makeNode('pos', 'positionLocal'), makeNode('len', 'length'), makeNode('m', 'mul'), makeNode('s', 'sin'), makeNode('sp', 'splatOutput')],
      [makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'm', 'a'), makeEdge('m', 'out', 'sp', 'cut'), makeEdge('m', 'out', 's', 'x')],
    );
    expect([...p.mainAlso].sort()).toEqual(['len', 'm', 'pos']);
  });

  it('the march\'s depth-2 case closes the same way (it was a ReferenceError too)', () => {
    const p = marchPartition(
      [makeNode('pos', 'positionLocal'), makeNode('len', 'length'), makeNode('m', 'mul'), makeNode('s', 'sin'), makeNode('rm', 'raymarchOutput')],
      [makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'm', 'a'), makeEdge('m', 'out', 'rm', 'field'), makeEdge('m', 'out', 's', 'x')],
      'rm',
    );
    expect([...p.mainAlso].sort()).toEqual(['len', 'm', 'pos']);
  });

  it('an ancestor that is in no scope is never ADDED (it is flat already), and a member nothing flat reads stays scoped', async () => {
    const p = await splatPart(
      [makeNode('pos', 'positionLocal'), makeNode('k', 'float', { value: 2 }), makeNode('len', 'length'), makeNode('m', 'mul'),
        makeNode('ab', 'abs'), makeNode('s', 'sin'), makeNode('sp', 'splatOutput')],
      [
        makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'm', 'a'), makeEdge('k', 'out', 'm', 'b'),
        makeEdge('m', 'out', 'sp', 'cut'), makeEdge('m', 'out', 's', 'x'),
        // A second, independent member on Opacity — nothing flat reads it.
        makeEdge('pos', 'out', 'ab', 'x'), makeEdge('ab', 'out', 'sp', 'opacity'),
      ],
    );
    expect([...p.mainAlso].sort()).toEqual(['len', 'm', 'pos']);
  });
});

describe('the march keeps a scoped node in the flat body when a NON-scope socket reads it', () => {
  it('a Field feeder also wired to Bend (a march number, read in the IIFE) is declared flat too', () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('rm', 'raymarchOutput')];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), makeEdge('sd', 'out', 'rm', 'bend')];
    const p = marchPartition(nodes, edges, 'rm');
    expect(p.scopes.get('field')!.has('sd')).toBe(true);
    expect(p.mainAlso.has('sd')).toBe(true);
    // …while a Field + Color feeder is read inside BOTH Fns and needs no flat copy.
    const both = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), makeEdge('sd', 'out', 'rm', 'color')];
    expect(marchPartition(nodes, both, 'rm').mainAlso.has('sd')).toBe(false);
  });
});

describe('the sink predicates', () => {
  it('isSinkNode / isCustomSink / isSplatOutput', async () => {
    const { isSinkNode, isCustomSink, isSplatOutput, isMarchOutput, SPLAT_OUTPUT_TYPE } = await import('./sdfPartition');
    expect(SPLAT_OUTPUT_TYPE).toBe('splatOutput');
    const sp = makeNode('sp', 'splatOutput');
    const rm = makeNode('rm', 'raymarchOutput');
    const out = makeNode('out', 'output');
    const f = makeNode('f', 'float');
    expect([sp, rm, out, f].map(isSinkNode)).toEqual([true, true, true, false]);
    expect([sp, rm, out, f].map(isCustomSink)).toEqual([true, true, false, false]);
    expect([sp, rm, out, f].map(isSplatOutput)).toEqual([true, false, false, false]);
    expect(isMarchOutput(sp)).toBe(false);
  });

  it('drivingSplatOutput / drivingCustomSink follow the active sink; the march window stays march-only', async () => {
    const { drivingSplatOutput, drivingCustomSink, drivingMarchOutput, marchWindowRadius } = await import('./sdfPartition');
    const nodes = [makeNode('c', 'color'), makeNode('sp', 'splatOutput'), makeNode('out', 'output')];
    const wired = [makeEdge('c', 'out', 'sp', 'color')];
    expect(drivingSplatOutput(nodes, wired)?.id).toBe('sp');
    expect(drivingCustomSink(nodes, wired)?.id).toBe('sp');
    expect(drivingMarchOutput(nodes, wired)).toBeNull();
    expect(marchWindowRadius(nodes, wired)).toBeNull();
    // Unwired, it does not drive; the plain Output is the sink again.
    expect(drivingSplatOutput(nodes, [])).toBeNull();
    expect(drivingCustomSink(nodes, [])).toBeNull();
    // Feather alone is not a primary socket — it refines a cut, it is not one.
    expect(drivingSplatOutput(nodes, [makeEdge('c', 'out', 'sp', 'feather')])).toBeNull();
    for (const socket of ['color', 'opacity', 'cut', 'move', 'size']) {
      expect(drivingSplatOutput(nodes, [makeEdge('c', 'out', 'sp', socket)])?.id, socket).toBe('sp');
    }
  });
});

/**
 * The IMPLICIT reads: a node whose unwired input defaults to a geometry read
 * (a noise's `positionGeometry`, `uv()`) is a member of a splat scope as if
 * that root were wired — inside the splat renderer's vertex stage the
 * geometry is the quad CORNER, so emitting the read there would make a Cut,
 * Move or Colour differ across the four corners of one splat.
 */
describe('implicitRootOf — the reads an UNWIRED input makes', () => {
  const none = () => false;
  const only = (...handles: string[]) => (h: string) => handles.includes(h);

  it('the noise family is exactly the registry\'s noise category', async () => {
    const { NOISE_TYPES, NOISE_POS_DEFAULT } = await import('./sdfPartition');
    const { NODE_REGISTRY } = await import('@/registry/nodeRegistry');
    const noise = [...NODE_REGISTRY.values()].filter((d) => d.category === 'noise');
    expect(new Set(noise.map((d) => d.type))).toEqual(NOISE_TYPES);
    // …and every one of them defaults its position to the one identifier.
    for (const d of noise) expect(d.defaultValues?.pos, d.type).toBe(NOISE_POS_DEFAULT);
  });

  it('a noise reads its STORED position identifier while `pos` is unwired, nothing once wired', async () => {
    const { implicitRootOf, noisePosIdentifier } = await import('./sdfPartition');
    expect(implicitRootOf(makeNode('n', 'perlin'), none)).toBe('positionGeometry');
    expect(implicitRootOf(makeNode('n', 'voronoiVec3', { pos: 'positionWorld' }), none)).toBe('positionWorld');
    expect(implicitRootOf(makeNode('n', 'fbm', { pos: 'normalWorld' }), none)).toBe('normalWorld');
    expect(implicitRootOf(makeNode('n', 'perlin'), only('pos'))).toBeNull();
    // A wired SCALE is an ordinary edge, not a reason to drop the read.
    expect(implicitRootOf(makeNode('n', 'perlin'), only('scale'))).toBe('positionGeometry');
    // The identifier is shape-checked exactly as the emitter checks it.
    expect(noisePosIdentifier('1); evil(')).toBe('positionGeometry');
    expect(noisePosIdentifier(3)).toBe('positionGeometry');
    expect(noisePosIdentifier(undefined)).toBe('positionGeometry');
    expect(noisePosIdentifier('cameraPosition')).toBe('cameraPosition');
    expect(implicitRootOf(makeNode('n', 'perlin', { pos: '1); evil(' }), none)).toBe('positionGeometry');
    // An entry that would THROW on coercion is dropped by getNodeValues, never read.
    const poisoned = makeNode('n', 'perlin');
    (poisoned.data as { values: Record<string, unknown> }).values = { pos: { toString: 1 } };
    expect(implicitRootOf(poisoned, none)).toBe('positionGeometry');
  });

  it('the uv readers: Image (unless UV or Direction is wired), the value-ramps, the samplers', async () => {
    const { implicitRootOf } = await import('./sdfPartition');
    expect(implicitRootOf(makeNode('i', 'imageNode'), none)).toBe('uv');
    expect(implicitRootOf(makeNode('i', 'imageNode'), only('uv'))).toBeNull();
    expect(implicitRootOf(makeNode('i', 'imageNode'), only('dir'))).toBeNull();
    expect(implicitRootOf(makeNode('i', 'imageNode'), only('tileX'))).toBe('uv');
    for (const type of ['colormap', 'dataRange', 'isolines']) {
      expect(implicitRootOf(makeNode('x', type), none), type).toBe('uv');
      expect(implicitRootOf(makeNode('x', type), only('value')), type).toBeNull();
    }
    expect(implicitRootOf(makeNode('x', 'dataviz'), none)).toBe('uv');
    expect(implicitRootOf(makeNode('x', 'dataviz'), only('signal'))).toBeNull();
    // Always sampled along uv, whatever is wired.
    expect(implicitRootOf(makeNode('x', 'stripes'), only('signal'))).toBe('uv');
    expect(implicitRootOf(makeNode('x', 'dataNode'), none)).toBe('uv');
    expect(implicitRootOf(makeNode('x', 'wireframe'), none)).toBe('uv');
    // The edges wireframe reads the loader's `bary` attribute — no root of any scope.
    expect(implicitRootOf(makeNode('x', 'wireframe', { edges: 1 }), none)).toBeNull();
  });

  it('everything else reads nothing implicitly: numbers, helpers, and the roots themselves', async () => {
    const { implicitRootOf } = await import('./sdfPartition');
    for (const type of ['sdCircle', 'sdBox', 'mix', 'add', 'length', 'hsl', 'append', 'time', 'float', 'positionLocal', 'uv', 'vertexColor', 'splatOutput']) {
      expect(implicitRootOf(makeNode('x', type), none), type).toBeNull();
    }
  });

  it('implicitIdentifierOf is the inverse codeToGraph reads a bound position back through', async () => {
    const { implicitIdentifierOf, bindingOfRoot, SPLAT_SCOPES } = await import('./sdfPartition');
    const s = SPLAT_SCOPES[0];
    expect(implicitIdentifierOf(s, 'p')).toBe('positionGeometry');
    expect(implicitIdentifierOf(s, 'pw')).toBe('positionWorld');
    expect(implicitIdentifierOf(s, 'n')).toBe('normalLocal');
    expect(implicitIdentifierOf(s, 'c')).toBe('vertexColor');
    expect(implicitIdentifierOf(s, 'vec2(0.5)')).toBe('screenUV');
    expect(implicitIdentifierOf(s, 'q')).toBeNull();
    expect(implicitIdentifierOf(s, 'modelViewMatrix.mul(vec4(p, 1)).xyz')).toBe('positionView');
    // …and every answer binds back to the expression it came from.
    for (const expr of ['p', 'pw', 'n', 'c', 'vec2(0.5)']) {
      expect(bindingOfRoot(s, implicitIdentifierOf(s, expr)!)?.expr, expr).toBe(expr);
    }
  });
});

describe('marchPartition — implicit roots scope the splat, and ONLY the splat', () => {
  const splatPart = async (nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[]) => {
    const { SPLAT_SCOPES } = await import('./sdfPartition');
    return marchPartition(nodes, edges, 'sp', SPLAT_SCOPES);
  };

  it('a noise with its position unwired is a member of the scope it feeds — and not a root', async () => {
    const nodes = [makeNode('nz', 'perlin'), makeNode('ab', 'abs'), makeNode('sp', 'splatOutput')];
    const edges = [makeEdge('nz', 'out', 'ab', 'x'), makeEdge('ab', 'out', 'sp', 'cut')];
    const p = await splatPart(nodes, edges);
    expect([...p.scopes.get('shape')!].sort()).toEqual(['ab', 'nz']);
    expect(p.scopes.get('shade')!.size).toBe(0);
    // Unlike a real root it is NOT copied into the flat body for nothing.
    expect(p.mainAlso.size).toBe(0);
  });

  it('…is kept in the flat body too when something outside every Fn reads it', async () => {
    const nodes = [makeNode('nz', 'perlin'), makeNode('ab', 'abs'), makeNode('sp', 'splatOutput')];
    const dangling = await splatPart(nodes, [makeEdge('nz', 'out', 'sp', 'cut'), makeEdge('nz', 'out', 'ab', 'x')]);
    expect(dangling.scopes.get('shape')!.has('nz')).toBe(true);
    expect(dangling.mainAlso.has('nz')).toBe(true);
    // Feather is a scope of its own now (read per splat, like Size), so a
    // noise on Cut AND Feather is bound in both Fns and needs no flat copy.
    const feather = await splatPart(nodes, [makeEdge('nz', 'out', 'sp', 'cut'), makeEdge('nz', 'out', 'sp', 'feather')]);
    expect(feather.scopes.get('feather')!.has('nz')).toBe(true);
    expect(feather.mainAlso.has('nz')).toBe(false);
  });

  it('a noise whose position is WIRED to a constant is captured, not scoped; a stored non-root identifier likewise', async () => {
    const nodes = [makeNode('f', 'float', { value: 2 }), makeNode('nz', 'perlin'), makeNode('sp', 'splatOutput')];
    const wired = await splatPart(nodes, [makeEdge('f', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'cut')]);
    expect(wired.scopes.get('shape')!.size).toBe(0);
    const cam = await splatPart(
      [makeNode('nz', 'perlin', { pos: 'cameraPosition' }), makeNode('sp', 'splatOutput')],
      [makeEdge('nz', 'out', 'sp', 'cut')],
    );
    expect(cam.scopes.get('shape')!.size).toBe(0);
  });

  it('a dangling wire (its source is gone) does not count as wired', async () => {
    const nodes = [makeNode('nz', 'perlin'), makeNode('sp', 'splatOutput')];
    const p = await splatPart(nodes, [makeEdge('ghost', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'cut')]);
    expect(p.scopes.get('shape')!.has('nz')).toBe(true);
  });

  it('a uv reader (an unwired Colormap) scopes the chain it feeds', async () => {
    const nodes = [makeNode('cm', 'colormap'), makeNode('sp', 'splatOutput')];
    const p = await splatPart(nodes, [makeEdge('cm', 'out', 'sp', 'color')]);
    expect([...p.scopes.get('shade')!]).toEqual(['cm']);
  });

  it('the MARCH is untouched: an unwired-position noise on a Field stays captured, as it always was', () => {
    const nodes = [makeNode('nz', 'perlin'), makeNode('rm', 'raymarchOutput')];
    const p = marchPartition(nodes, [makeEdge('nz', 'out', 'rm', 'field')], 'rm');
    expect(p.scopes.get('field')!.size).toBe(0);
    expect(p.mainAlso.size).toBe(0);
  });

  it('the position-derived roots are per-splat constants of the splat scopes, and no root of the march', async () => {
    const { SPLAT_SCOPES, MARCH_SCOPES, bindingOfRoot, scopeRootTypes } = await import('./sdfPartition');
    const s = SPLAT_SCOPES[0];
    expect(bindingOfRoot(s, 'positionView')).toEqual({ expr: 'modelViewMatrix.mul(vec4(p, 1)).xyz', imports: ['modelViewMatrix', 'vec4'] });
    expect(bindingOfRoot(s, 'positionViewDirection')?.expr).toBe('modelViewMatrix.mul(vec4(p, 1)).xyz.negate().normalize()');
    expect(bindingOfRoot(s, 'positionWorldDirection')).toEqual({ expr: 'p.transformDirection(modelWorldMatrix)', imports: ['modelWorldMatrix'] });
    expect(bindingOfRoot(s, 'rayDirection')).toEqual({ expr: 'n.negate()', imports: [] });
    for (const m of MARCH_SCOPES) {
      for (const type of ['positionView', 'positionViewDirection', 'positionWorldDirection']) expect(scopeRootTypes(m).has(type), `${m.handle} ${type}`).toBe(false);
    }
    // A View Position chain on Cut is scoped, the root copied flat as every root is.
    const p = marchPartition(
      [makeNode('pv', 'positionView'), makeNode('len', 'length'), makeNode('sp', 'splatOutput')],
      [makeEdge('pv', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'cut')],
      'sp',
      SPLAT_SCOPES,
    );
    expect([...p.scopes.get('shape')!].sort()).toEqual(['len', 'pv']);
    expect(p.mainAlso.has('pv')).toBe(true);
  });

  it('the march specs carry no implicitRoots, the splat specs all do', async () => {
    const { MARCH_SCOPES, SPLAT_SCOPES } = await import('./sdfPartition');
    for (const s of MARCH_SCOPES) expect(s.implicitRoots, s.handle).toBeUndefined();
    for (const s of SPLAT_SCOPES) expect(s.implicitRoots, s.handle).toBe(true);
  });
});
