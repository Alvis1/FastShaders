/**
 * DROPPED CODE (owner, 2026-11-26): code the graph cannot hold used to vanish
 * on Apply with `errors: []`. Every such spot now warns: what was lost, why,
 * and what to write instead (codeToGraph.ts, `droppedWhy`).
 *
 * Two halves. The warnings themselves, one per case. And the sweep that keeps
 * them honest: no code the APP writes — every node type, pictures, data charts,
 * the SDF and splat outputs, per-mesh materials, the intro's code slide, the
 * "?" prompt's example — ever reads as dropped, since a warning on every Apply
 * would teach everyone to ignore it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { codeToGraph } from './codeToGraph';
import { graphToCode } from './graphToCode';
import { loadUnknownExpressionValidator } from './unknownExpression';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '@/test-utils';
import { makeDataNodeData } from '@/utils/dataNode';
import { codeSnapshots } from '@/intro/codeTour';
import { EXTERNAL_EXAMPLE } from '@/llm/externalPrompt';
import type { AppNode, AppEdge } from '@/types';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import lv from '@/i18n/lv.json';

beforeAll(() => loadUnknownExpressionValidator());

const wrap = (body: string, imports = 'Fn, color, float, mul, mx_noise_float, positionGeometry, sin, time') =>
  `import { ${imports} } from "three/tsl";\n\nconst shader = Fn(() => {\n${body}\n});\nexport default shader;`;
const warningsOf = (code: string) => codeToGraph(code).errors;
const messages = (code: string) => warningsOf(code).map((e) => e.message);

/** The messages this change added — every older warning says something else. */
const DROPPED = /was dropped —|is not an input or a node declared above|extra arguments? dropped —|that part of the vector stays 0|lost its value —|was read as ONE component —/;
const droppedIn = (code: string) => warningsOf(code).filter((e) => DROPPED.test(e.message)).map((e) => `L${e.line}: ${e.message}`);

