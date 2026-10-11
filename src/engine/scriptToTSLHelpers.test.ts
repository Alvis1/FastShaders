import { describe, it, expect } from 'vitest';
import { scriptToTSL } from './scriptToTSL';
import { buildShaderModule } from './tslCodeProcessor';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { MODULE_HELPERS } from './moduleHelpers';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * The `.js → editor` direction keeps module-scope helper declarations, because
 * the editor code and the live preview still CALL them. It used to keep only
 * `hsl`/`toHsl` (a hard-coded regex), so a `.js` using Brightness/Contrast, a
 * distance field or Ray Direction came into the editor calling a helper nothing
 * declared. The regex is now built from the one table, `Fn` and plain-JS alike.
 */

const roundTrip = (editorCode: string) => scriptToTSL(buildShaderModule(editorCode));

describe('scriptToTSL keeps every module helper the module declares', () => {
  for (const [type, helper, port] of [
    ['brightContrast', 'brightContrast', 'color'],
    ['sdCircle', 'sdCircle', 'p'],
    // (rayDirection is not here: a zero-parameter helper is INLINED by scriptToTSL's own pass.)
  ] as const) {
    it(`${type}: the ${helper} declaration survives, and the editor code parses back to the node`, () => {
      const uv = makeNode('uv', 'uv');
      const n = makeNode('n', type);
      const out = makeNode('out', 'output');
      const edges = [makeEdge('n', 'out', 'out', 'color')];
      if (port) edges.push(makeEdge('uv', 'out', 'n', port));
      const code = graphToCode([uv, n, out], edges).code;
      expect(code).toContain(`const ${helper} = Fn(`);
      const back = roundTrip(code);
      expect(back.split(`const ${helper} = Fn(`)).toHaveLength(2);
      // the whole declaration, not just its first line
      const lines = MODULE_HELPERS.get(helper)!.lines;
      expect(back).toContain(lines[lines.length - 2]);
      const r = codeToGraph(back);
      expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
      expect(r.nodes.some((x) => x.data.registryType === type)).toBe(true);
    });
  }

  it('a plain-JS helper (fsLut) survives whole, braces counted on the MASKED line', () => {
    const base = graphToCode([makeNode('f', 'float'), makeNode('out', 'output')], [makeEdge('f', 'out', 'out', 'roughness')]).code;
    const fsLut = MODULE_HELPERS.get('fsLut')!.lines;
    // A helper line whose STRING holds a brace must not move the depth.
    const editor = base.replace('\nconst shader = Fn(', `\n${fsLut.join('\n')}\nconst fsLutProbe = '{';\n\nconst shader = Fn(`);
    const back = roundTrip(editor);
    // Kept VERBATIM from the module, where buildShaderModule bound `globalThis.THREE` to an imported
    // namespace — so the namespace import rides along and the editor code stays self-consistent.
    for (const line of fsLut) expect(back).toContain(line.replace(/globalThis\.THREE/g, 'THREE'));
    expect(back).toContain("import * as THREE from 'three/webgpu';");
    // the shader body is still found after it
    expect(back).toContain('const shader = Fn(() => {');
    expect(back).toContain('roughness');
    // …and the editor code parses: the helper is skipped by name, the shader still reads.
    const r = codeToGraph(back);
    expect(r.errors).toEqual([]);
    expect(r.nodes.map((x) => x.data.registryType).sort()).toEqual(['float', 'output']);
  });

  it('a .js with a Color Ramp keeps fsLut AND fsColorRamp, and parses back to the node with its stops', () => {
    const stops = '0 #ff0000 1,0.5 #0000ff 0.25';
    const code = graphToCode(
      [makeNode('c', 'colorRamp', { fac: 0.3, stops, interp: 'constant' }), makeNode('out', 'output')],
      [makeEdge('c', 'out', 'out', 'color'), makeEdge('c', 'alpha', 'out', 'opacity')],
    ).code;
    const back = roundTrip(code);
    expect(back.split('const fsLut = (() => {')).toHaveLength(2);
    expect(back.split('const fsColorRamp = (fac, stops, interp) => {')).toHaveLength(2);
    const r = codeToGraph(back);
    expect(r.errors).toEqual([]);
    const ramp = r.nodes.find((x) => x.data.registryType === 'colorRamp')!;
    expect(ramp).toBeDefined();
    expect((ramp.data as { values: Record<string, unknown> }).values).toMatchObject({ fac: 0.3, stops, interp: 'constant' });
    expect(r.edges.map((e) => `${e.sourceHandle}->${e.targetHandle}`).sort()).toEqual(['alpha->opacity', 'out->color']);
  });

  it('a .js with RGB Curves keeps fsLut AND fsRgbCurves, and parses back to the node with its curves', () => {
    const curveC = '0 0,0.25 0.15,0.75 0.85,1 1';
    const code = graphToCode(
      [makeNode('k', 'rgbCurves', { color: 0.4, fac: 0.8, curveC, extend: 'horizontal' }), makeNode('out', 'output')],
      [makeEdge('k', 'out', 'out', 'color')],
    ).code;
    const back = roundTrip(code);
    expect(back.split('const fsLut = (() => {')).toHaveLength(2);
    expect(back.split('const fsRgbCurves = (col, fac, curveC, curveR, curveG, curveB, extend) => {')).toHaveLength(2);
    const r = codeToGraph(back);
    expect(r.errors).toEqual([]);
    const k = r.nodes.find((x) => x.data.registryType === 'rgbCurves')!;
    expect((k.data as { values: Record<string, unknown> }).values).toEqual({ color: 0.4, fac: 0.8, curveC, extend: 'horizontal' });
  });
});
