/**
 * THE Output node's `values` accessor.
 *
 * `getNodeValues` hard-returns `{}` for `output`, so every Output reader wrote
 * its own `(data as OutputNodeData).values ?? {}` — a nullish-only guard on a
 * field NO restore path coerces (`sanitizeOutputMaterialsReport` cleans
 * MATERIALS ENTRIES only; `unfoldOutputMaterials`' material-0 branch is a
 * shallow spread). A tampered `values: 5` therefore reached
 * `ShaderSettingsMenu`'s `'opacity' in values` and `OutputNode`'s
 * `channel in current`, and `in` THROWS on a primitive — inside a React event
 * handler, so the checkbox and the clear-swatch silently did nothing.
 *
 * The `in` operator is what throws, so every case asserts against it directly
 * rather than against the returned shape alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getNodeValues, outputNodeValues } from './node.types';
import type { AppNode } from './node.types';

const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('outputNodeValues', () => {
  it('coerces every non-object to {} — `in` is what throws', () => {
    for (const junk of [5, 'abc', [], true, null, undefined, NaN, 0, '']) {
      const v = outputNodeValues({ registryType: 'output', values: junk });
      expect(v).toEqual({});
      expect(() => 'opacity' in v).not.toThrow();
    }
  });

  it('the raw field is what throws, so the guard is not decorative', () => {
    // The shape this replaces, executed: proof the test above is not vacuous.
    const raw: unknown = (({ values: 5 } as { values?: unknown }).values) ?? {};
    expect(() => 'opacity' in (raw as object)).toThrow(TypeError);
  });

  it('returns the SAME object for a real bag, so no memo is invalidated', () => {
    const values = { color: '#ffffff', roughness: 0.4 };
    expect(outputNodeValues({ registryType: 'output', values })).toBe(values);
  });

  it('takes absent data and absent values', () => {
    expect(outputNodeValues(undefined)).toEqual({});
    expect(outputNodeValues(null)).toEqual({});
    expect(outputNodeValues({ registryType: 'output' })).toEqual({});
  });

  it('shares ONE shape guard with getNodeValues', () => {
    const junk = { type: 'mul', data: { registryType: 'mul', label: 'mul', cost: 1, values: 5 } } as unknown as AppNode;
    expect(getNodeValues(junk)).toEqual(outputNodeValues(junk.data));
  });
});

describe('no Output reader keeps the nullish-only guard', () => {
  const MENU = src('../components/NodeEditor/menus/ShaderSettingsMenu.tsx');
  const OUTPUT_NODE = src('../components/NodeEditor/nodes/OutputNode.tsx');

  it('ShaderSettingsMenu reads through the accessor', () => {
    expect(MENU).toContain('const values = outputNodeValues(outputData);');
    expect(MENU).not.toMatch(/const values = outputData\?\.values;/);
  });

  it('OutputNode reads through the accessor on both paths', () => {
    expect(OUTPUT_NODE).toContain('const values = outputNodeValues(data);');
    expect(OUTPUT_NODE).toContain('return outputNodeValues(node?.data);');
    expect(OUTPUT_NODE).not.toMatch(/\?\.values \?\? \{\}/);
    expect(OUTPUT_NODE).not.toMatch(/\(data as OutputNodeData\)\.values \?\? \{\}/);
  });
});
