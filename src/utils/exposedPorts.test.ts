import { describe, it, expect } from 'vitest';
import {
  autoExposeConnectedParamPorts,
  effectiveExposedPorts,
  usesExposedPorts,
  normalizeExposedPorts,
  OUTPUT_DEFAULT_EXPOSED,
  MAX_EXPOSED_PORTS,
  effectiveImageDef,
  effectiveNodeDef,
  effectiveRampDef,
} from './exposedPorts';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '../test-utils';
import type { ShaderNodeData, AppNode, AppEdge } from '@/types';

const exposedOf = (n: ReturnType<typeof makeNode>) =>
  (n.data as ShaderNodeData).exposedPorts;

describe('usesExposedPorts', () => {
  it('covers noise, output, and imageNode — nothing else', () => {
    expect(usesExposedPorts(NODE_REGISTRY.get('perlin'))).toBe(true);
    expect(usesExposedPorts(NODE_REGISTRY.get('output'))).toBe(true);
    expect(usesExposedPorts(NODE_REGISTRY.get('imageNode'))).toBe(true);
    expect(usesExposedPorts(NODE_REGISTRY.get('add'))).toBe(false);
    expect(usesExposedPorts(undefined)).toBe(false);
  });
});

describe('autoExposeConnectedParamPorts', () => {
  it('exposes connected params on noise and image nodes', () => {
    const noise = makeNode('n1', 'perlin');
    const img = makeNode('i1', 'imageNode');
    const f = makeNode('f1', 'float', { value: 1 });
    autoExposeConnectedParamPorts(
      [noise, img, f],
      [makeEdge('f1', 'out', 'n1', 'pos'), makeEdge('f1', 'out', 'i1', 'uv')],
    );
    expect(exposedOf(noise)).toEqual(['pos']);
    expect(exposedOf(img)).toEqual(['uv']);
  });

  it('unions with existing exposure, never dropping entries', () => {
    const noise = makeNode('n1', 'perlin');
    (noise.data as ShaderNodeData).exposedPorts = ['scale'];
    autoExposeConnectedParamPorts([noise], [makeEdge('f1', 'out', 'n1', 'pos')]);
    expect(exposedOf(noise)).toEqual(['scale', 'pos']);
  });

  it("seeds the Output node's implicit defaults — exposing one channel never hides them", () => {
    const out = makeNode('o1', 'output');
    autoExposeConnectedParamPorts([out], [makeEdge('f1', 'out', 'o1', 'emissive')]);
    expect(exposedOf(out)).toEqual([...OUTPUT_DEFAULT_EXPOSED, 'emissive']);
  });

  it('leaves an Output node implicit (undefined) when connections are already covered', () => {
    const out = makeNode('o1', 'output');
    autoExposeConnectedParamPorts([out], [makeEdge('f1', 'out', 'o1', 'color')]);
    expect(exposedOf(out)).toBeUndefined();
  });

  it('respects an EXPLICIT empty list as the union base', () => {
    const out = makeNode('o1', 'output');
    (out.data as ShaderNodeData).exposedPorts = [];
    autoExposeConnectedParamPorts([out], [makeEdge('f1', 'out', 'o1', 'color')]);
    expect(exposedOf(out)).toEqual(['color']);
  });

  it('never touches nodes outside the exposedPorts system', () => {
    const add = makeNode('a1', 'add');
    autoExposeConnectedParamPorts([add], [makeEdge('f1', 'out', 'a1', 'a')]);
    expect(exposedOf(add)).toBeUndefined();
  });
});

describe('effectiveExposedPorts', () => {
  it('resolves implicit Output defaults, explicit lists, and non-output nodes', () => {
    expect(effectiveExposedPorts(makeNode('o1', 'output'))).toEqual(OUTPUT_DEFAULT_EXPOSED);
    const img = makeNode('i1', 'imageNode');
    expect(effectiveExposedPorts(img)).toEqual([]);
    (img.data as ShaderNodeData).exposedPorts = ['uv'];
    expect(effectiveExposedPorts(img)).toEqual(['uv']);
  });
});