describe('code that cannot become a node says so', () => {
  it('a plain-number const, once — its later reads stay quiet', () => {
    const errors = warningsOf(wrap('  const scale = 3;\n  const p = mul(positionGeometry, scale);\n  const n = mx_noise_float(p);\n  return n;'));
    expect(errors.map((e) => e.message)).toEqual(['"scale = 3" was dropped — a plain number is not a node; write float(3).']);
    expect(errors[0]).toMatchObject({ line: 4, severity: 'warning' });
  });

  it('an operator, with the function to write instead', () => {
    expect(messages(wrap('  const n = mx_noise_float(positionGeometry) * 0.5;\n  return n;'))).toEqual([
      '"n = mx_noise_float(positionGeometry) * 0.5" was dropped — shader values have no * operator; write mul(mx_noise_float(positionGeometry), 0.5).',
    ]);
    expect(messages(wrap('  const a = float(0.5);\n  const b = -a;\n  return b;'))).toEqual([
      '"b = -a" was dropped — shader values have no - sign; write mul(a, -1).',
    ]);
    // The fix is WHOLE: every operator of the line, not only the outermost
    // (which sent the user back for a second warning about the inner one).
    expect(messages(wrap('  const n = mx_noise_float(positionGeometry) * 0.5 + 0.5;\n  return n;'))).toEqual([
      '"n = mx_noise_float(positionGeometry) * 0.5 + 0.5" was dropped — shader values have no + operator; write add(mul(mx_noise_float(positionGeometry), 0.5), 0.5).',
    ]);
    expect(messages(wrap('  const a = float(0.5);\n  const b = -a * (1 / 4) - 2;\n  return b;'))).toEqual([
      '"b = -a * (1 / 4) - 2" was dropped — shader values have no - operator; write sub(mul(mul(a, -1), 1 / 4), 2).',
    ]);
    // …and written that way, it IS read.
    expect(messages(wrap('  const n = add(mul(mx_noise_float(positionGeometry), 0.5), 0.5);\n  return n;', 'Fn, add, mul, mx_noise_float, positionGeometry'))).toEqual([]);
    expect(messages(wrap('  const a = float(0.5);\n  const b = sub(mul(mul(a, -1), 1 / 4), 2);\n  return b;', 'Fn, float, mul, sub'))).toEqual([]);
    // Inside a call, the older "Cannot represent" line now says what to write.
    expect(messages(wrap('  const t = time;\n  const s = sin(t * 2);\n  return s;'))).toEqual([
      'Cannot represent "t * 2" (argument of sin) — the port keeps its default value (shader values have no * operator; write mul(t, 2)).',
    ]);
  });

  it('a ternary, a function of your own, a destructuring', () => {
    expect(messages(wrap('  const n = mx_noise_float(positionGeometry);\n  const c = n > 0.5 ? color(0xff0000) : color(0x0000ff);\n  return c;'))[0])
      .toBe('"c = n > 0.5 ? color(0xff0000) : color(0x0000ff)" was dropped — a ? b : c is not a node; write select(condition, ifTrue, ifFalse).');
    expect(messages(wrap('  const twice = (x) => mul(x, 2);\n  const v = twice(time);\n  return v;'))).toEqual([
      '"twice = (x) => mul(x, 2)" was dropped — a function of your own is not a node; write its steps in the shader itself.',
      'Unknown function: twice',
    ]);
    expect(messages(wrap('  const { x, y } = positionGeometry;\n  return x;'))).toEqual([
      '"{ x, y } = positionGeometry" was dropped — a destructured name is not a node; give each value its own const.',
    ]);
  });

  it('a bare number or an operator in an Output channel, with the form that channel takes', () => {
    expect(messages(wrap('  const base = color(0x3366ff);\n  return { color: base, roughness: 0.3, emissive: 0 };'))).toEqual([
      '"roughness: 0.3" was dropped — a plain number is not a node; write roughness: float(0.3).',
      '"emissive: 0" was dropped — a plain number is not a node; write emissive: color(0xRRGGBB).',
    ]);
    expect(messages(wrap('  const a = color(0x3366ff);\n  const b = float(0.5);\n  return { color: a * b };'))).toEqual([
      '"color: a * b" was dropped — shader values have no * operator; write mul(a, b).',
    ]);
    // The stored form itself is read, as ever.
    expect(messages(wrap('  const base = color(0x3366ff);\n  return { color: base, roughness: float(0.3) };'))).toEqual([]);
  });

  it('a return and a Discard that read nothing', () => {
    expect(messages(wrap('  return 0.5;'))).toEqual(['"return 0.5" was dropped — a plain number is not a node; write float(0.5).']);
    expect(messages(wrap('  const n = mx_noise_float(positionGeometry);\n  Discard(n > 0.5);\n  return n;', 'Fn, Discard, mx_noise_float, positionGeometry'))).toEqual([
      '"Discard(n > 0.5)" was dropped — shader values have no > operator; write greaterThan(n, 0.5).',
    ]);
  });

  it('a name declared nowhere, wherever it is read', () => {
    expect(messages(wrap('  const n = mx_noise_float(positonGeometry);\n  const m = mul(n, scal);\n  return { color: m, opacity: alfa };'))).toEqual([
      '"positonGeometry" (the position of mx_noise_float) is not an input or a node declared above — the noise reads positionGeometry.',
      '"scal" (argument of mul) is not an input or a node declared above — the port keeps its default value.',
      '"opacity: alfa" was dropped — "alfa" is not an input or a node declared above.',
    ]);
    expect(messages(wrap('  const m = foo.mul(2);\n  return m;'))).toEqual([
      '"foo" (the value mul is called on) is not an input or a node declared above — mul\'s first input keeps its default value.',
    ]);
  });

  it('an argument past the last socket', () => {
    expect(messages(wrap('  const s = sin(time, 2);\n  return s;'))).toEqual(['sin: 1 extra argument dropped — "2".']);
  });

  it('a module-level constant, and a bare body\'s own top level', () => {
    expect(messages('import { Fn, mul, positionGeometry } from "three/tsl";\nconst SCALE = 4.0;\nconst shader = Fn(() => {\n  const p = mul(positionGeometry, SCALE);\n  return p;\n});\nexport default shader;'))
      .toEqual(['"SCALE = 4.0" was dropped — a plain number is not a node; write float(4).']);
    expect(messages('const k = 2;\nconst n = mx_noise_float(positionGeometry);\nreturn { color: n, roughness: k };'))
      .toEqual(['"k = 2" was dropped — a plain number is not a node; write float(2).']);
  });

  it('only an unknown function is KEPT — the banner says "not applied" under every other warning', () => {
    const errors = warningsOf(wrap('  const v = hash(time);\n  const w = v * 2;\n  return w;', 'Fn, hash, time'));
    expect(errors.find((e) => e.message === 'Unknown function: hash')?.kept).toBe(true);
    expect(errors.find((e) => e.message.startsWith('"w = v * 2"'))?.kept).toBeUndefined();
  });
});

