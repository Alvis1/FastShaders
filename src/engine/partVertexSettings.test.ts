/**
 * Every Output has its own vertex settings (owner, 2026-11-10): a TARGETED
 * material's Along Normal / Merge Vertices ride its part body where they differ
 * from the module-settings Output's (materialSettingsCode `partVertexProps`),
 * buildShaderModule spends `displacementMode` on that part's positionNode and
 * passes `mergeVertices` to loader 0.8 (delta 14), and the parse reads both back.
 */
import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, MaterialSettings } from '@/types';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildShaderModule } from './tslCodeProcessor';
import { effectiveVertexSettings, partVertexProps } from './materialSettingsCode';

const output = (id: string, targets: string[] | null, settings?: MaterialSettings): AppNode => {
  const n = makeNode(id, 'output');
  const d = n.data as Record<string, unknown>;
  d.exposedPorts = ['color', 'position'];
  if (targets) d.meshTargets = targets;
  if (settings) d.materialSettings = settings;
  return n;
};

const graph = (def?: MaterialSettings, body?: MaterialSettings) => {
  const noise = makeNode('n', 'perlin');
  const nodes = [noise, output('out', null, def), output('body', ['Body'], body)];
  const edges = [
    makeEdge('n', 'out', 'out', 'position'),
    makeEdge('n', 'out', 'body', 'position'),
  ];
  return { nodes, edges };
};

const partOf = (code: string, name: string): string => {
  const at = code.indexOf(`"${name}": {`);
  expect(at, name).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = code.indexOf('{', at); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(code.indexOf('{', at) + 1, i).trim();
  }
  return '';
};

describe('effectiveVertexSettings / partVertexProps', () => {
  it('own, else the owner\'s, else along the normal and welded', () => {
    expect(effectiveVertexSettings(undefined, undefined)).toEqual({ displacementMode: 'normal', mergeVertices: true });
    expect(effectiveVertexSettings(undefined, { displacementMode: 'offset', mergeVertices: false }))
      .toEqual({ displacementMode: 'offset', mergeVertices: false });
    expect(effectiveVertexSettings({ displacementMode: 'normal', mergeVertices: true }, { displacementMode: 'offset', mergeVertices: false }))
      .toEqual({ displacementMode: 'normal', mergeVertices: true });
  });

  it('writes only what differs, both ways, as literals', () => {
    expect(partVertexProps(undefined, undefined)).toEqual([]);
    expect(partVertexProps({ displacementMode: 'offset' }, undefined)).toEqual(["displacementMode: 'offset'"]);
    expect(partVertexProps({ mergeVertices: true }, { mergeVertices: false })).toEqual(['mergeVertices: true']);
    expect(partVertexProps({ displacementMode: 'normal' }, { displacementMode: 'offset' })).toEqual(["displacementMode: 'normal'"]);
    expect(partVertexProps({ displacementMode: 'alert(1)' as 'offset' }, undefined)).toEqual([]);
  });
});

describe('a targeted Output with its own vertex settings', () => {
  it('writes them into its part body, and the default\'s stay out of the code', () => {
    const { nodes, edges } = graph({ displacementMode: 'normal' }, { displacementMode: 'offset', mergeVertices: false });
    const { code } = graphToCode(nodes, edges);
    expect(partOf(code, 'Body')).toContain("displacementMode: 'offset', mergeVertices: false");
    expect(code.slice(0, code.indexOf('parts:'))).not.toMatch(/displacementMode|mergeVertices/);
  });

  it('the module displaces that part as an offset and tells loader 0.8 to leave it torn', () => {
    const { nodes, edges } = graph(undefined, { displacementMode: 'offset', mergeVertices: false });
    const mod = buildShaderModule(graphToCode(nodes, edges).code, {});
    const body = partOf(mod, 'Body');
    expect(body).toMatch(/positionNode: __fsDisplaced\d\(positionLocal\.add\(noise\w*\)\)/);
    expect(body).toContain('mergeVertices: false');
    expect(body).not.toContain('displacementMode');
    // The default keeps along-the-normal.
    expect(mod).toMatch(/return \{ positionNode: __fsDisplaced\d\(positionLocal\.add\(normalLocal\.mul\(/);
  });

  it('a part that never chose follows the module: an older graph\'s bytes do not move', () => {
    const plain = graph({ displacementMode: 'offset' });
    const mod = buildShaderModule(graphToCode(plain.nodes, plain.edges).code, { materialSettings: { displacementMode: 'offset' } });
    expect(partOf(mod, 'Body')).toMatch(/positionNode: __fsDisplaced\d\(positionLocal\.add\(noise\w*\)\)/);
    expect(partOf(mod, 'Body')).not.toContain('mergeVertices');
  });

  it('round-trips through the code panel onto the same Output', () => {
    const { nodes, edges } = graph(undefined, { displacementMode: 'offset', mergeVertices: false });
    const back = codeToGraph(graphToCode(nodes, edges).code);
    expect(back.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    const targeted = back.nodes.find((n) => n.data.registryType === 'output'
      && Array.isArray((n.data as Record<string, unknown>).meshTargets));
    expect((targeted!.data as { materialSettings?: MaterialSettings }).materialSettings)
      .toEqual({ displacementMode: 'offset', mergeVertices: false });
    // …and its Position is still wired, not read as a channel called displacementMode.
    expect(back.edges.some((e) => e.target === targeted!.id && e.targetHandle === 'position')).toBe(true);
    expect(back.edges.some((e) => e.targetHandle === 'displacementMode' || e.targetHandle === 'mergeVertices')).toBe(false);
  });
});
