import { describe, it, expect, beforeAll } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { makeEdge, makeNode } from '@/test-utils';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { feedsAnOutputIds, panelCodegen } from './panelCode';
import { connectedExportIds } from './exportGraph';
import { loadUnknownExpressionValidator } from './unknownExpression';

/**
 * The code panel shows only the nodes that FEED AN OUTPUT (engine/panelCode.ts)
 * through `graphToCode`'s `emitOnly`, an EMISSION scope: every name is still
 * claimed over the whole graph. Pinned here: a scope that hides nothing is
 * today's pass byte for byte; one that hides a chain renames nothing, declares
 * nothing hidden and parses back cleanly; and the out-edge reads that SHOULD
 * forget a hidden consumer do.
 */

// The unknown-node case reads the validator's rebind (it fails closed cold).
beforeAll(() => loadUnknownExpressionValidator());

const blocking = (code: string) => codeToGraph(code).errors.filter((e) => e.severity !== 'warning');
const declares = (code: string, name: string) => new RegExp(`\\bconst ${name} =`).test(code);
const count = (code: string, needle: string) => code.split(needle).length - 1;

const frame = (id: string): AppNode =>
  ({ id, type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: id, color: '#888888', width: 200, height: 100 } }) as unknown as AppNode;
const note = (id: string): AppNode =>
  ({ id, type: 'note', position: { x: 0, y: 0 }, data: { registryType: 'note', title: '', body: 'a note' } }) as unknown as AppNode;

/** A built-in asset wired into a live Output through its own `outputEdges`. */
function withOutput(a: { nodes: AppNode[]; edges: AppEdge[]; outputEdges: AppEdge[] }): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [...a.nodes, makeNode('live-out', 'output')],
    edges: [...a.edges, ...a.outputEdges.map((e) => makeEdge(e.source, e.sourceHandle ?? 'out', 'live-out', e.targetHandle ?? 'color'))],
  };
}

/** A chain feeding nothing: a property, a noise, a multiply. */
function deadChain(): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [
      makeNode('dead-p', 'property_float', { name: 'deadKnob', value: 2 }),
      makeNode('dead-n', 'perlin'),
      makeNode('dead-m', 'mul'),
    ],
    edges: [makeEdge('dead-p', 'out', 'dead-m', 'a'), makeEdge('dead-n', 'out', 'dead-m', 'b')],
  };
}

const ASSETS = [...getBuiltinPresets(), ...getBuiltinTextures()];

