import { describe, it, expect } from 'vitest';
import type { AppNode } from '@/types';
import { makeNode } from '@/test-utils';
import {
  expandSelection,
  monacoText,
  planHighlight,
  revealTarget,
  selectionKey,
  MAX_GROUP_DEPTH,
  type HighlightItem,
} from './nodeCodeHighlight';

/**
 * The pure half of the code panel's node → code highlight
 * (useNodeCodeHighlight.ts): which nodes a selection means, what to draw,
 * where a click's reveal goes.
 */

const node = (id: string, opts: { selected?: boolean; parentId?: string } = {}): AppNode =>
  ({ ...makeNode(id, 'float'), ...opts }) as AppNode;
const group = (id: string, opts: { selected?: boolean; parentId?: string } = {}): AppNode =>
  ({ id, type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: id }, ...opts }) as unknown as AppNode;

const line = (from: number, to: number, kind: HighlightItem['kind'] = 'own'): HighlightItem => ({
  startLineNumber: from,
  startColumn: 1,
  endLineNumber: to,
  endColumn: 10,
  kind,
  inline: false,
});
const inline = (ln: number, from: number, to: number, kind: HighlightItem['kind'] = 'own'): HighlightItem => ({
  startLineNumber: ln,
  startColumn: from,
  endLineNumber: ln,
  endColumn: to,
  kind,
  inline: true,
});

describe('selectionKey', () => {
  it('folds the selected ids into one string, empty for none', () => {
    expect(selectionKey([node('a'), node('b')])).toBe('');
    expect(selectionKey([node('a', { selected: true }), node('b'), node('c', { selected: true })])).toBe('a\nc\n');
  });
});

describe('expandSelection', () => {
  it('a selected frame means every member, nested frames included, in nodes order', () => {
    const nodes = [
      group('g', { selected: true }),
      node('a', { parentId: 'g' }),
      group('inner', { parentId: 'g' }),
      node('b', { parentId: 'inner' }),
      node('c'),
    ];
    const sel = expandSelection(nodes);
    expect(sel.ids).toEqual(['g', 'a', 'inner', 'b']);
    expect(sel.units).toEqual(['g']);
  });

  it('a marquee that takes a frame AND its members is ONE unit', () => {
    const nodes = [group('g', { selected: true }), node('a', { parentId: 'g', selected: true }), node('b', { selected: true })];
    const sel = expandSelection(nodes);
    expect(sel.ids).toEqual(['g', 'a', 'b']);
    expect(sel.units).toEqual(['g', 'b']);
  });

  it('a selected plain node is its own unit; a node is listed once', () => {
    const sel = expandSelection([node('a', { selected: true })]);
    expect(sel).toEqual({ ids: ['a'], units: ['a'] });
  });

  it('a parentId cycle from a file terminates', () => {
    const nodes = [group('g1', { selected: true, parentId: 'g2' }), group('g2', { parentId: 'g1' }), node('a', { parentId: 'g2' })];
    const sel = expandSelection(nodes);
    expect(sel.ids).toEqual(['g1', 'g2', 'a']);
    expect(sel.units).toEqual(['g1']);
  });

  it('a nest deeper than the cap stops there', () => {
    const nodes: AppNode[] = [group('g0', { selected: true })];
    for (let i = 1; i <= 200; i++) nodes.push(group(`g${i}`, { parentId: `g${i - 1}` }));
    const sel = expandSelection(nodes);
    expect(sel.ids.length).toBe(MAX_GROUP_DEPTH + 1);
    expect(sel.units).toEqual(['g0']);
  });
});

describe('planHighlight', () => {
  it('sorts, drops exact duplicates and merges touching whole-line runs of one kind', () => {
    const plan = planHighlight([line(4, 6), line(1, 2), line(3, 3), line(1, 2), line(9, 9), line(5, 5)]);
    expect(plan.map((p) => [p.startLineNumber, p.endLineNumber])).toEqual([[1, 6], [9, 9]]);
  });

  it('never merges inline items, nor whole-line items of different kinds', () => {
    const plan = planHighlight([line(1, 1, 'setup'), line(2, 2), inline(3, 5, 9), inline(3, 12, 20), inline(3, 12, 20, 'use')]);
    expect(plan.map((p) => [p.startLineNumber, p.startColumn, p.kind])).toEqual([
      [1, 1, 'setup'],
      [2, 1, 'own'],
      [3, 5, 'own'],
      [3, 12, 'own'],
      [3, 12, 'use'],
    ]);
  });

  it('keeps at most `cap` items, and nothing in is nothing out', () => {
    const many = Array.from({ length: 10 }, (_, i) => line(i * 3 + 1, i * 3 + 1));
    expect(planHighlight(many, 4)).toHaveLength(4);
    expect(planHighlight([])).toEqual([]);
  });
});

describe('revealTarget', () => {
  it('a body beats a module-scope setup, and nothing is null', () => {
    expect(revealTarget([line(2, 9, 'setup'), line(14, 14)])).toEqual(line(14, 14));
    expect(revealTarget([inline(4, 2, 6, 'use')])).toEqual(inline(4, 2, 6, 'use'));
    expect(revealTarget([])).toBeNull();
  });
});

describe('monacoText — a pair as Monaco holds it', () => {
  it('every CRLF and lone CR becomes LF; the line count is Monaco’s', () => {
    const pair = { code: 'a\r\nb\rc\nd', spans: new Map() };
    expect(monacoText(pair)).toBe('a\nb\nc\nd');
    expect(monacoText(pair).split('\n')).toHaveLength(pair.code.split(/\r\n|\r|\n/).length);
  });

  it('a text with no CR is the pair’s own string', () => {
    const pair = { code: 'const a = 1;\nconst b = 2;', spans: new Map() };
    expect(monacoText(pair)).toBe(pair.code);
  });
});
