/**
 * An Image wired in PLACE of another source samples where that source sampled
 * (imageUvHandoff.ts). The case that shipped: the LED Display texture's noise
 * reads each display pixel's CENTRE, and an Image wired into Max in its place
 * read the mesh UV instead — every diode showed a slice of the photo, not one
 * flat colour. Pinned through `connectNodes`, the one connect rule every wire
 * drop, drag-connect and menu connect funnels through.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { connectNodes } from './edgeInsert';
import { inheritedImageUv } from './imageUvHandoff';

/** uv → Divide(uv, grid) → Noise.pos → Max.a — the LED texture's picture slot. */
function ledSlot() {
  useAppStore.setState({
    nodes: [
      makeNode('u', 'uv'),
      makeNode('g', 'float'),
      makeNode('d', 'div'),
      makeNode('n', 'perlinVec3'),
      makeNode('mx', 'max'),
      makeNode('img', 'imageNode'),
    ],
    edges: [
      makeEdge('u', 'out', 'd', 'a'),
      makeEdge('g', 'out', 'd', 'b'),
      makeEdge('d', 'out', 'n', 'pos'),
      makeEdge('n', 'out', 'mx', 'a'),
    ],
  });
}

const edges = () => useAppStore.getState().edges;
const into = (id: string, handle: string) =>
  edges().filter((e) => e.target === id && e.targetHandle === handle);
const imageNode = () => useAppStore.getState().nodes.find((n) => n.id === 'img')!;

describe('an Image replacing a source inherits its coordinate', () => {
  beforeEach(ledSlot);

  it('takes the coordinate the replaced noise read (noise still on the canvas)', () => {
    connectNodes('img', 'out', 'mx', 'a');
    expect(into('mx', 'a').map((e) => e.source)).toEqual(['img']);
    expect(into('img', 'uv').map((e) => e.source)).toEqual(['d']);
    // The socket is hidden at rest: the hand-off must expose it, or the wire
    // exists in the store, steers the codegen, and never draws.
    expect(effectiveExposedPorts(imageNode() as never)).toContain('uv');
  });

  it('takes the wire a deleted noise left behind (Divide bridged into Max)', () => {
    useAppStore.setState({
      nodes: useAppStore.getState().nodes.filter((n) => n.id !== 'n'),
      edges: [makeEdge('u', 'out', 'd', 'a'), makeEdge('g', 'out', 'd', 'b'), makeEdge('d', 'out', 'mx', 'a')],
    });
    connectNodes('img', 'out', 'mx', 'a');
    expect(into('mx', 'a').map((e) => e.source)).toEqual(['img']);
    expect(into('img', 'uv').map((e) => e.source)).toEqual(['d']);
  });

  it('works from a channel socket too — every output reads the same sample', () => {
    connectNodes('img', 'r', 'mx', 'a');
    expect(into('img', 'uv').map((e) => e.source)).toEqual(['d']);
  });

  it('swapping one Image for another keeps the first one\'s UV', () => {
    useAppStore.setState({
      nodes: [...useAppStore.getState().nodes, makeNode('img0', 'imageNode')],
      edges: [
        makeEdge('u', 'out', 'd', 'a'),
        makeEdge('g', 'out', 'd', 'b'),
        makeEdge('d', 'out', 'img0', 'uv'),
        makeEdge('img0', 'out', 'mx', 'a'),
      ],
    });
    connectNodes('img', 'out', 'mx', 'a');
    expect(into('img', 'uv').map((e) => e.source)).toEqual(['d']);
  });
});

describe('…and hands over nothing when nothing is unambiguous', () => {
  beforeEach(ledSlot);

  it('never a constant: a fixed vec2 is not a place on the surface', () => {
    useAppStore.setState({
      nodes: [...useAppStore.getState().nodes, makeNode('c', 'vec2')],
      edges: [makeEdge('c', 'out', 'mx', 'a')],
    });
    connectNodes('img', 'out', 'mx', 'a');
    expect(into('img', 'uv')).toEqual([]);
  });

  it('never a 3-D coordinate: an Image samples a 2-D one', () => {
    useAppStore.setState({
      nodes: [...useAppStore.getState().nodes, makeNode('nl', 'normalLocal')],
      edges: [makeEdge('nl', 'out', 'n', 'pos'), makeEdge('n', 'out', 'mx', 'a')],
    });
    connectNodes('img', 'out', 'mx', 'a');
    expect(into('img', 'uv')).toEqual([]);
  });

  it('never an operand: only a sampler\'s coordinate socket says where it sampled', () => {
    // Multiply(Divide, vec3) is vec3 wide, so it is not a coordinate itself,
    // and its `a` is an operand — not a `uv`/`pos` socket.
    useAppStore.setState({
      nodes: [...useAppStore.getState().nodes, makeNode('m', 'mul'), makeNode('k', 'vec3')],
      edges: [
        makeEdge('u', 'out', 'd', 'a'),
        makeEdge('g', 'out', 'd', 'b'),
        makeEdge('d', 'out', 'm', 'a'),
        makeEdge('k', 'out', 'm', 'b'),
        makeEdge('m', 'out', 'mx', 'a'),
      ],
    });
    connectNodes('img', 'out', 'mx', 'a');
    expect(into('img', 'uv')).toEqual([]);
  });

  it('never over a UV the Image already has', () => {
    useAppStore.setState({
      edges: [...edges(), makeEdge('u', 'out', 'img', 'uv')],
    });
    connectNodes('img', 'out', 'mx', 'a');
    expect(into('img', 'uv').map((e) => e.source)).toEqual(['u']);
  });

  it('never into an EMPTY input — there was no source to replace', () => {
    connectNodes('img', 'out', 'mx', 'b');
    expect(into('img', 'uv')).toEqual([]);
  });

  it('never from a source that is not an Image', () => {
    connectNodes('g', 'out', 'mx', 'a');
    expect(edges().filter((e) => e.target === 'img')).toEqual([]);
    expect(edges()).toHaveLength(4);
  });

  it('never a coordinate that depends on the picture itself (a cycle)', () => {
    // Divide's divisor is the Image's own R channel: wiring Divide into the
    // Image's UV would close a loop.
    useAppStore.setState({
      edges: [
        makeEdge('u', 'out', 'd', 'a'),
        makeEdge('img', 'r', 'd', 'b'),
        makeEdge('d', 'out', 'n', 'pos'),
        makeEdge('n', 'out', 'mx', 'a'),
      ],
    });
    const { nodes, edges: es } = useAppStore.getState();
    expect(inheritedImageUv(nodes, es, 'img', 'mx', 'a')).toBeNull();
  });
});
