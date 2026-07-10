import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import { MAX_CHAIN_OPERANDS } from '@/registry/nodeRegistry';

/** Names of every `const <name> =` declaration emitted into the module. */
function constNames(code: string): string[] {
  return [...code.matchAll(/\bconst (\w+) =/g)].map((m) => m[1]);
}

describe('graphToCode — binary-op identity defaults (eval/codegen parity)', () => {
  it('emits min with the identity 1 for an unwired operand, not the annihilator 0', () => {
    const b = makeNode('b', 'float', { value: 0.7 });
    const m = makeNode('m', 'min');
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [b, m, out],
      [makeEdge('b', 'out', 'm', 'b'), makeEdge('m', 'out', 'out', 'color')],
    );
    expect(code).toMatch(/min\(1,/);
    expect(code).not.toMatch(/min\(0,/);
  });

  it('emits pow(1, 1) for a fully unwired power node', () => {
    const pw = makeNode('pw', 'pow');
    const out = makeNode('out', 'output');
    const { code } = graphToCode([pw, out], [makeEdge('pw', 'out', 'out', 'color')]);
    expect(code).toContain('pow(1, 1)');
  });

  it('emits mod(0, 1) — never mod(x, 0) — for a fully unwired modulo node', () => {
    const md = makeNode('md', 'mod');
    const out = makeNode('out', 'output');
    const { code } = graphToCode([md, out], [makeEdge('md', 'out', 'out', 'color')]);
    expect(code).toContain('mod(0, 1)');
  });
});

describe('graphToCode — Data node degrades instead of crashing', () => {
  it('emits an inert float(0) for a referenced column whose payload will not decode', () => {
    // Empty values → decodeDataNode returns null (malformed/tampered payload).
    const d = makeNode('d', 'dataNode', {});
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [d, out],
      [makeEdge('d', 'col0', 'out', 'color')],
    );
    // The column variable is DECLARED (no undeclared-identifier ReferenceError)…
    expect(code).toContain('const data1_col0 = float(0.0);');
    // …and it is what the output consumes.
    expect(code).toContain('data1_col0');
    // No texture is baked from a payload that never decoded.
    expect(code).not.toContain('DataTexture');
  });

  it('never emits a duplicate const when a property name collides with a data column', () => {
    // A property renamed exactly to a data column identifier used to produce two
    // `const data1_col0` in one scope → SyntaxError. Names must stay unique.
    const d = makeNode('d', 'dataNode', {});
    const p = makeNode('p', 'property_float', { name: 'data1_col0', value: 0.5 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode(
      [d, p, out],
      [makeEdge('d', 'col0', 'out', 'color'), makeEdge('p', 'out', 'out', 'opacity')],
    );
    const names = constNames(code);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('codeToGraph — variadic operand cap', () => {
  it('clamps a >64-operand call and reports a warning instead of silently truncating', () => {
    const args = Array.from({ length: MAX_CHAIN_OPERANDS + 6 }, (_, i) => `a${i}`).join(', ');
    const result = codeToGraph(`
      import { Fn, add } from 'three/tsl';
      const shader = Fn(() => {
        const s = add(${args});
        return s;
      });
      export default shader;
    `);
    expect(
      result.errors.some((e) => /operands/i.test(e.message) && e.severity === 'warning'),
    ).toBe(true);
    const addNode = result.nodes.find((n) => n.data.registryType === 'add');
    expect(addNode).toBeDefined();
    const wired = result.edges.filter((e) => e.target === addNode!.id);
    expect(wired.length).toBeLessThanOrEqual(MAX_CHAIN_OPERANDS);
  });
});