/**
 * MORE COMPATIBILITY WHEN PASTING IN (owner, 2026-11-26): the forms a chat AI
 * writes when it follows three.js instead of the "?" prompt. Each was a silent
 * misread — measured the same day — and is now read exactly, or says so.
 */
describe('forms a pasted reply uses', () => {
  const regenerated = (code: string) => {
    const r = codeToGraph(code);
    return graphToCode(r.nodes, r.edges).code;
  };

  it('vec3(x) with ONE number is that number in every component, as in TSL', () => {
    const code = wrap('  const g = vec3(0.5);\n  return g;', 'Fn, vec3');
    expect(warningsOf(code)).toEqual([]);
    expect(regenerated(code)).toContain('vec3(0.5, 0.5, 0.5)');
    // …and a constant written as arithmetic or as π.
    expect(regenerated(wrap('  const g = vec2(1 / 4);\n  return vec3(g.x, g.y, 0);', 'Fn, vec2, vec3'))).toContain('vec2(0.25, 0.25)');
  });

  it('vec3(n) with one ONE-CHANNEL wire feeds every socket (it was read as (n, 0, 0): grey came back red)', () => {
    for (const body of [
      '  const n = mx_noise_float(positionGeometry);\n  const c = vec3(n);\n  return c;',
      '  const c = vec3(mx_noise_float(positionGeometry));\n  return c;',
      '  const n = mx_noise_float(positionGeometry);\n  const f = float(n);\n  const c = vec3(f);\n  return c;',
    ]) {
      const code = wrap(body, 'Fn, float, mx_noise_float, positionGeometry, vec3');
      expect(warningsOf(code), body).toEqual([]);
      expect(regenerated(code), body).toContain('vec3(noise1, noise1, noise1)');
    }
  });

  it('a WIDER wire in a one-value vector cannot be held, and says so', () => {
    const errors = warningsOf(wrap('  const p = positionGeometry;\n  const c = vec3(p);\n  return c;', 'Fn, positionGeometry, vec3'));
    expect(errors.map((e) => e.message)).toEqual([
      '"vec3(p)" was read as ONE component — a vec3 node takes one number per socket; write each: vec3(a.x, a.y, a.z).',
    ]);
    expect(errors[0]).toMatchObject({ line: 5, severity: 'warning' });
    expect(errors[0].kept).toBeUndefined();
  });

  it('three.js\'s own channel names are read where the module builder only renames them', () => {
    const code = wrap(
      '  const c = vec3(0.1, 0.2, 0.8);\n  const n = heightToNormal(mx_noise_float(positionGeometry), 1);\n  return { colorNode: c, emissiveNode: c, normalNode: n, roughnessNode: float(0.4), metalnessNode: float(1), opacityNode: float(0.5) };',
      'Fn, float, heightToNormal, mx_noise_float, positionGeometry, vec3',
    );
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    const output = r.nodes.find((n) => n.data.registryType === 'output')!;
    expect(r.edges.filter((e) => e.target === output.id).map((e) => e.targetHandle).sort()).toEqual(['color', 'emissive', 'normal']);
    expect((output.data as { values?: Record<string, unknown> }).values).toMatchObject({ roughness: 0.4, metalness: 1, opacity: 0.5 });
    // The same names inside a per-mesh material's body — which a bare-script
    // import of an exported module hands over unreversed (scriptToTSL.ts).
    const parts = codeToGraph(wrap('  const c = vec3(0.1, 0.2, 0.8);\n  return { parts: { "Glass": { colorNode: c, roughnessNode: float(0.2) } } };', 'Fn, float, vec3'));
    expect(parts.errors).toEqual([]);
    const glass = parts.nodes.filter((n) => n.data.registryType === 'output').find((n) => parts.edges.some((e) => e.target === n.id))!;
    expect(parts.edges.filter((e) => e.target === glass.id).map((e) => e.targetHandle)).toEqual(['color']);
    expect((glass.data as { values?: Record<string, unknown> }).values).toMatchObject({ roughness: 0.2 });
  });

  it('a channel the Output does not have names the ones it has — never a dead wire', () => {
    const code = wrap('  const n = mx_noise_float(positionGeometry);\n  return { color: n, alpha: n, positionNode: n };', 'Fn, mx_noise_float, positionGeometry');
    const r = codeToGraph(code);
    const sockets = NODE_REGISTRY.get('output')!.inputs.map((p) => p.id);
    expect(r.errors.map((e) => e.message)).toEqual([
      `"alpha: n" was dropped — the Output has no "alpha" channel; its channels are ${sockets.join(', ')}.`,
      // three's positionNode is the WHOLE position, the Output's only the
      // amount (the module builder wraps it): read as one, it displaces twice.
      '"positionNode: n" was dropped — the Output\'s "position" channel takes only how far to move along the normal (a float), not the whole position.',
    ]);
    const output = r.nodes.find((n) => n.data.registryType === 'output')!;
    for (const e of r.edges.filter((x) => x.target === output.id)) expect(sockets).toContain(e.targetHandle);
  });

  it('a dropped value under three\'s key is quoted as written, and the fix names the Output\'s channel', () => {
    expect(messages(wrap('  const c = vec3(0.1, 0.2, 0.8);\n  return { colorNode: c, roughnessNode: 0.3 };', 'Fn, vec3'))).toEqual([
      '"roughnessNode: 0.3" was dropped — a plain number is not a node; write roughness: float(0.3).',
    ]);
  });

  it('a raw module\'s own non-channel key is no dropped channel', () => {
    // buildShaderModule writes `uvDisplaced` (module-only); pasted with the rest
    // of an exported module it is skipped like the material settings beside it.
    expect(messages(wrap('  const c = vec3(0.1, 0.2, 0.8);\n  return { colorNode: c, uvDisplaced: false, transparent: true, side: 2 };', 'Fn, vec3'))).toEqual([]);
  });

  it('a uniform reads a number or a hex colour however it is spelled, and says when it holds neither', () => {
    const code = wrap(
      "  const tint = uniform(color('#FF8800'));\n  const s = uniform(float(2));\n  const k = uniform(Math.PI * 2);\n  const v = uniform(vec3(1, 0, 0));\n  const c = mul(tint, s, k, v);\n  return c;",
      'Fn, color, float, mul, uniform, vec3',
    );
    const r = codeToGraph(code);
    expect(r.errors.map((e) => e.message)).toEqual([
      '"v = uniform(vec3(1, 0, 0))" lost its value — a uniform holds a number or a hex colour; write uniform(1.5) or uniform(color(0xRRGGBB)).',
    ]);
    const valuesOf = (name: string) => (r.nodes.find((n) => n.data.label === name)!.data as { values: Record<string, unknown> }).values;
    expect(valuesOf('tint')).toMatchObject({ hex: '#ff8800', name: 'tint' });
    expect(valuesOf('s')).toMatchObject({ value: 2, name: 's' });
    expect(valuesOf('k').value).toBeCloseTo(Math.PI * 2, 12);
    // The lost one is still a uniform its consumers are wired to — and no
    // orphan node, no wire onto a socket a property does not have.
    expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(['mul', 'output', 'property_color', 'property_float', 'property_float', 'property_float']);
    const ids = new Map(r.nodes.map((n) => [n.id, n] as const));
    for (const e of r.edges) expect(String(ids.get(e.target)!.data.registryType)).not.toMatch(/^property_/);
  });

  it('PI, TWO_PI, HALF_PI and Math.PI are their numbers', () => {
    const code = wrap('  const a = mul(time, PI);\n  const b = mul(time, Math.PI);\n  const c = mul(time, TWO_PI);\n  const d = mul(time, HALF_PI);\n  const s = sin(add(a, b, c, d));\n  return s;', 'Fn, HALF_PI, PI, TWO_PI, add, mul, sin, time');
    expect(warningsOf(code)).toEqual([]);
    const text = regenerated(code);
    expect(text.match(/3\.141592653589793\)/g)).toHaveLength(2);
    expect(text).toContain('6.283185307179586)');
    expect(text).toContain('1.5707963267948966)');
  });

  it('a node the module itself names PI is that node, not the number', () => {
    const r = codeToGraph(wrap('  const PI = float(3);\n  const a = mul(time, PI);\n  return a;', 'Fn, float, mul, time'));
    const pi = r.nodes.find((n) => n.data.label === 'PI')!;
    const mulNode = r.nodes.find((n) => n.data.registryType === 'mul')!;
    expect(r.edges.some((e) => e.source === pi.id && e.target === mulNode.id)).toBe(true);
  });
});

