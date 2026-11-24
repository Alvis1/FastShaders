/**
 * The Image → Normal colour-space flip (normalMapFlip.ts), read after the
 * connect — directly, and through Branches and Portals in either wiring order.
 */
import { describe, it, expect } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { makeEdge, makeKnot, makeNode, makeTunnelIn, makeTunnelOut } from '@/test-utils';
import { imageToLinearize } from './normalMapFlip';

const img = () => makeNode('img', 'imageNode');
const out = () => makeNode('o', 'output');
const made = (e: AppEdge) => ({
  source: e.source,
  sourceHandle: e.sourceHandle,
  target: e.target,
  targetHandle: e.targetHandle,
});

describe('imageToLinearize', () => {
  it('flips an image wired straight into Normal', () => {
    const w = makeEdge('img', 'out', 'o', 'normal');
    expect(imageToLinearize([img(), out()], [w], made(w))).toBe('img');
  });

  it('never for a channel socket, an image already in data, or one that also feeds Color', () => {
    const ch = makeEdge('img', 'r', 'o', 'normal');
    expect(imageToLinearize([img(), out()], [ch], made(ch))).toBeNull();
    const data = makeNode('img', 'imageNode', { colorSpace: 'data' });
    const w = makeEdge('img', 'out', 'o', 'normal');
    expect(imageToLinearize([data, out()], [w], made(w))).toBeNull();
    expect(imageToLinearize([img(), out()], [makeEdge('img', 'out', 'o', 'color'), w], made(w))).toBeNull();
  });

  it('through a Branch, in either order', () => {
    const nodes: AppNode[] = [img(), out(), makeKnot('k')];
    const intoK = makeEdge('img', 'out', 'k', 'in');
    const kOut = makeEdge('k', 'out', 'o', 'normal');
    // Branch → Normal made LAST: the wire out of the Branch resolves to the image.
    expect(imageToLinearize(nodes, [intoK, kOut], made(kOut))).toBe('img');
    // Image → Branch made LAST (Branch → Normal was already there).
    expect(imageToLinearize(nodes, [kOut, intoK], made(intoK))).toBe('img');
    // A Branch that feeds Color too keeps the image sRGB.
    const kColor = makeEdge('k', 'out', 'o', 'color');
    expect(imageToLinearize(nodes, [kOut, kColor, intoK], made(intoK))).toBeNull();
    // A Branch that feeds no Normal flips nothing.
    expect(imageToLinearize(nodes, [kColor, intoK], made(intoK))).toBeNull();
  });

  it('through a Branch chain and a Portal', () => {
    const nodes: AppNode[] = [img(), out(), makeKnot('k1'), makeKnot('k2'), makeTunnelIn('in1'), makeTunnelOut('x1', 'in1')];
    const intoK1 = makeEdge('img', 'out', 'k1', 'in');
    const edges = [
      makeEdge('k1', 'out', 'k2', 'in'),
      makeEdge('k2', 'out', 'in1', 'in'),
      makeEdge('x1', 'out', 'o', 'normal'),
      intoK1,
    ];
    expect(imageToLinearize(nodes, edges, made(intoK1))).toBe('img');
  });
});
