import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { MARCH_DEFAULT_EXPOSED, effectiveExposedPorts, usesExposedPorts, autoExposeConnectedParamPorts } from './exposedPorts';
import { graphToCode } from '@/engine/graphToCode';

/**
 * The Raymarch Output shows its MAIN sockets and hides every setting behind
 * its settings menu (the Output's channel rule, with values editable there).
 */
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('Raymarch Output socket exposure', () => {
  it('exposes the six chain sockets by default and hides every number and light setting', () => {
    const def = NODE_REGISTRY.get('raymarchOutput')!;
    expect(MARCH_DEFAULT_EXPOSED).toEqual(['field', 'color', 'emissive', 'density', 'glow', 'background']);
    for (const p of MARCH_DEFAULT_EXPOSED) expect(def.inputs.some((i) => i.id === p), p).toBe(true);
    const hidden = def.inputs.map((i) => i.id).filter((id) => !MARCH_DEFAULT_EXPOSED.includes(id));
    expect(hidden).toEqual(expect.arrayContaining(['steps', 'stepSize', 'epsilon', 'bend', 'horizon', 'window', 'fieldRadius', 'lightX', 'lightY', 'lightZ', 'lightColor', 'ambient', 'ao', 'shadow', 'stepScale']));
    expect(usesExposedPorts(def)).toBe(true);
    expect(effectiveExposedPorts(makeNode('rm', 'raymarchOutput'))).toBe(MARCH_DEFAULT_EXPOSED);
  });

  it('a wire into a hidden setting exposes it on every ingestion path (autoExpose), keeping the defaults', () => {
    const rm = makeNode('rm', 'raymarchOutput');
    const f = makeNode('f', 'float');
    const nodes = [rm, f];
    autoExposeConnectedParamPorts(nodes, [makeEdge('f', 'out', 'rm', 'steps')]);
    expect(effectiveExposedPorts(rm)).toEqual([...MARCH_DEFAULT_EXPOSED, 'steps']);
  });

  it('a hidden setting still EMITS — it applies whether or not it is wired', () => {
    const pos = makeNode('pos', 'positionLocal');
    const sd = makeNode('sd', 'sdCircle');
    const rm = { ...makeNode('rm', 'raymarchOutput'), data: { ...makeNode('rm', 'raymarchOutput').data, values: { steps: 33, ao: 0.4 } } } as AppNode;
    const code = graphToCode([pos, sd, rm], [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')]).code;
    expect(code).toContain('Loop(int(33)');
    expect(code).toContain('const ao = float(0.4);');
  });

  it('the node renders exposed rows only, re-measures on the exposed set, and skips empty sections (source pins)', () => {
    const node = read('../components/NodeEditor/nodes/RaymarchOutputNode.tsx');
    expect(node).toContain('effectiveExposedPorts({ id, data } as unknown as ShaderFlowNode)');
    expect(node).toContain('}, [id, exposedKey, updateNodeInternals]);');
    expect(node).toContain("ids.includes(p.id) && exposed.has(p.id)");
    expect(node).toContain('config.sections.filter((section) => section.ports.some((p) => exposed.has(p)))');
    const card = read('../components/NodeEditor/NodePreviewCard.tsx');
    expect(card).toContain('new Set<string>(MARCH_DEFAULT_EXPOSED)');
  });

  it('right-click opens the Raymarch settings menu, which toggles sockets and edits values (source pins)', () => {
    const editor = read('../components/NodeEditor/NodeEditor.tsx');
    expect(editor).toContain("raymarchOutput: 'raymarch',");
    const ctx = read('../components/NodeEditor/menus/ContextMenu.tsx');
    expect(ctx).toContain("{type === 'raymarch' && nodeId && <RaymarchSettingsMenu nodeId={nodeId} />}");
    const menu = read('../components/NodeEditor/menus/RaymarchSettingsMenu.tsx');
    expect(menu).toContain('toggleExposedPort(nodeId, exposedPorts, portId)');
    expect(menu).toContain('onCommit={(v) => setValue(portId, setting.clamp(v))}');
    expect(menu).toContain('history="bracket"');
    // Hiding keeps the value: the menu never clears values on a toggle.
    expect(menu).not.toContain('valuesWithout(');
  });
});