describe('code the app writes never reads as dropped', () => {
  const SINKS = new Set(['output', 'raymarchOutput', 'splatOutput', 'unknown']);
  const DATA = makeDataNodeData({ columnNames: ['ramp', 'signed'], columns: [[0, 1, 2, 3, 4], [-2, -1, 0, 1, 4]], rowCount: 5 }, 2).values;
  const node = (id: string, type: string) => (type === 'dataNode' ? makeNode(id, type, DATA) : makeNode(id, type));
  const outOf = (type: string) => (type === 'dataNode' ? 'col0' : NODE_REGISTRY.get(type)!.outputs[0]?.id ?? 'out');
  const types = [...NODE_REGISTRY.values()].filter((d) => !SINKS.has(d.type)).map((d) => d.type);

  it.each(types)('%s, with its defaults and with every input wired', (type) => {
    const def = NODE_REGISTRY.get(type)!;
    const alone = graphToCode([node('n1', type), makeNode('o', 'output')], [makeEdge('n1', outOf(type), 'o', 'color')]).code;
    expect(droppedIn(alone), alone).toEqual([]);
    // Every input from a node of its own, so every argument is a NAME.
    const feeders = def.inputs.map((_, i) => makeNode(`f${i}`, 'float', { value: 0.5 }));
    const edges: AppEdge[] = [
      ...def.inputs.map((p, i) => makeEdge(`f${i}`, 'out', 'n1', p.id)),
      makeEdge('n1', outOf(type), 'o', 'color'),
    ];
    const wired = graphToCode([...feeders, node('n1', type), makeNode('o', 'output')], edges).code;
    expect(droppedIn(wired), wired).toEqual([]);
  });

  it('the data charts, each reading a Data column', () => {
    for (const type of ['stripes', 'dataviz', 'colormap', 'dataRange', 'isolines', 'wireframe']) {
      const def = NODE_REGISTRY.get(type)!;
      const nodes = [makeNode('d1', 'dataNode', DATA), makeNode('n1', type), makeNode('o', 'output')];
      const edges = [
        ...(def.inputs[0] ? [makeEdge('d1', 'col0', 'n1', def.inputs[0].id)] : []),
        makeEdge('n1', outOf(type), 'o', 'color'),
      ];
      const code = graphToCode(nodes, edges).code;
      expect(droppedIn(code), `${type}\n${code}`).toEqual([]);
    }
  });

  it('a picture: its module-scope setup, its sample, a read of it and the Environment channel', () => {
    const img = makeNode('img1', 'imageNode');
    (img.data as { values: Record<string, unknown> }).values = {
      imageB64: `data:image/png;base64,${btoa('abc')}`, width: 2, height: 2, fileName: 'x.png', colorSpace: 'color',
    };
    const nodes = [img, makeNode('m1', 'mul'), makeNode('o', 'output')];
    const edges = [makeEdge('img1', 'out', 'm1', 'a'), makeEdge('m1', 'out', 'o', 'color'), makeEdge('img1', 'out', 'o', 'env')];
    const code = graphToCode(nodes, edges).code;
    expect(code).toContain('new Image()');
    expect(droppedIn(code), code).toEqual([]);
  });

  it('the SDF Output and a lit Splat Output', () => {
    const march = graphToCode(
      [makeNode('s1', 'sdSphere'), makeNode('r1', 'raymarchOutput'), makeNode('c1', 'color', { hex: '#ff8800' })],
      [makeEdge('s1', 'out', 'r1', 'field'), makeEdge('c1', 'out', 'r1', 'color')],
    ).code;
    expect(droppedIn(march), march).toEqual([]);
    const splat = graphToCode(
      [makeNode('n1', 'perlin'), makeNode('sp1', 'splatOutput', { lit: 1 } as unknown as Record<string, number>), makeNode('c1', 'color', { hex: '#33aa55' })],
      [makeEdge('c1', 'out', 'sp1', 'color'), makeEdge('n1', 'out', 'sp1', 'cut')],
    ).code;
    expect(droppedIn(splat), splat).toEqual([]);
  });

  it('a per-mesh material with its settings in the part body', () => {
    const def = makeNode('out1', 'output');
    const part = makeNode('out2', 'output', { roughness: 0.25 });
    Object.assign(part.data as Record<string, unknown>, {
      meshTargets: ['Glass'],
      materialSettings: { transparent: true, side: 'double', flatShading: true, displacementMode: 'offset', mergeVertices: false },
    });
    const nodes: AppNode[] = [makeNode('c0', 'color', { hex: '#112233' }), makeNode('c1', 'color', { hex: '#445566' }), def, part];
    const code = graphToCode(nodes, [makeEdge('c0', 'out', 'out1', 'color'), makeEdge('c1', 'out', 'out2', 'color')]).code;
    expect(code).toContain('parts');
    expect(droppedIn(code), code).toEqual([]);
  });

  it('the intro\'s code slide and the "?" prompt\'s example', () => {
    const lone = graphToCode([makeNode('o', 'output')], []).code;
    for (const snap of codeSnapshots(lone) ?? []) expect(droppedIn(snap), snap).toEqual([]);
    expect(warningsOf(EXTERNAL_EXAMPLE.code)).toEqual([]);
  });
});