describe('graphToCode emitOnly', () => {
  it('a set holding every node is the whole pass, byte for byte (every built-in)', () => {
    for (const a of ASSETS) {
      const g = withOutput(a);
      const all = new Set(g.nodes.map((n) => n.id));
      expect(graphToCode(g.nodes, g.edges, NODE_REGISTRY, { emitOnly: all }).code, a.id).toBe(graphToCode(g.nodes, g.edges).code);
    }
  });

  it('leaving out only frames and notes changes no byte (they emit nothing)', () => {
    for (const a of ASSETS) {
      const g = withOutput(a);
      const nodes = [frame('extra-frame'), note('extra-note'), ...g.nodes];
      const emitting = new Set(nodes.filter((n) => n.type !== 'group' && n.type !== 'note').map((n) => n.id));
      expect(graphToCode(nodes, g.edges, NODE_REGISTRY, { emitOnly: emitting }).code, a.id).toBe(graphToCode(nodes, g.edges).code);
    }
  });

  it('with a dead chain added, the panel renames nothing, declares nothing hidden and parses back (every built-in)', () => {
    for (const a of ASSETS) {
      const g = withOutput(a);
      const dead = deadChain();
      const nodes = [...dead.nodes, ...g.nodes];
      const edges = [...dead.edges, ...g.edges];
      const whole = graphToCode(nodes, edges);
      const { result, emitted } = panelCodegen(nodes, edges, false);
      expect(emitted, a.id).not.toBeNull();
      expect(result.varNames, a.id).toEqual(whole.varNames);
      for (const id of ['dead-p', 'dead-n', 'dead-m']) {
        expect(emitted!.has(id), a.id).toBe(false);
        expect(declares(result.code, whole.varNames.get(id)!), `${a.id} ${id}`).toBe(false);
      }
      expect(declares(whole.code, 'deadKnob'), a.id).toBe(true);
      expect(blocking(result.code), a.id).toEqual([]);
    }
  });

  it('hands a shared texture to the first KEPT image node', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const img = (id: string) => makeNode(id, 'imageNode', { imageB64: PNG, width: 1, height: 1, colorSpace: 'color' });
    const nodes = [img('imgA'), img('imgB'), makeNode('dead', 'mul'), makeNode('out', 'output')];
    const edges = [makeEdge('imgA', 'out', 'dead', 'a'), makeEdge('imgB', 'out', 'out', 'color')];
    const whole = graphToCode(nodes, edges).code;
    const panel = panelCodegen(nodes, edges, false).result.code;
    // Whole: imgA owns `_image1_tex` and imgB shares it. Panel: imgB owns it.
    expect(whole).toContain('"fs-asset:imgA-');
    expect(panel).not.toContain('imgA');
    expect(panel).toContain('"fs-asset:imgB-');
    expect(panel).toContain('const image2 = texture(_image2_tex, uv())');
    expect(declares(panel, 'image1')).toBe(false);
  });

  it('a Data column only a hidden node reads is not declared', () => {
    const data = makeNode('d', 'dataNode');
    (data.data as { dynamicOutputs?: unknown }).dynamicOutputs = [
      { id: 'col0', label: 'a', dataType: 'float' },
      { id: 'col1', label: 'b', dataType: 'float' },
    ];
    const nodes = [data, makeNode('dead', 'mul'), makeNode('out', 'output')];
    const edges = [makeEdge('d', 'col0', 'out', 'roughness'), makeEdge('d', 'col1', 'dead', 'a')];
    expect(graphToCode(nodes, edges).code).toContain('const data1_col1');
    const panel = panelCodegen(nodes, edges, false).result.code;
    expect(panel).toContain('const data1_col0');
    expect(panel).not.toContain('data1_col1');
  });

  it('a Sound node feeding only hidden nodes emits nothing, and keeps its name', () => {
    const nodes = [makeNode('snd', 'soundNode'), makeNode('dead', 'add'), makeNode('f', 'float', { value: 1 }), makeNode('out', 'output')];
    const edges = [makeEdge('snd', 'bass', 'dead', 'a'), makeEdge('f', 'out', 'out', 'roughness')];
    expect(graphToCode(nodes, edges).code).toContain('sound1_bass = uniform(');
    const { result } = panelCodegen(nodes, edges, false);
    expect(result.code).not.toContain('sound1');
    expect(result.varNames.get('snd')).toBe('sound1');
  });

  it('a march scope node that also fed a hidden consumer gets no flat copy', () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('rm', 'raymarchOutput'), makeNode('dead', 'sin')];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), makeEdge('sd', 'out', 'dead', 'x')];
    expect(count(graphToCode(nodes, edges).code, 'const sdCircle1 =')).toBe(2);
    const panel = panelCodegen(nodes, edges, false).result.code;
    expect(count(panel, 'const sdCircle1 =')).toBe(1);
    expect(panel).not.toContain('sin(');
    expect(blocking(panel)).toEqual([]);
  });

  it('a splat scope node that also fed a hidden consumer gets no flat copy', () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('s', 'sin'), makeNode('sp', 'splatOutput'), makeNode('dead', 'cos')];
    const edges = [makeEdge('pos', 'out', 's', 'x'), makeEdge('s', 'out', 'sp', 'color'), makeEdge('s', 'out', 'dead', 'x')];
    expect(count(graphToCode(nodes, edges).code, 'const sin1 =')).toBe(2);
    const panel = panelCodegen(nodes, edges, false).result.code;
    expect(count(panel, 'const sin1 =')).toBe(1);
    expect(panel).not.toContain('cos');
    expect(blocking(panel)).toEqual([]);
  });
});

