import { describe, expect, it } from 'vitest';
import { makeEdge, makeNode } from '@/test-utils';
import { BAKE_SPLIT_ID, bakeGraph, bakeModuleText } from './bakeModule';
import { tslToPreviewHTML } from './tslToPreviewHTML';

const TSL = `import { Fn, vec3 } from 'three/tsl';
const shader = Fn(() => { return vec3(1, 0, 0); });
export default shader;`;

function graph() {
  const nodes = [makeNode('u', 'uv'), makeNode('p', 'perlin'), makeNode('r', 'float', { value: 0.4 }), makeNode('o', 'output')];
  const edges = [makeEdge('u', 'out', 'p', 'pos'), makeEdge('p', 'out', 'o', 'color'), makeEdge('r', 'out', 'o', 'roughness')];
  return { nodes, edges };
}

describe('bakeGraph / bakeModuleText', () => {
  it('routes the socket to an UNLIT Color and unplugs everything else', () => {
    const { nodes, edges } = graph();
    const g = bakeGraph(nodes, edges, { nodeId: 'p', handleId: 'out' });
    const out = g.nodes.find((n) => n.data.registryType === 'output')!;
    expect((out.data as { materialSettings?: unknown }).materialSettings).toEqual({ unlit: true });
    expect(g.edges.filter((e) => e.target === out.id).map((e) => [e.source, e.targetHandle])).toEqual([['p', 'color']]);
    const text = bakeModuleText(nodes, edges, { nodeId: 'p', handleId: 'out' });
    expect(text).toMatch(/unlit:\s*true/);
    expect(text).not.toMatch(/roughness/);
  });

  it('an alpha pass routes the fourth channel through a Split of its own', () => {
    const nodes = [makeNode('v', 'vec4', { x: 0.1, y: 0.2, z: 0.3, w: 0.9 }), makeNode('o', 'output')];
    const edges = [makeEdge('v', 'out', 'o', 'color')];
    const g = bakeGraph(nodes, edges, { nodeId: 'v', handleId: 'out' }, 'alpha');
    expect(g.edges.find((e) => e.target === BAKE_SPLIT_ID)).toMatchObject({ source: 'v', targetHandle: 'v' });
    expect(g.edges.find((e) => e.source === BAKE_SPLIT_ID)).toMatchObject({ sourceHandle: 'w', targetHandle: 'color' });
  });
});

describe('the stage’s bake service', () => {
  it('rides the sandboxed editor preview only — never the VR popup, which nobody messages', () => {
    expect(tslToPreviewHTML(TSL, { geometry: 'sphere' })).toContain('fs:bake-result');
    expect(tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true })).not.toContain('fs:bake');
  });
});
