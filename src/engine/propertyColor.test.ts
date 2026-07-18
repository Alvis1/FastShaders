/**
 * Colour uniforms (property_color) — emission, parsing, schema, evaluation,
 * and the constant ↔ uniform conversion helper.
 */
import { describe, it, expect } from 'vitest';
import { graphToCode, hexLiteral } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildShaderModule } from './tslCodeProcessor';
import { scriptToTSL } from './scriptToTSL';
import { evaluateNodeOutput } from './cpuEvaluator';
import { convertPropertyNode, nextPropertyName } from '@/utils/propertyConvert';
import { getNodeValues } from '@/types';
import { makeNode, makeEdge } from '@/test-utils';

function emit(hex: string, name = 'tint') {
  const pc = makeNode('pc', 'property_color', { hex, name });
  const out = makeNode('out', 'output');
  return graphToCode([pc, out], [makeEdge('pc', 'out', 'out', 'color')]).code;
}

describe('property_color — emission', () => {
  it('emits a colour-valued uniform, not a float of the hex bits', () => {
    const code = emit('#22aa5e');
    expect(code).toContain('const tint = uniform(color(0x22aa5e));');
    expect(code).not.toContain('uniform(0x22aa5e)');
  });

  it('degrades a malformed stored hex to black instead of splicing it into code', () => {
    // Adversarial .fastshader payload: hex that tries to break out of the call.
    const code = emit("#ff0000); evil(");
    expect(code).toContain('uniform(color(0x000000))');
    expect(code).not.toContain('evil');
  });
});

describe('hexLiteral — adversarial hex handling', () => {
  it('passes a well-formed hex through', () => {
    expect(hexLiteral('#A1b2C3')).toBe('0xA1b2C3');
  });
  for (const bad of ['#fff', 'ff0000', '#gg0000', '', null, undefined, '#ff0000; x']) {
    it(`degrades ${JSON.stringify(bad)} to black`, () => {
      expect(hexLiteral(bad)).toBe('0x000000');
    });
  }
});

describe('property_color — round trip', () => {
  it('parses uniform(color(0x…)) back to a property_color with name + hex', () => {
    const back = codeToGraph(emit('#22aa5e'));
    const node = back.nodes.find((n) => n.data.registryType === 'property_color');
    expect(node).toBeTruthy();
    expect(getNodeValues(node!)).toMatchObject({ hex: '#22aa5e', name: 'tint' });
    // Crucially it must NOT decompose into color → property_float.
    expect(back.nodes.some((n) => n.data.registryType === 'property_float')).toBe(false);
    expect(back.errors).toEqual([]);
  });
});

describe('property_color — module schema', () => {
  it("emits a quoted type:'color' schema entry and rewrites the line to params", () => {
    const moduleCode = buildShaderModule(emit('#22aa5e'));
    expect(moduleCode).toContain("tint: { type: 'color', default: '#22aa5e' }");
    expect(moduleCode).toContain('const tint = params.tint;');
    expect(moduleCode).not.toContain('uniform(color(');
  });

  it('keeps float schema entries unchanged alongside a colour', () => {
    const pc = makeNode('pc', 'property_color', { hex: '#010203', name: 'tint' });
    const pf = makeNode('pf', 'property_float', { value: 0.5, name: 'speed' });
    const mixN = makeNode('m', 'mul');
    const out = makeNode('out', 'output');
    const { code } = graphToCode([pc, pf, mixN, out], [
      makeEdge('pc', 'out', 'm', 'a'),
      makeEdge('pf', 'out', 'm', 'b'),
      makeEdge('m', 'out', 'out', 'color'),
    ]);
    const moduleCode = buildShaderModule(code);
    expect(moduleCode).toContain("tint: { type: 'color', default: '#010203' }");
    expect(moduleCode).toContain("speed: { type: 'number', default: 0.5 }");
  });
});

describe('explicit schema pass — sanitized-name collisions', () => {
  it('keeps BOTH unwired properties whose names sanitize identically', () => {
    const moduleCode = buildShaderModule('const x = Fn(() => { return vec3(1, 0, 0); })();', {
      properties: [
        { name: 'my speed', defaultValue: 1 },
        { name: 'my-speed', defaultValue: 2 },
      ],
    });
    expect(moduleCode).toContain("my_speed: { type: 'number', default: 1 }");
    expect(moduleCode).toContain("my_speed2: { type: 'number', default: 2 }");
  });
});

