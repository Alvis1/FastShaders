import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { MODULE_HELPERS, MODULE_HELPER_NAMES, HELPER_ALIASES, helperNameFor, helperCallPorts } from './moduleHelpers';
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
  it('every key is a registry type\'s tslFunction, or a VARIANT of one (alias.type) — no import module either way', () => {
    for (const [name, h] of MODULE_HELPERS) {
      if (h.alias) {
        const owner = NODE_REGISTRY.get(h.alias.type);
        expect(owner, `${name} → ${h.alias.type}`).toBeTruthy();
        expect(owner!.tslImportModule, `${h.alias.type}.tslImportModule`).toBe('');
        // A variant's port list names real ports of its owner.
        for (const port of h.alias.ports ?? []) expect(owner!.inputs.some((i) => i.id === port), `${name} port ${port}`).toBe(true);
        // A mode variant's mode is in the owner's closed vocabulary.
        const mode = h.alias.values?.mode;
        if (typeof mode === 'string') expect(owner!.modes?.values, `${name} mode ${mode}`).toContain(mode);
        continue;
      }
      const def = [...NODE_REGISTRY.values()].find((d) => d.tslFunction === name);
      expect(def, name).toBeTruthy();
      expect(def!.tslImportModule, `${def!.type}.tslImportModule`).toBe('');
    }
  });

  it('every mode of a multi-mode def resolves to a helper, and the default mode to the def\'s own tslFunction', () => {
    for (const def of NODE_REGISTRY.values()) {
      if (!def.modes) continue;
      expect(MODULE_HELPERS.has(def.tslFunction), `${def.type}.tslFunction`).toBe(true);
      expect(helperNameFor(def, undefined)).toBe(def.tslFunction);
      expect(helperNameFor(def, { mode: def.modes.default })).toBe(def.tslFunction);
      expect(helperNameFor(def, { mode: 'junk' })).toBe(def.tslFunction);
      for (const m of def.modes.values) {
        const name = helperNameFor(def, { mode: m });
        expect(MODULE_HELPERS.has(name), `${def.type} mode ${m}`).toBe(true);
        // Every variant name parses back to this def with this mode stamped
        // (the default mode's name carries no alias: it IS the tslFunction).
        if (m !== def.modes.default) expect(HELPER_ALIASES.get(name)).toEqual(expect.objectContaining({ type: def.type, values: { mode: m } }));
        expect(helperCallPorts(name, def.inputs).length).toBeGreaterThan(0);
      }
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

  // [registry type, the helper a uv-wired instance emits]
  for (const [type, helper] of [
    ['sdCircle', 'sdCircle'], ['sdBox', 'sdBox2'], ['sdTorus', 'sdTorus'], ['sdCombine', 'sdUnion'],
    ['sdCylinder', 'sdCylinder'], ['sdCapsule', 'sdCapsule'], ['sdCone', 'sdCone'], ['sdPlane', 'sdPlane'],
    ['sdOctahedron', 'sdOctahedron'], ['sdStar', 'sdStar'], ['sdfTransform', 'sdfTransform'], ['sdfRepeat', 'sdfRepeat'],
    ['sdfRepeatPolar', 'sdfRepeatPolar'], ['sdfMirror', 'sdfMirror'], ['sdfModify', 'sdRound'], ['sdfDeform', 'sdfTwist'],
    ['sdfExtrude', 'sdfExtrude'], ['sdfRevolve', 'sdfRevolve'], ['sdfMask', 'sdfMask'],
  ]) {
    it(`${type}: helper emitted once, parsed back to one node, re-emitted byte-identically`, () => {
      const code = build(type);
      expect(code.split(`const ${helper} = Fn(`)).toHaveLength(2);
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
