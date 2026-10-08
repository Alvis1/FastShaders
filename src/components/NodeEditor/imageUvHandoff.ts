/**
 * An Image wired in PLACE of another source samples where that source sampled.
 *
 * The Image node's UV socket is hidden at rest, and an unwired UV reads the
 * mesh's own `uv()` — so swapping a coordinate-driven source (a noise, another
 * Image) for a picture used to change WHERE the picture is read without
 * anything on the canvas saying so. The LED Display texture is the case that
 * shipped: its noise reads each display pixel's CENTRE, and an Image wired
 * into Max in its place was read at every fragment instead, so every diode
 * showed a slice of the photo rather than one flat colour.
 *
 * Splicing an Image onto a wire already did the right thing (the wire's source
 * lands on its first free input, `uv`); this is the same answer for the other
 * swap gesture, a wire into an occupied input. It hands over a coordinate only
 * when one is unambiguous:
 *  - the displaced source IS one — a 2-channel value that varies over the
 *    surface (the wire a deleted noise leaves behind), or
 *  - the displaced source READS one on its coordinate socket (`uv` on an Image,
 *    `pos` on a noise) — the noise or the Image being replaced.
 * A constant (a fixed vec2) never counts, and neither does a 3-D position: an
 * Image samples a 2-D coordinate. Nothing happens when the Image's UV is
 * already wired, or when the wire would close a cycle.
 *
 * Pure: the caller (`connectNodes`) wires and exposes the socket under its own
 * history bracket, so one undo reverts the connection and the hand-off together.
 */
import type { AppNode, AppEdge } from '@/types';
import { getEdgeOutputShape, getFieldUpstreamSet } from '@/engine/cpuEvaluator';
import { wouldCreateCycle } from './dragConnect';

/** The sockets a sampler reads its coordinate from. */
const COORDINATE_HANDLES: ReadonlySet<string> = new Set(['uv', 'pos']);

export interface UvSource {
  source: string;
  sourceHandle: string | null;
}

/**
 * The coordinate an Image should inherit when `source` (an Image output) is
 * wired into `target.targetHandle` — read BEFORE the connection replaces that
 * input's current wire. Null when there is nothing to hand over.
 */
export function inheritedImageUv(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  source: string,
  target: string,
  targetHandle: string | null,
): UvSource | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.get(source)?.data.registryType !== 'imageNode') return null;
  if (edges.some((e) => e.target === source && e.targetHandle === 'uv')) return null;
  const displaced = edges.find((e) => e.target === target && e.targetHandle === targetHandle);
  if (!displaced || displaced.source === source) return null;

  const nodeList = nodes as AppNode[];
  const edgeList = edges as AppEdge[];
  const field = getFieldUpstreamSet(nodeList, edgeList);
  const isCoordinate = (e: AppEdge) =>
    field.has(e.source) && getEdgeOutputShape(e, nodeList, edgeList) === 2;
  const coord = isCoordinate(displaced)
    ? displaced
    : edges.find(
        (e) =>
          e.target === displaced.source &&
          COORDINATE_HANDLES.has(e.targetHandle ?? '') &&
          isCoordinate(e),
      );
  if (!coord || coord.source === source) return null;
  // Group frames carry no shader semantics; a coordinate is a real node.
  if (byId.get(coord.source)?.type === 'group') return null;
  // The coordinate must not depend on the picture it would steer — counted on
  // the graph as it will be, with the Image already wired into the target.
  const after = [
    ...edges.filter((e) => !(e.target === target && e.targetHandle === targetHandle)),
    { source, target },
  ];
  if (wouldCreateCycle(after, coord.source, source)) return null;
  return { source: coord.source, sourceHandle: coord.sourceHandle ?? null };
}
