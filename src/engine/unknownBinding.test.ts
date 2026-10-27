import { describe, it, expect, beforeAll } from 'vitest';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { loadUnknownExpressionValidator, MAX_UNKNOWN_REFS } from './unknownExpression';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { TSL_EXPORT_NAMES } from './tslExportNames';
import { isSinkNode } from '@/utils/sdfPartition';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';

// @babel/traverse CJS/ESM interop (CLAUDE.md, TypeScript Notes).
const traverse = (
  typeof (_traverse as unknown as { default: typeof _traverse }).default === 'function'
    ? (_traverse as unknown as { default: typeof _traverse }).default
    : _traverse
) as typeof _traverse;

/**
 * An `unknown` node's BOUND references (engine/unknownExpression.ts, "BOUND
 * REFERENCES"): every identifier its call reads that names a node is an edge
 * into a positional `ref<i>` socket, re-emitted as what that edge resolves to
 * TODAY. What is pinned is what that buys — an Apply is a fixed point, and the
 * text never reads a name the module does not declare.
 */

beforeAll(() => loadUnknownExpressionValidator());

/** One code-panel Apply: parse the text, regenerate from the graph it built. */
function apply(code: string): { nodes: AppNode[]; edges: AppEdge[]; code: string; blocked: boolean } {
  const parsed = codeToGraph(code);
  const blocked = parsed.errors.some((e) => e.severity !== 'warning');
  return { nodes: parsed.nodes, edges: parsed.edges, code: graphToCode(parsed.nodes, parsed.edges).code, blocked };
}

/** The names a module reads that nothing declares (Babel's program-scope
 *  globals), less three/tsl's — the module build completes that import. */
function undeclared(code: string): string[] {
  const ast = parse(code, { sourceType: 'module' });
  let globals: string[] = [];
  traverse(ast, {
    Program(path) {
      globals = Object.keys((path.scope as unknown as { globals: Record<string, unknown> }).globals);
    },
  });
  return globals.filter((n) => !TSL_EXPORT_NAMES.has(n)).sort();
}

const shader = (lines: string[]): string =>
  ["import { Fn, float, uniform, vec3, add, mul, sin, max, saturate, positionLocal } from 'three/tsl';", '',
    'const shader = Fn(() => {', ...lines.map((l) => `  ${l}`), '});', '', 'export default shader;', ''].join('\n');

describe('the parse BINDS what an unknown call reads', () => {
  const parsed = codeToGraph(shader([
    'const a = float(1);',
    'const speed = uniform(0.5);',
    'const b = saturate(a, a.x, max(speed, 1), time, "a", positionLocal);',
    'return vec3(b);',
  ]));
  const unknown = parsed.nodes.find((n) => n.data.registryType === 'unknown')!;
  const into = parsed.edges.filter((e) => e.target === unknown.id);

  it('one edge per declared name, into ref0…, the names in `refs`', () => {
    expect((unknown.data as { values: Record<string, unknown> }).values.refs).toBe('a speed');
    const byId = new Map(parsed.nodes.map((n) => [n.id, n]));
    expect(into.map((e) => [byId.get(e.source)!.data.registryType, e.targetHandle])).toEqual([
      ['float', 'ref0'],
      ['property_float', 'ref1'],
    ]);
  });

  it('never a global (`time`), a callee (`max`), a member name (`.x`) or a string', () => {
    expect(into).toHaveLength(2);
  });

  it('nothing in a call graphToCode would not emit, and never itself', () => {
    const unsafe = codeToGraph(shader(['const a = float(1);', 'const b = mysteryFn(a);', 'return vec3(b);']));
    const u = unsafe.nodes.find((n) => n.data.registryType === 'unknown')!;
    expect((u.data as { values: Record<string, unknown> }).values.refs).toBeUndefined();
    expect(unsafe.edges.some((e) => e.target === u.id)).toBe(false);
  });

  it(`at most ${MAX_UNKNOWN_REFS} names`, () => {
    const decl = Array.from({ length: MAX_UNKNOWN_REFS + 3 }, (_, i) => `const v${i} = float(${i});`);
    const args = Array.from({ length: MAX_UNKNOWN_REFS + 3 }, (_, i) => `v${i}`).join(', ');
    const many = codeToGraph(shader([...decl, `const b = saturate(${args});`, 'return vec3(b);']));
    const u = many.nodes.find((n) => n.data.registryType === 'unknown')!;
    expect(String((u.data as { values: Record<string, unknown> }).values.refs).split(' ')).toHaveLength(MAX_UNKNOWN_REFS);
    expect(many.edges.filter((e) => e.target === u.id)).toHaveLength(MAX_UNKNOWN_REFS);
  });
});