describe('adversarial exposedPorts (tampered fs:graph / .fastshader)', () => {
  const node = (exposedPorts: unknown, registryType = 'output') =>
    ({ id: 'n', data: { registryType, label: 'n', cost: 0, values: {}, exposedPorts } } as unknown as AppNode);

  it.each([5, null, {}, true, 'color'])(
    'effectiveExposedPorts always returns a string[] for %s',
    (bad) => {
      const r = effectiveExposedPorts(node(bad));
      expect(Array.isArray(r)).toBe(true);
      expect(r.every((s) => typeof s === 'string')).toBe(true);
    },
  );

  it('autoExposeConnectedParamPorts does not throw on a tampered value', () => {
    const nodes = [node(5)];
    const edges = [
      { id: 'e', source: 'a', target: 'n', sourceHandle: 'out', targetHandle: 'emissive' },
    ] as unknown as AppEdge[];
    expect(() => autoExposeConnectedParamPorts(nodes, edges)).not.toThrow();
    // The non-array is deleted, so the Output node falls back to its implicit
    // defaults and then unions in the connected channel.
    expect(effectiveExposedPorts(nodes[0])).toContain('emissive');
  });

  it('normalizeExposedPorts deletes a non-array so implicit defaults return', () => {
    const nodes = [node(5)];
    normalizeExposedPorts(nodes);
    expect((nodes[0].data as { exposedPorts?: unknown }).exposedPorts).toBeUndefined();
    expect(effectiveExposedPorts(nodes[0])).toEqual(OUTPUT_DEFAULT_EXPOSED);
  });

  it('normalizeExposedPorts keeps an explicit empty array (user hid everything)', () => {
    const nodes = [node([])];
    normalizeExposedPorts(nodes);
    expect(effectiveExposedPorts(nodes[0])).toEqual([]);
  });

  it('normalizeExposedPorts filters non-string members and caps the length', () => {
    const nodes = [node(['color', 7, null, 'roughness'])];
    normalizeExposedPorts(nodes);
    expect((nodes[0].data as { exposedPorts?: unknown }).exposedPorts).toEqual(['color', 'roughness']);
    const huge = [node(Array.from({ length: 500 }, (_, i) => `p${i}`))];
    normalizeExposedPorts(huge);
    expect((huge[0].data as { exposedPorts: string[] }).exposedPorts).toHaveLength(MAX_EXPOSED_PORTS);
  });
});

describe('effectiveImageDef / effectiveNodeDef — the ONE def both surfaces draw from', () => {
  const image = NODE_REGISTRY.get('imageNode')!;

  it('returns every other node by IDENTITY (the memos downstream key on it)', () => {
    for (const type of ['mul', 'uv', 'perlin', 'output', 'colormap', 'toHsl']) {
      const d = NODE_REGISTRY.get(type)!;
      expect(effectiveImageDef(d, []), type).toBe(d);
      expect(effectiveNodeDef(d, []), type).toBe(d);
    }
  });

  it('nothing exposed: no param inputs and no defaultValues (so no setting rows)', () => {
    const d = effectiveImageDef(image, []);
    expect(d.inputs).toEqual([]);
    expect(d.defaultValues).toEqual({});
  });

  it('keeps the exposed params in REGISTRY order, whatever order they were ticked in', () => {
    expect(effectiveImageDef(image, ['tileY', 'uv']).inputs.map((i) => i.id)).toEqual(['uv', 'tileY']);
    expect(effectiveImageDef(image, new Set(['dir', 'offsetX'])).inputs.map((i) => i.id)).toEqual(['offsetX', 'dir']);
  });

  it('never touches the outputs, and never mutates the registry def', () => {
    const before = image.inputs.length;
    expect(effectiveNodeDef(image, ['uv']).outputs).toBe(image.outputs);
    expect(image.inputs).toHaveLength(before);
    expect(Object.keys(image.defaultValues ?? {})).toEqual(['tileX', 'tileY', 'offsetX', 'offsetY']);
  });

  it('still composes the ramp filter for Data Stripes / Data Viz', () => {
    for (const type of ['stripes', 'dataviz']) {
      const d = NODE_REGISTRY.get(type)!;
      expect(effectiveNodeDef(d, [])).toEqual(effectiveRampDef(d, []));
      expect(effectiveNodeDef(d, ['lowColor'])).toEqual(effectiveRampDef(d, ['lowColor']));
    }
  });
});
