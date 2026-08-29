import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Panel,
  addEdge,
  reconnectEdge,
  useReactFlow,
  useStore,
  type ReactFlowState,
  Position,
  type OnConnect,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type InternalNode,
  BackgroundVariant,
  SelectionMode,
} from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, resolveDeviceTextureDim, resolveDeviceBudget } from '@/store/useAppStore';
import type { ContextMenuType } from '@/store/useAppStore';
import { useLongPress } from '@/hooks/useLongPress';
import { ShaderNode } from './nodes/ShaderNode';
import { ColorNode } from './nodes/ColorNode';
import { PreviewNode } from './nodes/PreviewNode';
import { MathPreviewNode } from './nodes/MathPreviewNode';
import { OutputNode } from './nodes/OutputNode';
import { ClockNode } from './nodes/ClockNode';
import { MicNode } from './nodes/MicNode';
import { AudioInputNode } from './nodes/AudioInputNode';
import { GroupNode } from './nodes/GroupNode';
import { NoteNode } from './nodes/NoteNode';
import { CONNECTION_RADIUS } from './nodes/connectionReveal';
import { clearSocketTapTooltip } from './handles/TypedHandle';
import { TypedEdge } from './edges/TypedEdge';
import { cardinalControlPoint, radialControlPoint, distancePointToCubicBezier, distancePointToSpline, insertWaypointOrdered, splinePath } from './edges/bezierGeometry';
import { DrawingLayer } from './DrawingLayer';
import { DrawToolbar } from './DrawToolbar';
import {
  quantizeOpacity,
  strokePointPairs,
  strokeBounds,
  MAX_POINTS_PER_STROKE,
  type DrawStroke,
} from '@/utils/drawings';
import { ContextMenu } from './menus/ContextMenu';
import { ContentBrowser } from './ContentBrowser';
import { useKeyboardNav } from './useKeyboardNav';
import { ColorPickerPopover } from '@/components/inputs/PaletteColorPicker';
import { NewShaderModal } from '@/components/Modals/NewShaderModal';
import { ImageImportModal, type ImageImportChoice } from '@/components/Modals/ImageImportModal';
import { ImageConvertInfoModal } from '@/components/Modals/ImageConvertInfoModal';
import { downloadShader } from '@/engine/exportShader';
import { evalLog, isEvalSessionActive } from '@/eval/telemetry';
import { evalTask } from '@/eval/evalTask';
import { SAVED_GROUP_DRAG_TYPE } from './SavedGroupCard';
import { BUILTIN_TEXTURE_DRAG_TYPE } from './TextureCard';
import { BUILTIN_PRESET_DRAG_TYPE } from './PresetCard';
import {
  TILE_DROP_EVENT,
  TILE_DRAG_MOVE_EVENT,
  TILE_DRAG_END_EVENT,
  getHtml5TileDrag,
  endHtml5TileDrag,
  type TileDropEventDetail,
  type TilePayload,
} from './tileDrag';
import {
  pickDropTargetNode,
  planDragConnect,
  wouldCreateCycle,
  type ConnectHandle,
  type DragConnectEndpoints,
  type DragConnectPlan,
  type NodeBox,
} from './dragConnect';
import { resolveOverlapCascade, type CascadeBox, type CascadeShift } from './overlapCascade';
import { pickSpliceInputPort } from './edgeSplice';
import { existingOutputId, focusOutputNode } from './outputFocus';
import {
  readStoredViewport, writeStoredViewport, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM,
  type StoredViewport,
} from '@/utils/viewportMemory';
import { outputDormancyFromState } from '@/utils/outputMaterials';
import { CostBar } from '@/components/Layout/CostBar';
import { PreviewLink } from '@/components/Layout/PreviewLink';
import { getCostScale, getContrastColor } from '@/utils/colorUtils';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import { isEdgeDisconnecting, setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import { bridgeEdgesAcrossDeletedNodes, makeTypedEdge, unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { parseCsv, COLUMN_WARN_THRESHOLD } from '@/utils/csvParser';
import { makeDataNodeData } from '@/utils/dataNode';
import { makeImageNodeFromEncode, resolveImageDrop, totalImageChars, MAX_TOTAL_IMAGE_CHARS } from '@/utils/imageNode';
import { stashImageOrigin } from '@/utils/imageOriginCache';
import { usesExposedPorts, effectiveExposedPorts } from '@/utils/exposedPorts';
import { encodeImageFile, isImageFile, isSvgFile, type ImageConvertMode } from '@/utils/imageImport';
import { importShaderZip, importShaderText, isZipFile } from '@/engine/projectImport';
import type { AppNode, AppEdge, ShaderNodeData, OutputNodeData, NodeDefinition } from '@/types';
import { getNodeValues } from '@/types';
import { t } from '@/i18n';
import { initialNodeValues } from '@/utils/newNodeValues';
import complexityData from '@/registry/complexity.json';
import './NodeEditor.css';

// Constant ReactFlow prop objects, hoisted so their identities are stable —
// NodeEditor re-renders every drag frame (it feeds ReactFlow the nodes), and
// a freshly-allocated options object per render defeats the memoization
// inside @xyflow/react's GraphView/Controls/MiniMap 60x/s during drags.
const DEFAULT_EDGE_OPTIONS = { type: 'typed', animated: true } as const;
const FIT_VIEW_OPTIONS = { maxZoom: 1.5 } as const;

/** Trailing window for persisting the viewport — the graph autosave's 300ms. */
const VIEWPORT_SAVE_DEBOUNCE_MS = 300;

/**
 * While a canvas gesture is in flight, take the 3D preview's IFRAME out of
 * hit-testing (`:root.fs-canvas-busy` — see ShaderPreview.css).
 *
 * A middle-button pan that wandered over the preview never ended: the iframe is
 * a SANDBOXED, opaque-origin document, so the moment the pointer crosses into it
 * the parent stops receiving mouse events entirely — including the `mouseup`
 * that d3-zoom listens for on the window. Release the button there and the pane
 * simply kept panning, because as far as the parent knew the button was still
 * down. Node drags and connection drags cross the same boundary and hang the
 * same way.
 *
 * Refcounted, because these gestures overlap: React Flow fires `onMoveStart`
 * for the pan under a selection drag, and a connect can start while a move is
 * still settling. A boolean would let whichever finished first re-arm the
 * iframe under the one still running.
 */
let canvasBusy = 0;
function setCanvasBusy(busy: boolean): void {
  canvasBusy = Math.max(0, canvasBusy + (busy ? 1 : -1));
  document.documentElement.classList.toggle('fs-canvas-busy', canvasBusy > 0);
}
const PRO_OPTIONS = { hideAttribution: true } as const;
const DESKTOP_PAN_ON_DRAG = [1, 2];

/**
 * How long an armed import-fit waits for the imported graph to render before
 * giving up. Generous enough for the code→graph pass a bare script needs, short
 * enough that an import which never produces a graph (parse errors, an
 * identical re-import) can't leave a fit primed to hijack a later unrelated
 * edit. See the import-fit effect.
 */
const IMPORT_FIT_TIMEOUT_MS = 3000;

/**
 * Nodes whose right-click opens a SPECIALIZED settings menu instead of the
 * generic one. Everything absent takes `'node'`. See `ContextMenuType` in the
 * store for why the dataviz family each need their own.
 */
const NODE_MENU_TYPES: Record<string, ContextMenuType> = {
  output: 'shader',
  stripes: 'stripes',
  dataviz: 'dataviz',
  colormap: 'colormap',
  dataRange: 'dataRange',
};
/**
 * Modifiers that make a click ADD to the selection instead of replacing it.
 * Shift is the one users reach for; Cmd/Ctrl (React Flow's platform default)
 * stays in so existing habits keep working. An ARRAY means "any of these", not
 * a combination — a '+' inside one entry would be the combination form.
 * Module-scope so the array identity is stable: useKeyPress memoizes on it, so
 * a fresh array per render would re-bind its key listeners every frame of a
 * drag (the same reason the objects above are hoisted).
 */
const MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control'];

const nodeTypes = {
  shader: ShaderNode,
  color: ColorNode,
  preview: PreviewNode,
  mathPreview: MathPreviewNode,
  clock: ClockNode,
  mic: MicNode,
  audio: AudioInputNode,
  output: OutputNode,
  group: GroupNode,
  note: NoteNode,
};

const edgeTypes = {
  typed: TypedEdge,
};

// The edge-snap radius (CONNECTION_RADIUS) lives in connectionReveal.ts —
// shared with the drag-reveal system so hidden sockets appear at exactly
// snapping distance.

/**
 * Landing a connection on a drag-revealed (still hidden) parameter socket
 * makes the exposure permanent — otherwise the temporary handle unmounts when
 * the drag ends and the fresh edge points at nothing. Runs under the caller's
 * pushHistory (connect AND reconnect gestures), so the edge + exposure revert
 * as one undo step.
 */
function exposeConnectedTarget(targetId: string, targetHandle: string | null | undefined): void {
  if (!targetHandle) return;
  const nodes = useAppStore.getState().nodes;
  const tgt = nodes.find((n) => n.id === targetId);
  if (!tgt || !usesExposedPorts(NODE_REGISTRY.get(tgt.data.registryType))) return;
  // The Output node's default-exposed channels are implicit (undefined
  // exposedPorts) — union from the EFFECTIVE list so exposing one new channel
  // can't hide the defaults.
  const current = effectiveExposedPorts(tgt);
  if (current.includes(targetHandle)) return;
  useAppStore.getState().setNodes(
    nodes.map((n) =>
      n.id === tgt.id
        ? { ...n, data: { ...n.data, exposedPorts: [...current, targetHandle] } }
        : n,
    ) as AppNode[],
  );
}
/** Snap radius for drop-on-edge insertion, in SCREEN px. 1.5× the original 8px
 *  so the node center no longer has to sit almost exactly on the curve. Divided
 *  by the viewport zoom at the call site so the acceptance band is a constant
 *  on-screen distance at every zoom level (a fixed FLOW-space radius shrinks to
 *  a sub-pixel target when zoomed out — part of the "sometimes doesn't detect"
 *  report). */
const DROP_ON_EDGE_RADIUS = 12;
/** Pixels of movement before a node drag is considered "real" (and worth pushing history). */
const DRAG_HISTORY_THRESHOLD = 2;
/** Drag-connect: flow-px gap between the two handle anchors when the dropped
 *  node snaps into place beside the node it just connected to. */
const CONNECT_SNAP_GAP = 48;
/** Placeholder node id when planning a drag-connect for a palette tile whose
 *  node doesn't exist yet — a fresh id matches no edge, so it can neither
 *  cycle nor occupy anything. Swapped for the real id at drop. */
const TILE_PHANTOM_ID = '__fs-tile-drag__';

type Measured = AppNode & { measured?: { width?: number; height?: number } };
function getNodeSize(n: AppNode) {
  return {
    w: (n as Measured).measured?.width ?? 120,
    h: (n as Measured).measured?.height ?? 40,
  };
}

/** Compute absolute (flow-space) position of a node, walking up the parent chain. */
function nodeAbsolutePos(node: AppNode, allNodes: AppNode[]): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  const seen = new Set<string>();
  let cur: AppNode | undefined = node;
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = allNodes.find((p) => p.id === cur!.parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    cur = parent;
  }
  return { x, y };
}

type GetInternalNode = (id: string) => InternalNode | undefined;

/**
 * The edge anchor React Flow actually draws from/to for one handle, in
 * flow-space: the handle box's CARDINAL-side midpoint (Right → right edge, Left
 * → left edge, …), exactly what @xyflow/system's getHandlePosition(center=false)
 * returns. Also reports the handle's node-local CENTER (`localCx/localCy`) so a
 * color-circle source can reconstruct its radial exit vector. Falls back to the
 * node's mid-left/mid-right edge when handle bounds haven't been measured yet.
 * Reading the ACTUAL handle (not the node's vertical center) is what lets a drop
 * land on an edge feeding a non-centered socket — e.g. the Output node's
 * displacement/normal rows, or the `b` input of an arithmetic node.
 */
function handleAnchor(
  node: InternalNode,
  handleId: string | null | undefined,
  kind: 'source' | 'target',
): { x: number; y: number; position: Position; localCx: number; localCy: number } {
  const pos = node.internals.positionAbsolute;
  const bounds = node.internals.handleBounds?.[kind];
  const h = (handleId ? bounds?.find((b) => b.id === handleId) : undefined) ?? bounds?.[0];
  if (h) {
    const localCx = h.x + h.width / 2;
    const localCy = h.y + h.height / 2;
    let x = pos.x + localCx;
    let y = pos.y + localCy;
    switch (h.position) {
      case Position.Left:   x = pos.x + h.x; break;
      case Position.Right:  x = pos.x + h.x + h.width; break;
      case Position.Top:    y = pos.y + h.y; break;
      case Position.Bottom: y = pos.y + h.y + h.height; break;
    }
    return { x, y, position: h.position, localCx, localCy };
  }
  const w = node.measured?.width ?? 120;
  const ht = node.measured?.height ?? 40;
  return kind === 'source'
    ? { x: pos.x + w, y: pos.y + ht / 2, position: Position.Right, localCx: w, localCy: ht / 2 }
    : { x: pos.x, y: pos.y + ht / 2, position: Position.Left, localCx: 0, localCy: ht / 2 };
}

/**
 * Drag-connect adapter: a node's MOUNTED handles of one kind as plain
 * absolute-flow-space points for the pure planner. Mounted is the right
 * filter — hidden `exposedPorts` parameters have no handle to aim a tooltip
 * at, and React Flow can only draw an edge to a handle that exists.
 * `ignoreSourceId` exempts edges from the drag gesture's own counterpart when
 * computing `occupied` — re-docking a node onto the peer it already feeds must
 * re-recognize that connection, not treat the socket as taken by a stranger
 * and silently double-feed a second input.
 */
function mountedHandles(
  node: InternalNode,
  kind: 'source' | 'target',
  edges: AppEdge[],
  ignoreSourceId?: string,
): ConnectHandle[] {
  const pos = node.internals.positionAbsolute;
  const bounds = node.internals.handleBounds?.[kind] ?? [];
  const handles: ConnectHandle[] = [];
  for (const b of bounds) {
    if (b.id == null) continue;
    handles.push({
      id: b.id,
      cx: pos.x + b.x + b.width / 2,
      cy: pos.y + b.y + b.height / 2,
      ...(kind === 'target'
        ? {
            occupied: edges.some(
              (e) =>
                e.target === node.id && e.targetHandle === b.id && e.source !== ignoreSourceId,
            ),
          }
        : {}),
    });
  }
  return handles;
}

/**
 * Position delta that snaps a just-connected node beside its peer: connecting
 * handles vertically aligned, a wire's length (CONNECT_SNAP_GAP) apart on the
 * connection's side. Shared by the node-drag drop and the tile-drop snap so
 * both gestures land identically.
 */
function connectSnapOffset(
  plan: DragConnectPlan,
  di: InternalNode,
  hi: InternalNode,
): { dx: number; dy: number } {
  const feedHover = plan.mode === 'feed-hover';
  const staticAnchor = feedHover
    ? handleAnchor(hi, plan.targetHandle, 'target')
    : handleAnchor(hi, plan.sourceHandle, 'source');
  const dragAnchor = feedHover
    ? handleAnchor(di, plan.sourceHandle, 'source')
    : handleAnchor(di, plan.targetHandle, 'target');
  return {
    dx: staticAnchor.x + (feedHover ? -CONNECT_SNAP_GAP : CONNECT_SNAP_GAP) - dragAnchor.x,
    dy: staticAnchor.y - dragAnchor.y,
  };
}

/** Node types whose card renders CSS-scaled by cost (transform-origin top-left). */
const COST_SCALED_TYPES = new Set(['shader', 'clock', 'preview', 'mathPreview']);

/** Whether dropping this tile could splice into an edge — only node tiles
 *  with both inputs and outputs qualify (placeTilePayload's own guard).
 *  Anything else must not get the drop-on-edge highlight: it would promise
 *  an insertion the drop never performs. */
function tileCanSplice(payload: TilePayload): boolean {
  if (payload.kind !== 'node') return false;
  const def = NODE_REGISTRY.get(payload.nodeType);
  return !!def && def.inputs.length > 0 && def.outputs.length > 0;
}

/**
 * Visible size of a node's card. Cost-scaled node types render up to 1.35×
 * LARGER than the measured layout box (transform-origin top-left, transform
 * doesn't affect layout), so anything aiming at what the user SEES — target
 * boxes and the dragged node's own center alike — must scale the measured box.
 */
function nodeVisualSize(node: AppNode): { w: number; h: number } {
  const s = getNodeSize(node);
  const scale = COST_SCALED_TYPES.has(node.type ?? '')
    ? getCostScale((node.data as { cost?: number }).cost ?? 0)
    : 1;
  return { w: s.w * scale, h: s.h * scale };
}

/**
 * Visual absolute bounding box of one node — boxes follow the VISIBLE card,
 * otherwise exactly the expensive nodes users aim at grow a dead band along
 * their right/bottom edges.
 */
function nodeVisualBox(node: AppNode, allNodes: AppNode[]): NodeBox {
  const p = nodeAbsolutePos(node, allNodes);
  const s = nodeVisualSize(node);
  return { id: node.id, x: p.x, y: p.y, w: s.w, h: s.h };
}

/** Absolute bounding boxes of every legal drag-connect target. */
function connectTargetBoxes(draggedId: string, allNodes: AppNode[]): NodeBox[] {
  const boxes: NodeBox[] = [];
  for (const other of allNodes) {
    if (other.id === draggedId) continue;
    if (other.type === 'group' || other.type === 'note') continue;
    if ((other.className ?? '').includes('fs-collapsed-member')) continue;
    boxes.push(nodeVisualBox(other, allNodes));
  }
  return boxes;
}

/**
 * Boxes for the post-connect make-room cascade: every visible movable node in
 * absolute coords, the just-connected pair marked fixed, and the placed
 * node's box taken at its SNAPPED position (the store still holds the raw
 * drop position when this runs).
 */
function makeRoomBoxes(
  allNodes: AppNode[],
  placedId: string,
  placedAbs: { x: number; y: number },
  peerId: string,
): CascadeBox[] {
  const out: CascadeBox[] = [];
  for (const n of allNodes) {
    if (n.type === 'group' || n.type === 'note') continue;
    if ((n.className ?? '').includes('fs-collapsed-member')) continue;
    const box = nodeVisualBox(n, allNodes);
    if (n.id === placedId) {
      box.x = placedAbs.x;
      box.y = placedAbs.y;
    }
    out.push({ ...box, fixed: n.id === placedId || n.id === peerId });
  }
  return out;
}

/**
 * Find the closest edge to (cx, cy) in flow-space within `radius` (flow px).
 * `excludeNodeId` skips edges connected to the node being dragged. Distance is
 * measured against the SAME cubic bezier TypedEdge renders — exact handle
 * anchors, React Flow's control-point math, and the color-circle radial exit —
 * so what highlights is exactly what snaps. Invisible edges (collapsed-group
 * internals / hidden boundary edges) are skipped so a node can't splice onto an
 * edge the user can't see.
 */
/**
 * What is not DRAWN must not be hit-testable. React Flow renders an edge only
 * when its NAMED handle resolves in the node's measured bounds — an edge into
 * a DORMANT Output section's unmounted `m<n>:<channel>` handle renders as
 * NOTHING — but `handleAnchor`'s first-handle fallback would still anchor it
 * at the node's first mounted handle, so `findNearestEdge` measured a phantom
 * curve across empty-looking canvas that a drop could then SPLICE with no
 * highlight ever painted ("what wasn't previewed is never committed"). A null
 * handle id keeps the first-handle fallback (React Flow's own rule), and
 * unmeasured bounds stay permissive (a one-frame mid-mount state).
 */
function edgeEndpointDrawable(
  node: InternalNode,
  handleId: string | null | undefined,
  kind: 'source' | 'target',
): boolean {
  if (!handleId) return true;
  const bounds = node.internals.handleBounds?.[kind];
  if (!bounds) return true;
  return bounds.some((b) => b.id === handleId);
}

function findNearestEdge(
  cx: number, cy: number,
  allEdges: AppEdge[],
  getInternalNode: GetInternalNode,
  radius: number,
  excludeNodeId?: string,
): string | null {
  let bestId: string | null = null;
  let bestDist = radius;

  for (const edge of allEdges) {
    if (edge.hidden) continue;
    if ((edge as { className?: string }).className?.includes('fs-collapsed-edge')) continue;
    if (excludeNodeId && (edge.source === excludeNodeId || edge.target === excludeNodeId)) continue;
    const srcNode = getInternalNode(edge.source);
    const tgtNode = getInternalNode(edge.target);
    if (!srcNode || !tgtNode) continue;
    if (!edgeEndpointDrawable(srcNode, edge.sourceHandle, 'source')) continue;
    if (!edgeEndpointDrawable(tgtNode, edge.targetHandle, 'target')) continue;

    const s = handleAnchor(srcNode, edge.sourceHandle, 'source');
    const t = handleAnchor(tgtNode, edge.targetHandle, 'target');

    // Routed edges (user waypoints) draw a spline, not a single bezier — measure
    // against the SAME spline so what highlights is exactly what snaps.
    const wps = (edge.data?.waypoints ?? []) as { x: number; y: number }[];
    let d: number;
    if (wps.length) {
      d = distancePointToSpline(
        [[s.x, s.y], ...wps.map((w) => [w.x, w.y] as [number, number]), [t.x, t.y]],
        cx, cy,
      );
    } else {
      // Color nodes are circles whose output rides the perimeter and exits along
      // the radial (TypedEdge's getRadialBezierPath) — everything else uses the
      // cardinal exit. Match whichever this edge is actually drawn with.
      let c1x: number, c1y: number;
      const rdx = s.localCx - (srcNode.measured?.width ?? 28) / 2;
      const rdy = s.localCy - (srcNode.measured?.height ?? 28) / 2;
      const rlen = Math.hypot(rdx, rdy);
      if (srcNode.type === 'color' && rlen > 1e-3) {
        [c1x, c1y] = radialControlPoint(s.x, s.y, rdx / rlen, rdy / rlen, t.x, t.y);
      } else {
        [c1x, c1y] = cardinalControlPoint(s.position, s.x, s.y, t.x, t.y);
      }
      const [c2x, c2y] = cardinalControlPoint(t.position, t.x, t.y, s.x, s.y);
      d = distancePointToCubicBezier(s.x, s.y, c1x, c1y, c2x, c2y, t.x, t.y, cx, cy);
    }
    if (d < bestDist) {
      bestDist = d;
      bestId = edge.id;
    }
  }
  return bestId;
}

function groupSize(g: AppNode) {
  const m = (g as Measured).measured;
  const sz = g as AppNode & { width?: number; height?: number };
  const dataSz = g.data as { width?: number; height?: number };
  return {
    w: m?.width ?? sz.width ?? dataSz.width ?? 200,
    h: m?.height ?? sz.height ?? dataSz.height ?? 120,
  };
}

/**
 * Given a node's absolute drop position, find the first non-collapsed group
 * whose bounds contain its center, skipping the node itself. Returns the
 * target group (if any) along with its absolute position for coordinate
 * translation.
 */
function findContainingGroup(
  draggedId: string,
  absX: number, absY: number,
  nw: number, nh: number,
  allNodes: AppNode[],
): { id: string; absX: number; absY: number } | null {
  const cx = absX + nw / 2;
  const cy = absY + nh / 2;
  for (const other of allNodes) {
    if (other.type !== 'group' || other.id === draggedId) continue;
    if ((other.data as { collapsed?: boolean }).collapsed) continue;
    const oAbs = nodeAbsolutePos(other, allNodes);
    const { w: ow, h: oh } = groupSize(other);
    if (cx >= oAbs.x && cx <= oAbs.x + ow && cy >= oAbs.y && cy <= oAbs.y + oh) {
      return { id: other.id, absX: oAbs.x, absY: oAbs.y };
    }
  }
  return null;
}

/**
 * Reparent one dragged node: compute its target group (or root) based on the
 * absolute position of the drop, then rewrite its parentId + local position.
 * Group containers themselves are left alone. Returns the updated node and
 * whether the parent actually changed (so the caller can decide whether to
 * reorder for React Flow's parent-before-children invariant).
 */
function reparentedNode(
  draggedNode: AppNode,
  allNodes: AppNode[],
  finalLocalX: number,
  finalLocalY: number,
): { node: AppNode; targetGroupId: string | undefined; parentChanged: boolean } {
  const { w: nw, h: nh } = getNodeSize(draggedNode);
  const startAbs = nodeAbsolutePos(draggedNode, allNodes);
  const absX = startAbs.x + (finalLocalX - draggedNode.position.x);
  const absY = startAbs.y + (finalLocalY - draggedNode.position.y);
  const target = findContainingGroup(draggedNode.id, absX, absY, nw, nh, allNodes);

  const newLocalX = Math.round(absX - (target?.absX ?? 0));
  const newLocalY = Math.round(absY - (target?.absY ?? 0));
  const parentChanged = target?.id !== draggedNode.parentId;

  const { extent: _extent, parentId: _pid, ...rest } =
    draggedNode as AppNode & { extent?: unknown; parentId?: string };
  void _extent; void _pid;
  const node = {
    ...rest,
    ...(target ? { parentId: target.id } : {}),
    position: { x: newLocalX, y: newLocalY },
  } as AppNode;
  return { node, targetGroupId: target?.id, parentChanged };
}

/**
 * Try to insert `nodeId` (with registry def `def`) onto the nearest edge at
 * flow-space center (cx, cy) within `radius` (flow px). Returns true if an
 * insertion was made.
 */
function tryInsertOnEdge(
  nodeId: string,
  def: NodeDefinition,
  cx: number, cy: number,
  getInternalNode: GetInternalNode,
  radius: number,
): boolean {
  const store = useAppStore.getState();
  const edgeId = findNearestEdge(cx, cy, store.edges, getInternalNode, radius, nodeId);
  if (!edgeId) return false;
  const edge = store.edges.find((e) => e.id === edgeId);
  if (!edge) return false;

  // Land on the node's first FREE input, not always its first (edgeSplice.ts):
  // dragging an already-wired node onto a new edge keeps what it has. Variadic
  // folds grow a fresh socket for this; a node with every socket taken falls
  // back to the first port, whose stale edge the filter below then replaces.
  const node = store.nodes.find((n) => n.id === nodeId);
  const connected = store.edges.flatMap((e) =>
    e.target === nodeId && e.targetHandle ? [e.targetHandle] : [],
  );
  const inputPortId = pickSpliceInputPort(
    def,
    connected,
    node ? Object.keys(getNodeValues(node)) : [],
  );
  if (!inputPortId) return false;
  const outputPort = def.outputs[0];

  const newEdge1 = makeTypedEdge(edge.source, edge.sourceHandle, nodeId, inputPortId);
  const newEdge2 = makeTypedEdge(nodeId, outputPort.id, edge.target, edge.targetHandle);

  store.setEdges(
    store.edges
      .filter((e) => e.id !== edge.id)
      // Inputs are single-connection. Only reachable once EVERY socket is taken
      // (pickSpliceInputPort's fallback) — drop that port's stale edge so it
      // can't end up double-fed.
      .filter((e) => !(e.target === nodeId && e.targetHandle === inputPortId))
      .concat(newEdge1, newEdge2) as AppEdge[],
  );
  // The chosen port may be a hidden param socket (Image/Mic): make the exposure
  // permanent, or the fresh edge points at a handle that never mounts. Same
  // rule — and the same helper — as a wire dropped on a drag-revealed socket.
  exposeConnectedTarget(nodeId, inputPortId);
  return true;
}

export function NodeEditor() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const onNodesChange = useAppStore((s) => s.onNodesChange);
  const onEdgesChange = useAppStore((s) => s.onEdgesChange);
  const setEdges = useAppStore((s) => s.setEdges);
  const addNode = useAppStore((s) => s.addNode);
  const removeEdge = useAppStore((s) => s.removeEdge);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const contextMenu = useAppStore((s) => s.contextMenu);
  // While a node's settings menu is open, that node stays ACTIVE — same lift
  // (shadow + rise) it gets from hover or selection, held for the life of the
  // menu. Without it the node drops back to resting the instant the pointer
  // travels the few px to the menu, so the panel you are editing sits beside a
  // graph that no longer says which node it belongs to.
  //
  // Imperative, following `clearConnectPreview` above: the alternative is a
  // className on the node OBJECT, and node data changes push through history
  // and the autosave — opening a menu is not an edit. `contextMenu` already
  // lives in the store, so the effect key is simply the id it carries.
  //
  // The cleanup covers EVERY way the menu ends, without enumerating them:
  // closing (nodeId -> undefined), choosing an action, Escape, clicking away,
  // and a second right-click MOVING the menu to another node — that last one
  // only re-renders the same menu, so the id change is the only signal, and
  // running cleanup first is what stops the previous node keeping the class.
  // `CSS.escape` is load-bearing: node ids arrive from `.fastshader` files, so
  // an unescaped id could throw out of querySelector during an effect.
  const menuNodeId = contextMenu.open ? contextMenu.nodeId : undefined;
  useEffect(() => {
    if (!menuNodeId) return;
    let el: Element | null = null;
    try {
      el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(menuNodeId)}"]`);
    } catch {
      return;
    }
    if (!el) return;
    el.classList.add('fs-menu-active');
    // Safe even if the node was deleted while its menu was open: the element is
    // detached by then and removing a class from it is a no-op.
    return () => el?.classList.remove('fs-menu-active');
  }, [menuNodeId]);
  const nodeEditorBgColor = useAppStore((s) => s.nodeEditorBgColor);
  const setNodeEditorBgColor = useAppStore((s) => s.setNodeEditorBgColor);
  // Canvas-background picker. `ColorPickerPopover` rather than the trigger-
  // bearing `PaletteColorPicker`: this control is a `.fs-canvas-bar__btn` in a
  // row of bar buttons (−, +, ⤢) with a small swatch inside it, and a
  // full-bleed 26x12 colour chip in its place would break the bar's rhythm —
  // so the bar button stays the trigger AND the anchor.
  const bgBtnRef = useRef<HTMLButtonElement>(null);
  const [bgPickerOpen, setBgPickerOpen] = useState(false);
  const closeBgPicker = useCallback(() => setBgPickerOpen(false), []);
  const drawToolActive = useAppStore((s) => s.drawToolActive);
  const drawEraser = useAppStore((s) => s.drawEraser);
  const canUndo = useAppStore((s) => s.past.length > 0);
  const canRedo = useAppStore((s) => s.future.length > 0);
  const language = useAppStore((s) => s.language);
  // NEW button → save-first confirmation. Local state like the toolbar's
  // feedback dialog: nothing outside this component opens it.
  const [newShaderOpen, setNewShaderOpen] = useState(false);
  // In-flight image imports, one ghost per file at its drop point (see
  // placeImageFile). Screen coords: these are chrome, not graph content, so
  // they deliberately do NOT pan/zoom with the canvas during the import.
  const [importGhosts, setImportGhosts] = useState<
    { id: string; x: number; y: number; name: string }[]
  >([]);
  // Drop-time "convert or keep?" prompt. The pending promise resolver lives in
  // a ref so the async drop loop can await a decision the user makes in React.
  const [convertAsk, setConvertAsk] = useState<{ count: number; fileName: string } | null>(null);
  const convertResolver = useRef<((choice: ImageImportChoice) => void) | null>(null);
  // One-liner shown when a requested optimization didn't happen. Structured
  // rather than a pre-rendered string so it re-renders in the active language.
  const [importNote, setImportNote] = useState<
    { id: string; reason: 'no-webp' | 'preference'; storedAs: string } | null
  >(null);
  const [convertInfoOpen, setConvertInfoOpen] = useState(false);
  // Live in-progress stroke path, written imperatively by the draw-capture
  // handler (below) and rendered inside DrawingLayer's live opacity group.
  const livePathRef = useRef<SVGPathElement | null>(null);
  const { screenToFlowPosition, getViewport, setViewport, getInternalNode, zoomIn, zoomOut, fitView } =
    useReactFlow();
  /**
   * Where the canvas was left last time, or null to fit the graph instead.
   *
   * A lazy `useState` initializer, so the read happens exactly ONCE — during the
   * first render, before any effect and before React Flow's own initialisation
   * can move (and therefore record) a viewport. `useRef(readStoredViewport())`
   * would look equivalent and hit localStorage on every one of this component's
   * many renders.
   */
  const [bootViewport] = useState(readStoredViewport);
  const onMoveStartBusy = useCallback(() => setCanvasBusy(true), []);
  // A gesture interrupted by unmount must not leave the preview inert.
  useEffect(() => () => document.documentElement.classList.remove('fs-canvas-busy'), []);
  /**
   * The cost pill's total doubles as "take me to the Output" — the number is
   * this shader's price and the Output node is where it is spent, so the same
   * "take me to it" glide the Output's palette tile and Add-node row already
   * perform (outputFocus.ts, same framing so all three land identically).
   *
   * The node is looked up at CLICK time rather than captured, so the callback
   * stays stable across every drag frame and cannot hold a deleted id.
   */
  const focusOutput = useCallback(() => {
    const nodesNow = useAppStore.getState().nodes;
    const id = existingOutputId(nodesNow);
    if (id) focusOutputNode(fitView, nodesNow, id);
  }, [fitView]);
  /** …but only offered while there IS one. The user can delete the Output, and
   *  a visible control that silently does nothing reads as the app being
   *  broken — the lesson the Output tile's own redirect is built around. */
  const hasOutput = useMemo(() => existingOutputId(nodes) != null, [nodes]);
  const viewportSaveRef = useRef(0);
  /**
   * Record the viewport, trailing-debounced.
   *
   * `onMoveEnd` looks like it fires once per gesture, and for React Flow's own
   * pan/zoom it does — but the custom trackpad and two-finger paths below drive
   * the canvas by calling `setViewport` imperatively per pointermove, and each
   * of those is a complete d3-zoom start/zoom/end cycle. Without the debounce
   * that is a localStorage write per frame for the whole gesture.
   *
   * Programmatic moves report through here too, which is deliberate: `fitView`
   * after an import, NEW, or a Work-folder load re-aims the memory at the graph
   * that is now on screen, so nothing has to remember to clear it.
   */
  const rememberViewport = useCallback((_: unknown, vp: StoredViewport) => {
    setCanvasBusy(false);
    window.clearTimeout(viewportSaveRef.current);
    viewportSaveRef.current = window.setTimeout(
      () => writeStoredViewport(vp),
      VIEWPORT_SAVE_DEBOUNCE_MS,
    );
  }, []);
  // A pending write is dropped on unmount rather than fired: the only way this
  // component unmounts is the page going away, and the last committed viewport
  // is already good enough to come back to.
  useEffect(() => () => window.clearTimeout(viewportSaveRef.current), []);

  // Disable the bar's zoom buttons at the zoom limits, mirroring the selector
  // React Flow's own <Controls> used before this bar replaced it.
  const { minZoomReached, maxZoomReached } = useStore(
    useShallow((s: ReactFlowState) => ({
      minZoomReached: s.transform[2] <= s.minZoom,
      maxZoomReached: s.transform[2] >= s.maxZoom,
    }))
  );

  // True while a two-finger touch navigation gesture (pan / pinch-zoom) is in
  // progress — lets the draw handler pause its stroke so a second finger
  // navigates instead of corrupting the ink. Only ever set on coarse pointers.
  const twoFingerNavRef = useRef(false);
  // Coarse pointer = touch/pen (e.g. iPad). Drives the touch interaction model:
  // ONE finger manipulates (drag nodes/edges; tap selects — marquee stays a
  // mouse-only affordance, see selectionOnDrag), TWO fingers navigate
  // (pan + pinch-zoom), long-press opens the menu. A mouse keeps the desktop
  // model (panOnDrag={[1,2]}, double-tap-drag pan) completely intact.
  //
  // NB matchMedia('(pointer: coarse)') is unreliable as the SOLE signal on
  // iPad: with a trackpad/Magic Keyboard paired the primary pointer reports
  // fine — though on a bare iPad the coarse query DOES match, which is why
  // the @media (pointer: coarse) CSS sizing layer is live there. navigator.
  // maxTouchPoints is the signal that holds across all configurations (iPad
  // reports 5 even in desktop mode) — the same trick tslToPreviewHTML already
  // uses. `any-pointer` catches touch even when the primary pointer is a
  // paired trackpad. The CSS layer deliberately keys on the STATIC primary-
  // pointer query while this JS model uses the broader dynamic signal — the
  // divergence is intentional (sizing follows the device class, interaction
  // follows the pointer actually in use).
  const [isCoarsePointer, setIsCoarsePointer] = useState(() => {
    if (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0) return true;
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(any-pointer: coarse)').matches || window.matchMedia('(pointer: coarse)').matches;
  });
  useEffect(() => {
    // Adapt to the device actually in use: a mouse/trackpad → desktop model, a
    // finger/pen → touch model. Only flips on a real change (React bails on an
    // equal value), and a single gesture is always one pointer type, so this
    // never re-renders mid-drag. Keeps a hybrid device (iPad + Magic Keyboard,
    // or a touchscreen laptop) correct for whichever input the user reaches for.
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') setIsCoarsePointer(false);
      else if (e.pointerType === 'touch' || e.pointerType === 'pen') setIsCoarsePointer(true);
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
  }, []);

  // Copy/paste clipboard
  const clipboardRef = useRef<AppNode[]>([]);

  useEffect(() => {
    /** Clone nodes + their internal edges, deselect originals, select clones. */
    function pasteNodes(sourceNodes: AppNode[]) {
      const store = useAppStore.getState();
      const idMap = new Map<string, string>();

      // Outputs are dropped from a paste/duplicate. The Output is a SINGLETON
      // — per-mesh shading lives INSIDE it as stacked materials (see
      // outputFocus.ts and the CLAUDE.md per-mesh convention) — so a clone
      // could never emit: `findDefaultOutput` takes the first, and the copy is
      // dead weight the next code-panel Apply deletes without a word.
      // Dropped from the clone set rather than refusing the whole paste: a
      // selection is usually a working cluster that happens to include the
      // Output, and losing the rest of it would be the bigger surprise.
      sourceNodes = sourceNodes.filter((n) => n.data.registryType !== 'output');
      if (sourceNodes.length === 0) return [];

      const clones = sourceNodes.map((node) => {
        const newId = generateId();
        idMap.set(node.id, newId);
        const cloned = structuredClone(node);
        cloned.id = newId;
        cloned.position = { x: node.position.x + 30, y: node.position.y + 30 };
        cloned.selected = true;
        return cloned;
      });

      const sourceIds = new Set(sourceNodes.map((n) => n.id));
      const edgeClones: AppEdge[] = store.edges
        .filter((e) => sourceIds.has(e.source) && sourceIds.has(e.target))
        .map((e) => {
          const cloned = structuredClone(e);
          cloned.source = idMap.get(e.source) ?? e.source;
          cloned.target = idMap.get(e.target) ?? e.target;
          cloned.id = generateEdgeId(
            cloned.source,
            cloned.sourceHandle ?? 'out',
            cloned.target,
            cloned.targetHandle ?? 'in',
          );
          return cloned;
        });

      store.pushHistory();
      const deselected = store.nodes.map((n) => ({ ...n, selected: false }));
      store.setNodes([...deselected, ...clones] as AppNode[]);
      store.setEdges([...store.edges, ...edgeClones] as AppEdge[]);

      return clones;
    }

    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Esc leaves draw mode (before any accelerator).
      if (e.key === 'Escape' && useAppStore.getState().drawToolActive) {
        useAppStore.getState().setDrawToolActive(false);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      // Normalized so Caps Lock (which reports 'C' rather than 'c') doesn't
      // silently break every accelerator below.
      const key = e.key.toLowerCase();

      // Ctrl+C — copy selected nodes
      if (mod && key === 'c') {
        const selected = useAppStore.getState().nodes.filter((n) => n.selected);
        if (selected.length > 0) {
          clipboardRef.current = structuredClone(selected);
        }
      }

      // Ctrl+V — paste copied nodes
      if (mod && key === 'v') {
        if (clipboardRef.current.length === 0) return;
        e.preventDefault();
        const clones = pasteNodes(clipboardRef.current);
        // Shift clipboard for cascading pastes
        clipboardRef.current = clones.map((n) => structuredClone(n));
      }

      // Ctrl+G — group selected nodes (Ctrl+Shift+G ungroups the selected group)
      if (mod && key === 'g') {
        e.preventDefault();
        const store = useAppStore.getState();
        const selected = store.nodes.filter((n) => n.selected);
        if (e.shiftKey) {
          // Ungroup any selected group nodes
          for (const n of selected) {
            if (n.type === 'group') store.ungroup(n.id);
          }
        } else {
          // Group selected non-group nodes
          const groupable = selected.filter((n) => n.type !== 'group');
          if (groupable.length >= 2) {
            store.groupSelection(groupable.map((n) => n.id));
          }
        }
        return;
      }

      // Ctrl+D — duplicate selected
      if (mod && key === 'd') {
        const selected = useAppStore.getState().nodes.filter((n) => n.selected);
        if (selected.length === 0) return;
        e.preventDefault();
        clipboardRef.current = structuredClone(selected);
        pasteNodes(selected);
      }

      // Delete / Backspace — remove selected nodes and/or edges
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const store = useAppStore.getState();
        const selectedNodes = store.nodes.filter((n) => n.selected);
        const selectedEdges = store.edges.filter((edge) => edge.selected);
        if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
        e.preventDefault();

        const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));
        const selectedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
        // Eval telemetry: this deletion path bypasses store.removeNode/
        // removeEdge (it rewrites via setNodes/setEdges), so it logs its own.
        for (const n of selectedNodes) {
          evalLog('node-remove', {
            nodeType: (n.data as { registryType?: string })?.registryType ?? n.type ?? 'unknown',
            how: 'delete-key',
          });
        }
        for (let i = 0; i < selectedEdges.length; i++) evalLog('edge-disconnect', { how: 'delete-key' });
        store.pushHistory();

        // Deleting a group should dissolve it, not orphan its children with a
        // dangling parentId. Lift them out first, then proceed with the normal
        // deletion path so the rest of the selection is removed too.
        const deletedGroups = selectedNodes.filter((n) => n.type === 'group');
        if (deletedGroups.length > 0) {
          for (const g of deletedGroups) store.ungroup(g.id);
          // ungroup() pushed history; treat the rest as a single follow-up.
        }

        // Re-read nodes/edges since ungroup may have mutated them.
        const { nodes: currentNodes, edges: currentEdges } = useAppStore.getState();
        if (selectedNodeIds.size > 0) {
          store.setNodes(currentNodes.filter((n) => !selectedNodeIds.has(n.id)) as AppNode[]);
        }
        // Splice-delete: bridge outgoing edges of deleted nodes onto their
        // first connected input's upstream, then drop the user's explicitly
        // selected edges. Chain deletes (X→A→B→C with A and B selected)
        // resolve across the whole deleted run to produce X→C.
        const afterBridge = bridgeEdgesAcrossDeletedNodes(
          currentEdges as AppEdge[],
          selectedNodeIds,
        );
        store.setEdges(afterBridge.filter((e) => !selectedEdgeIds.has(e.id)));
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Track the dragged node's start position so we can detect "no real movement" clicks.
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // Track the edge currently highlighted for drop-on-edge insertion.
  const highlightedEdgeRef = useRef<string | null>(null);

  /** Remove the CSS highlight class from the currently highlighted edge (if any). */
  const clearEdgeHighlight = useCallback(() => {
    if (highlightedEdgeRef.current) {
      document
        .querySelector(`.react-flow__edge[data-id="${CSS.escape(highlightedEdgeRef.current)}"]`)
        ?.classList.remove('fs-edge-drop-target');
      highlightedEdgeRef.current = null;
    }
  }, []);

  // Capture the start position; defer the history push to onNodeDragStop
  // (so click-only "drags" don't pollute the undo buffer with no-op snapshots).
  const onNodeDragStart = useCallback((_event: React.MouseEvent, node: AppNode) => {
    // The drag can wander over the 3D preview; see setCanvasBusy.
    setCanvasBusy(true);
    dragStartPosRef.current = { x: node.position.x, y: node.position.y };
    // A drag-connect preview forces tooltips of its own; a leftover tap-shown
    // label next to them would muddy which socket the drop will commit to.
    clearSocketTapTooltip();
  }, []);

  // --- Drag-connect preview (drag a node ONTO a node to wire them) ---
  // Imperative DOM highlight + tooltip, same pattern as the drop-on-edge edge
  // highlight: classes and a floating label are cheaper than re-rendering the
  // graph 60×/s mid-drag. The ref holds the plan the drop will commit.
  const connectPreviewRef = useRef<DragConnectPlan | null>(null);

  const clearConnectPreview = useCallback(() => {
    const plan = connectPreviewRef.current;
    if (!plan) return;
    const hoverId = plan.mode === 'feed-hover' ? plan.target : plan.source;
    document
      .querySelector(`.react-flow__node[data-id="${CSS.escape(hoverId)}"]`)
      ?.classList.remove('fs-connect-target');
    document
      .querySelector(
        `.react-flow__node[data-id="${CSS.escape(plan.target)}"] .react-flow__handle.target[data-handleid="${CSS.escape(plan.targetHandle)}"]`,
      )
      ?.classList.remove('fs-connect-socket');
    document
      .querySelector(`.react-flow__node[data-id="${CSS.escape(plan.target)}"]`)
      ?.classList.remove('fs-connect-front');
    connectPreviewRef.current = null;
  }, []);

  /** Show (or move) the drag-connect preview for `plan`: ring the hovered node
   *  and the chosen input socket. The socket's OWN name tooltip is activated by
   *  the `.fs-connect-socket` class (see TypedHandle.css) — no custom tooltip is
   *  drawn. */
  const showConnectPreview = useCallback(
    (plan: DragConnectPlan) => {
      const prev = connectPreviewRef.current;
      const same =
        prev &&
        prev.source === plan.source &&
        prev.sourceHandle === plan.sourceHandle &&
        prev.target === plan.target &&
        prev.targetHandle === plan.targetHandle;
      if (!same) clearConnectPreview();
      // The classes are (re)applied even for an unchanged plan: classList.add
      // is idempotent, and a React className rewrite on the handle mid-preview
      // (any state-driven re-render — e.g. TypedHandle's tap-tooltip flipping
      // under simultaneous pen+touch input) would otherwise wipe the ring for
      // the rest of the hover while the drop still commits the plan.
      const hoverId = plan.mode === 'feed-hover' ? plan.target : plan.source;
      document
        .querySelector(`.react-flow__node[data-id="${CSS.escape(hoverId)}"]`)
        ?.classList.add('fs-connect-target');
      document
        .querySelector(
          `.react-flow__node[data-id="${CSS.escape(plan.target)}"] .react-flow__handle.target[data-handleid="${CSS.escape(plan.targetHandle)}"]`,
        )
        ?.classList.add('fs-connect-socket');
      // Lift the node that OWNS the target socket above the other, so the ringed
      // socket + its tooltip are never hidden: feed-hover raises the hovered
      // node (dragged node slides underneath); feed-dragged raises the dragged
      // node (its own input is the target).
      document
        .querySelector(`.react-flow__node[data-id="${CSS.escape(plan.target)}"]`)
        ?.classList.add('fs-connect-front');
      connectPreviewRef.current = plan;
    },
    [clearConnectPreview],
  );

  /**
   * Drag-connect preview for a palette tile in flight (HTML5 dragover or the
   * touch tileDrag move stream). The node doesn't exist yet, so it plans as a
   * PHANTOM: def-derived handle ids all sitting at the cursor — vertical tile
   * movement therefore picks the hover node's socket by cursor alignment,
   * while the tile side always offers its first port (which for a
   * not-yet-created node IS its first free one, matching what a drop-on-edge
   * splice of the same tile would pick — see edgeSplice.ts). Returns whether
   * the cursor is over a node body at all, so the caller can suppress the
   * drop-on-edge preview (never-both rule, same as node drags).
   */
  const previewTileConnect = useCallback(
    (payload: TilePayload, clientX: number, clientY: number): boolean => {
      if (payload.kind !== 'node') {
        clearConnectPreview();
        return false;
      }
      const def = NODE_REGISTRY.get(payload.nodeType);
      if (!def) {
        clearConnectPreview();
        return false;
      }
      const pos = screenToFlowPosition({ x: clientX, y: clientY });
      const store = useAppStore.getState();
      // An Output tile's drop is REDIRECTED to the existing node (the singleton
      // rule — see placeTilePayload), so previewing a connection here would
      // promise a wire the drop will never commit.
      if (def.type === 'output' && existingOutputId(store.nodes)) {
        clearConnectPreview();
        return false;
      }
      const boxes = connectTargetBoxes(TILE_PHANTOM_ID, store.nodes);
      const hoverId = pickDropTargetNode(pos.x, pos.y, boxes);
      const hoverBox = hoverId ? boxes.find((b) => b.id === hoverId) : undefined;
      if (!hoverBox) {
        clearConnectPreview();
        return false;
      }
      const hi = getInternalNode(hoverBox.id);
      const hoverNode = store.nodes.find((n) => n.id === hoverBox.id);
      if (!hi || !hoverNode) {
        clearConnectPreview();
        return true;
      }
      const logicalEdges = unwrapCollapsedGroupEdges(store.nodes, store.edges);
      const phantomPorts = (ports: { id: string }[]): ConnectHandle[] =>
        ports.map((p) => ({ id: p.id, cx: pos.x, cy: pos.y }));
      const endpoints: DragConnectEndpoints = {
        draggedId: TILE_PHANTOM_ID,
        hoverId: hoverBox.id,
        draggedCenterX: pos.x,
        hoverCenterX: hoverBox.x + hoverBox.w / 2,
        draggedInputs: phantomPorts(def.inputs),
        draggedOutputs: phantomPorts(def.outputs),
        hoverInputs: mountedHandles(hi, 'target', logicalEdges),
        hoverOutputs: mountedHandles(hi, 'source', logicalEdges),
      };
      const plan = planDragConnect(endpoints, logicalEdges);
      if (!plan) {
        clearConnectPreview();
        return true;
      }
      showConnectPreview(plan);
      return true;
    },
    [
      screenToFlowPosition,
      getInternalNode,
      clearConnectPreview,
      showConnectPreview,
    ],
  );

  /**
   * Snap a just-created tile node beside the peer it connected to, then make
   * room (same overlap cascade as node-drag connects). Deferred two frames —
   * React Flow hasn't measured the new node's handles at drop time. No
   * history push: it rides addNode's entry, so undo reverses
   * add + connect + snap + cascade together.
   */
  const scheduleTileConnectSnap = useCallback(
    (nodeId: string, plan: DragConnectPlan) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const store = useAppStore.getState();
          const hoverId = plan.mode === 'feed-hover' ? plan.target : plan.source;
          const di = getInternalNode(nodeId);
          const hi = getInternalNode(hoverId);
          const node = store.nodes.find((n) => n.id === nodeId);
          if (!di || !hi || !node) return;
          const { dx, dy } = connectSnapOffset(plan, di, hi);
          const abs = nodeAbsolutePos(node, store.nodes);
          const shifts = resolveOverlapCascade(
            makeRoomBoxes(store.nodes, nodeId, { x: abs.x + dx, y: abs.y + dy }, hoverId),
          );
          if (!dx && !dy && shifts.length === 0) return;
          // Same position→membership reconciliation as the node-drag path:
          // the snapped node and every cascade-shifted neighbor re-derive
          // their group parent from where they actually landed.
          const shiftById = new Map(shifts.map((s) => [s.id, s]));
          const newParents = new Set<string>();
          const next: AppNode[] = store.nodes.map((n) => {
            const s = n.id === nodeId ? { dx, dy } : shiftById.get(n.id);
            if (!s) return n;
            const { node: moved, targetGroupId: g, parentChanged: pc } =
              reparentedNode(n, store.nodes, n.position.x + s.dx, n.position.y + s.dy);
            if (pc && g) newParents.add(g);
            return moved;
          });
          for (const parentId of newParents) {
            for (;;) {
              const parentIdx = next.findIndex((p) => p.id === parentId);
              if (parentIdx < 0) break;
              const childIdx = next.findIndex(
                (n, i) => i < parentIdx
                  && (n as AppNode & { parentId?: string }).parentId === parentId,
              );
              if (childIdx < 0) break;
              const [item] = next.splice(childIdx, 1);
              next.splice(parentIdx, 0, item);
            }
          }
          store.setNodes(next);
        }),
      );
    },
    [getInternalNode],
  );

  /**
   * Commit a connection: single-input enforcement, edge add, hidden-socket
   * exposure, and the image→normal colorSpace flip. History is the CALLER's
   * responsibility — wire drags (onConnect) and drag-connect drops
   * (onNodeDragStop) each bracket it under their own single pushHistory.
   */
  const applyConnection = useCallback(
    (connection: Connection) => {
      // Read fresh edges from store to avoid stale closure
      const currentEdges = useAppStore.getState().edges;

      // Enforce single-input: remove any existing edge to the same target handle
      const filtered = currentEdges.filter(
        (e) =>
          !(e.target === connection.target && e.targetHandle === connection.targetHandle),
      );

      const newEdge = makeTypedEdge(
        connection.source,
        connection.sourceHandle,
        connection.target,
        connection.targetHandle,
      );
      setEdges(addEdge(newEdge, filtered) as AppEdge[]);
      exposeConnectedTarget(connection.target, connection.targetHandle);

      // Eval telemetry: this is the ONE connect path (wire drops, drag-connect
      // and tile drag-connect all funnel here), so one call covers them all.
      // Gated so normal sessions don't pay the two node scans for a log call
      // that would be dropped (evalLog's own guard covers only the call).
      if (isEvalSessionActive()) {
        const ns = useAppStore.getState().nodes;
        const typeOf = (id: string | null): string => {
          const n = ns.find((x) => x.id === id);
          return (n?.data as { registryType?: string } | undefined)?.registryType ?? n?.type ?? 'unknown';
        };
        evalLog('edge-connect', {
          sourceType: typeOf(connection.source),
          targetType: typeOf(connection.target),
          targetHandle: connection.targetHandle ?? '',
        });
      }

      // Auto-linearize an image wired into the Output's Normal socket. The
      // codegen decodes it as a tangent-space normal MAP via normalMap(), which
      // needs LINEAR sampling — so flip the Image node to the 'data' colorSpace.
      // Skip when the same image also drives an sRGB channel (color/emissive):
      // one texture carries a single colorSpace and can't satisfy both, so we
      // leave the user's choice alone rather than silently wrong-colour it.
      // Mutating via setNodes here (mirroring updateNodeData's shape, but not
      // calling it) keeps the connect + colorSpace flip under the caller's
      // single pushHistory() → one undo step reverses the whole gesture.
      if (connection.targetHandle === 'normal') {
        const nodes = useAppStore.getState().nodes;
        const src = nodes.find((n) => n.id === connection.source);
        if (src?.data.registryType === 'imageNode') {
          const feedsSrgb = currentEdges.some(
            (e) =>
              e.source === connection.source &&
              (e.targetHandle === 'color' || e.targetHandle === 'emissive'),
          );
          if (!feedsSrgb && getNodeValues(src).colorSpace !== 'data') {
            useAppStore.getState().setNodes(
              nodes.map((n) =>
                n.id === connection.source
                  ? { ...n, data: { ...n.data, values: { ...getNodeValues(n), colorSpace: 'data' } } }
                  : n,
              ) as AppNode[],
            );
          }
        }
      }
    },
    [setEdges],
  );

  /** Set or clear the CSS highlight on the nearest candidate edge. */
  const updateEdgeHighlight = useCallback(
    (bestId: string | null) => {
      if (bestId !== highlightedEdgeRef.current) {
        clearEdgeHighlight();
        if (bestId) {
          document
            .querySelector(`.react-flow__edge[data-id="${CSS.escape(bestId)}"]`)
            ?.classList.add('fs-edge-drop-target');
          highlightedEdgeRef.current = bestId;
        }
      }
    },
    [clearEdgeHighlight],
  );

  // Drag preview: hovering another node's BODY proposes a drag-connect
  // (highlight + socket tooltip); otherwise fall back to the drop-on-edge
  // nearest-edge highlight.
  const onNodeDrag = useCallback(
    (_event: React.MouseEvent, draggedNode: AppNode, draggedNodes: AppNode[]) => {
      if (draggedNode.type === 'group' || draggedNode.type === 'note') return;

      const store = useAppStore.getState();
      // Visible size, not the measured box: cost-scaled cards render bigger,
      // so the tested point must be the center the user actually sees.
      const { w: nw, h: nh } = nodeVisualSize(draggedNode);
      const absPos = nodeAbsolutePos(draggedNode, store.nodes);
      const cx = absPos.x + nw / 2;
      const cy = absPos.y + nh / 2;

      const boxes = connectTargetBoxes(draggedNode.id, store.nodes);
      const hoverBox = (() => {
        const id = pickDropTargetNode(cx, cy, boxes);
        return id ? boxes.find((b) => b.id === id) : undefined;
      })();
      if (hoverBox) {
        // --- Drag-connect: single-node drags only (a multi-select clump has
        // no one "connecting" node). Wins over the drop-on-edge preview.
        if (draggedNodes.length === 1) {
          const hoverId = hoverBox.id;
          const di = getInternalNode(draggedNode.id);
          const hi = getInternalNode(hoverId);
          const hoverNode = store.nodes.find((n) => n.id === hoverId);
          // Plan against the LOGICAL graph: while a group is collapsed its
          // boundary edges are rewritten onto the group node, which would
          // contract all members into one vertex and fabricate cycles.
          const logicalEdges = unwrapCollapsedGroupEdges(store.nodes, store.edges);
          const endpoints =
            di && hi && hoverNode
              ? {
                  draggedId: draggedNode.id,
                  hoverId,
                  draggedCenterX: cx,
                  hoverCenterX: hoverBox.x + hoverBox.w / 2,
                  draggedInputs: mountedHandles(di, 'target', logicalEdges, hoverId),
                  draggedOutputs: mountedHandles(di, 'source', logicalEdges),
                  hoverInputs: mountedHandles(hi, 'target', logicalEdges, draggedNode.id),
                  hoverOutputs: mountedHandles(hi, 'source', logicalEdges),
                }
              : null;
          const plan = endpoints ? planDragConnect(endpoints, logicalEdges) : null;
          if (plan && endpoints && hoverNode) {
            clearEdgeHighlight();
            showConnectPreview(plan);
            return;
          }
        }
        // Over a node body with nothing to connect (nothing connectable, or a
        // multi-select clump) — suppress the edge preview too. The drop
        // suppresses splicing over any node body (overNodeBody in
        // onNodeDragStop), and splicing onto a wire hidden UNDER a node would
        // be a misfire anyway; showing a highlight here would promise an
        // insertion the drop never performs.
        clearConnectPreview();
        clearEdgeHighlight();
        return;
      }
      clearConnectPreview();

      // --- Drop-on-edge preview ---
      const def = NODE_REGISTRY.get(draggedNode.data.registryType);
      if (!def || def.inputs.length === 0 || def.outputs.length === 0) {
        clearEdgeHighlight();
        return;
      }
      const radius = DROP_ON_EDGE_RADIUS / getViewport().zoom;

      updateEdgeHighlight(findNearestEdge(cx, cy, store.edges, getInternalNode, radius, draggedNode.id));
    },
    [
      clearConnectPreview,
      showConnectPreview,
      clearEdgeHighlight,
      updateEdgeHighlight,
      getInternalNode,
      getViewport,
    ],
  );

  // Drop-on-edge: insert dragged node between source and target
  // + Anti-overlap: nudge dropped node so it doesn't sit on top of another
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: AppNode) => {
      // Released FIRST, above everything that can throw or return early below —
      // the same rule the drag chrome follows. Leaving it set would make the 3D
      // preview permanently unclickable.
      setCanvasBusy(false);
      const store = useAppStore.getState();

      clearEdgeHighlight();
      // Capture the drag-connect plan the preview promised, then tear the
      // preview down — the drop commits exactly what the tooltip showed.
      let connectPlan = connectPreviewRef.current;
      clearConnectPreview();
      // The graph can mutate mid-drag without a drag frame to refresh the
      // preview (Cmd+Z with the pointer held still — the keydown handler has
      // no drag guard). Committing a stale plan would insert a dangling edge
      // that persists in the store, so re-validate both endpoints — and
      // re-check acyclicity: an undo can RESTORE edges that make the captured
      // plan a cycle planDragConnect would never have offered.
      if (connectPlan) {
        const ids = new Set(store.nodes.map((n) => n.id));
        if (!ids.has(connectPlan.source) || !ids.has(connectPlan.target)) {
          connectPlan = null;
        } else if (
          wouldCreateCycle(
            unwrapCollapsedGroupEdges(store.nodes, store.edges),
            connectPlan.source,
            connectPlan.target,
          )
        ) {
          connectPlan = null;
        }
      }

      // Group nodes are pure containers — they should never trigger drop-on-edge,
      // never anti-overlap-nudge, and never push history beyond what React Flow
      // already does for the position change.
      if (draggedNode.type === 'group') {
        dragStartPosRef.current = null;
        return;
      }

      // Notes are free-floating background annotations: never anti-overlap-
      // nudged (which would fling them away from the nodes they were
      // deliberately dropped over, making them seem to vanish) and never
      // spliced onto an edge. They DO take part in group membership like any
      // other node, though — a note dropped inside a frame joins it and then
      // rides the group's drags, collapse and ungroup — so this falls through
      // to the reparent step below instead of bailing out of the whole handler.
      const isNote = draggedNode.type === 'note';

      // Skip work entirely if the node didn't actually move (click without
      // drag) — UNLESS a connect preview is showing: React Flow starts drags
      // at 1px, so a sub-threshold drop can carry a plan whose tooltip/rings
      // promised a connection (stacked nodes), and discarding it would make
      // the preview lie.
      const startPos = dragStartPosRef.current;
      dragStartPosRef.current = null;
      if (startPos && !connectPlan) {
        const moved = Math.hypot(
          draggedNode.position.x - startPos.x,
          draggedNode.position.y - startPos.y,
        );
        if (moved < DRAG_HISTORY_THRESHOLD) return;
      }

      // History snapshot covers the position change plus any drag-connect or
      // drop-on-edge mutation — one undo step for the whole gesture.
      // Pushed once here (not in onNodeDragStart) so click-only events don't add no-op entries.
      store.pushHistory();

      // --- Drag-connect: commit the previewed connection ---
      if (connectPlan) {
        applyConnection({
          source: connectPlan.source,
          sourceHandle: connectPlan.sourceHandle,
          target: connectPlan.target,
          targetHandle: connectPlan.targetHandle,
        });
      }

      // applyConnection can rewrite node data (hidden-socket exposure, image
      // colorSpace flip), so re-read state and work from the FRESH dragged
      // node — building the final setNodes from the stale array would
      // silently revert those changes.
      const allNodes = useAppStore.getState().nodes;
      const freshDragged = allNodes.find((n) => n.id === draggedNode.id) ?? draggedNode;

      const { w: nw, h: nh } = getNodeSize(freshDragged);
      // Use absolute position for edge-proximity so grouped nodes compare correctly,
      // and the VISIBLE center (cost-scaled cards render bigger than their
      // measured box) so the drop tests the same point the drag preview did.
      const absPos = nodeAbsolutePos(freshDragged, allNodes);
      const { w: vw, h: vh } = nodeVisualSize(freshDragged);
      const cx = absPos.x + vw / 2;
      const cy = absPos.y + vh / 2;

      // --- Drop-on-edge insertion (a drop that just connected never also
      // splices, and neither does a drop over any node BODY — the drag
      // preview suppressed the edge highlight there, so splicing onto a wire
      // hidden under the node would commit something never previewed) ---
      const def = NODE_REGISTRY.get(freshDragged.data.registryType);
      const overNodeBody =
        connectPlan != null ||
        pickDropTargetNode(cx, cy, connectTargetBoxes(freshDragged.id, allNodes)) != null;
      // (`isNote` is redundant with `def` — a note has no registry entry — but
      // stated explicitly so the rule survives one ever gaining one.)
      if (!isNote && !overNodeBody && def && def.inputs.length > 0 && def.outputs.length > 0) {
        const radius = DROP_ON_EDGE_RADIUS / getViewport().zoom;
        tryInsertOnEdge(freshDragged.id, def, cx, cy, getInternalNode, radius);
      }

      // --- Placement clean-up ---
      const GAP = 10;
      let posX = freshDragged.position.x;
      let posY = freshDragged.position.y;
      let nudged = false;
      let cascadeShifts: CascadeShift[] = [];

      if (connectPlan) {
        // Drag-connect drop: snap beside the node it just wired to —
        // connecting handles aligned, a wire's length apart — then MAKE ROOM:
        // the connected pair stays fixed (the alignment is the point of the
        // gesture) and everything they overlap is pushed out, knock-on pushes
        // rippling outward (overlapCascade.ts). The dragged node itself is
        // never nudged off its alignment.
        const hoverId =
          connectPlan.mode === 'feed-hover' ? connectPlan.target : connectPlan.source;
        const di = getInternalNode(freshDragged.id);
        const hi = getInternalNode(hoverId);
        if (di && hi) {
          const { dx, dy } = connectSnapOffset(connectPlan, di, hi);
          posX += dx;
          posY += dy;
          nudged = true;
        }
        const placedAbs = {
          x: absPos.x + (posX - freshDragged.position.x),
          y: absPos.y + (posY - freshDragged.position.y),
        };
        cascadeShifts = resolveOverlapCascade(
          makeRoomBoxes(allNodes, freshDragged.id, placedAbs, hoverId),
          GAP,
        );
      } else if (!isNote) {
        // --- Anti-overlap: nudge the dropped node itself off whatever it
        // landed on (plain moves and drop-on-edge splices; single pass) ---
        for (const other of allNodes) {
          if (other.id === freshDragged.id) continue;
          // Group containers + background notes must not push other nodes aside.
          if (other.type === 'group' || other.type === 'note') continue;
          // Only compare nodes in the same coordinate space (same parent).
          if (other.parentId !== freshDragged.parentId) continue;
          const { w: ow, h: oh } = getNodeSize(other);

          // Check AABB overlap
          const overlapX = Math.min(posX + nw, other.position.x + ow) - Math.max(posX, other.position.x);
          const overlapY = Math.min(posY + nh, other.position.y + oh) - Math.max(posY, other.position.y);

          if (overlapX > 0 && overlapY > 0) {
            // Compute push-out distance for each direction
            const pushRight = (other.position.x + ow + GAP) - posX;
            const pushLeft = posX + nw - (other.position.x - GAP);
            const pushDown = (other.position.y + oh + GAP) - posY;
            const pushUp = posY + nh - (other.position.y - GAP);

            // Pick smallest push-out
            const minPush = Math.min(pushRight, pushLeft, pushDown, pushUp);

            if (minPush === pushRight) posX += pushRight;
            else if (minPush === pushLeft) posX -= pushLeft;
            else if (minPush === pushDown) posY += pushDown;
            else posY -= pushUp;

            nudged = true;
          }
        }
      }

      // --- Group attachment: if the dragged node lands inside a group's
      // bounds, attach it; if it lands outside its current parent, detach it.
      // React Flow doesn't reparent on its own, so this is the only place that
      // mutates parentId based on drag.
      const finalPosX = nudged ? posX : freshDragged.position.x;
      const finalPosY = nudged ? posY : freshDragged.position.y;
      const { node: updatedNode, targetGroupId, parentChanged } =
        reparentedNode(freshDragged, allNodes, finalPosX, finalPosY);
      if (!nudged && !parentChanged && cascadeShifts.length === 0) return;

      // Cascade deltas are absolute-space, applied to local positions — a
      // delta is parent-invariant, so grouped neighbors shift correctly too.
      // Every shifted node gets the SAME position→membership reconciliation a
      // user drag gets (reparentedNode): a member pushed out of its group
      // frame detaches — otherwise it would invisibly vanish on collapse and
      // ride the group's drags from a distance — and a free node pushed
      // inside a frame attaches.
      const shiftById = new Map(cascadeShifts.map((s) => [s.id, s]));
      const newParents = new Set<string>();
      if (parentChanged && targetGroupId) newParents.add(targetGroupId);
      const updated: AppNode[] = allNodes.map((n) => {
        if (n.id === freshDragged.id) return updatedNode;
        const s = shiftById.get(n.id);
        if (!s) return n;
        const { node: shifted, targetGroupId: g, parentChanged: pc } =
          reparentedNode(n, allNodes, n.position.x + s.dx, n.position.y + s.dy);
        if (pc && g) newParents.add(g);
        return shifted;
      });

      // React Flow requires each parent to come BEFORE its children in the
      // array — lift any child of a newly adopted group above it.
      for (const parentId of newParents) {
        for (;;) {
          const parentIdx = updated.findIndex((p) => p.id === parentId);
          if (parentIdx < 0) break;
          const childIdx = updated.findIndex(
            (n, i) => i < parentIdx
              && (n as AppNode & { parentId?: string }).parentId === parentId,
          );
          if (childIdx < 0) break;
          const [item] = updated.splice(childIdx, 1);
          updated.splice(parentIdx, 0, item);
        }
      }

      store.setNodes(updated);
    },
    [clearEdgeHighlight, clearConnectPreview, applyConnection, getInternalNode, getViewport],
  );

  // Multi-node drag: React Flow fires this for selection drags (instead of
  // onNodeDragStop per-node). Apply group attachment to every dragged node in
  // one commit so a box-selected clump dropped onto a group all reparents
  // together rather than only one landing inside.
  const onSelectionDragStop = useCallback(
    (_event: React.MouseEvent, draggedNodes: AppNode[]) => {
      const store = useAppStore.getState();
      const allNodes = store.nodes;
      const draggedById = new Map<string, AppNode>(draggedNodes.map((n) => [n.id, n]));

      // Each node's local position in the drag event is already the post-drag
      // position; the reparent helper expects that same coordinate as the
      // final local. Skip group containers — they're moved, not attached.
      const replacements = new Map<string, AppNode>();
      const newParents = new Set<string>();
      let anyParentChanged = false;
      for (const dragged of draggedNodes) {
        // Group containers are moved, not attached. Notes DO attach, like any
        // other member (they're only exempt from nudging and edge-splicing).
        if (dragged.type === 'group') continue;
        const { node: updatedNode, targetGroupId, parentChanged } =
          reparentedNode(dragged, allNodes, dragged.position.x, dragged.position.y);
        // A selection-drag doesn't pick up a new parent if the dropped group
        // is itself part of the selection — that would nest the group inside
        // one of its own peers being moved, causing a parent-loop.
        if (targetGroupId && draggedById.has(targetGroupId)) continue;
        replacements.set(dragged.id, updatedNode);
        if (parentChanged) {
          anyParentChanged = true;
          if (targetGroupId) newParents.add(targetGroupId);
        }
      }

      store.pushHistory();
      if (!anyParentChanged) return;

      const updated: AppNode[] = allNodes.map((n) => replacements.get(n.id) ?? n);

      // React Flow requires each parent to come BEFORE its children in the
      // array. For each newly adopted group, lift any child sitting before it
      // to the slot immediately after.
      for (const parentId of newParents) {
        for (;;) {
          const parentIdx = updated.findIndex((p) => p.id === parentId);
          if (parentIdx < 0) break;
          const childIdx = updated.findIndex(
            (n, i) => i < parentIdx
              && (n as AppNode & { parentId?: string }).parentId === parentId,
          );
          if (childIdx < 0) break;
          const [item] = updated.splice(childIdx, 1);
          updated.splice(parentIdx, 0, item);
        }
      }

      store.setNodes(updated);
    },
    [],
  );

  /**
   * Which node the pointer is over — published to the store so the WIRES on a
   * lifted node can move with its sockets (see TypedEdge). React Flow's own
   * mouse-enter/leave are used rather than CSS, because CSS `:hover` is not
   * readable from the edge components.
   *
   * Suppressed for the whole of a connection drag: dragging a wire sweeps the
   * pointer across every node between the socket and the target, and lifting
   * each one in turn is noise on top of a gesture that already has its own
   * target affordance (the revealed sockets). `fs-connecting` on the canvas
   * root does the same for the CSS half; the two MUST agree, or the card lifts
   * while its wires do not — the exact defect this whole mechanism exists to
   * prevent.
   */
  const setHoveredNode = useAppStore((s) => s.setHoveredNode);
  const connectingRef = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const onNodeMouseEnter = useCallback(
    (_e: React.MouseEvent, node: AppNode) => {
      if (connectingRef.current) return;
      setHoveredNode(node.id);
    },
    [setHoveredNode],
  );
  const onNodeMouseLeave = useCallback(() => setHoveredNode(null), [setHoveredNode]);

  // Track whether a connection attempt succeeded; if not, open add-node menu
  const connectSucceeded = useRef(false);
  const pendingSourceRef = useRef<{ nodeId: string; handleId: string } | null>(null);

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: { nodeId: string | null; handleId: string | null; handleType: string | null }) => {
      setCanvasBusy(true);
      connectSucceeded.current = false;
      // A node already lifted under the pointer must drop back BEFORE the wire
      // starts moving, or it stays raised for the whole drag with no pointer on
      // it (mouse-leave is swallowed once React Flow captures the pointer).
      connectingRef.current = true;
      setConnecting(true);
      setHoveredNode(null);
      // NB: deliberately NO clearSocketTapTooltip() here — a bare touch tap on
      // a socket ALSO starts a connection (every handle is isConnectableStart),
      // so clearing on connect-start would dismiss the tooltip the tap itself
      // just popped. Stale tap labels during wire drags are handled at the
      // handle level instead: reveal turning on clears the tap (TypedHandle).
      // Only track source when dragging from an output (source) handle
      if (params.handleType === 'source' && params.nodeId && params.handleId) {
        pendingSourceRef.current = { nodeId: params.nodeId, handleId: params.handleId };
      } else {
        pendingSourceRef.current = null;
      }
    },
    [],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // Cleared up front, above every early return below: this function has
      // several, and a missed reset would leave the canvas permanently unable
      // to highlight a node again — and would strand the 3D preview inert.
      setCanvasBusy(false);
      connectingRef.current = false;
      setConnecting(false);
      const pending = pendingSourceRef.current;
      pendingSourceRef.current = null;
      if (connectSucceeded.current) return;
      // If this connection was initiated from an edge disconnect, don't open the menu
      if (isEdgeDisconnecting) {
        setEdgeDisconnecting(false);
        return;
      }
      // Dropped ON a socket (or within CONNECTION_RADIUS of one), but no edge
      // was made — the connection was rejected as invalid: wrong direction,
      // self-connect, or a cycle. React Flow sets `toHandle` for the snapped
      // handle regardless of validity, so it distinguishes "aimed at a socket
      // and missed" from "let go over empty canvas". Only the latter is a
      // request to add a node; popping the menu over the socket the user was
      // aiming at is just noise on top of a failed connect.
      if (connectionState.toHandle) return;
      // Connection dropped on empty space — open add-node menu with source pin info
      const clientX = 'clientX' in event ? event.clientX : event.changedTouches[0].clientX;
      const clientY = 'clientY' in event ? event.clientY : event.changedTouches[0].clientY;
      openContextMenu(clientX, clientY, 'canvas', undefined, undefined, pending?.nodeId, pending?.handleId);
    },
    [openContextMenu],
  );

  // Track whether a reconnect was successful (dropped on a valid handle)
  const reconnectSuccessful = useRef(false);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      connectSucceeded.current = true;
      useAppStore.getState().pushHistory();
      applyConnection(connection);
      // A drag that started as an edge disconnect ended in a successful
      // connect — onConnectEnd's early-return would leave the flag set and
      // silently swallow the NEXT empty-space drop's AddNodeMenu.
      setEdgeDisconnecting(false);
    },
    [applyConnection],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, 'canvas');
    },
    [openContextMenu]
  );

  // React Flow error 008 ("Couldn't create edge for … handle id") is ALWAYS a
  // bug — the missing-useUpdateNodeInternals trap CLAUDE.md documents — with
  // ONE deliberate exception: edges into a DORMANT Output section, whose
  // unmounted handles are the visibility rule's steady state. Unscoped, a
  // sleeping section floods the dev console at frame rate on every pan (the
  // edge position selector re-runs per internal store write) and buries the
  // real 008s. The swallow is scoped to handles that parse to a CURRENTLY
  // dormant material — blanket 008 suppression would hide the real bug class.
  const onFlowError = useCallback((code: string, message: string) => {
    if (code === '008') {
      const m = /handle id: "m(\d+):/.exec(message);
      if (m && outputDormancyFromState(useAppStore.getState()).dormant.has(Number(m[1]))) {
        return;
      }
    }
    // Everything else keeps React Flow's default reporting: warn in dev,
    // silent in production.
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[React Flow]: ${message}`);
    }
  }, []);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: AppNode) => {
      event.preventDefault();
      const menuType =
        node.type === 'group'
          ? 'group'
          : node.type === 'note'
            ? 'note'
            : NODE_MENU_TYPES[node.data.registryType] ?? 'node';
      // Which Output MATERIAL SECTION was under the cursor: each block carries
      // `data-material-index`, so the settings menu opens already scoped to
      // that section (its channels, its material settings). The touch
      // long-press path re-dispatches contextmenu on the pointerdown target,
      // so `event.target` resolves identically there.
      const section = (event.target as HTMLElement | null)?.closest?.('[data-material-index]');
      const raw = section ? Number(section.getAttribute('data-material-index')) : NaN;
      const materialIndex = Number.isInteger(raw) && raw >= 0 ? raw : undefined;
      openContextMenu(
        event.clientX, event.clientY, menuType, node.id,
        undefined, undefined, undefined, materialIndex,
      );
    },
    [openContextMenu]
  );

  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, 'edge', undefined, edge.id);
    },
    [openContextMenu]
  );

  // Double-click an edge → drop a routing waypoint at the click point. Ordered
  // by minimum detour so it lands on the right part of the wire regardless of
  // click order (see insertWaypointOrdered). Node centers approximate the wire
  // endpoints well enough for ordering. Double-clicking a waypoint dot removes
  // it (handled in EdgeWaypointHandles, which stops propagation).
  const onEdgeDoubleClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.stopPropagation();
      const src = getInternalNode(edge.source);
      const tgt = getInternalNode(edge.target);
      if (!src || !tgt) return;
      const p = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const center = (n: InternalNode) => ({
        x: n.internals.positionAbsolute.x + (n.measured?.width ?? 120) / 2,
        y: n.internals.positionAbsolute.y + (n.measured?.height ?? 40) / 2,
      });
      const store = useAppStore.getState();
      const current = store.edges.find((e) => e.id === edge.id);
      const wps = (current?.data?.waypoints ?? []) as { x: number; y: number }[];
      const next = insertWaypointOrdered(center(src), center(tgt), wps, p);
      store.setEdgeWaypoints(edge.id, next, { history: true });
    },
    [screenToFlowPosition, getInternalNode]
  );

  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, 'canvas');
    },
    [openContextMenu]
  );

  // Drag-to-delete: track reconnect start + save history
  const onReconnectStart = useCallback(() => {
    reconnectSuccessful.current = false;
    // Dragging an edge END off its socket is a disconnect gesture, but React
    // Flow still runs the connection lifecycle for it (onConnectStart/End) — so
    // flag it exactly like the edge-body drag-to-disconnect does. Otherwise
    // releasing on empty canvas pops the AddNodeMenu on top of the disconnect.
    setEdgeDisconnecting(true);
    useAppStore.getState().pushHistory();
  }, []);

  // Drag-to-delete: handle successful reconnect
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      reconnectSuccessful.current = true;
      const currentEdges = useAppStore.getState().edges;
      setEdges(reconnectEdge(oldEdge, newConnection, currentEdges) as AppEdge[]);
      // Reconnecting onto a drag-revealed hidden socket must expose it too —
      // under onReconnectStart's pushHistory, same one-undo-step contract as
      // a fresh connect.
      exposeConnectedTarget(newConnection.target, newConnection.targetHandle);
    },
    [setEdges]
  );

  // Drag-to-delete: if reconnect failed (dropped on empty space), delete the edge
  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: Edge) => {
      if (!reconnectSuccessful.current) {
        removeEdge(edge.id);
      }
      reconnectSuccessful.current = true;
      // Clear the disconnect flag AFTER onConnectEnd has run this tick (it reads
      // the flag to suppress the AddNodeMenu, and the two callbacks' firing
      // order isn't guaranteed), so the next genuine empty-canvas wire drop
      // still opens the menu.
      requestAnimationFrame(() => setEdgeDisconnecting(false));
    },
    [removeEdge]
  );

  // Content browser drag-and-drop: allow drop on canvas
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    // Drag-connect preview for a node tile in flight (payload comes from
    // tileDrag's module record — dataTransfer is unreadable during dragover).
    // Over a node body the drop-on-edge preview is suppressed, same
    // never-both rule as node drags.
    const tile = getHtml5TileDrag();
    if (tile) {
      if (previewTileConnect(tile, event.clientX, event.clientY)) {
        clearEdgeHighlight();
        return;
      }
      // A tile that can't splice (value/source nodes: no inputs) must not
      // get the edge highlight either — the drop won't insert it.
      if (!tileCanSplice(tile)) {
        clearEdgeHighlight();
        return;
      }
    }

    // Highlight the nearest edge for drop-on-edge insertion preview (asset browser drags).
    const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const store = useAppStore.getState();
    const radius = DROP_ON_EDGE_RADIUS / getViewport().zoom;
    updateEdgeHighlight(findNearestEdge(pos.x, pos.y, store.edges, getInternalNode, radius));
  }, [previewTileConnect, clearEdgeHighlight, screenToFlowPosition, updateEdgeHighlight, getInternalNode, getViewport]);

  // Place a node/group/texture at the given screen point. Shared by both the
  // HTML5 onDrop path (desktop) and the touch tileDrag path (iPad/phone).
  const placeTilePayload = useCallback(
    (payload: TilePayload, clientX: number, clientY: number, activate = false) => {
      // Capture the drag-connect plan the drag preview promised (set by HTML5
      // dragover or the touch move stream). Guards: only PHANTOM plans belong
      // to a tile gesture (a live node-drag preview must not be hijacked),
      // and click/Enter activation never previewed anything, so a plan found
      // there is stale by definition (e.g. a swallowed dragend) — drop it.
      const captured = connectPreviewRef.current;
      const tilePlan =
        !activate &&
        captured &&
        (captured.source === TILE_PHANTOM_ID || captured.target === TILE_PHANTOM_ID)
          ? captured
          : null;
      clearConnectPreview();
      const position = screenToFlowPosition({ x: clientX, y: clientY });

      // The Output-singleton redirect runs BEFORE the asset-drop telemetry:
      // once an Output exists the tile is a "take me to it" affordance — the
      // drop glides the view to the existing node instead of silently doing
      // nothing, which read as a broken tile — and a redirected drop places
      // nothing, so an eval session must not count it as an asset placement.
      if (payload.kind === 'node') {
        const dropDef = NODE_REGISTRY.get(payload.nodeType);
        if (dropDef?.type === 'output') {
          const nodesNow = useAppStore.getState().nodes;
          const existing = existingOutputId(nodesNow);
          if (existing) {
            focusOutputNode(fitView, nodesNow, existing);
            return;
          }
        }
      }

      // Eval telemetry: which ready-made asset (or palette node) was placed.
      // Node-kind drops ALSO produce a node-add via addNode — this event is
      // the "came from the palette" marker, not a duplicate count.
      evalLog('asset-drop', {
        kind: payload.kind,
        id: payload.kind === 'node' ? payload.nodeType : payload.id,
      });

      if (payload.kind === 'savedGroup') {
        useAppStore.getState().instantiateSavedGroup(payload.id, position);
        return;
      }
      if (payload.kind === 'texture') {
        useAppStore.getState().instantiateBuiltinTexture(payload.id, position);
        return;
      }
      if (payload.kind === 'preset') {
        useAppStore.getState().instantiateBuiltinPreset(payload.id, position);
        return;
      }

      const def = NODE_REGISTRY.get(payload.nodeType);
      if (!def) return;
      const costs = complexityData.costs as Record<string, number>;
      const cost = costs[def.type] ?? 0;
      const currentNodes = useAppStore.getState().nodes;

      let newNodeId: string | undefined;
      if (def.type === 'output') {
        // Reached only with NO Output present (the user deleted it) — the
        // singleton redirect above returned before the telemetry otherwise.
        const newNode: AppNode = {
          id: generateId(),
          type: 'output',
          position,
          data: { registryType: 'output', label: 'Output', cost: 0 } as OutputNodeData,
        };
        addNode(newNode);
        newNodeId = newNode.id;
      } else {
        // Property auto-naming (one sequence shared with AddNodeMenu and the
        // convert-to-uniform action, so tile drops can't mint duplicates) plus
        // a random colour for colour nodes.
        const values = initialNodeValues(def, currentNodes);
        const newNode = {
          id: generateId(),
          type: getFlowNodeType(def),
          position,
          data: { registryType: def.type, label: def.label, cost, values } as ShaderNodeData,
        } as AppNode;
        addNode(newNode);
        newNodeId = newNode.id;
      }

      if (!newNodeId) return;

      // --- Drag-connect: commit the previewed plan against the real node id.
      // Rides addNode's pushHistory — add + connect + snap = one undo step.
      if (tilePlan) {
        const source = tilePlan.source === TILE_PHANTOM_ID ? newNodeId : tilePlan.source;
        const target = tilePlan.target === TILE_PHANTOM_ID ? newNodeId : tilePlan.target;
        const liveIds = new Set(useAppStore.getState().nodes.map((n) => n.id));
        if (liveIds.has(source) && liveIds.has(target)) {
          applyConnection({
            source,
            sourceHandle: tilePlan.sourceHandle,
            target,
            targetHandle: tilePlan.targetHandle,
          });
          scheduleTileConnectSnap(newNodeId, tilePlan);
          return;
        }
      }

      // --- Drop-on-edge insertion. DRAG drops never splice under a node
      // body (the drag preview suppressed the edge highlight there, so
      // nothing was promised); click/Enter adds showed no preview either way
      // and keep their historical unconditional splice at canvas centre. ---
      if (def.inputs.length > 0 && def.outputs.length > 0) {
        const overNodeBody =
          !activate &&
          pickDropTargetNode(
            position.x,
            position.y,
            connectTargetBoxes(newNodeId, useAppStore.getState().nodes),
          ) != null;
        if (!overNodeBody) {
          const radius = DROP_ON_EDGE_RADIUS / getViewport().zoom;
          tryInsertOnEdge(newNodeId, def, position.x, position.y, getInternalNode, radius);
        }
      }
    },
    [
      screenToFlowPosition,
      addNode,
      getInternalNode,
      getViewport,
      fitView,
      clearConnectPreview,
      applyConnection,
      scheduleTileConnectSnap,
    ],
  );

  // Parse a dropped CSV on the host and place a Data node at the drop point.
  // Parsing stays here (the sandboxed preview iframe can't read files); the data
  // travels onward only as validated numbers baked into the node payload.
  const placeCsvFile = useCallback(
    (file: File, clientX: number, clientY: number) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = parseCsv(String(reader.result ?? ''));
        if (!res.ok) {
          window.alert(`Could not load "${file.name}":\n${res.error}`);
          return;
        }
        const position = screenToFlowPosition({ x: clientX, y: clientY });
        // Over-wide CSVs prompt the user (cancel / place as-is / transpose)
        // rather than dropping a Data node with an unwieldy number of outputs.
        if (res.data.columns.length > COLUMN_WARN_THRESHOLD) {
          useAppStore.getState().enqueueCsvImport({
            id: generateId(),
            fileName: file.name,
            columnCount: res.data.columns.length,
            rowCount: res.data.rowCount,
            parsed: res.data,
            position,
          });
          return;
        }
        const cost = (complexityData.costs as Record<string, number>).dataNode ?? 2;
        addNode({
          id: generateId(),
          type: 'shader',
          position,
          data: makeDataNodeData(res.data, cost, file.name),
        } as AppNode);
      };
      reader.onerror = () => window.alert(`Could not read "${file.name}".`);
      reader.readAsText(file);
    },
    [screenToFlowPosition, addNode],
  );

  // Re-encode a dropped image on the host and place an Image node at the drop
  // point. The canvas round-trip strips metadata and bounds the payload; limit
  // hits surface the LimitModal (with an override) instead of failing silently.
  /**
   * Decode + re-encode one dropped image and place its node.
   *
   * `ghostId` is the in-flight indicator already on screen for this file (the
   * multi-drop path raises all of them up front); it is removed here whatever
   * happens. Awaitable so a multi-file drop can queue the encodes.
   */
  /**
   * The drop's convert-or-keep decision, asked ONCE per drop (not per file).
   * A remembered answer skips the dialog entirely.
   */
  const askConvertMode = useCallback(
    async (count: number, fileName: string): Promise<ImageImportChoice> => {
      const pref = useAppStore.getState().imageConvertMode;
      if (pref === 'always') return 'convert';
      if (pref === 'never') return 'keep';
      const choice = await new Promise<ImageImportChoice>((resolve) => {
        convertResolver.current = resolve;
        setConvertAsk({ count, fileName });
      });
      return choice;
    },
    [],
  );

  const resolveConvertAsk = useCallback((choice: ImageImportChoice, remember: boolean) => {
    if (remember) {
      useAppStore.getState().setImageConvertMode(choice === 'convert' ? 'always' : 'never');
    }
    setConvertAsk(null);
    const resolver = convertResolver.current;
    convertResolver.current = null;
    resolver?.(choice);
  }, []);

  const placeImageFile = useCallback(
    async (file: File, clientX: number, clientY: number, ghostId: string, mode: ImageConvertMode) => {
      const position = screenToFlowPosition({ x: clientX, y: clientY });
      if (isSvgFile(file)) {
        setImportGhosts((g) => g.filter((x) => x.id !== ghostId));
        window.alert(
          `Could not load "${file.name}":\nSVG images can't be imported — export it as PNG or WebP first.`,
        );
        return;
      }
      try {
        const store = useAppStore.getState();
        const ignore = store.ignoreImageLimits;
        const deviceCap = resolveDeviceTextureDim(store.selectedHeadsetId, store.costProfiles);
        const deviceLabel = resolveDeviceBudget(store.selectedHeadsetId, store.costProfiles).label;
        const res = await encodeImageFile(file, ignore, deviceCap, mode);
        if (!res.ok) {
          if (res.reason === 'too-large' || res.reason === 'pixels') {
            store.enqueueLimitNotice({
              id: generateId(),
              kind: res.reason === 'pixels' ? 'image-too-many-pixels' : 'image-too-large',
              fileName: file.name,
              detail: res.width && res.height ? `${res.width}×${res.height}` : undefined,
              file,
              position,
              convert: mode === 'convert',
            });
          } else {
            window.alert(`Could not load "${file.name}" as an image.`);
          }
          return;
        }

        // Stash the pre-snap payload BEFORE anything can bail out: the record
        // is content-keyed, so writing it for a drop the user later cancels
        // costs one LRU slot and nothing else — whereas deferring it past the
        // total-cap notice would leave every "Add anyway" image permanently
        // un-revertible (the notice carries no blob). If the stash is refused,
        // resolveImageDrop discards the snap instead of shipping it.
        const { payload, origin } = resolveImageDrop(res, file.name, (p) =>
          stashImageOrigin(p, Date.now()),
        );

        // Per-image budget met — now check the whole-project image budget
        // (every payload is multiplied through auto-save + undo history).
        if (!ignore && totalImageChars(useAppStore.getState().nodes) + payload.dataUrl.length > MAX_TOTAL_IMAGE_CHARS) {
          store.enqueueLimitNotice({
            id: generateId(),
            kind: 'image-total-cap',
            fileName: file.name,
            file,
            position,
            convert: mode === 'convert',
            // Carry the finished encode so "Add anyway" places exactly this
            // payload instead of re-encoding at the relaxed dimension cap —
            // provenance included, or the override would drop the revert.
            encoded: { ...payload, origin },
          });
          return;
        }
        const cost = (complexityData.costs as Record<string, number>).imageNode ?? 2;
        addNode({
          id: generateId(),
          type: 'shader',
          position,
          data: makeImageNodeFromEncode(payload, cost, file.name, origin),
        } as AppNode);
        // The user asked to optimize and it didn't happen — a WebP request on
        // WebKit comes back as PNG, so a dropped .png can land as .jpg and
        // look like nothing occurred. Reported as ONE line (with the detail
        // behind its "?"), not a modal: it is information about the browser,
        // not a decision the user has to make, and it must not stand between
        // a drag and the canvas.
        const storedAs =
          res.mime === 'image/jpeg' ? 'JPEG' : res.mime === 'image/png' ? 'PNG' : res.mime === 'image/webp' ? 'WebP' : res.mime;
        if (!store.hideImageConvertNotice) {
          if (mode === 'convert' && !res.webpAvailable) {
            setImportNote({ id: generateId(), reason: 'no-webp', storedAs });
          } else if (mode === 'keep' && store.imageConvertMode === 'never') {
            // A REMEMBERED "no" is invisible by construction — no dialog, no
            // change, nothing to see. Without this line the feature simply
            // looks broken, and the preference that caused it has no other
            // way of announcing itself.
            setImportNote({ id: generateId(), reason: 'preference', storedAs });
          }
        }
        // Device-aware downscale notice (informational; the node is already
        // placed). Only when the source exceeded the target headset's texture
        // cap, the user hasn't opted out of size limits, and hasn't hidden it.
        //
        // Deliberately NOT re-gated on "the dimensions changed at all": the
        // power-of-two snap touches an axis on most images, and this is a
        // BLOCKING modal — it would fire on nearly every drop. The snap is
        // reported non-modally instead, in the node's settings menu. For the
        // same reason the reported final size is the PRE-snap one: this
        // dialog is about the device cap, and "downscaled to 2048×1024" would
        // be a lie about an axis the snap rounded up.
        if (
          !ignore &&
          !store.hideImageDownscaleWarning &&
          Math.max(res.sourceWidth, res.sourceHeight) > deviceCap
        ) {
          store.enqueueLimitNotice({
            id: generateId(),
            kind: 'image-device-downscaled',
            fileName: file.name,
            downscale: {
              deviceLabel,
              cap: deviceCap,
              sourceW: res.sourceWidth,
              sourceH: res.sourceHeight,
              finalW: res.original?.width ?? payload.width,
              finalH: res.original?.height ?? payload.height,
            },
          });
        }
      } finally {
        setImportGhosts((g) => g.filter((x) => x.id !== ghostId));
      }
    },
    [screenToFlowPosition, addNode],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      clearEdgeHighlight();

      // OS file drop (a real file from disk) — each `.csv` becomes a Data
      // node, each image an Image node. Checked first because
      // dataTransfer.files is only populated for genuine file drops, never
      // for the app's internal tile drags. Partitioned ONCE and mutually
      // exclusively (csv test wins) so a mixed drop places everything and no
      // file can match twice.
      const files = event.dataTransfer.files;
      if (files && files.length > 0) {
        // A drop carrying OS files is never a tile drag — any live tile
        // payload record or connect preview is stale (a swallowed dragend
        // can leave both armed) and must be healed here, or the next
        // palette interaction would inherit a plan it never previewed.
        clearConnectPreview();
        endHtml5TileDrag();

        // A benchmark complexity .json isn't a graph file — the canvas doesn't
        // import it (drops are restricted to the cost bar + code panel). Point
        // the user at the right target instead of silently ignoring it.
        if (files.length === 1 && /\.json$/i.test(files[0].name)) {
          window.alert('Drop a benchmark complexity.json on the cost bar (top-left) or the code panel to reprice nodes.');
          return;
        }

        const csvs: File[] = [];
        const images: File[] = [];
        // A `.zip` export or a shader script (.js/.mjs/.tsl) is a *project* —
        // importing it REPLACES the whole graph, so it can't be combined with
        // the loose data-file appends below (they would race the replace and
        // be lost).
        const projects: File[] = [];
        for (const f of Array.from(files)) {
          const lower = f.name.toLowerCase();
          if (lower.endsWith('.csv') || f.type === 'text/csv') csvs.push(f);
          else if (isZipFile(f) || /\.(js|mjs|tsl)$/.test(lower)) projects.push(f);
          else if (isImageFile(f)) images.push(f);
        }

        // Project import wins and is exclusive: load exactly one and ignore
        // everything else (with a notice) rather than clobbering the imported
        // graph with appended data nodes — or losing one project to another.
        if (projects.length > 0) {
          const proj = projects[0];
          const ignored = projects.length - 1 + csvs.length + images.length;
          const done = isZipFile(proj)
            ? importShaderZip(proj).then((result) => {
                if (result === null) {
                  window.alert(`"${proj.name}" doesn't contain a FastShaders shader (.js).`);
                  return false;
                }
                return true;
              })
            : proj.text().then((text) => {
                importShaderText(text);
                return true;
              });
          void done
            .catch((e) => {
              // Imported files are adversarial input — a crash inside the
              // import must surface, not silently no-op the drop.
              window.alert(
                `Could not import "${proj.name}": ${e instanceof Error ? e.message : String(e)}`,
              );
              return false;
            })
            .then((ok) => {
              // The "ignored companions" notice may only follow an import that
              // actually succeeded — alerting 'Loaded "x"' before (or despite)
              // a failure gave contradictory feedback.
              if (ok && ignored > 0) {
                window.alert(
                  `Loaded "${proj.name}". ${ignored} other dropped file(s) were ignored — drop a project on its own.`,
                );
              }
            });
          return;
        }

        // No project file: csv + image appends don't conflict (each addNode is a
        // functional update). Shared cascade so multi-file drops don't overlap.
        const STEP = 34;
        let slot = 0;
        for (const csv of csvs) {
          const off = STEP * slot++;
          placeCsvFile(csv, event.clientX + off, event.clientY + off);
        }
        // Images are imported ONE AT A TIME. Each import is a decode plus one
        // or two canvas encodes; firing N concurrently piles N encoders onto
        // the same main thread, so a five-image drop compounded into one long
        // freeze instead of a visible cascade.
        //
        // The in-flight ghosts go up for ALL of them immediately, before the
        // first encode blocks — an image import takes a few hundred ms and
        // the node only appears at the end, so without this the canvas looks
        // like the drop did nothing. It is the honest indicator, too: the
        // encoders are single opaque calls with no callback and no cancel, so
        // real progress cannot be computed.
        const queued = images.map((img, i) => ({
          img,
          ghostId: generateId(),
          x: event.clientX + STEP * (slot + i),
          y: event.clientY + STEP * (slot + i),
        }));
        slot += images.length;
        if (queued.length > 0) {
          void (async () => {
            // Ask BEFORE the ghosts go up: the ghosts mean "working on it",
            // and nothing is being worked on while a dialog waits. Both
            // answers import the image — only the conversion differs.
            const choice = await askConvertMode(queued.length, queued[0].img.name);
            setImportGhosts((g) => [
              ...g,
              ...queued.map((q) => ({ id: q.ghostId, x: q.x, y: q.y, name: q.img.name })),
            ]);
            for (const q of queued) {
              await placeImageFile(q.img, q.x, q.y, q.ghostId, choice);
            }
          })();
        }
        // A real file drop never doubles as a tile drag — swallow it even when
        // nothing matched instead of falling through to the getData branches.
        return;
      }

      // Saved-group drag payload takes precedence over a regular node-type drag
      // (the two payloads can't both be set at once but we check this one first
      // so the regular path doesn't accidentally swallow it).
      const savedGroupId = event.dataTransfer.getData(SAVED_GROUP_DRAG_TYPE);
      if (savedGroupId) {
        placeTilePayload({ kind: 'savedGroup', id: savedGroupId }, event.clientX, event.clientY);
        return;
      }
      const textureId = event.dataTransfer.getData(BUILTIN_TEXTURE_DRAG_TYPE);
      if (textureId) {
        placeTilePayload({ kind: 'texture', id: textureId }, event.clientX, event.clientY);
        return;
      }
      const presetId = event.dataTransfer.getData(BUILTIN_PRESET_DRAG_TYPE);
      if (presetId) {
        placeTilePayload({ kind: 'preset', id: presetId }, event.clientX, event.clientY);
        return;
      }
      const nodeType = event.dataTransfer.getData('application/reactflow-type');
      if (!nodeType) {
        // Unrecognized drop — tear down any preview armed during its dragover.
        clearConnectPreview();
        return;
      }
      placeTilePayload({ kind: 'node', nodeType }, event.clientX, event.clientY);
    },
    [clearEdgeHighlight, clearConnectPreview, placeTilePayload, placeCsvFile, placeImageFile, askConvertMode],
  );


  // Pick a contrast color for the canvas-scoped badge text + 1-channel edges
  // (black on light bg, white on dark bg). Same value drives both, so they
  // always flip together when the user picks a new background.
  const contrastColor = getContrastColor(nodeEditorBgColor);
  const contrastShadow = contrastColor === '#000000'
    ? 'rgba(255, 255, 255, 0.65)'
    : 'rgba(0, 0, 0, 0.65)';
  // The dot-grid color is a React Flow PROP (SVG fill), so tokens.css can't
  // reach it — flip it here, following the CANVAS backdrop (subtle either way).
  const gridColor = contrastColor === '#000000' ? '#BBBBBB' : 'rgba(255, 255, 255, 0.12)';
  // NB no `--canvas-bg` here: the canvas color is applied directly to the React
  // Flow root. Publishing it as a var invited chrome (the asset bar) to tint
  // itself with the user's canvas pick, which it must not do.
  /**
   * How far the SELECTED nodes' visible cards overhang React Flow's own
   * selection rectangle, on the right and the bottom, in flow px.
   *
   * React Flow builds that rectangle from each node's MEASURED layout box, but
   * the expensive node types paint up to 1.35x larger than it — `getCostScale`
   * as a `transform: scale()` with `transform-origin: top left`, and a
   * transform does not affect layout (the same fact `nodeVisualSize` above
   * exists for). So the rectangle is correct along the top and left edges and
   * falls SHORT along the other two, by a different amount per node: a marquee
   * around two 35-point noise nodes drew its line straight through both cards.
   *
   * Only two numbers are needed because the shortfall is one-sided. They are
   * published as CSS variables and consumed by the boundary's `inset`
   * (NodeEditor.css) — the rectangle's own geometry is React Flow's and is left
   * exactly as it is, so the element the user drags to move a selection keeps
   * the size and hit area React Flow gave it. The 5px standoff and the selected
   * nodes' uniform `--fs-node-rise` are folded in there too, in CSS, so no px
   * literal from tokens.css has to be duplicated here.
   *
   * Computed as a difference of UNIONS, never as the largest per-node
   * difference: the node with the right-most measured edge need not be the one
   * whose card reaches furthest right.
   */
  const selectionOverflow = useMemo(() => {
    let measuredR = -Infinity, measuredB = -Infinity;
    let visualR = -Infinity, visualB = -Infinity;
    for (const n of nodes) {
      if (!n.selected) continue;
      const p = nodeAbsolutePos(n, nodes);
      const m = getNodeSize(n);
      const v = nodeVisualSize(n);
      measuredR = Math.max(measuredR, p.x + m.w);
      measuredB = Math.max(measuredB, p.y + m.h);
      visualR = Math.max(visualR, p.x + v.w);
      visualB = Math.max(visualB, p.y + v.h);
    }
    if (!Number.isFinite(measuredR)) return { dr: 0, db: 0 };
    return {
      dr: Math.max(0, visualR - measuredR),
      db: Math.max(0, visualB - measuredB),
    };
  }, [nodes]);

  const canvasCssVars = {
    '--node-cost-text': contrastColor,
    '--node-cost-text-shadow': contrastShadow,
    '--fs-sel-dr': `${selectionOverflow.dr}px`,
    '--fs-sel-db': `${selectionOverflow.db}px`,
  } as React.CSSProperties;

  // Let middle/right-click pan through the selection overlay.
  // React Flow's d3-zoom filter blocks panning when the event target is inside
  // an element with the `nopan` class. The nodesselection wrapper carries this
  // class to prevent left-drag panning (so the selection can be dragged
  // instead). But it also blocks middle-click panning, which is unwanted.
  // Fix: on middle/right mousedown, temporarily strip the `nopan` class from
  // the nodesselection wrapper so d3-zoom's filter lets the event through,
  // then restore it on the next frame.
  const canvasRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation: Tab cycles nodes (canvas-scoped), arrows move the
  // focused node, Cmd/Ctrl+arrows walk the graph, Alt+arrows cycle panes. It
  // runs in CAPTURE phase so it can stand in front of React Flow's own node
  // onKeyDown rather than firing alongside it — see useKeyboardNav.ts.
  useKeyboardNav({ drawToolActive });


  // Keyboard entry point for adding a node. The graph was otherwise pointer-only
  // — the Add-Node menu could be reached ONLY by right-click or by dropping a
  // wire, so a keyboard user had no way to author a node at all. Shift+A mirrors
  // Blender's Add shortcut and opens the menu at the canvas centre; the menu
  // already autofocuses its search box and handles Arrow/Enter from there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.metaKey || e.ctrlKey || e.altKey || !e.shiftKey) return;
      if (e.key.toLowerCase() !== 'a') return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      e.preventDefault();
      useAppStore
        .getState()
        .openContextMenu(rect.left + rect.width / 2, rect.top + rect.height / 2, 'canvas');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Touch/pen long-press → context menu. We dispatch a synthetic `contextmenu`
  // MouseEvent on the original DOM target so React Flow's existing per-element
  // handlers (onPaneContextMenu / onNodeContextMenu / onEdgeContextMenu /
  // onSelectionContextMenu) route the gesture exactly as a right-click would —
  // no duplicate hit-testing here. Handles get skipped so a long-press on a
  // port doesn't pop a menu mid-connection-drag.
  useLongPress(canvasRef, (target, clientX, clientY) => {
    if (target.closest('.react-flow__handle')) return;
    const evt = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 2,
    });
    target.dispatchEvent(evt);
  });

  // Touch-drag landing pad: tiles (NodePreviewCard / SavedGroupCard /
  // TextureCard) dispatch these events on the canvas — moves drive the same
  // drag-connect / drop-on-edge previews HTML5 dragover shows, the drop
  // routes through the same placement logic as HTML5 DnD, and end (any drag
  // teardown, including HTML5 dragend) clears the previews.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onDropEvt = (event: Event) => {
      const detail = (event as CustomEvent<TileDropEventDetail>).detail;
      placeTilePayload(detail.payload, detail.clientX, detail.clientY, detail.activate ?? false);
    };
    const onMoveEvt = (event: Event) => {
      const detail = (event as CustomEvent<TileDropEventDetail>).detail;
      if (previewTileConnect(detail.payload, detail.clientX, detail.clientY)) {
        clearEdgeHighlight();
        return;
      }
      // Only payloads the drop can actually splice get the edge highlight
      // (saved groups / textures / input-only nodes never splice).
      if (!tileCanSplice(detail.payload)) {
        clearEdgeHighlight();
        return;
      }
      const pos = screenToFlowPosition({ x: detail.clientX, y: detail.clientY });
      const radius = DROP_ON_EDGE_RADIUS / getViewport().zoom;
      updateEdgeHighlight(
        findNearestEdge(pos.x, pos.y, useAppStore.getState().edges, getInternalNode, radius),
      );
    };
    const onEndEvt = () => {
      clearConnectPreview();
      clearEdgeHighlight();
    };
    el.addEventListener(TILE_DROP_EVENT, onDropEvt);
    el.addEventListener(TILE_DRAG_MOVE_EVENT, onMoveEvt);
    el.addEventListener(TILE_DRAG_END_EVENT, onEndEvt);
    return () => {
      el.removeEventListener(TILE_DROP_EVENT, onDropEvt);
      el.removeEventListener(TILE_DRAG_MOVE_EVENT, onMoveEvt);
      el.removeEventListener(TILE_DRAG_END_EVENT, onEndEvt);
    };
  }, [
    placeTilePayload,
    previewTileConnect,
    clearConnectPreview,
    clearEdgeHighlight,
    updateEdgeHighlight,
    screenToFlowPosition,
    getInternalNode,
    getViewport,
  ]);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      if (e.button === 0) return;
      const sel = (e.target as HTMLElement).closest('.react-flow__nodesselection');
      if (sel && sel.classList.contains('nopan')) {
        sel.classList.remove('nopan');
        requestAnimationFrame(() => sel.classList.add('nopan'));
      }
    };
    el.addEventListener('mousedown', handler, true);
    return () => el.removeEventListener('mousedown', handler, true);
  }, []);

  // Wheel handling. A HORIZONTAL wheel always pans — a mouse tilt-wheel and a
  // trackpad sideways swipe both emit `deltaX` on its own, which is unambiguous
  // whatever the device. What a VERTICAL wheel does is the user's `trackpadScroll`
  // setting: OFF (default) it falls through to React Flow's `zoomOnScroll`, ON it
  // pans.
  //
  // A SETTING rather than a device sniff, and that is the design. The two
  // gestures arrive as the SAME event, so separating them needs a heuristic —
  // one was built (`wheelKind.ts`: pixel-vs-line delta mode, then the legacy
  // `wheelDelta` detent of 120), shipped, and REVERTED, because it read a real
  // macOS mouse as a trackpad and removed that user's zoom. Almost certainly
  // because macOS accelerates mouse wheels too, so `wheelDelta` is rarely a
  // clean multiple of 120. Two properties make the class unsafe to guess at:
  // the failure is ASYMMETRIC (misreading a trackpad costs a pan you repeat,
  // misreading a mouse removes a primary control), and it is UNTESTABLE from
  // here — CDP's `Input.dispatchMouseEvent` hardcodes `wheelDeltaY` to ±120
  // whatever delta you ask for, and a constructed `WheelEvent` leaves it at 0.
  // Don't reintroduce a sniff; the toolbar's right-click menu owns this now.
  //
  // Zooming stays reachable in BOTH modes: pinch and Ctrl/Cmd+wheel pass
  // straight through to React Flow, which is also the trackpad's native zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // pinch-to-zoom / explicit zoom
      // React Flow's own opt-out, honoured here too: the canvas bar and the
      // cost overlay are scrollable chrome sitting inside this element, and a
      // capture-phase listener would otherwise pan the graph out from under a
      // wheel aimed at them.
      if ((e.target as Element | null)?.closest?.('.nowheel')) return;
      // Read the flag off the store at EVENT time rather than closing over it:
      // this listener is bound once (its deps are the stable viewport helpers),
      // so a captured value would freeze whatever the setting was at mount and
      // the toggle would only take effect after a remount.
      const panVertically = useAppStore.getState().trackpadScroll;
      if (!panVertically && e.deltaX === 0) return; // → React Flow zooms
      e.preventDefault();
      e.stopImmediatePropagation();
      const vp = getViewport();
      setViewport({
        x: vp.x - e.deltaX,
        y: panVertically ? vp.y - e.deltaY : vp.y,
        zoom: vp.zoom,
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [getViewport, setViewport]);

  // Double-tap-and-drag to pan. On a trackpad the natural "grab" gesture is
  // tap-tap-hold-drag; on touch it's the same with fingers. `panOnDrag={[1, 2]}`
  // only pans with middle/right buttons, so without this the second press
  // lands on a node (often a group) and starts a node drag instead of a canvas
  // pan. We intercept the second pointerdown in the capture phase, block React
  // Flow from seeing it, and take over the gesture by rewriting the viewport
  // ourselves. Pointer events cover mouse, trackpad, touch and pen uniformly.
  useEffect(() => {
    const el = canvasRef.current;
    // Coarse pointers pan with two fingers (the touch-nav effect below), so
    // the one-finger double-tap-drag pan is disabled there — two quick finger
    // taps would otherwise false-trigger it. Desktop/trackpad keep it.
    if (!el || isCoarsePointer) return;

    let lastDownAt = 0;
    let panning = false;
    let activePointerId = -1;
    let panStart = { x: 0, y: 0 };
    let vpStart = { x: 0, y: 0, zoom: 1 };
    const DOUBLE_MS = 300;

    const isInteractive = (target: EventTarget | null) => {
      const t = target as HTMLElement | null;
      return !!t?.closest('input, textarea, select, button, .nodrag, [contenteditable="true"]');
    };

    const onDown = (e: PointerEvent) => {
      // Draw mode owns primary-button gestures — the draw-capture handler runs
      // instead (it stopImmediatePropagation's, but bail here too in case order
      // ever changes).
      if (useAppStore.getState().drawToolActive) { lastDownAt = 0; return; }
      // Primary button only (e.button === 0 for left-click / first-touch / pen-tip).
      if (e.button !== 0 || isInteractive(e.target)) {
        lastDownAt = 0;
        return;
      }
      const now = Date.now();
      const second = now - lastDownAt < DOUBLE_MS;
      lastDownAt = second ? 0 : now;
      if (!second) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      panning = true;
      activePointerId = e.pointerId;
      panStart = { x: e.clientX, y: e.clientY };
      vpStart = getViewport();
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    };

    const onMove = (e: PointerEvent) => {
      if (!panning || e.pointerId !== activePointerId) return;
      setViewport({
        x: vpStart.x + (e.clientX - panStart.x),
        y: vpStart.y + (e.clientY - panStart.y),
        zoom: vpStart.zoom,
      });
    };

    const onUp = (e: PointerEvent) => {
      if (!panning || e.pointerId !== activePointerId) return;
      panning = false;
      activePointerId = -1;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [getViewport, setViewport, isCoarsePointer]);

  // Draw mode: freehand ink capture. Same capture-phase pattern as the
  // double-tap pan — a pointerdown listener on the canvas that, when draw mode
  // is active, swallows the gesture (stopImmediatePropagation, so React Flow
  // never pans / selects / node-drags) and draws instead. Pen strokes update
  // livePathRef imperatively per move (no store write until release, so no
  // per-frame graph clone) and commit as ONE undo entry via addStroke; the
  // eraser removes strokes under the cursor, bracketed into one undo entry.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    let drawing = false;
    let ptrId = -1;
    let erasing = false;
    const pts: number[] = [];
    let lastScreen = { x: 0, y: 0 };

    const isChrome = (t: EventTarget | null) =>
      !!(t as HTMLElement | null)?.closest(
        'input, textarea, select, button, .nodrag, [contenteditable="true"], .react-flow__panel',
      );
    const flow = (e: PointerEvent) => screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const updateLive = () => livePathRef.current?.setAttribute('d', splinePath(strokePointPairs(pts)));

    const eraseAt = (fx: number, fy: number) => {
      const store = useAppStore.getState();
      const rad = 12 / getViewport().zoom; // eraser radius, screen px → flow units
      const hit: string[] = [];
      for (const s of store.drawings) {
        const b = strokeBounds(s.points);
        const pad = rad + s.width / 2;
        if (fx < b.minX - pad || fx > b.maxX + pad || fy < b.minY - pad || fy > b.maxY + pad) continue;
        if (distancePointToSpline(strokePointPairs(s.points), fx, fy) <= pad) hit.push(s.id);
      }
      if (hit.length) store.eraseStrokeIds(hit);
    };

    const onDown = (e: PointerEvent) => {
      const store = useAppStore.getState();
      // Only the primary finger/pen draws — a second finger is a two-finger
      // navigation gesture (handled by the touch-nav effect), never more ink.
      if (!store.drawToolActive || e.button !== 0 || !e.isPrimary || isChrome(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      drawing = true;
      ptrId = e.pointerId;
      erasing = store.drawEraser;
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      lastScreen = { x: e.clientX, y: e.clientY };
      const p = flow(e);
      if (erasing) {
        store.beginInteraction(); // one undo entry for the whole erase gesture
        eraseAt(p.x, p.y);
      } else {
        pts.length = 0;
        pts.push(p.x, p.y);
        updateLive();
      }
    };

    const onMove = (e: PointerEvent) => {
      // Pause the stroke while a second finger navigates (pan/pinch-zoom); it
      // resumes when the nav gesture ends and the primary finger keeps moving.
      if (!drawing || e.pointerId !== ptrId || twoFingerNavRef.current) return;
      const p = flow(e);
      if (erasing) { eraseAt(p.x, p.y); return; }
      // Decimate: drop samples < 2 screen px from the last kept point, and stop
      // at the per-stroke cap.
      const dx = e.clientX - lastScreen.x, dy = e.clientY - lastScreen.y;
      if (dx * dx + dy * dy < 4) return;
      if (pts.length / 2 >= MAX_POINTS_PER_STROKE) return;
      lastScreen = { x: e.clientX, y: e.clientY };
      pts.push(p.x, p.y);
      updateLive();
    };

    const onUp = (e: PointerEvent) => {
      if (!drawing || e.pointerId !== ptrId) return;
      drawing = false;
      ptrId = -1;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      const store = useAppStore.getState();
      if (erasing) {
        store.endInteraction();
        erasing = false;
        return;
      }
      if (pts.length >= 4) {
        store.addStroke({
          id: generateId(),
          color: store.drawColor,
          opacity: quantizeOpacity(store.drawOpacity),
          width: store.drawWidth,
          points: pts.slice(),
        } satisfies DrawStroke);
      }
      // Committed stroke now renders from the store — clear the live path.
      livePathRef.current?.setAttribute('d', '');
      pts.length = 0;
    };

    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [screenToFlowPosition, getViewport]);

  // Two-finger touch navigation: pan (centroid drag) + pinch-zoom, anchored to
  // the pinch centre. On coarse pointers React Flow's own drag-to-pan is OFF
  // (panOnDrag={false}) so ONE finger is free to drag nodes/edges and marquee
  // select — but that same flag also disables React Flow's native touch
  // pan/zoom, so we re-create the two-finger gesture here (same capture-phase
  // pattern as the draw + double-tap-pan handlers). We stopImmediatePropagation
  // so a second finger cleanly takes over from any in-progress one-finger node
  // drag (its touchmoves never reach React Flow's d3-drag). One-finger touches
  // (touches.length !== 2) are ignored and flow straight through to React Flow.
  // Not attached on a mouse — desktop is untouched.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !isCoarsePointer) return;

    let active = false;
    let d0 = 1;      // initial pinch distance
    let cx0 = 0, cy0 = 0;        // initial centroid (client)
    let z0 = 1, vpx0 = 0, vpy0 = 0;   // viewport at gesture start
    let fx = 0, fy = 0;          // flow point under the initial centroid
    const clampZ = (z: number) => Math.min(3, Math.max(0.1, z));
    const centroid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      active = true;
      twoFingerNavRef.current = true;
      // The first pinch finger may have landed on a socket (its pointerdown
      // fired before this touchstart could be intercepted) — dismiss the
      // tooltip it popped now that the gesture is known to be navigation.
      clearSocketTapTooltip();
      const c = centroid(e.touches);
      cx0 = c.x; cy0 = c.y;
      d0 = spread(e.touches) || 1;
      const vp = getViewport();
      z0 = vp.zoom; vpx0 = vp.x; vpy0 = vp.y;
      const f = screenToFlowPosition({ x: cx0, y: cy0 });
      fx = f.x; fy = f.y;
    };

    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length < 2) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const c = centroid(e.touches);
      const z = clampZ(z0 * (spread(e.touches) / d0));
      // screen = flow*zoom + viewport (+ container origin). Holding the flow
      // point (fx,fy) under the moving centroid gives pan+zoom without needing
      // the container origin: vp = vp0 + (centreΔ) + flowPt*(z0 − z).
      setViewport({
        x: vpx0 + (c.x - cx0) + fx * (z0 - z),
        y: vpy0 + (c.y - cy0) + fy * (z0 - z),
        zoom: z,
      });
    };

    const onEnd = (e: TouchEvent) => {
      if (!active) return;
      if (e.touches.length < 2) {
        active = false;
        twoFingerNavRef.current = false;
      }
    };

    el.addEventListener('touchstart', onStart, { capture: true, passive: false });
    el.addEventListener('touchmove', onMove, { capture: true, passive: false });
    el.addEventListener('touchend', onEnd, { capture: true });
    el.addEventListener('touchcancel', onEnd, { capture: true });
    return () => {
      el.removeEventListener('touchstart', onStart, { capture: true } as EventListenerOptions);
      el.removeEventListener('touchmove', onMove, { capture: true } as EventListenerOptions);
      el.removeEventListener('touchend', onEnd, { capture: true } as EventListenerOptions);
      el.removeEventListener('touchcancel', onEnd, { capture: true } as EventListenerOptions);
    };
  }, [isCoarsePointer, getViewport, setViewport, screenToFlowPosition]);

  // The import one-liner clears itself. Keyed on the note's id so a second
  // drop restarts the clock instead of inheriting the first one's timer, and
  // the guard means a note dismissed by hand can't be cleared twice.
  useEffect(() => {
    if (!importNote) return;
    const id = importNote.id;
    const timer = window.setTimeout(() => {
      setImportNote((n) => (n?.id === id ? null : n));
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [importNote]);

  // Frame the graph an import just dropped in. An import replaces the nodes but
  // NOT the viewport, so a shader dropped onto a panned/zoomed canvas lands
  // off-screen and reads as a failed import — the same problem the New button
  // solves for its lone Output node.
  //
  // The fit can't run on the event itself. A project block writes its nodes in
  // the same tick the event fires (React hasn't rendered them yet), and a bare
  // script has no graph at all until useSyncEngine's code→graph pass finishes a
  // commit or two later. So the event ARMS a fit and the effect below fires it
  // on the next graph the editor actually renders, with the double-rAF
  // measurement guard startNewShader uses: fitView frames the MEASURED box, and
  // unmeasured nodes fit as zero-size points at maxZoom.
  const importFitArmedRef = useRef(false);
  const importFitTimerRef = useRef(0);
  const importFitRafRef = useRef(0);
  useEffect(() => {
    const arm = () => {
      importFitArmedRef.current = true;
      window.clearTimeout(importFitTimerRef.current);
      importFitTimerRef.current = window.setTimeout(() => {
        importFitArmedRef.current = false;
      }, IMPORT_FIT_TIMEOUT_MS);
    };
    window.addEventListener('fs:graph-imported', arm);
    // `newGraph()` is the same "nodes replaced, viewport not" case and fires its
    // OWN event, so it needs arming here too. The toolbar's NEW button has
    // always framed the fresh document itself (startNewShader schedules its own
    // fit, which is why this listener was originally only for imports) — but
    // that is the BUTTON's path, and EvalGate's `cleanSlateForStudy` calls
    // `newGraph()` on the store directly. Nothing framed the blank document
    // there; it merely happened to stay on screen because the boot fit had run
    // over the previous graph, whose box contains the flow origin the new
    // Output sits at. Remembering the viewport removed that accident, so a
    // study session could open on the PREVIOUS participant's pan with the
    // blank document metres off-screen. The two events stay distinct — the
    // Work folder's `fs:graph-new` tracking is untouched — and arming twice on
    // the NEW button is two fits to the same box, i.e. free.
    window.addEventListener('fs:graph-new', arm);
    return () => {
      window.removeEventListener('fs:graph-imported', arm);
      window.removeEventListener('fs:graph-new', arm);
      window.clearTimeout(importFitTimerRef.current);
      cancelAnimationFrame(importFitRafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!importFitArmedRef.current) return;
    importFitArmedRef.current = false;
    window.clearTimeout(importFitTimerRef.current);
    // The pending frames are held in a ref and torn down only on unmount, NOT
    // by this effect's cleanup: the cost pass writes the Output node's new
    // total straight back into `nodes`, so an imported graph re-renders once
    // more inside the two-frame window — a cleanup-owned rAF would be
    // cancelled by exactly the change that proves the import landed.
    importFitRafRef.current = requestAnimationFrame(() => {
      importFitRafRef.current = requestAnimationFrame(() => fitView(FIT_VIEW_OPTIONS));
    });
  }, [nodes, fitView]);

  // NEW: optionally export the current shader, then reset the graph to a bare
  // Output node (one undo entry) and frame it. The export runs FIRST — it
  // reads the store imperatively at call time, so it must see the old graph.
  const startNewShader = useCallback(
    (save: boolean) => {
      setNewShaderOpen(false);
      if (save) downloadShader();
      useAppStore.getState().newGraph();
      // The viewport is unchanged by the reset, so the lone Output node at the
      // origin can land off-screen. Two frames, like the tile-drop snap: the
      // first lets React commit the node, the second lets React Flow measure
      // it — fitView frames the MEASURED box, and an unmeasured node would be
      // fitted as a zero-size point at maxZoom.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => fitView(FIT_VIEW_OPTIONS)),
      );
    },
    [fitView],
  );

  return (
    <div className="node-editor" style={canvasCssVars}>
      <div
        className={`node-editor__canvas${drawToolActive ? ' fs-draw-active' : ''}${drawToolActive && drawEraser ? ' fs-erase-active' : ''}${connecting ? ' fs-connecting' : ''}`}
        ref={canvasRef}
        // HTML5 drag wandering off the canvas (into the code editor / assets
        // bar) must tear down the live previews — dragover stops firing here,
        // so nothing else would. relatedTarget is the element being entered;
        // moves between the canvas's own children are not a leave. Safari
        // leaves relatedTarget null on dragleave (WebKit bug 66547, fixed
        // only in 2026 builds), so fall back to coordinates there — a leave
        // fired inside the canvas rect is a child-boundary crossing, and
        // clearing on it would flicker the preview every crossing.
        onDragLeave={(e) => {
          const rt = e.relatedTarget as Node | null;
          if (rt && e.currentTarget.contains(rt)) return;
          if (!rt) {
            const r = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX > r.left && e.clientX < r.right &&
              e.clientY > r.top && e.clientY < r.bottom
            ) return;
          }
          clearConnectPreview();
          clearEdgeHighlight();
        }}
      >
        <div className="node-editor__cost-overlay">
          {/* The study's cost-feedback condition can hide the bar entirely
              (`?costbar=off` on the /eval launch URL). Outside eval mode the
              task defaults to visible, so this is inert for normal users. */}
          {evalTask().costBarVisible && <CostBar onFocusOutput={hasOutput ? focusOutput : undefined} />}
        </div>
        {/* Top-RIGHT chrome, immediately left of the cost pill: start a fresh
            shader. Kept well away from the bottom-left working bar — it throws
            the whole document away (undoably, and after a save offer). */}
        <button
          type="button"
          className="node-editor__new-btn"
          onClick={() => setNewShaderOpen(true)}
          title={t('Start a new shader — offers to export the current one first; can be undone with Ctrl+Z / ⌘Z', language)}
        >
          {t('New', language)}
        </button>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={onSelectionDragStop}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onSelectionContextMenu={onSelectionContextMenu}
          onPaneClick={closeContextMenu}
          onReconnectStart={onReconnectStart}
          onReconnect={onReconnect}
          onReconnectEnd={onReconnectEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          deleteKeyCode={null}
          // React Flow makes every EDGE a tab stop by default, so a graph of N
          // nodes and E edges had N+E stops before the asset bar's dozens — Tab
          // was unusable as a way of reaching a node. Nodes stay focusable;
          // edges are reached from the node they touch.
          edgesFocusable={false}
          panActivationKeyCode={null}
          edgesReconnectable
          connectionRadius={CONNECTION_RADIUS}
          // Draw mode owns the left-drag gesture: turn React Flow's rubber-band
          // selection, node dragging, and element selection OFF while drawing,
          // so a stroke never also starts (and strands) a selection box. The
          // draw-capture handler still swallows the pointerdown; these props are
          // the declarative belt-and-suspenders that actually keep RF idle.
          // Also OFF on coarse pointers. With panOnDrag={false} on touch, the
          // FIRST finger of a two-finger pan lands on the pane; React Flow then
          // starts a marquee (pointer-driven) before the second finger arrives,
          // and a touchstart can't retroactively cancel that pointer selection —
          // so an empty-canvas two-finger pan came out as a selection box. (Over
          // a node the first finger starts a node-drag instead, which is why the
          // two-finger nav only worked over nodes.) Dropping selectionOnDrag on
          // touch leaves the two-finger nav effect unopposed. Rubber-band
          // marquee-select stays a mouse-only affordance; tap still selects.
          selectionOnDrag={!drawToolActive && !isCoarsePointer}
          nodesDraggable={!drawToolActive}
          elementsSelectable={!drawToolActive}
          selectionMode={SelectionMode.Partial}
          // Shift+click adds to the selection (Cmd/Ctrl still do too).
          multiSelectionKeyCode={MULTI_SELECT_KEYS}
          // Shift MUST be released from its DEFAULT job (hold-to-marquee) for
          // the line above to work at all: while selectionKeyCode is held, the
          // Pane's onPointerDownCapture stopPropagation()s a pointerdown that
          // landed on a NODE and opens a rubber band instead — so Shift+click
          // would start a marquee rather than extend the selection.
          // Nothing is lost: selectionOnDrag already gives a modifier-free
          // marquee by left-dragging empty canvas, and `isSelecting` reads
          // `selectionKeyPressed || userSelectionActive || selectionOnDrag`.
          selectionKeyCode={null}
          // Desktop (mouse): pan with middle/right button, left is free for
          // select/move. Touch/pen (coarse): turn drag-to-pan OFF so ONE finger
          // drags nodes/edges; TWO fingers pan + pinch-zoom via the touch-nav
          // effect above.
          panOnDrag={isCoarsePointer ? false : DESKTOP_PAN_ON_DRAG}
          zoomOnScroll
          // Double-click is reserved for edge routing waypoints (add on an edge,
          // remove on a point). React Flow attaches onEdgeDoubleClick as a plain
          // synthetic handler, so it CANNOT stopPropagation the pane's native
          // d3 `dblclick.zoom` (which fires first, at an ancestor) — leaving it
          // on would zoom the canvas every time a waypoint is placed/removed.
          zoomOnDoubleClick={false}
          // Fit only when there is nothing remembered. A stored viewport means
          // the user left the canvas somewhere deliberate and the graph it was
          // measured against is still on disk (utils/viewportMemory.ts); fitting
          // over it would throw that away on every reload. Both props apply on
          // the first render only, so this reads once and never flips.
          fitView={bootViewport == null}
          defaultViewport={bootViewport ?? undefined}
          // Without a cap, fitView blows a small graph (the first-open demo)
          // up to maxZoom=3 — nodes fill the screen. 1.5 opens the canvas 2x
          // further out; larger graphs that fit below 1.5 are unaffected, and
          // manual zoom can still reach 3.
          fitViewOptions={FIT_VIEW_OPTIONS}
          onError={onFlowError}
          // Pan/zoom brackets the iframe suppression; the matching release
          // lives in `rememberViewport`, which is this gesture's own end.
          onMoveStart={onMoveStartBusy}
          onMoveEnd={rememberViewport}
          minZoom={VIEWPORT_MIN_ZOOM}
          maxZoom={VIEWPORT_MAX_ZOOM}
          proOptions={PRO_OPTIONS}
          style={{ background: nodeEditorBgColor }}
        >
          <Background
            variant={BackgroundVariant.Cross}
            gap={20}
            size={1}
            color={gridColor}
          />
          {/* Symbolic Output→preview wire. Sits at z-index -1 (behind node
              cards, above the canvas bg) and is clipped by the pane, so it
              tucks behind the code/preview frames. */}
          <PreviewLink />
          <DrawingLayer livePathRef={livePathRef} />
          {/* Bottom-LEFT canvas bar: undo/redo + draw tools + view controls
              in one pill (replaces the old toolbar history group, the RF
              Controls stack, and the top-center draw toolbar). */}
          <Panel position="bottom-left" className="fs-canvas-bar nodrag nowheel">
            {/* One bordered segment holding both, split by a hairline — and
                solid-filled curved arrows rather than the ↶/↷ text glyphs,
                which rendered thin and weightless next to the other controls.
                Inline SVG, not an icon font: the app self-hosts a woff2 SUBSET
                of Inter and must run offline. */}
            <div className="fs-canvas-bar__group fs-canvas-bar__group--history">
              <button
                type="button"
                className="fs-canvas-bar__btn fs-canvas-bar__btn--history"
                onClick={() => useAppStore.getState().undo()}
                disabled={!canUndo}
                title={t('Undo (Ctrl+Z / ⌘Z)', language)}
                aria-label={t('Undo', language)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
                </svg>
              </button>
              <button
                type="button"
                className="fs-canvas-bar__btn fs-canvas-bar__btn--history"
                onClick={() => useAppStore.getState().redo()}
                disabled={!canRedo}
                title={t('Redo (Ctrl+Shift+Z / ⇧⌘Z)', language)}
                aria-label={t('Redo', language)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z" />
                </svg>
              </button>
            </div>
            <div className="fs-canvas-bar__group">
              <DrawToolbar />
            </div>
            <div className="fs-canvas-bar__group">
              <button
                type="button"
                className="fs-canvas-bar__btn"
                onClick={() => zoomOut()}
                disabled={minZoomReached}
                title={t('Zoom out', language)}
                aria-label={t('Zoom out', language)}
              >
                −
              </button>
              <button
                type="button"
                className="fs-canvas-bar__btn"
                onClick={() => zoomIn()}
                disabled={maxZoomReached}
                title={t('Zoom in', language)}
                aria-label={t('Zoom in', language)}
              >
                +
              </button>
              <button
                type="button"
                className="fs-canvas-bar__btn"
                onClick={() => fitView()}
                title={t('Fit view', language)}
                aria-label={t('Fit view', language)}
              >
                ⤢
              </button>
              <button
                ref={bgBtnRef}
                type="button"
                className="fs-canvas-bar__btn node-editor__bg-color-btn"
                title={t('Canvas background color', language)}
                aria-label={t('Canvas background color', language)}
                onClick={() => setBgPickerOpen((o) => !o)}
              >
                <span
                  className="node-editor__bg-color-swatch"
                  style={{ background: nodeEditorBgColor }}
                />
              </button>
              {/* `history="none"`: the canvas backdrop is a PREFERENCE —
                  `setNodeEditorBgColor` writes localStorage (per theme) and the
                  store, never pushHistory — so bracketing would push an undo
                  entry that restores nothing and clear the redo stack. */}
              <ColorPickerPopover
                anchor={bgBtnRef.current}
                open={bgPickerOpen}
                onClose={closeBgPicker}
                value={nodeEditorBgColor}
                onPick={setNodeEditorBgColor}
                history="none"
              />
            </div>
          </Panel>
        </ReactFlow>

        {/* In-flight image imports. Fixed-positioned at the drop point and
            pointer-events:none, so they never intercept a drag; the pulse is
            a compositor-only transform/opacity animation, which keeps running
            while the encoder blocks the main thread. */}
        {importGhosts.map((g) => (
          <div
            key={g.id}
            className="node-editor__import-ghost"
            style={{ left: g.x, top: g.y }}
            aria-hidden="true"
          >
            <span className="node-editor__import-ghost-dot" />
            {t('Importing image…', language)}
          </div>
        ))}

        {/* Import one-liner: what happened, a "?" for why, and a dismiss.
            Top-centre — the only free edge of the canvas (NEW is top-left,
            the cost pill top-right, the tool bar bottom-left). */}
        {importNote && (
          <div className="node-editor__import-note" role="status">
            <span>
              {(importNote.reason === 'preference'
                ? t('Not optimized (set to “Never”) — stored as {fmt}', language)
                : t('Not optimized — stored as {fmt}', language)
              ).replace('{fmt}', () => importNote.storedAs)}
            </span>
            <button
              type="button"
              className="node-editor__import-note-btn"
              onClick={() => setConvertInfoOpen(true)}
              title={t('Why?', language)}
              aria-label={t('Why?', language)}
            >
              ?
            </button>
            <button
              type="button"
              className="node-editor__import-note-btn"
              onClick={() => setImportNote(null)}
              title={t('Dismiss', language)}
              aria-label={t('Dismiss', language)}
            >
              ✕
            </button>
          </div>
        )}
        <ImageConvertInfoModal open={convertInfoOpen} onClose={() => setConvertInfoOpen(false)} />

        {contextMenu.open && <ContextMenu />}
        <ImageImportModal request={convertAsk} onResolve={resolveConvertAsk} />
        <NewShaderModal
          open={newShaderOpen}
          onCancel={() => setNewShaderOpen(false)}
          onConfirm={startNewShader}
        />
      </div>
      <ContentBrowser />
    </div>
  );
}