describe('graphToCode re-emits a bound name as what its edge resolves to TODAY', () => {
  const unknown = (refs: string, expr = 'saturate(a, 2)') =>
    makeNode('u', 'unknown', { functionName: 'saturate', rawExpression: expr, refs });
  const out = () => makeNode('out', 'output');

  it('the node the edge names, whatever the stored name says', () => {
    const nodes = [makeNode('x', 'float', { value: 1 }), makeNode('y', 'float', { value: 2 }), unknown('a'), out()];
    // Wired from the SECOND Float: its name is float2, the text still says `a`.
    const code = graphToCode(nodes, [makeEdge('y', 'out', 'u', 'ref0'), makeEdge('u', 'out', 'out', 'color')]).code;
    expect(code).toContain('const saturate1 = saturate(float2, 2);');
  });

  it('`float(0)` when the socket is unwired — never the stale name — and `float` is imported', () => {
    const code = graphToCode([unknown('a'), out()], [makeEdge('u', 'out', 'out', 'color')]).code;
    expect(code).toContain('const saturate1 = saturate(float(0), 2);');
    expect(code).toMatch(/import \{[^}]*\bfloat\b[^}]*\} from 'three\/tsl'/);
  });

  it('a tampered `refs` stays inert: a resolved name that is a gateway is refused whole', () => {
    // A property named `top` IS declared — but `top` is never readable.
    const nodes = [makeNode('p', 'property_float', { name: 'top', value: 1 }), unknown('a'), out()];
    const code = graphToCode(nodes, [makeEdge('p', 'out', 'u', 'ref0'), makeEdge('u', 'out', 'out', 'color')]).code;
    expect(code).toContain('const saturate1 = float(0);');
  });
});

describe('an Apply is a FIXED POINT for an unknown reading any socket of any node', () => {
  // Review 2026-10-27: the parse binds `fresnel1` in `fresnel1.y` to `out`,
  // whose reference is `fresnel1.x` — spliced in, `.y` landed on it and every
  // Apply added another `.x` (Color Ramp: `.rgb.rgb.a`).
  const sinks = new Set(['output', 'raymarchOutput', 'splatOutput', 'unknown']);
  const cases: [string, string][] = [];
  for (const def of NODE_REGISTRY.values()) {
    if (sinks.has(def.type)) continue;
    for (const o of def.outputs) cases.push([def.type, o.id]);
  }

  it('covers the own-member sockets that grew', () => {
    for (const c of ['fresnel.out', 'fresnel.facing', 'colorRamp.out', 'colorRamp.alpha']) {
      expect(cases.map(([t, h]) => `${t}.${h}`)).toContain(c);
    }
  });

  it.each(cases)('%s.%s', (type, handle) => {
    const src = makeNode('src', type);
    if (isSinkNode(src)) return;
    const nodes = [
      src,
      makeNode('u', 'unknown', { functionName: 'saturate', rawExpression: 'saturate(x)', refs: 'x' }),
      makeNode('out', 'output'),
    ];
    const first = graphToCode(nodes, [makeEdge('src', handle, 'u', 'ref0'), makeEdge('u', 'out', 'out', 'color')]).code;
    const once = apply(first);
    // A node the parse cannot read back (the one-way families: "left unwired")
    // leaves nothing bound, and that degradation is not this rule's.
    const u = once.nodes.find((n) => n.data.registryType === 'unknown');
    if (once.blocked || !u || !once.edges.some((e) => e.target === u.id)) return;
    const twice = apply(once.code);
    expect(twice.code).toBe(once.code);
  });

  it('a typed own-member read keeps its member: `saturate(fresnel1.y)`', () => {
    const code = graphToCode(
      [makeNode('f', 'fresnel'), makeNode('out', 'output')],
      [makeEdge('f', 'out', 'out', 'color')],
    ).code;
    // The shader's own return — the last one; the fsFresnel helper has its own.
    const at = code.lastIndexOf('\n  return ');
    const typed = `${code.slice(0, at)}\n  const h = saturate(fresnel1.y);\n  return vec3(h);${code.slice(code.indexOf('\n', at + 1))}`;
    expect(typed).toContain('saturate(fresnel1.y)');
    const once = apply(typed);
    expect(once.code).toContain('saturate(fresnel1.y)');
    expect(apply(once.code).code).toBe(once.code);
  });
});

describe('an Apply of typed text never reads an undeclared name', () => {
  it('a node, a property, members and a multi-line call: stable, every read declared', () => {
    const typed = shader([
      'const a = float(1);',
      'const speed = uniform(0.5);',
      'const b = saturate(',
      '  a.mul(2), // a',
      '  max(speed, a),',
      ');',
      'return vec3(b);',
    ]);
    const once = apply(typed);
    expect(once.blocked).toBe(false);
    expect(undeclared(once.code)).toEqual([]);
    const twice = apply(once.code);
    expect(twice.code).toBe(once.code);
    expect(twice.nodes).toHaveLength(once.nodes.length);
  });

  it.each([
    ['grid', {}],
    ['edges', { edges: 1 }],
  ])('a Wireframe node (%s mode) after one Apply: every dFdx/dFdy/attribute line reads a declared name', (_mode, values) => {
    const code = graphToCode(
      [makeNode('w', 'wireframe', values as Record<string, number>), makeNode('out', 'output')],
      [makeEdge('w', 'out', 'out', 'color')],
    ).code;
    const once = apply(code);
    expect(once.blocked).toBe(false);
    // Before binding, `dFdx(_wireframe1_d)` read a name the Apply had dropped.
    expect(undeclared(once.code)).toEqual([]);
    expect(apply(once.code).code).toBe(once.code);
  });
});
