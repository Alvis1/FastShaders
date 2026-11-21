import { describe, expect, it } from 'vitest';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeEdge, makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  bakeClassOf,
  bakeMeshFilter,
  bakeSockets,
  expandBakeSelection,
  geometryCanMeshBake,
  planBake,
  type BakeContext,
} from './bakePlan';
import type { LoadedModel } from './outputMaterials';

const SPHERE: BakeContext = { geometry: 'sphere', splatShown: false };

/**
 * Every registry type the planner reads as `pure` — reads only what its inputs
 * read. A new node type lands here only after someone asked what it does to a
 * bake: a camera read, a screen derivative or a hidden geometry attribute
 * belongs in bakePlan.ts's TYPE_CLASS (or `implicitRootOf`) instead.
 */
const PURE = [
  'abs', 'add', 'append', 'brightContrast', 'cellNoise', 'clamp', 'color', 'colorRamp', 'colormap', 'cos',
  'cross', 'dataNode', 'dataRange', 'dataviz', 'distance', 'div', 'dot', 'equal', 'exp', 'fbm', 'fbmVec3',
  'float', 'floor', 'fract', 'greaterThan', 'hsl', 'imageNode', 'int', 'length', 'lessThan', 'log2', 'max',
  'min', 'mix', 'mod', 'mul', 'normalize', 'oneMinus', 'perlin', 'perlinVec3', 'pow', 'remap', 'rgbCurves',
  'round', 'sdBox', 'sdCapsule', 'sdCircle', 'sdCombine', 'sdCone', 'sdCylinder', 'sdOctahedron', 'sdPlane',
  'sdStar', 'sdTorus', 'sdfDeform', 'sdfExtrude', 'sdfMask', 'sdfMirror', 'sdfModify', 'sdfRepeat',
  'sdfRepeatPolar', 'sdfRevolve', 'sdfTransform', 'select', 'sin', 'smoothstep', 'split', 'sqrt', 'sub',
  'toHsl', 'vec2', 'vec3', 'vec4', 'voronoi', 'voronoiVec2', 'voronoiVec3',
];

function out(id = 'o'): AppNode {
  const n = makeNode(id, 'output');
  return n;
}

describe('the class table', () => {
  it('gives every registry type a REVIEWED class (a new type fails here until it is placed)', () => {
    const unreviewed = [...NODE_REGISTRY.keys()].filter((t) => bakeClassOf(t) === 'pure' && !PURE.includes(t));
    expect(unreviewed).toEqual([]);
    // …and the list names nothing the registry dropped.
    expect(PURE.filter((t) => !NODE_REGISTRY.has(t))).toEqual([]);
  });

  it('refuses what depends on the camera, freezes what moves, flags screen derivatives', () => {
    for (const t of ['positionView', 'positionViewDirection', 'cameraPosition', 'screenUV', 'fresnel', 'rayDirection', 'heightToNormal']) {
      expect(bakeClassOf(t), t).toBe('view');
    }
    expect(bakeClassOf('time')).toBe('live');
    expect(bakeClassOf('soundNode')).toBe('live');
    expect(bakeClassOf('property_float')).toBe('tuned');
    for (const t of ['stripes', 'isolines', 'wireframe']) expect(bakeClassOf(t), t).toBe('derivative');
    expect(bakeClassOf('unknown')).toBe('refuse');
  });

  it('mesh-bakes only shapes whose UVs do not overlap', () => {
    expect(['sphere', 'plane', 'bunny', 'custom'].every((g) => geometryCanMeshBake(g as never))).toBe(true);
    expect(['cube', 'teapot', 'marchSphere'].some((g) => geometryCanMeshBake(g as never))).toBe(false);
  });
});

describe('bakeSockets / expandBakeSelection', () => {
  it('finds each socket whose value leaves the selection, with its outgoing wires', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('p', 'perlin'), makeNode('m', 'mul'), out()];
    const edges = [
      makeEdge('u', 'out', 'p', 'pos'),
      makeEdge('p', 'out', 'm', 'a'),
      makeEdge('m', 'out', 'o', 'color'),
      makeEdge('p', 'out', 'o', 'roughness'),
    ];
    const s = bakeSockets(nodes, edges, new Set(['u', 'p']));
    expect(s.map((x) => x.socket)).toEqual([{ nodeId: 'p', handleId: 'out' }]);
    expect(s[0].consumers.map((e) => e.target).sort()).toEqual(['m', 'o']);
  });

  it('a group stands for the nodes inside it; frames, notes and sinks carry nothing', () => {
    const g = { id: 'g', type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: 'G' } } as unknown as AppNode;
    const a = { ...makeNode('a', 'uv'), parentId: 'g' } as AppNode;
    const b = { ...makeNode('b', 'perlin'), parentId: 'g' } as AppNode;
    expect([...expandBakeSelection([g, a, b, out()], ['g', 'o'])].sort()).toEqual(['a', 'b']);
  });
});

