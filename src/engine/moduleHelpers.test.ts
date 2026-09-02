import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { MODULE_HELPERS, MODULE_HELPER_NAMES } from './moduleHelpers';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';

const traverse = (typeof (_traverse as unknown as { default?: unknown }).default === 'function'
  ? (_traverse as unknown as { default: typeof _traverse }).default
  : _traverse) as typeof _traverse;

/**
 * The module-scope helper table is the ONE exclusion both engines read (see
 * moduleHelpers.ts). These pins are what make adding a helper to one side
 * alone impossible to get wrong silently.
 */
describe('module-scope helper table', () => {
  it('every key is a registry type whose tslFunction IS the helper name, with no import module', () => {
    for (const type of MODULE_HELPERS.keys()) {
      const def = NODE_REGISTRY.get(type);
      expect(def, type).toBeTruthy();
      expect(def!.tslFunction, `${type}.tslFunction`).toBe(type);
      expect(def!.tslImportModule, `${type}.tslImportModule`).toBe('');
    }
  });

  it('each helper declares exactly the name its key promises', () => {
    for (const [type, h] of MODULE_HELPERS) {
      expect(h.lines[0], type).toMatch(new RegExp(`^const ${type} = Fn\\(`));
      expect(h.lines[h.lines.length - 1], type).toBe('});');
    }
  });

  it('every free-function call in a helper body is covered by its imports (plus Fn)', () => {
    for (const [type, h] of MODULE_HELPERS) {
      const src = h.lines.join('\n');
      const ast = parse(src, { sourceType: 'module' });
      const locals = new Set<string>();
      const called = new Set<string>();
      traverse(ast, {
        Identifier(path) {
          // Params and local consts inside the Fn body.
          if (path.parent.type === 'VariableDeclarator' && (path.parent as t.VariableDeclarator).id === path.node) locals.add(path.node.name);
          if (path.parentPath?.parent.type === 'ArrayPattern') locals.add(path.node.name);
        },
        CallExpression(path) {
          if (t.isIdentifier(path.node.callee)) called.add(path.node.callee.name);
        },
      });
      for (const name of called) {
        if (name === 'Fn' || name === type || locals.has(name)) continue;
        expect(h.imports, `${type} calls ${name}`).toContain(name);
      }
    }
  });

  it('MODULE_HELPER_NAMES is exactly the key set', () => {
    expect([...MODULE_HELPER_NAMES].sort()).toEqual([...MODULE_HELPERS.keys()].sort());
  });
});

describe('the distance-field helpers round-trip', () => {
  const build = (type: string) => {
    const uv = makeNode('uv', 'uv');
    const n = makeNode('n', type);
    const out = makeNode('out', 'output');
    const firstIn = NODE_REGISTRY.get(type)!.inputs[0].id;
    return graphToCode(
      [uv, n, out],
      [makeEdge('uv', 'out', 'n', firstIn), makeEdge('n', 'out', 'out', 'color')],
    ).code;
  };

  for (const type of ['sdCircle', 'sdBox2', 'sdBox3', 'sdTorus', 'smoothUnion', 'sdSubtract']) {
    it(`${type}: helper emitted once, parsed back to one node, re-emitted byte-identically`, () => {
      const code = build(type);
      expect(code.split(`const ${type} = Fn(`)).toHaveLength(2);
      const r = codeToGraph(code);
      const types = r.nodes.map((n) => n.data.registryType).sort();
      // uv + the node + Output — and NOTHING from the helper body.
      expect(types).toEqual(['output', type, 'uv']);
      expect(r.errors.filter((e) => e.severity !== 'warning')).toHaveLength(0);
      const again = graphToCode(r.nodes, r.edges).code;
      expect(again).toBe(code);
    });
  }

  it('hsl still emits its helper before toHsl, byte-identically to the old fixed order', () => {
    const h = makeNode('h', 'hsl');
    const th = makeNode('th', 'toHsl');
    const out = makeNode('out', 'output');
    const code = graphToCode(
      [th, h, out],
      [makeEdge('h', 'out', 'th', 'rgb'), makeEdge('th', 'out', 'out', 'color')],
    ).code;
    expect(code.indexOf('const hsl = Fn(')).toBeLessThan(code.indexOf('const toHsl = Fn('));
  });
});