describe('feedsAnOutputIds', () => {
  it('every sink and everything upstream of one — parked sinks keep their feeders', () => {
    const nodes = [
      makeNode('f1', 'float', { value: 0.5 }),
      makeNode('out1', 'output'),
      makeNode('f2', 'float', { value: 0.2 }),
      makeNode('parked', 'output'),
      makeNode('dead', 'mul'),
    ];
    const edges = [
      makeEdge('f1', 'out', 'out1', 'color'),
      makeEdge('f2', 'out', 'parked', 'color'),
      makeEdge('f1', 'out', 'dead', 'a'),
    ];
    expect([...feedsAnOutputIds(nodes, edges)!].sort()).toEqual(['f1', 'f2', 'out1', 'parked']);
    // The parked sink's feeder is declared (a flat const), so the panel holds it.
    const { result } = panelCodegen(nodes, edges, false);
    expect(result.code).toContain('float(0.2)');
  });

  it('is null with no sink at all, and the panel is then the whole pass', () => {
    const nodes = [makeNode('f1', 'float'), makeNode('m', 'mul')];
    const edges = [makeEdge('f1', 'out', 'm', 'a')];
    expect(feedsAnOutputIds(nodes, edges)).toBeNull();
    const { result, emitted } = panelCodegen(nodes, edges, false);
    expect(emitted).toBeNull();
    expect(result.code).toBe(graphToCode(nodes, edges).code);
  });

  it('`whole` (a study session) is the whole pass with no emitted set', () => {
    const dead = deadChain();
    const nodes = [...dead.nodes, makeNode('f', 'float'), makeNode('out', 'output')];
    const edges = [...dead.edges, makeEdge('f', 'out', 'out', 'color')];
    const { result, emitted } = panelCodegen(nodes, edges, true);
    expect(emitted).toBeNull();
    expect(result.code).toBe(graphToCode(nodes, edges).code);
    expect(result.code).toContain('deadKnob');
  });

  it('holds no frame and no note, and a collapsed group’s dead member stays out (EXPORT keeps it)', () => {
    const g = { ...frame('g'), data: { ...frame('g').data, collapsed: true } } as AppNode;
    const inG = (n: AppNode) => ({ ...n, parentId: 'g' }) as AppNode;
    const nodes = [g, inG(makeNode('f1', 'float')), inG(makeNode('spare', 'float')), note('n'), makeNode('out1', 'output')];
    const edges = [makeEdge('f1', 'out', 'out1', 'color')];
    expect([...feedsAnOutputIds(nodes, edges)!].sort()).toEqual(['f1', 'out1']);
    const exported = connectedExportIds(nodes, edges)!;
    expect(exported.has('spare')).toBe(true);
    expect(exported.has('g')).toBe(true);
    expect(exported.has('n')).toBe(true);
  });

  it('a node an unknown expression READS counts as connected (its bound-reference edge)', () => {
    const u = makeNode('u', 'unknown', { functionName: 'saturate', rawExpression: 'saturate(a, 2)', refs: 'a' });
    const nodes = [makeNode('a', 'float', { value: 0.25 }), u, makeNode('lonely', 'float', { value: 9 }), makeNode('out', 'output')];
    const edges = [makeEdge('a', 'out', 'u', 'ref0'), makeEdge('u', 'out', 'out', 'color')];
    expect([...feedsAnOutputIds(nodes, edges)!].sort()).toEqual(['a', 'out', 'u']);
    const panel = panelCodegen(nodes, edges, false).result.code;
    expect(panel).toContain('const float1 = float(0.25)');
    expect(panel).toContain('saturate(float1, 2)');
    expect(panel).not.toContain('float(9)');
  });

  it('…and so does one parsed from the panel’s own text', () => {
    const parsed = codeToGraph([
      "import { Fn, float } from 'three/tsl';",
      '',
      'const shader = Fn(() => {',
      '  const float1 = float(0.25);',
      '  const helped = saturate(float1, 2);',
      '',
      '  return helped;',
      '});',
      '',
      'export default shader;',
    ].join('\n'));
    const unknown = parsed.nodes.find((n) => n.data.registryType === 'unknown');
    expect(unknown).toBeDefined();
    const ids = feedsAnOutputIds(parsed.nodes, parsed.edges)!;
    const float = parsed.nodes.find((n) => n.data.registryType === 'float')!;
    expect(ids.has(unknown!.id)).toBe(true);
    expect(ids.has(float.id)).toBe(true);
  });
});
