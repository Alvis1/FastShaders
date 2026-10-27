import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { MODULE_HELPERS, UV_CHANNEL_HELPER } from './moduleHelpers';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/**
 * A WIRED UV Channel chooses its map in the shader. three r184's `uv(index)`
 * names the attribute from a JS number at BUILD time (`'uv' + (index > 0 ?
 * index : '')`), so the old `uv(int1)` read channel 0 whatever the wire held —
 * measured on both backends, as was the helper below picking uv/uv1/uv2 by an
 * Int, a Float and a run-time uniform (2026-10-27).
 */

const code = (nodes: AppNode[], edges: AppEdge[]) => graphToCode(nodes, edges).code;
const typeOf = (g: { nodes: AppNode[] }, id: string) => g.nodes.find((n) => n.id === id)?.data.registryType;
const wires = (g: { nodes: AppNode[]; edges: AppEdge[] }) =>
  g.edges.map((e) => `${typeOf(g, e.source)}.${e.sourceHandle}->${typeOf(g, e.target)}.${e.targetHandle}`).sort();
const module = (body: string) =>
  `import { Fn, int, mul, uv, vec2, vec3 } from 'three/tsl';\nconst shader = Fn(() => {\n${body}\n});\nexport default shader;\n`;

const channelWired = (uvValues: Record<string, number> = {}): [AppNode[], AppEdge[]] => [
  [makeNode('i', 'int', { value: 1 }), makeNode('u', 'uv', { channel: 0, tilingU: 1, tilingV: 1, rotation: 0, ...uvValues }), makeNode('o', 'output')],
  [makeEdge('i', 'out', 'u', 'channel'), makeEdge('u', 'out', 'o', 'color')],
];

describe('a wired UV Channel', () => {
  it('emits the helper, declared once at module scope', () => {
    const c = code(...channelWired());
    expect(c).toContain(`const uv1 = ${UV_CHANNEL_HELPER}(int1);`);
    expect(c.split(`const ${UV_CHANNEL_HELPER} = Fn(`)).toHaveLength(2);
    expect(c).not.toMatch(/\buv\(int1\)/);
  });

  it('the helper rounds the wire and reads uv1–uv3, anything else channel 0', () => {
    const text = MODULE_HELPERS.get(UV_CHANNEL_HELPER)!.lines.join('\n');
    expect(text).toContain('round(float(index))');
    for (const map of ['uv(1)', 'uv(2)', 'uv(3)', 'uv()']) expect(text).toContain(map);
  });

  it('a stored channel emits exactly as before', () => {
    const nodes = [makeNode('u', 'uv', { channel: 2, tilingU: 1, tilingV: 1, rotation: 0 }), makeNode('o', 'output')];
    const c = code(nodes, [makeEdge('u', 'out', 'o', 'color')]);
    expect(c).toContain('const uv1 = uv(2);');
    expect(c).not.toContain(UV_CHANNEL_HELPER);
  });

  it('round-trips without and with tiling, keeping the channel wire', () => {
    for (const values of [{}, { tilingU: 2 }] as Record<string, number>[]) {
      const [nodes, edges] = channelWired(values);
      const a = code(nodes, edges);
      const g = codeToGraph(a);
      expect(g.errors).toEqual([]);
      expect(wires(g)).toEqual(['int.out->uv.channel', 'uv.out->output.color']);
      expect(code(g.nodes, g.edges)).toBe(a);
    }
  });

  it('a hand-written uv(int1) — tiled or not — is read as the wire it meant', () => {
    for (const body of [
      '  const int1 = int(1);\n  const uv1 = uv(int1);\n  return vec3(uv1);',
      '  const int1 = int(1);\n  const uv1 = mul(uv(int1), vec2(2, 1));\n  return vec3(uv1);',
    ]) {
      const g = codeToGraph(module(body));
      expect(wires(g), body).toEqual(['int.out->uv.channel', 'uv.out->output.color']);
      expect(code(g.nodes, g.edges)).toContain(`${UV_CHANNEL_HELPER}(int1)`);
    }
  });
});
