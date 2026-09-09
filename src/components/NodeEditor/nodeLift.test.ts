/**
 * What a LIFTED canvas node does — hovered, selected, or with its menu open.
 *
 * It deepens its shadow and grows very slightly. It does NOT move, and the
 * distinction is the whole point of this file.
 *
 * The 3px translate this replaced had a defect it could not avoid: React Flow
 * computes wire endpoints from stored positions and knows nothing about a CSS
 * translate, so every wire on a lifted node was offset by the same 3px to stay
 * on its socket — a PREDICTION that holds only while React Flow measured the
 * sockets with the card at rest. Selecting a node also thickens its border,
 * which changes its SIZE, which fires React Flow's per-node ResizeObserver and
 * re-measures the handles while the card is displaced. The displacement was
 * then baked into the bounds AND added again by the edge. Hover was exempt for
 * the one reason that made it hard to place: hover does not thicken the border,
 * so it triggers no re-measure.
 *
 * The GROWTH is not a smaller version of the same bug, and the size is why.
 * A transform changes no layout, so it fires no observer of its own; it does
 * move the sockets (getBoundingClientRect includes transforms), but at 1.02 on
 * a 50px node the extreme socket moves 0.5px — against the 3px that was
 * reported as wires hanging off their ports — and nothing predicts it in JS any
 * more, so the worst case is a stale sub-pixel offset rather than a doubled
 * visible one. Raising the scale materially brings the defect back at a size
 * people can see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const base = read('./nodes/NodeBase.css');
const tokens = read('../../styles/tokens.css');
const edge = read('./edges/TypedEdge.tsx');

describe('a lifted node', () => {
  it('does not move — nothing publishes or reads a shift any more', () => {
    for (const f of ['./nodes/NodeBase.css', './nodes/ColorNode.css', './nodes/GroupNode.css',
                     './nodes/NoteNode.css', './nodes/OutputNode.css']) {
      expect(read(f), `${f} still shifts a canvas node`).not.toContain('--fs-node-shift');
    }
  });

  it('grows instead, by a scale small enough to stay under the old defect', () => {
    expect(base).toContain('--fs-node-scale: var(--fs-node-grow);');
    expect(base).toContain('transform: scale(var(--fs-node-scale, 1));');
    const m = /--fs-node-grow:\s*([\d.]+);/.exec(tokens);
    expect(m, 'the growth token is gone').toBeTruthy();
    const grow = Number(m![1]);
    // The bound that keeps a socket's movement sub-pixel on a typical node.
    expect(grow).toBeGreaterThan(1);
    expect(grow).toBeLessThanOrEqual(1.03);
  });

  it('carries the multi-channel stack layers with it', () => {
    // They are absolute siblings of the card; left at the resting size, a
    // lifted stacked node visibly comes apart.
    const stack = base.slice(base.indexOf('.node-base__stack {'), base.indexOf('.node-base__stack {') + 700);
    expect(stack).toContain('transform: scale(var(--fs-node-scale, 1));');
  });

  it('exempts an expanded group frame, which must not move OR grow', () => {
    // Its members are separate nodes that stay put, so a frame that changed
    // size would visibly detach from the cluster it encloses.
    const rule = base.slice(base.indexOf('.react-flow__node-group:not(:has('));
    expect(rule.slice(0, 120)).toContain('--fs-node-scale: 1;');
  });

  it('gives the ASSET TILES the same lift, not the retired one', () => {
    // A tile that lifted differently from the node it depicts is the drift
    // assetCardGeometry.test.ts exists to stop. The scale also suits that
    // surface better: the strip is drawn through a computed zoom, so a
    // translate had to be sized to survive being multiplied by it, where a
    // scale is scale-invariant.
    const card = read('./NodePreviewCard.css');
    const browser = read('./ContentBrowser.css');
    expect(card).toContain('transform: scale(var(--fs-node-grow));');
    expect(browser).toContain('transform: scale(var(--fs-node-grow));');
    for (const f of [card, browser]) expect(f).not.toContain('--fs-node-rise');
  });

  it('has retired the rise token everywhere, not just stopped reading it', () => {
    // A declared-but-unused token invites the next reader to wire it back up.
    expect(tokens).not.toMatch(/^\s*--fs-node-rise:/m);
  });

  it('leaves the edges with nothing to compensate for', () => {
    // The prediction, its two per-edge store subscriptions and nodeRisePx are
    // all gone; React Flow's reported endpoints are simply used.
    expect(edge).not.toContain('nodeRisePx');
    expect(edge).not.toContain('liftedBySelection');
    expect(edge).toContain('const sourceX = rawSourceX;');
  });
});
