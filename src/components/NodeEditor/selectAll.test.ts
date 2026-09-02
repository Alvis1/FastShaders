import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import { isSelectableNode, selectAllChanges } from './selectAll';

const sel = (n: AppNode, selected: boolean): AppNode => ({ ...n, selected }) as AppNode;
const hidden = (n: AppNode): AppNode => ({ ...n, className: 'fs-collapsed-member' }) as AppNode;

describe('selectAllChanges — the A key', () => {
  it('selects every visible node that is not yet selected', () => {
    const nodes = [makeNode('a', 'float'), sel(makeNode('b', 'mul'), true), makeNode('c', 'output')];
    expect(selectAllChanges(nodes)).toEqual([
      { type: 'select', id: 'a', selected: true },
      { type: 'select', id: 'c', selected: true },
    ]);
  });

  it('skips members hidden inside a collapsed group — the pill stands in for them', () => {
    const nodes = [hidden(makeNode('m1', 'float')), makeNode('g1', 'mul')];
    expect(isSelectableNode(nodes[0])).toBe(false);
    expect(selectAllChanges(nodes)).toEqual([{ type: 'select', id: 'g1', selected: true }]);
  });

  it('deselects everything once every visible node is selected (the toggle), hidden ones included', () => {
    const nodes = [sel(makeNode('a', 'float'), true), sel(makeNode('b', 'mul'), true), sel(hidden(makeNode('m', 'abs')), true)];
    expect(selectAllChanges(nodes)).toEqual([
      { type: 'select', id: 'a', selected: false },
      { type: 'select', id: 'b', selected: false },
      { type: 'select', id: 'm', selected: false },
    ]);
  });

  it('does nothing on an empty graph', () => {
    expect(selectAllChanges([])).toEqual([]);
  });

  it('is bound to a bare A in NodeEditor, beside F and Shift+A, through the same typing/modifier guards (source pin)', () => {
    const src = readFileSync(path.resolve(__dirname, 'NodeEditor.tsx'), 'utf8');
    const handler = src.slice(src.indexOf('F frames the SELECTION'), src.indexOf("key !== 'a'"));
    expect(handler).toMatch(/key === 'a' && !e\.shiftKey[\s\S]{0,400}selectAllChanges\(/);
    expect(handler).toContain("if (tag === 'INPUT' || tag === 'TEXTAREA') return;");
    expect(handler).toContain('if (e.metaKey || e.ctrlKey || e.altKey) return;');
  });
});