describe('the code panel shows them, in a study session too', () => {
  const panel = readFileSync(path.join(__dirname, '../components/CodeEditor/CodeEditor.tsx'), 'utf8');

  it('says "kept" only under an unknown function, and "did not reach the graph" under the rest', () => {
    expect(panel).toMatch(/warnings\.some\(\(w\) => w\.kept\) && \(\s*<div className="code-editor__error-hint">\{t\('Unknown functions are preserved as-is in the graph\.', language\)\}/);
    expect(panel).toMatch(/warnings\.some\(\(w\) => !w\.kept\) && \(\s*<div className="code-editor__error-hint">\{t\('The code these lines quote did not reach the graph\. Write it the way they say and press Apply again\.', language\)\}/);
    const ui = (lv as { ui: Record<string, string> }).ui;
    const key = 'The code these lines quote did not reach the graph. Write it the way they say and press Apply again.';
    expect(ui[key]).toBeTruthy();
    expect(ui[key]).not.toBe(key);
  });

  it('the banner is drawn in every session, and the warnings log nothing (owner, 2026-11-26)', () => {
    // The study shows them (consent-17 unchanged): no study gate on the banner…
    expect(panel).toContain("{isTSL && codeErrors.length > 0 && (() => {\n        const errors = codeErrors.filter(e => e.severity !== 'warning');");
    // …and nothing about a warning reaches the study log: an Apply is still the
    // field-less `code-apply` it always was.
    expect(panel.match(/evalLog\(/g)).toHaveLength(2);
    expect(panel).not.toMatch(/evalLog\('code-apply', /);
  });
});
