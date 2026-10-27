import { describe, it, expect, beforeAll } from 'vitest';
import type { AppEdge, AppNode, CodeSpan } from '@/types';
import { makeEdge, makeNode } from '@/test-utils';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { unfoldOutputMaterials } from '@/utils/outputMaterials';
import { graphToCode } from './graphToCode';
import { panelCodegen } from './panelCode';
import { loadUnknownExpressionValidator } from './unknownExpression';

/**
 * graphToCode's `nodeSpans` (engine/codeSpans.ts) — which part of the module
 * each node wrote, for the code panel's node → code highlight. Bookkeeping:
 * the attribution is by the plan iteration that PUSHED a line, and every
 * position is counted the way Monaco counts lines in the joined text.
 */

// The multi-line `unknown` case needs the real validator (it fails closed cold).
beforeAll(() => loadUnknownExpressionValidator());

const LINE_BREAK = /\r\n|\r|\n/;
const linesOf = (code: string) => code.split(LINE_BREAK);

/** The text a span covers, by Monaco's line rule. */
function spanText(code: string, s: CodeSpan): string {
  const ls = linesOf(code);
  if (s.startLineNumber === s.endLineNumber) return ls[s.startLineNumber - 1].slice(s.startColumn - 1, s.endColumn - 1);
  const parts = [ls[s.startLineNumber - 1].slice(s.startColumn - 1)];
  for (let l = s.startLineNumber + 1; l < s.endLineNumber; l++) parts.push(ls[l - 1]);
  parts.push(ls[s.endLineNumber - 1].slice(0, s.endColumn - 1));
  return parts.join('\n');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every invariant that must hold for ANY graph. Returns the pass for the
 * case-specific assertions.
 */
function checkInvariants(name: string, nodes: AppNode[], edges: AppEdge[]) {
  const result = graphToCode(nodes, edges);
  const { code, nodeSpans, varNames } = result;
  const ls = linesOf(code);

  for (const [id, spans] of nodeSpans) {
    expect(spans.length, `${name}: ${id} has an entry with no span`).toBeGreaterThan(0);
    let prev = 0;
    for (const s of spans) {
      // In bounds, ordered, well-formed.
      expect(s.startLineNumber, `${name}: ${id}`).toBeGreaterThanOrEqual(1);
      expect(s.endLineNumber, `${name}: ${id}`).toBeLessThanOrEqual(ls.length);
      expect(s.startLineNumber <= s.endLineNumber, `${name}: ${id}`).toBe(true);
      expect(s.startColumn, `${name}: ${id}`).toBeGreaterThanOrEqual(1);
      expect(s.endColumn - 1, `${name}: ${id} ${JSON.stringify(s)}`).toBeLessThanOrEqual(ls[s.endLineNumber - 1].length);
      const at = s.startLineNumber * 1e6 + s.startColumn;
      expect(at, `${name}: ${id} spans in document order`).toBeGreaterThanOrEqual(prev);
      prev = at;
      // A whole-line span covers whole lines.
      if (!s.inline) {
        expect(s.startColumn, `${name}: ${id} whole-line starts at column 1`).toBe(1);
        expect(s.endColumn - 1, `${name}: ${id} whole-line ends at the line's end`).toBe(ls[s.endLineNumber - 1].length);
      }
      expect(s.kind === 'use', `${name}: ${id} only a Split read is a use`).toBe(s.inline && s.kind === 'use');
    }
  }

  // No line is the OWN whole-line code of two nodes.
  const owner = new Map<number, string>();
  for (const [id, spans] of nodeSpans) {
    for (const s of spans) {
      if (s.inline) continue;
      for (let l = s.startLineNumber; l <= s.endLineNumber; l++) {
        expect(owner.get(l) ?? id, `${name}: line ${l} claimed twice`).toBe(id);
        owner.set(l, id);
      }
    }
  }

  // A named node's code holds its name (`_image1_tex`, `sound1_level`,
  // `rm1Field` are its name too) — attribution by pusher, not a name scan,
  // so this is a real check.
  for (const [id, spans] of nodeSpans) {
    const v = varNames.get(id);
    const own = spans.filter((s) => s.kind !== 'use');
    if (!v || own.length === 0) continue;
    const text = own.map((s) => spanText(code, s)).join('\n');
    const n = escapeRe(v);
    const re = new RegExp(`(^|[^\\w$])_?${n}(?![\\w$])|(^|[^\\w$])_?${n}_|(^|[^\\w$])${n}[A-Z]`);
    expect(re.test(text), `${name}: ${id} (${v}) owns no text with its name:\n${text}`).toBe(true);
  }

  // Every non-blank line of the shader body is someone's — except the red
  // sentinel a module with no Output returns.
  const start = ls.indexOf('const shader = Fn(() => {');
  const end = ls.lastIndexOf('});');
  const covered = new Set<number>();
  for (const [, spans] of nodeSpans) {
    for (const s of spans) if (s.kind !== 'use') for (let l = s.startLineNumber; l <= s.endLineNumber; l++) covered.add(l);
  }
  for (let l = start + 2; l < end + 1; l++) {
    const text = ls[l - 1];
    if (text.trim() === '' || text === '  return vec3(1, 0, 0);') continue;
    expect(covered.has(l), `${name}: body line ${l} belongs to nobody: ${text}`).toBe(true);
  }
  return result;
}

const spansOf = (r: ReturnType<typeof graphToCode>, id: string) => r.nodeSpans.get(id) ?? [];
const textsOf = (r: ReturnType<typeof graphToCode>, id: string) => spansOf(r, id).map((s) => spanText(r.code, s));

describe('nodeSpans: every graph', () => {
  it('every built-in recipe, preset and texture: every node with code has spans, all invariants hold', () => {
    let withSpans = 0;
    for (const a of [...getBuiltinPresets(), ...getBuiltinTextures()]) {
      const r = checkInvariants(a.id, a.nodes, a.edges);
      for (const n of a.nodes) {
        if (n.type === 'group' || n.type === 'note') continue;
        if (r.nodeSpans.has(n.id)) withSpans++;
        else expect(r.varNames.has(n.id) && !new RegExp(`\\b${escapeRe(r.varNames.get(n.id)!)}\\b`).test(r.code), `${a.id}: ${n.id} emitted code but has no span`).toBe(true);
      }
    }
    expect(withSpans).toBeGreaterThan(500);
  });

  it('every registry type, wired into an Output and unwired', () => {
    for (const [type, def] of NODE_REGISTRY) {
      if (type === 'output') continue;
      const out = def.outputs[0]?.id;
      const wired = checkInvariants(`${type} wired`, [makeNode('n', type), makeNode('o', 'output')], out ? [makeEdge('n', out, 'o', 'color')] : []);
      checkInvariants(`${type} unwired`, [makeNode('n', type), makeNode('o', 'output')], []);
      // A node wired into the Output that writes a line owns it.
      if (out && type !== 'split' && new RegExp(`const ${escapeRe(wired.varNames.get('n') ?? '\u0000')}\\b`).test(wired.code)) {
        expect(wired.nodeSpans.has('n'), `${type}: wired node with a declaration has no span`).toBe(true);
      }
    }
  });
});

describe('nodeSpans: lines are counted as Monaco counts them', () => {
  it('a multi-line unknown expression moves every later line, and a lone CR is a line break', () => {
    const r = checkInvariants('multiline unknown', [
      makeNode('u', 'unknown', { functionName: 'saturate', rawExpression: 'saturate(\n    1,\n    0.25\n  )' }),
      makeNode('u2', 'unknown', { functionName: 'fwidth', rawExpression: 'fwidth(/*\r*/1)' }),
      makeNode('a', 'add'),
      makeNode('o', 'output'),
    ], [makeEdge('u', 'out', 'a', 'a'), makeEdge('u2', 'out', 'a', 'b'), makeEdge('a', 'out', 'o', 'color')]);
    const [add] = spansOf(r, 'a');
    expect(spanText(r.code, add)).toBe('  const add1 = add(saturate1, fwidth1);');
    expect(linesOf(r.code)[add.startLineNumber - 1]).toBe('  const add1 = add(saturate1, fwidth1);');
    const [myFn] = spansOf(r, 'u');
    expect(myFn.endLineNumber - myFn.startLineNumber).toBe(3);
    const [foo] = spansOf(r, 'u2');
    expect(foo.endLineNumber - foo.startLineNumber).toBe(1);
  });
});

describe('nodeSpans: what each node owns', () => {
  it('a shared image: the owner has its module-scope setup and its sample, the sharer its sample only', () => {
    const IMG = 'data:image/webp;base64,' + btoa('abc');
    const img = { imageB64: IMG, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' };
    const r = checkInvariants('image share', [
      makeNode('i1', 'imageNode', img),
      makeNode('i2', 'imageNode', img),
      makeNode('m', 'mul'),
      makeNode('o', 'output'),
    ], [makeEdge('i1', 'out', 'm', 'a'), makeEdge('i2', 'out', 'm', 'b'), makeEdge('m', 'out', 'o', 'color')]);
    const owner = spansOf(r, 'i1');
    expect(owner.map((s) => s.kind)).toEqual(['setup', 'own']);
    expect(spanText(r.code, owner[0])).toContain('new Image()');
    expect(spansOf(r, 'i2').map((s) => s.kind)).toEqual(['own']);
    expect(spanText(r.code, spansOf(r, 'i2')[0])).toContain('_image1_tex');
  });

  it('a Split owns its READS: one span per read, inside its consumer, never a line', () => {
    const r = checkInvariants('split', [
      makeNode('p', 'positionLocal'),
      makeNode('s', 'split'),
      makeNode('iso', 'isolines'),
      makeNode('o', 'output'),
      makeNode('s2', 'split'),
    ], [
      makeEdge('p', 'out', 's', 'v'),
      makeEdge('s', 'x', 'iso', 'value'),
      makeEdge('s', 'y', 'o', 'roughness'),
      makeEdge('iso', 'out', 'o', 'color'),
      makeEdge('s', 'z', 's2', 'v'),
    ]);
    const reads = spansOf(r, 's');
    expect(reads.every((s) => s.kind === 'use' && s.inline)).toBe(true);
    expect(reads.map((s) => spanText(r.code, s))).toEqual(['positionLocal1.x', 'positionLocal1.y']);
    const ls = linesOf(r.code);
    // The Isolines read sits in Isolines' own text; the roughness read in the return line.
    expect(ls[reads[0].startLineNumber - 1]).toContain('isolines');
    expect(ls[reads[1].startLineNumber - 1]).toMatch(/^ {2}return \{.*roughness: positionLocal1\.y/);
    // Split → Split resolves to nothing, so the second Split wrote nothing.
    expect(r.nodeSpans.has('s2')).toBe(false);
  });

  it('a Split read by a Raymarch Field is found inside the march', () => {
    const r = checkInvariants('split → field', [makeNode('pos', 'positionLocal'), makeNode('s', 'split'), makeNode('rm', 'raymarchOutput')], [
      makeEdge('pos', 'out', 's', 'v'),
      makeEdge('s', 'x', 'rm', 'field'),
    ]);
    const reads = spansOf(r, 's');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((s) => spanText(r.code, s) === 'positionLocal1.x')).toBe(true);
    expect(reads.some((s) => linesOf(r.code)[s.startLineNumber - 1].includes('return positionLocal1.x;'))).toBe(true);
  });

  it('the Raymarch Output owns its program but not its members’ chains', () => {
    const r = checkInvariants('raymarch', [
      makeNode('pos', 'positionLocal'),
      makeNode('sd', 'sdCircle'),
      makeNode('col', 'color', { hex: '#2d6cdf' }),
      makeNode('rm', 'raymarchOutput'),
      makeNode('o', 'output'),
      makeNode('k', 'float', { value: 2 }),
    ], [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field'), makeEdge('col', 'out', 'rm', 'color'), makeEdge('k', 'out', 'o', 'color')]);
    const sink = textsOf(r, 'rm').join('\n');
    expect(sink).toContain('const rm1Field = Fn(([p]) => {');
    expect(sink).toContain('const rm1 = Fn(() => {');
    expect(sink).toContain('return { color: color(0x000000), emissive: rm1Col, roughness: float(1) };');
    // The chain copied into rm1Field is its members' code, not the sink's.
    expect(sink).not.toContain('sdCircle(');
    expect(textsOf(r, 'sd').join('\n')).toContain('sdCircle(');
    // A plain Output parked behind a driving march wrote nothing.
    expect(r.nodeSpans.has('o')).toBe(false);
  });

  it('a Raymarch Output whose Field resolves to nothing: no span lands outside the body', () => {
    const r = checkInvariants('dead field', [
      makeNode('pos', 'positionLocal'),
      makeNode('s', 'split'),
      makeNode('rm', 'raymarchOutput'),
      makeNode('sd', 'sdCircle'),
    ], [makeEdge('s', 'x', 'rm', 'field'), makeEdge('pos', 'out', 'sd', 'p')]);
    const bodyStart = linesOf(r.code).indexOf('const shader = Fn(() => {') + 1;
    for (const [, spans] of r.nodeSpans) for (const s of spans) expect(s.startLineNumber).toBeGreaterThan(bodyStart);
    expect(r.nodeSpans.has('rm')).toBe(false);
  });

  it('a lit Splat Output owns its light line, inside the shade Fn', () => {
    const sp = makeNode('sp', 'splatOutput');
    (sp.data as { values: Record<string, unknown> }).values = { color: '#2d6cdf', lit: true };
    const r = checkInvariants('splat lit', [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('n', 'perlin'), sp], [
      makeEdge('pos', 'out', 'sd', 'p'),
      makeEdge('sd', 'out', 'sp', 'cut'),
      makeEdge('n', 'out', 'sp', 'opacity'),
    ]);
    const lightLine = linesOf(r.code).findIndex((l) => /const sp1Light = /.test(l)) + 1;
    expect(lightLine).toBeGreaterThan(0);
    expect(spansOf(r, 'sp').some((s) => s.startLineNumber <= lightLine && lightLine <= s.endLineNumber)).toBe(true);
  });

  it('per-mesh materials: each Output owns its own entry of the shared return line', () => {
    const out = makeNode('out1', 'output');
    Object.assign(out.data, {
      materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }, { meshTargets: ['Named'] }],
      modelSignature: { materials: ['Body', 'Glass', 'Trim'] },
      modelMeshes: [{ name: 'Hull', material: 0 }, { name: 'Window', material: 1 }, { name: 'Named', material: 1 }],
    });
    const nodes = [
      makeNode('c1', 'color', { hex: '#ff0000' }),
      makeNode('c2', 'color', { hex: '#00ff00' }),
      makeNode('c3', 'color', { hex: '#0000ff' }),
      makeNode('c4', 'color', { hex: '#00ffff' }),
      out,
    ];
    const edges = [
      makeEdge('c4', 'out', 'out1', 'color'),
      makeEdge('c1', 'out', 'out1', 'm1:color'),
      makeEdge('c2', 'out', 'out1', 'm2:color'),
      makeEdge('c3', 'out', 'out1', 'm3:color'),
    ];
    const u = unfoldOutputMaterials(nodes, edges);
    const r = checkInvariants('parts unfolded', u.nodes, u.edges);
    const outputs = u.nodes.filter((n) => n.data.registryType === 'output');
    expect(outputs.length).toBeGreaterThan(1);
    const returnLine = linesOf(r.code).findIndex((l) => l.startsWith('  return {')) + 1;
    for (const o of outputs) {
      const spans = spansOf(r, o.id);
      expect(spans.length, `${o.id} owns nothing`).toBeGreaterThan(0);
      for (const s of spans) {
        expect(s.inline).toBe(true);
        expect(s.startLineNumber).toBe(returnLine);
        const text = spanText(r.code, s);
        expect(text, `${o.id}: ${text}`).toMatch(o.id === 'out1' ? /^color: / : /^"[^"]+": \{ /);
      }
    }
  });

  it('nodes that emit nothing get no entry: an orphaned property, an unconsumed Sound or Data node, a lone Split, a non-contributing Output', () => {
    const r = checkInvariants('empties', [
      makeNode('p', 'property_float', { name: 'speed', value: 1 }),
      makeNode('snd', 'soundNode'),
      makeNode('dn', 'dataNode'),
      makeNode('sp', 'split'),
      makeNode('o', 'output'),
      makeNode('o2', 'output'),
      makeNode('c', 'color', { hex: '#ffffff' }),
    ], [makeEdge('c', 'out', 'o', 'color')]);
    expect([...r.nodeSpans.keys()].sort()).toEqual(['c', 'o']);
  });

  it('emitOnly: a node the panel hides has no entry, and the rest are where the text puts them', () => {
    const nodes = [
      makeNode('c', 'color', { hex: '#ff0000' }),
      makeNode('o', 'output'),
      makeNode('dead-p', 'property_float', { name: 'deadKnob', value: 2 }),
      makeNode('dead-n', 'perlin'),
      makeNode('dead-m', 'mul'),
    ];
    const edges = [makeEdge('c', 'out', 'o', 'color'), makeEdge('dead-p', 'out', 'dead-m', 'a'), makeEdge('dead-n', 'out', 'dead-m', 'b')];
    const whole = graphToCode(nodes, edges);
    expect(whole.nodeSpans.has('dead-m')).toBe(true);
    const { result, emitted } = panelCodegen(nodes, edges, false);
    expect(emitted).not.toBeNull();
    expect([...result.nodeSpans.keys()].sort()).toEqual(['c', 'o']);
    expect(textsOf(result, 'c')).toEqual(['  const color1 = color(0xff0000);']);
  });
});
