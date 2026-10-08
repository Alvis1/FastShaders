import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { MODULE_HELPERS } from './moduleHelpers';
import { codeToGraph, argReporter, HELPER_ARG_READERS } from './codeToGraph';
import type { ParseError } from '@/types';

/**
 * A plain-JS module helper (`kind: 'js'`, engine/lutHelperText.ts) is graph
 * content to codeToGraph until it is skipped BY NAME — and its body is full of
 * returns, assignments and calls that would otherwise mint nodes on every
 * Apply. Before 2026-10 the skip covered only `const X = Fn(`.
 */

const JS = [...MODULE_HELPERS].filter(([, h]) => h.kind === 'js');

const moduleWith = (helperText: string) =>
  [
    "import { Fn, float, texture, vec2 } from 'three/tsl';",
    '',
    helperText,
    '',
    'const shader = Fn(() => {',
    '  const float1 = float(0.5);',
    '',
    '  return { roughness: float1 };',
    '});',
    '',
    'export default shader;',
  ].join('\n');

describe('codeToGraph skips plain-JS helpers by name', () => {
  it('there is at least one js helper (a vacuous sweep would pass on nothing)', () => {
    expect(JS.length).toBeGreaterThan(0);
  });

  for (const [name, h] of JS) {
    it(`${name}: its declaration contributes NO node, NO edge and NO message`, () => {
      const bare = codeToGraph(moduleWith(''));
      const r = codeToGraph(moduleWith(h.lines.join('\n')));
      expect(r.errors).toEqual(bare.errors);
      expect(r.errors).toEqual([]);
      expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(bare.nodes.map((n) => n.data.registryType).sort());
      expect(r.edges).toHaveLength(bare.edges.length);
    });

    it(`${name}: skipped whatever its init shape (a hand-written \`const ${name} = 3\` is not a node either)`, () => {
      const r = codeToGraph(moduleWith(`const ${name} = 3;`));
      const bare = codeToGraph(moduleWith(''));
      expect(r.nodes).toHaveLength(bare.nodes.length);
      expect(r.errors).toEqual([]);
    });
  }
});

describe('every helper text parses cleanly with codeToGraph\'s EXACT options', () => {
  // `errorRecovery: true` + the typescript plugin read `a < b … >` runs through the type-argument
  // lookahead and RECOVER silently — a clean round trip alone would not show a recovered error.
  for (const [name, h] of MODULE_HELPERS) {
    it(`${name}: ast.errors is empty`, () => {
      const ast = parse(h.lines.join('\n'), { sourceType: 'module', plugins: ['typescript'], errorRecovery: true });
      expect(ast.errors ?? []).toEqual([]);
    });
  }
});

describe('the helper-argument hook', () => {
  it('argReporter warns on the call line and quotes at most 80 chars of source', () => {
    const code = `f(${'x'.repeat(100)}, y)`;
    const ast = parse(code, { sourceType: 'module' });
    const call = (ast.program.body[0] as t.ExpressionStatement).expression as t.CallExpression;
    const errors: ParseError[] = [];
    const { warn, quote } = argReporter(call, code, errors);
    expect(quote(call.arguments[1])).toBe('"y"');
    expect(quote(call.arguments[0])).toBe(`"${'x'.repeat(80)}…"`);
    expect(quote(t.identifier('noPosition'))).toBe('"argument"');
    warn('m');
    expect(errors).toEqual([{ message: 'm', line: 1, severity: 'warning' }]);
  });

  it('readers are keyed by registry TYPE in a Map (a type string from a file is adversarial)', () => {
    expect(HELPER_ARG_READERS).toBeInstanceOf(Map);
    expect(HELPER_ARG_READERS.get('__proto__')).toBeUndefined();
    expect(HELPER_ARG_READERS.get('constructor')).toBeUndefined();
  });
});
