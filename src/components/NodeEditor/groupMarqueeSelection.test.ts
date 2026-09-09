import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyGroupMarqueeRule, type MarqueeSelectionNode } from './groupMarqueeSelection';

const NODE_EDITOR = readFileSync(new URL('./NodeEditor.tsx', import.meta.url), 'utf8');
const GROUP_CSS = readFileSync(new URL('./nodes/GroupNode.css', import.meta.url), 'utf8');

const node = (id: string, parentId?: string, selected = false): MarqueeSelectionNode =>
  ({ id, type: 'shader', parentId, selected });
const group = (id: string, opts: { parentId?: string; selected?: boolean; collapsed?: boolean } = {}): MarqueeSelectionNode =>
  ({ id, type: 'group', parentId: opts.parentId, selected: opts.selected ?? false, data: { collapsed: opts.collapsed } });
const sel = (id: string, selected: boolean) => ({ type: 'select', id, selected });

/** Where each id ends up after the rule has had its say. */
const resolve = (nodes: MarqueeSelectionNode[], changes: ReturnType<typeof sel>[]) => {
  const out = new Map(nodes.map((n) => [n.id, !!n.selected]));
  for (const c of applyGroupMarqueeRule(nodes, changes)) {
    if (c.type === 'select' && c.id) out.set(c.id, !!c.selected);
  }
  return out;
};

describe('applyGroupMarqueeRule', () => {
  it('does NOT take the frame when only SOME of its members are swept', () => {
    // THE defect: SelectionMode.Partial means a band drawn anywhere inside a
    // frame overlaps the frame, so React Flow proposed it alongside the two
    // nodes actually picked — and dragging that moved the whole group.
    const nodes = [group('g'), node('a', 'g'), node('b', 'g'), node('c', 'g')];
    const after = resolve(nodes, [sel('g', true), sel('a', true), sel('b', true)]);
    expect(after.get('a')).toBe(true);
    expect(after.get('b')).toBe(true);
    expect(after.get('g')).toBe(false);
  });

  it('DOES take the frame once every member is swept', () => {
    // Otherwise dragging the selection would carry every member out of a frame
    // that stayed behind — and the drop would then detach them from it.
    const nodes = [group('g'), node('a', 'g'), node('b', 'g')];
    const after = resolve(nodes, [sel('g', true), sel('a', true), sel('b', true)]);
    expect(after.get('g')).toBe(true);
  });

  it('drops the frame again when a member leaves the band', () => {
    // React Flow will not re-propose this: its own set still holds the group,
    // so nothing emits select:false for it. The rule has to say so itself.
    const nodes = [group('g', { selected: true }), node('a', 'g', true), node('b', 'g', true)];
    const after = resolve(nodes, [sel('b', false)]);
    expect(after.get('g')).toBe(false);
  });

  it('adds the frame with NO help from React Flow when the set stops changing', () => {
    // The reason the rule reads MEMBERS and not the rectangle: growing the
    // band to cover the frame sweeps in no new node, so React Flow's set is
    // unchanged and it emits nothing at all. Here the last member's own change
    // is what carries the frame.
    const nodes = [group('g'), node('a', 'g', true), node('b', 'g')];
    const out = applyGroupMarqueeRule(nodes, [sel('b', true)]);
    expect(out).toContainEqual({ type: 'select', id: 'g', selected: true });
  });

  it('leaves a COLLAPSED group alone — a pill stands in for a node', () => {
    const nodes = [group('g', { collapsed: true }), node('a', 'g')];
    const out = applyGroupMarqueeRule(nodes, [sel('g', true)]);
    expect(out).toContainEqual(sel('g', true));
  });

  it('never marquee-selects an EMPTY frame', () => {
    // Documented gap rather than an oversight: with no members there is
    // nothing to have "taken", and the alternative is a frame that any band
    // near it grabs for free. Its header and the select-all key still work.
    const nodes = [group('g'), node('loose')];
    const after = resolve(nodes, [sel('g', true), sel('loose', true)]);
    expect(after.get('g')).toBe(false);
    expect(after.get('loose')).toBe(true);
  });

  it('resolves NESTED frames deepest-first', () => {
    // The outer frame's members include the inner FRAME, whose own answer is
    // derived — so the order is load-bearing: outer-first would read a stale
    // inner selection and never take the outer.
    const nodes = [
      group('outer'),
      group('inner', { parentId: 'outer' }),
      node('a', 'inner'),
      node('b', 'outer'),
    ];
    const after = resolve(nodes, [
      sel('outer', true), sel('inner', true), sel('a', true), sel('b', true),
    ]);
    expect(after.get('inner')).toBe(true);
    expect(after.get('outer')).toBe(true);
  });

  it('does not take the outer frame when only the inner one is filled', () => {
    const nodes = [
      group('outer'), group('inner', { parentId: 'outer' }),
      node('a', 'inner'), node('b', 'outer'),
    ];
    const after = resolve(nodes, [sel('outer', true), sel('inner', true), sel('a', true)]);
    expect(after.get('inner')).toBe(true);
    expect(after.get('outer')).toBe(false);
  });

  it('passes non-select changes and group-free graphs straight through', () => {
    const moves = [{ type: 'position', id: 'a' }];
    expect(applyGroupMarqueeRule([node('a')], moves)).toBe(moves);
    const picks = [sel('a', true)];
    expect(applyGroupMarqueeRule([node('a')], picks)).toBe(picks);
  });

  it('survives a parent CYCLE from a hand-edited file', () => {
    // parentId comes out of a `.fastshader`; the depth walk must not spin.
    const nodes = [group('g1', { parentId: 'g2' }), group('g2', { parentId: 'g1' })];
    expect(() => applyGroupMarqueeRule(nodes, [sel('g1', true)])).not.toThrow();
  });
});

describe('where the rule is applied', () => {
  it('only while a marquee is in progress, gated on userSelectionRect', () => {
    // `userSelectionActive` is set AFTER the first batch of select changes is
    // dispatched, so it would let the opening sweep through unchanged.
    expect(NODE_EDITOR).toMatch(/userSelectionRect[\s\S]{0,200}applyGroupMarqueeRule/);
    expect(NODE_EDITOR).not.toMatch(/userSelectionActive[\s\S]{0,120}applyGroupMarqueeRule/);
  });

  it('leaves selectAll dispatching straight to the store', () => {
    // The A key deliberately takes frames along with everything else, which it
    // keeps by never passing through this wrapper.
    expect(NODE_EDITOR).toMatch(/useAppStore\.getState\(\)\.onNodesChange\(changes\)/);
  });
});

describe('an expanded frame is dragged by its HEADER only', () => {
  it('passes pointer events through the frame body', () => {
    // The other half of "select inside a group": if the body captured the
    // press, the band would never start — the drag would move the frame.
    const css = GROUP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(
      /\.react-flow__node\.react-flow__node-group,\s*\.react-flow__node-group \.group-node \{[^}]*pointer-events: none !important/,
    );
  });

  it('opts the header, the resize grip and a collapsed pill back in — and nothing else', () => {
    const css = GROUP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = /([^}]*)\{\s*pointer-events: auto !important;\s*\}/.exec(css);
    expect(block).not.toBeNull();
    const selectors = block![1].split(',').map((x) => x.trim()).filter(Boolean).sort();
    expect(selectors).toEqual([
      '.react-flow__node-group .group-node--collapsed',
      '.react-flow__node-group .group-node__header',
      '.react-flow__node-group .react-flow__resize-control',
    ]);
  });
});