describe('planBake', () => {
  it('a chain of the UV alone bakes across the UV square', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('p', 'perlin'), out()];
    const edges = [makeEdge('u', 'out', 'p', 'pos'), makeEdge('p', 'out', 'o', 'color')];
    const [plan] = planBake(nodes, edges, ['u', 'p'], SPHERE);
    expect(plan).toMatchObject({ nodeId: 'p', layout: 'uv', refusal: null, shape: 1, colorSpace: 'color', uvSet: 0 });
  });

  it('a noise of the surface position needs the model’s own UV layout — and is refused on the Cube', () => {
    const nodes = [makeNode('p', 'perlin'), makeNode('m', 'mul'), out()];
    const edges = [makeEdge('p', 'out', 'm', 'a'), makeEdge('m', 'out', 'o', 'roughness')];
    const [plan] = planBake(nodes, edges, ['p'], SPHERE);
    expect(plan).toMatchObject({ layout: 'mesh', refusal: null, colorSpace: 'data' });
    expect(planBake(nodes, edges, ['p'], { geometry: 'cube', splatShown: false })[0].refusal).toBe('needs-mesh');
  });

  it('refuses the camera, one value, a wired UV channel, and the no-preview cases', () => {
    const fres = planBake([makeNode('f', 'fresnel'), out()], [makeEdge('f', 'out', 'o', 'color')], ['f'], SPHERE);
    expect(fres[0].refusal).toBe('view');
    const flat = planBake([makeNode('c', 'float', { value: 2 }), makeNode('m', 'mul'), out()], [makeEdge('c', 'out', 'm', 'a'), makeEdge('m', 'out', 'o', 'color')], ['c', 'm'], SPHERE);
    expect(flat[0].refusal).toBe('constant');
    const wiredCh = planBake(
      [makeNode('i', 'int', { value: 1 }), makeNode('u', 'uv'), out()],
      [makeEdge('i', 'out', 'u', 'channel'), makeEdge('u', 'out', 'o', 'color')],
      ['i', 'u'],
      SPHERE,
    );
    expect(wiredCh[0].refusal).toBe('uv-channel-wired');
    const nodes = [makeNode('u', 'uv'), out()];
    const edges = [makeEdge('u', 'out', 'o', 'color')];
    expect(planBake(nodes, edges, ['u'], { geometry: null, splatShown: false })[0].refusal).toBe('no-preview');
    expect(planBake(nodes, edges, ['u'], { geometry: 'custom', splatShown: true })[0].refusal).toBe('no-preview');
  });

  it('reads the UV channel a chain samples, so the Image samples the same one', () => {
    const nodes = [makeNode('u', 'uv', { channel: 2 }), makeNode('p', 'perlin'), out()];
    const edges = [makeEdge('u', 'out', 'p', 'pos'), makeEdge('p', 'out', 'o', 'color')];
    expect(planBake(nodes, edges, ['u', 'p'], SPHERE)[0].uvSet).toBe(2);
    const two = [makeNode('u', 'uv', { channel: 1 }), makeNode('v', 'uv'), makeNode('a', 'add'), out()];
    const twoE = [makeEdge('u', 'out', 'a', 'a'), makeEdge('v', 'out', 'a', 'b'), makeEdge('a', 'out', 'o', 'color')];
    expect(planBake(two, twoE, ['u', 'v', 'a'], SPHERE)[0].refusal).toBe('uv-channels');
  });

  it('warns that Time and properties freeze, and screen derivatives bake in texels', () => {
    const nodes = [makeNode('t', 'time'), makeNode('u', 'uv'), makeNode('k', 'property_float', { name: 'k' }), makeNode('a', 'add'), makeNode('m', 'mul'), out()];
    const edges = [
      makeEdge('u', 'out', 'a', 'a'),
      makeEdge('t', 'out', 'a', 'b'),
      makeEdge('a', 'out', 'm', 'a'),
      makeEdge('k', 'out', 'm', 'b'),
      makeEdge('m', 'out', 'o', 'color'),
    ];
    const [plan] = planBake(nodes, edges, ['t', 'u', 'k', 'a', 'm'], SPHERE);
    expect(plan.refusal).toBeNull();
    expect(plan.warnings).toEqual(expect.arrayContaining(['time', 'tuned']));
  });

  it('a vector socket keeps its width; a colour feeding Color bakes as colour, data elsewhere', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('v', 'perlinVec3'), out()];
    const edges = [makeEdge('u', 'out', 'v', 'pos'), makeEdge('v', 'out', 'o', 'normal')];
    const [plan] = planBake(nodes, edges, ['u', 'v'], SPHERE);
    expect(plan.shape).toBe(3);
    expect(plan.colorSpace).toBe('data');
  });
});

describe('bakeMeshFilter', () => {
  const NONE = { kind: 'none' } as unknown as LoadedModel;
  it('the default material covers every mesh no OTHER Output claims', () => {
    const def = out('o');
    const body = { ...makeNode('b', 'output'), data: { ...makeNode('b', 'output').data, meshTargets: ['Body'] } } as AppNode;
    const nodes = [makeNode('p', 'perlin'), def, body];
    const edges = [makeEdge('p', 'out', 'o', 'color')];
    const f = bakeMeshFilter(nodes, edges, edges, NONE);
    expect(f).toMatchObject({ all: true, exceptNames: ['Body'] });
  });

  it('a targeted Output covers its own meshes only', () => {
    const body = { ...makeNode('b', 'output'), data: { ...makeNode('b', 'output').data, meshTargets: ['Body', 'Arm'] } } as AppNode;
    const nodes = [makeNode('p', 'perlin'), out('o'), body];
    const edges = [makeEdge('p', 'out', 'b', 'color')];
    const f = bakeMeshFilter(nodes, edges, edges, NONE);
    expect(f).toMatchObject({ all: false, names: ['Body', 'Arm'], exceptNames: [] });
  });
});