describe('scriptToTSL — bare-module colour re-import', () => {
  it('re-imports a colour schema entry as a colour uniform, not float = 1', () => {
    // The exported module WITHOUT its project block (hand-shared / copied
    // Script-tab text) goes through scriptToTSL. Its schema reader used to
    // parseFloat('#22aa5e') → NaN → drop, hoisting `uniform(1)` — the colour
    // and its type silently vanished.
    const moduleCode = buildShaderModule(emit('#22aa5e'));
    const tsl = scriptToTSL(moduleCode);
    expect(tsl).toContain('uniform(color(0x22aa5e))');
    const back = codeToGraph(tsl);
    const node = back.nodes.find((n) => n.data.registryType === 'property_color');
    expect(node).toBeTruthy();
    expect(getNodeValues(node!)).toMatchObject({ hex: '#22aa5e', name: 'tint' });
    expect(back.nodes.some((n) => n.data.registryType === 'property_float')).toBe(false);
  });
});

describe('property name pre-claim — swatch collision', () => {
  it("a Color swatch never steals a colour property's name (schema key = emitted var = property name)", () => {
    // Swatch FIRST in node order: before the pre-claim pass it grabbed
    // `color1`, bumping the property to `color12` — and the exported schema +
    // usage header then documented `color1`, a key the body never read.
    const sw = makeNode('sw', 'color', { hex: '#00ff00' });
    const pc = makeNode('pc', 'property_color', { hex: '#ff0000', name: 'color1' });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([sw, pc, out], [
      makeEdge('sw', 'out', 'out', 'emissive'),
      makeEdge('pc', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('const color1 = uniform(color(0xff0000));');
    const moduleCode = buildShaderModule(code);
    expect(moduleCode).toContain("color1: { type: 'color', default: '#ff0000' }");
    expect(moduleCode).toContain('const color1 = params.color1;');
    expect(moduleCode).not.toContain('color12');
  });
});

describe('property_color — CPU evaluation', () => {
  it('evaluates to the hex as rgb01 triple', () => {
    const n = makeNode('n', 'property_color', { hex: '#ff8000', name: 'tint' });
    const res = evaluateNodeOutput('n', [n], [], 0);
    expect(res).not.toBeNull();
    expect(res![0]).toBeCloseTo(1, 5);
    expect(res![1]).toBeCloseTo(0x80 / 255, 5);
    expect(res![2]).toBeCloseTo(0, 5);
  });
});

describe('convertPropertyNode — constant ↔ uniform', () => {
  it('color → property_color keeps id/position, carries hex, mints a name, flips flow type', () => {
    const c = makeNode('c', 'color', { hex: '#123456' });
    c.type = 'color' as never;
    const converted = convertPropertyNode(c, 'property_color', [c]);
    expect(converted).toBeTruthy();
    expect(converted!.id).toBe('c');
    expect(converted!.type).toBe('shader');
    expect(converted!.data.registryType).toBe('property_color');
    expect(getNodeValues(converted!)).toMatchObject({ hex: '#123456', name: 'color1' });
  });

  it('float → property_float carries value; reverse drops the name', () => {
    const f = makeNode('f', 'float', { value: 2.5 });
    const up = convertPropertyNode(f, 'property_float', [f])!;
    expect(getNodeValues(up)).toMatchObject({ value: 2.5, name: 'property1' });
    const down = convertPropertyNode(up, 'float', [up])!;
    expect(getNodeValues(down)).toMatchObject({ value: 2.5 });
    expect(getNodeValues(down).name).toBeUndefined();
  });

  it('property_color → color flips flow type back to the swatch', () => {
    const pc = makeNode('pc', 'property_color', { hex: '#abcdef', name: 'color3' });
    const down = convertPropertyNode(pc, 'color', [pc])!;
    expect(down.type).toBe('color');
    expect(getNodeValues(down)).toMatchObject({ hex: '#abcdef' });
  });

  it('nextPropertyName counts across both property kinds', () => {
    const a = makeNode('a', 'property_color', { hex: '#000000', name: 'color7' });
    expect(nextPropertyName('color', [a])).toBe('color8');
    expect(nextPropertyName('property', [a])).toBe('property1');
  });
});
