/**
 * What the intro scenes share about graphs: their tiny node/edge sets built the
 * way the canvas builds them (never the store's — see ConnectScene), the value
 * text a wired input shows, and a still wire drawn with TypedEdge's geometry.
 */
import { memo, type RefObject } from 'react';
import { getBezierPath, Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import type { AppEdge, AppNode, NodeDefinition } from '@/types';
import { channelCount, edgeValueLabel } from '@/components/NodeEditor/nodes/ShaderNode';
import type { PortPreviewState } from '@/components/NodeEditor/nodes/NodeVisual';
import {
  ClockCardContent,
  MathCardContent,
  NoiseCardContent,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { useCostChrome } from '@/components/NodeEditor/nodes/useCostChrome';
import type { WaveformDynamicRefs } from '@/components/NodeEditor/nodes/WaveformSvg';
import { computeReachableCost } from '@/utils/nodeCost';
import {
  ARROW_FLARE,
  arrowMarks,
  chevronPath,
  edgeBezier,
  ribbonHalfWidth,
  ribbonNormal,
  ribbonOffsets,
  ribbonStrokeWidth,
} from '@/components/NodeEditor/edges/bezierGeometry';
import { COUNT_EDGE_COLORS, getContrastColor } from '@/utils/colorUtils';
import { initialNodeValues } from '@/utils/newNodeValues';
import { generateEdgeId } from '@/utils/idGenerator';
import type { Point } from './timeline';

export interface SceneEdge {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/** Edges as the canvas stores them (`generateEdgeId`, typed). */
export function toAppEdges(edges: readonly SceneEdge[]): AppEdge[] {
  return edges.map((e) => ({
    id: generateEdgeId(e.source, e.sourceHandle, e.target, e.targetHandle),
    ...e,
    type: 'typed',
    data: { dataType: 'any' },
  })) as AppEdge[];
}

/** Nodes built the way a palette drop builds fresh ones. */
export function sceneNodes(list: ReadonlyArray<{ id: string; def: NodeDefinition }>): AppNode[] {
  return list.map(({ id, def }) =>
    def.type === 'output'
      ? ({ id, type: 'output', position: { x: 0, y: 0 }, data: { registryType: 'output', label: def.label, cost: 0 } } as unknown as AppNode)
      : ({
          id,
          type: getFlowNodeType(def),
          position: { x: 0, y: 0 },
          data: { registryType: def.type, label: def.label, cost: 0, values: initialNodeValues(def, [], () => 0) },
        } as unknown as AppNode),
  );
}

/** What arrives on `edge` — the label a connected input shows, evaluated on
 *  the scene's own graph. */
export function wiredValue(
  nodes: ReadonlyArray<{ id: string; def: NodeDefinition }>,
  edges: readonly SceneEdge[],
  edge: SceneEdge,
): PortPreviewState {
  return edgePortState(sceneNodes(nodes), toAppEdges(edges), edge);
}

/** The same, on a graph of real nodes (a built-in asset's), with the channel
 *  count ShaderNode stacks its card by. */
export function edgePortState(nodes: AppNode[], edges: AppEdge[], edge: SceneEdge): PortPreviewState {
  const l = edgeValueLabel(edge.source, nodes, edges, edge.sourceHandle);
  return {
    mode: l.live || l.animated ? 'live' : 'inf',
    ch: channelCount(edge.source, edge.sourceHandle, nodes, edges),
    val: l.text,
  };
}

export function wiredValueText(
  nodes: ReadonlyArray<{ id: string; def: NodeDefinition }>,
  edges: readonly SceneEdge[],
  edge: SceneEdge,
): string {
  return wiredValue(nodes, edges, edge).val;
}

/** TypedEdge's one-channel wire colour. */
export function useWireInk(): string {
  return getContrastColor(useAppStore((s) => s.nodeEditorBgColor));
}

/** A still wire from a socket's outer edge to an input's: the stroke TypedEdge
 *  draws (one line per channel, `lines`; `wire` is the centreline) and its
 *  direction chevrons. */
export function wirePaths(
  src: Point,
  tgt: Point,
  exit: Position,
  boost = 1,
  count = 1,
): { wire: string; lines: string[]; arrows: string } {
  const path = (d: number, [px, py]: [number, number]) =>
    getBezierPath({
      sourceX: src.x + d * px, sourceY: src.y + d * py, sourcePosition: exit,
      targetX: tgt.x + d * px, targetY: tgt.y + d * py, targetPosition: Position.Left,
    })[0];
  const normal = ribbonNormal(src.x, src.y, tgt.x, tgt.y);
  const wire = path(0, normal);
  const lines = count > 1 ? ribbonOffsets(count).map((d) => path(d * boost, normal)) : [wire];
  const arrows = chevronPath(
    arrowMarks([edgeBezier(src.x, src.y, exit, tgt.x, tgt.y, Position.Left)]),
    (ribbonHalfWidth(count) + ARROW_FLARE) * boost,
  );
  return { wire, lines, arrows };
}

export function IntroWire({
  ink,
  boost = 1,
  count = 1,
  live = false,
  d,
  wireRef,
  arrowsRef,
}: {
  ink: string;
  boost?: number;
  /** Channels: a one-channel wire is canvas ink, a ribbon keeps its RGB(A). */
  count?: number;
  /** Time or Sound upstream: the wire MARCHES (React Flow's own `.animated`
   *  dash, which TypedEdge keeps for a live wire) and carries no chevrons. */
  live?: boolean;
  d?: { wire: string; lines?: string[]; arrows: string };
  wireRef?: RefObject<SVGPathElement>;
  arrowsRef?: RefObject<SVGPathElement>;
}) {
  const colours = count > 1 ? COUNT_EDGE_COLORS[count] ?? COUNT_EDGE_COLORS[1] : [ink];
  if (live) {
    return (
      <g className="react-flow__edge animated">
        {(count > 1 && d?.lines ? d.lines : [d?.wire]).map((line, i) => (
          <path key={i} d={line} fill="none" stroke={colours[i] ?? ink} strokeWidth={ribbonStrokeWidth(count) * boost} opacity={0.9} />
        ))}
      </g>
    );
  }
  return (
    <>
      {count > 1 && d?.lines ? (
        d.lines.map((line, i) => (
          <path key={i} d={line} fill="none" stroke={colours[i]} strokeWidth={ribbonStrokeWidth(count) * boost} opacity={0.9} />
        ))
      ) : (
        <path ref={wireRef} d={d?.wire} fill="none" stroke={ink} strokeWidth={ribbonStrokeWidth(1) * boost} opacity={0.9} />
      )}
      <path
        ref={arrowsRef}
        d={d?.arrows}
        fill="none"
        stroke={ink}
        strokeWidth={ribbonStrokeWidth(1) * boost}
        strokeLinecap="round"
        opacity={0.9}
      />
    </>
  );
}

/**
 * Where the dragged connection line ends: the pointer, until it comes within
 * `radius` of the socket — then on the socket, as React Flow's line snaps to
 * the handle it will connect to.
 */
export function connectionEnd(cursor: Point, socket: Point, radius: number): Point {
  return Math.hypot(cursor.x - socket.x, cursor.y - socket.y) <= radius ? socket : cursor;
}

/** The line a connection drag draws, from an output socket to `end` — React
 *  Flow's own default bezier. */
export function connectionPath(from: Point, end: Point): string {
  return getBezierPath({
    sourceX: from.x, sourceY: from.y, sourcePosition: Position.Right,
    targetX: end.x, targetY: end.y, targetPosition: Position.Left,
  })[0];
}

/** The connection being dragged, in React Flow's own connection-line classes
 *  (its grey default look); the scene writes `d` per frame through `lineRef`. */
export function IntroConnectionLine({ lineRef }: { lineRef: RefObject<SVGPathElement> }) {
  return (
    <svg className="react-flow__connectionline fs-intro__wires">
      <g className="react-flow__connection">
        <path ref={lineRef} className="react-flow__connection-path" />
      </g>
    </svg>
  );
}

/** The refs a scene animates a card through (the canvas's frame helpers). */
export interface CardRefs {
  hand?: RefObject<SVGGElement>;
  wave?: WaveformDynamicRefs;
  noise?: RefObject<HTMLCanvasElement>;
}

/**
 * One node of a scene graph, drawn by its flow type's card replica — the
 * Output with what arrives on each socket and the graph's total, a shader
 * card with its wired inputs' values. `live` hands a math card its wave refs.
 */
export const GraphCard = memo(function GraphCard({
  node,
  graph,
  live = false,
  refs = {},
}: {
  node: AppNode;
  graph: { nodes: AppNode[]; edges: AppEdge[] };
  live?: boolean;
  refs?: CardRefs;
}) {
  const def = NODE_REGISTRY.get(node.data.registryType as string)!;
  const chrome = useCardChrome(def);
  const sinkCost = def.type === 'output' ? computeReachableCost(graph.nodes, graph.edges) : 0;
  const sinkChrome = useCostChrome(sinkCost);
  const into = graph.edges.filter((e) => e.target === node.id);
  const arriving = (e: AppEdge) =>
    edgePortState(graph.nodes, graph.edges, {
      source: e.source,
      sourceHandle: e.sourceHandle ?? 'out',
      target: e.target,
      targetHandle: e.targetHandle ?? 'in',
    });
  const flow = getFlowNodeType(def);
  if (flow === 'output') {
    const wired: Record<string, string> = {};
    for (const e of into) wired[e.targetHandle ?? 'color'] = arriving(e).val;
    return <OutputCardContent {...chrome} {...sinkChrome} cost={sinkCost} wired={wired} />;
  }
  if (flow === 'clock') return <ClockCardContent {...chrome} handRef={refs.hand} />;
  if (flow === 'mathPreview') return <MathCardContent {...chrome} xWired={into.length > 0} dynamicRefs={live ? refs.wave : undefined} />;
  if (flow === 'preview') {
    const exposed = (node.data as { exposedPorts?: string[] }).exposedPorts ?? [];
    return <NoiseCardContent {...chrome} exposedPorts={exposed} canvasRef={refs.noise} />;
  }
  const portStates = Object.fromEntries(into.map((e) => [e.targetHandle ?? 'in', arriving(e)]));
  return <ShaderCardContent {...chrome} portStates={into.length > 0 ? portStates : undefined} />;
});
