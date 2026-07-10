import { describe, it, expect } from 'vitest';
import {
  autoExposeConnectedParamPorts,
  effectiveExposedPorts,
  usesExposedPorts,
  OUTPUT_DEFAULT_EXPOSED,
} from './exposedPorts';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '../test-utils';
import type { ShaderNodeData } from '@/types';

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
