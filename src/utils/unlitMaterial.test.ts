/**
 * The Unlit material (unlit) — utils/unlitMaterial.ts, loader 0.8 delta 13
 * (behaviour pinned in shaderloader08Core.test.ts). Here: the setting's
 * round trip, the module, the price and the menu/node wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, MaterialSettings } from '@/types';
import { materialSettingProps, materialSettingsFromSource } from '@/engine/materialSettingsCode';
import { buildShaderModule } from '@/engine/tslCodeProcessor';
import { graphToCode } from '@/engine/graphToCode';
import { scriptToTSLWithSettings } from '@/engine/scriptToTSL';
import { computeReachableCost, sinkCosts } from '@/utils/nodeCost';
import {
  UNLIT_HINT_KEY, UNLIT_IGNORED_CHANNELS, UNLIT_OFF_HINT_KEY, isUnlitSettings, unlitPortLabel,
} from './unlitMaterial';

const outWith = (settings: MaterialSettings | undefined, exposed: string[]): AppNode => {
  const out = makeNode('out', 'output');
  (out.data as { exposedPorts?: string[] }).exposedPorts = exposed;
  if (settings) (out.data as { materialSettings?: MaterialSettings }).materialSettings = settings;
  return out;
};

describe('the setting', () => {
  it('is stored and emitted only as true, last, and parses back', () => {
    expect(materialSettingProps({ unlit: true })).toEqual(['unlit: true']);
    expect(materialSettingProps({ flatShading: true, unlit: true })).toEqual(['flatShading: true', 'unlit: true']);
    expect(materialSettingProps({})).toEqual([]);
    expect(materialSettingProps({ unlit: 'yes' as unknown as boolean })).toEqual([]);
    expect(materialSettingsFromSource({ unlit: 'true' })).toEqual({ unlit: true });
    expect(materialSettingsFromSource({ unlit: 'false' })).toBeUndefined();
    expect(isUnlitSettings({ unlit: true })).toBe(true);
    for (const v of [undefined, null, {}, { unlit: 1 }, { unlit: 'true' }]) expect(isUnlitSettings(v)).toBe(false);
  });

  it('survives export → import', () => {
    const tsl = `import { Fn, color } from 'three/tsl';\nconst shader = Fn(() => {\n  return { color: color(0xff0000) };\n});\nexport default shader;\n`;
    const back = scriptToTSLWithSettings(buildShaderModule(tsl, { materialSettings: { unlit: true } }));
    expect(back.materialSettings).toEqual({ unlit: true });
    expect(back.code).not.toContain('unlit');
  });
});

describe('the module', () => {
  const noise = makeNode('n', 'perlin');
  const edges = [makeEdge('n', 'out', 'out', 'position'), makeEdge('n', 'out', 'out', 'color')];

  it('an unlit material gets no normal recompute — it reads no normal', () => {
    const lit = buildShaderModule(graphToCode([noise, outWith(undefined, ['color', 'position'])], edges).code, {});
    expect(lit).toContain('__fsDisplaced0(');
    const unlit = buildShaderModule(
      graphToCode([noise, outWith({ unlit: true }, ['color', 'position'])], edges).code,
      { materialSettings: { unlit: true } },
    );
    expect(unlit).not.toContain('__fsDisp');
    expect(unlit).toContain('unlit: true');
  });

  it('drops the separate Emissive (its Color IS the emission) — the panel code keeps it, a lit material keeps it', () => {
    const c = makeNode('c', 'cellNoise');
    const g = makeNode('g', 'perlin');
    const e = [makeEdge('c', 'out', 'out', 'color'), makeEdge('g', 'out', 'out', 'emissive')];
    const code = graphToCode([c, g, outWith({ unlit: true }, ['color', 'emissive'])], e).code;
    expect(code).toContain('emissive:');
    expect(buildShaderModule(code, { materialSettings: { unlit: true } })).not.toContain('emissiveNode');
    expect(buildShaderModule(code, {})).toContain('emissiveNode');
    // An emissive-only unlit material shows the default colour, not the dormant channel.
    const only = graphToCode([g, outWith({ unlit: true }, ['emissive'])], [e[1]]).code;
    expect(buildShaderModule(only, { materialSettings: { unlit: true } })).not.toContain('emissiveNode');
  });

  it('drops it from an unlit PART body too, and only there', () => {
    const tsl = `import { Fn, color } from 'three/tsl';\nconst shader = Fn(() => {\n  return { color: color(0xff0000), parts: { "A": { color: color(0x00ff00), emissive: color(0x0000ff), unlit: true }, "B": { color: color(0x00ff00), emissive: color(0x0000ff) } } };\n});\nexport default shader;\n`;
    const mod = buildShaderModule(tsl, {});
    const a = mod.slice(mod.indexOf('"A"'), mod.indexOf('"B"'));
    const b = mod.slice(mod.indexOf('"B"'));
    expect(a).toContain('unlit: true');
    expect(a).not.toContain('emissiveNode');
    expect(b).toContain('emissiveNode');
  });
});

describe('the price', () => {
  it('a chain feeding only a channel the Unlit material ignores is not priced', () => {
    const r = makeNode('r', 'perlin');
    const c = makeNode('c', 'cellNoise');
    const e = [makeEdge('r', 'out', 'out', 'roughness'), makeEdge('c', 'out', 'out', 'color')];
    const lit = outWith(undefined, ['color', 'roughness']);
    const unlit = outWith({ unlit: true }, ['color', 'roughness']);
    const colourOnly = computeReachableCost([c, lit], [e[1]]);
    expect(computeReachableCost([r, c, lit], e)).toBeGreaterThan(colourOnly);
    expect(computeReachableCost([r, c, unlit], e)).toBe(colourOnly);
    expect(sinkCosts([r, c, unlit], e).get('out')).toBe(colourOnly);
  });

  it('a feeder shared with Color is still priced once', () => {
    const n = makeNode('n', 'perlin');
    const e = [makeEdge('n', 'out', 'out', 'roughness'), makeEdge('n', 'out', 'out', 'color')];
    const unlit = outWith({ unlit: true }, ['color', 'roughness']);
    expect(computeReachableCost([n, unlit], e)).toBe(computeReachableCost([n, unlit], [e[1]]));
  });

  it('a displacement on an unlit material pays no normal recompute', () => {
    const n = makeNode('n', 'perlin');
    const e = [makeEdge('n', 'out', 'out', 'position')];
    expect(computeReachableCost([n, outWith({ unlit: true }, ['position'])], e))
      .toBe(computeReachableCost([n, outWith({ flatShading: true }, ['position'])], e));
  });
});

describe('the menu and the node', () => {
  const MENU = readFileSync(resolve(__dirname, '../components/NodeEditor/menus/ShaderSettingsMenu.tsx'), 'utf8');
  const NODE = readFileSync(resolve(__dirname, '../components/NodeEditor/nodes/OutputNode.tsx'), 'utf8');

  it('switches the ignored channels OFF — guarded and aria-disabled, never `disabled`, so the tooltip opens', () => {
    expect(MENU).toContain('off={unlit ? UNLIT_IGNORED_CHANNELS : undefined}');
    expect(MENU).toContain("onChange={() => { if (!isOff) onToggle(portId); }}");
    expect(MENU).toContain('aria-disabled={isOff || undefined}');
    expect(MENU).toContain('aria-disabled={unlit || undefined}');
    expect(MENU).not.toMatch(/\sdisabled=\{/);
    expect(MENU).toContain("updateSettings({ unlit: e.target.checked ? true : undefined })");
  });

  it('the Output node HIDES those rows, writing nothing — wires and exposure stay, so unticking restores them', () => {
    expect(NODE).toContain('!(unlit && UNLIT_IGNORED_CHANNELS.has(p.id))');
    expect(NODE).toContain('}, [id, exposedKey, unlit, updateNodeInternals]);');
    expect(NODE).not.toContain('output-node__row--off');
    // The hiding is a render filter: no write path may mention Unlit in the node.
    expect(NODE).not.toMatch(/updateNodeData\([^)]*unlit/);
    expect([...UNLIT_IGNORED_CHANNELS].sort()).toEqual(['emissive', 'env', 'metalness', 'normal', 'roughness']);
  });

  it('labels Color "Emissive" while Unlit is on — display only, the handle id stays `color`', () => {
    expect(unlitPortLabel('color', 'Color', true)).toBe('Emissive');
    expect(unlitPortLabel('color', 'Color', false)).toBe('Color');
    expect(unlitPortLabel('opacity', 'Opacity', true)).toBe('Opacity');
    expect(NODE).toContain('label={unlitPortLabel(port.id, port.label, unlit)}');
    expect(NODE).toContain('id={handle}');
  });

  it('carries its Latvian', () => {
    const LV = JSON.parse(readFileSync(resolve(__dirname, '../i18n/lv.json'), 'utf8')) as { ui?: Record<string, string> };
    for (const k of ['Unlit', UNLIT_HINT_KEY, UNLIT_OFF_HINT_KEY]) expect(LV.ui?.[k], k).toBeTruthy();
  });
});
