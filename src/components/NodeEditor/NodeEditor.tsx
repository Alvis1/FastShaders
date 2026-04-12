import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  reconnectEdge,
  useReactFlow,
  type OnConnect,
  type Connection,
  type Edge,
  BackgroundVariant,
  SelectionMode,
} from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { ShaderNode } from './nodes/ShaderNode';
import { ColorNode } from './nodes/ColorNode';
import { PreviewNode } from './nodes/PreviewNode';
import { MathPreviewNode } from './nodes/MathPreviewNode';
import { OutputNode } from './nodes/OutputNode';
import { ClockNode } from './nodes/ClockNode';
import { GroupNode } from './nodes/GroupNode';
import { TypedEdge } from './edges/TypedEdge';
import { ContextMenu } from './menus/ContextMenu';
import { ContentBrowser } from './ContentBrowser';
import { SAVED_GROUP_DRAG_TYPE } from './SavedGroupCard';
import { CostBar } from '@/components/Layout/CostBar';
import { getCostColor, getContrastColor } from '@/utils/colorUtils';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import { isEdgeDisconnecting, setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import type { AppNode, AppEdge, ShaderNodeData, OutputNodeData } from '@/types';
import { getNodeValues } from '@/types';
import complexityData from '@/registry/complexity.json';
import './NodeEditor.css';

const nodeTypes = {
  shader: ShaderNode,
  color: ColorNode,
  preview: PreviewNode,
  mathPreview: MathPreviewNode,
  clock: ClockNode,
  output: OutputNode,
  group: GroupNode,
};

const edgeTypes = {
  typed: TypedEdge,
};

/** Snap radius for edge drag-to-connect AND drop-on-edge insertion. */
const CONNECTION_RADIUS = 40;
/** Pixels of movement before a node drag is considered "real" (and worth pushing history). */
const DRAG_HISTORY_THRESHOLD = 2;

/** Minimum distance from point (cx,cy) to a cubic bezier with given source, target, and control-point offset. */
function bezierDist(
  sx: number, sy: number, tx: number, ty: number, cp: number,
  cx: number, cy: number,
): number {
  let min = Infinity;
  for (let t = 0; t <= 1; t += 0.05) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;
    const bx = mt3 * sx + 3 * mt2 * t * (sx + cp) + 3 * mt * t2 * (tx - cp) + t3 * tx;
    const by = mt3 * sy + 3 * mt2 * t * sy + 3 * mt * t2 * ty + t3 * ty;
    const d = Math.hypot(bx - cx, by - cy);
    if (d < min) min = d;
  }
  return min;
}

type Measured = AppNode & { measured?: { width?: number; height?: number } };
function getNodeSize(n: AppNode) {
  return {
    w: (n as Measured).measured?.width ?? 120,
    h: (n as Measured).measured?.height ?? 40,
  };
}

/**
 * Find the closest edge to (cx, cy) in flow-space that is within CONNECTION_RADIUS.
 * `excludeNodeId` skips edges connected to the node being dragged.
 */
function findNearestEdge(
  cx: number, cy: number,
  allNodes: AppNode[], allEdges: AppEdge[],
  excludeNodeId?: string,
): string | null {
  let bestId: string | null = null;
  let bestDist = CONNECTION_RADIUS;

  for (const edge of allEdges) {
    if (excludeNodeId && (edge.source === excludeNodeId || edge.target === excludeNodeId)) continue;
    const srcNode = allNodes.find((n) => n.id === edge.source);
    const tgtNode = allNodes.find((n) => n.id === edge.target);
    if (!srcNode || !tgtNode) continue;

    const { w: sw, h: sh } = getNodeSize(srcNode);
    const { h: th } = getNodeSize(tgtNode);
    const sx = srcNode.position.x + sw;
    const sy = srcNode.position.y + sh / 2;
    const tx = tgtNode.position.x;
    const ty = tgtNode.position.y + th / 2;
    const cp = Math.max(Math.abs(tx - sx) * 0.5, 50);

    const d = bezierDist(sx, sy, tx, ty, cp, cx, cy);
    if (d < bestDist) {
      bestDist = d;
      bestId = edge.id;
    }
  }
  return bestId;
}

/**
 * Try to insert `nodeId` (with registry def `def`) onto the nearest edge at
 * flow-space center (cx, cy). Returns true if an insertion was made.
 */
function tryInsertOnEdge(
  nodeId: string,
  def: { inputs: { id: string }[]; outputs: { id: string }[] },
  cx: number, cy: number,
): boolean {
  const store = useAppStore.getState();
  const edgeId = findNearestEdge(cx, cy, store.nodes, store.edges, nodeId);
  if (!edgeId) return false;
  const edge = store.edges.find((e) => e.id === edgeId);
  if (!edge) return false;

  const inputPort = def.inputs[0];
  const outputPort = def.outputs[0];

  const newEdge1: AppEdge = {
    id: generateEdgeId(edge.source, edge.sourceHandle ?? 'out', nodeId, inputPort.id),
    source: edge.source,
    target: nodeId,
    sourceHandle: edge.sourceHandle,
    targetHandle: inputPort.id,
    type: 'typed',
    animated: true,
    data: { dataType: 'any' },
  };

  const newEdge2: AppEdge = {
    id: generateEdgeId(nodeId, outputPort.id, edge.target, edge.targetHandle ?? 'in'),
    source: nodeId,
    target: edge.target,
    sourceHandle: outputPort.id,
    targetHandle: edge.targetHandle,
    type: 'typed',
    animated: true,
    data: { dataType: 'any' },
  };

  store.setEdges(
    store.edges.filter((e) => e.id !== edge.id).concat(newEdge1, newEdge2) as AppEdge[],
  );
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
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const nodeEditorBgColor = useAppStore((s) => s.nodeEditorBgColor);
  const setNodeEditorBgColor = useAppStore((s) => s.setNodeEditorBgColor);
  const { screenToFlowPosition } = useReactFlow();

  // Copy/paste clipboard
  const clipboardRef = useRef<AppNode[]>([]);

  useEffect(() => {
    /** Clone nodes + their internal edges, deselect originals, select clones. */
    function pasteNodes(sourceNodes: AppNode[]) {
      const store = useAppStore.getState();
      const idMap = new Map<string, string>();

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

      const mod = e.metaKey || e.ctrlKey;

      // Ctrl+C — copy selected nodes
      if (mod && e.key === 'c') {
        const selected = useAppStore.getState().nodes.filter((n) => n.selected);
        if (selected.length > 0) {
          clipboardRef.current = structuredClone(selected);
        }
      }

      // Ctrl+V — paste copied nodes
      if (mod && e.key === 'v') {
        if (clipboardRef.current.length === 0) return;
        e.preventDefault();
        const clones = pasteNodes(clipboardRef.current);
        // Shift clipboard for cascading pastes
        clipboardRef.current = clones.map((n) => structuredClone(n));
      }

      // Ctrl+G — group selected nodes (Ctrl+Shift+G ungroups the selected group)
      if (mod && e.key.toLowerCase() === 'g') {
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
      if (mod && e.key === 'd') {
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
        store.pushHistory();

        // Deleting a group should dissolve it, not orphan its children with a
        // dangling parentId. Lift them out first, then proceed with the normal
        // deletion path so the rest of the selection is removed too.
        const deletedGroups = selectedNodes.filter((n) => n.type === 'group');
        if (deletedGroups.length > 0) {
          for (const g of deletedGroups) store.ungroup(g.id);
          // ungroup() pushed history; treat the rest as a single follow-up.
        }

        // Re-read nodes since ungroup may have mutated them.
        const currentNodes = useAppStore.getState().nodes;
        if (selectedNodeIds.size > 0) {
          store.setNodes(currentNodes.filter((n) => !selectedNodeIds.has(n.id)) as AppNode[]);
        }
        store.setEdges(
          store.edges.filter(
            (edge) =>
              !selectedEdgeIds.has(edge.id) &&
              !selectedNodeIds.has(edge.source) &&
              !selectedNodeIds.has(edge.target),
          ) as AppEdge[],
        );
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
    dragStartPosRef.current = { x: node.position.x, y: node.position.y };
  }, []);

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

  // Highlight the nearest edge when dragging a node close to it (drop-on-edge preview).
  const onNodeDrag = useCallback(
    (_event: React.MouseEvent, draggedNode: AppNode) => {
      if (draggedNode.type === 'group') return;
      const def = NODE_REGISTRY.get(draggedNode.data.registryType);
      if (!def || def.inputs.length === 0 || def.outputs.length === 0) {
        clearEdgeHighlight();
        return;
      }

      const store = useAppStore.getState();
      const { w: nw, h: nh } = getNodeSize(draggedNode);
      const cx = draggedNode.position.x + nw / 2;
      const cy = draggedNode.position.y + nh / 2;

      updateEdgeHighlight(findNearestEdge(cx, cy, store.nodes, store.edges, draggedNode.id));
    },
    [clearEdgeHighlight, updateEdgeHighlight],
  );

  // Drop-on-edge: insert dragged node between source and target
  // + Anti-overlap: nudge dropped node so it doesn't sit on top of another
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: AppNode) => {
      const store = useAppStore.getState();
      const allNodes = store.nodes;

      clearEdgeHighlight();

      // Group nodes are pure containers — they should never trigger drop-on-edge,
      // never anti-overlap-nudge, and never push history beyond what React Flow
      // already does for the position change.
      if (draggedNode.type === 'group') {
        dragStartPosRef.current = null;
        return;
      }

      // Skip work entirely if the node didn't actually move (click without drag).
      const startPos = dragStartPosRef.current;
      dragStartPosRef.current = null;
      if (startPos) {
        const moved = Math.hypot(
          draggedNode.position.x - startPos.x,
          draggedNode.position.y - startPos.y,
        );
        if (moved < DRAG_HISTORY_THRESHOLD) return;
      }

      const { w: nw, h: nh } = getNodeSize(draggedNode);
      const cx = draggedNode.position.x + nw / 2;
      const cy = draggedNode.position.y + nh / 2;

      // History snapshot covers BOTH the position change and any drop-on-edge insertion.
      // Pushed once here (not in onNodeDragStart) so click-only events don't add no-op entries.
      store.pushHistory();

      // --- Drop-on-edge insertion ---
      const def = NODE_REGISTRY.get(draggedNode.data.registryType);
      if (def && def.inputs.length > 0 && def.outputs.length > 0) {
        tryInsertOnEdge(draggedNode.id, def, cx, cy);
      }

      // --- Anti-overlap: nudge node if it sits on top of another ---
      const GAP = 10;
      let posX = draggedNode.position.x;
      let posY = draggedNode.position.y;
      let nudged = false;

      for (const other of allNodes) {
        if (other.id === draggedNode.id) continue;
        // Group containers must not push their members aside.
        if (other.type === 'group') continue;
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

      // --- Group attachment: if the dragged node lands inside a group's
      // bounds, attach it; if it lands outside its current parent, detach it.
      // React Flow doesn't reparent on its own, so this is the only place that
      // mutates parentId based on drag.
      const absolutePos = (node: AppNode): { x: number; y: number } => {
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
      };
      const groupSize = (g: AppNode) => {
        const sz = g as AppNode & { width?: number; height?: number };
        const dataSz = g.data as { width?: number; height?: number };
        return { w: sz.width ?? dataSz.width ?? 200, h: sz.height ?? dataSz.height ?? 120 };
      };

      // Translate the post-nudge LOCAL position into absolute coords by adding
      // the (post-nudge − pre-drag) delta to the pre-drag absolute.
      const finalPosX = nudged ? posX : draggedNode.position.x;
      const finalPosY = nudged ? posY : draggedNode.position.y;
      const startAbs = absolutePos(draggedNode);
      const draggedAbsX = startAbs.x + (finalPosX - draggedNode.position.x);
      const draggedAbsY = startAbs.y + (finalPosY - draggedNode.position.y);
      const draggedCx = draggedAbsX + nw / 2;
      const draggedCy = draggedAbsY + nh / 2;

      // Find a non-collapsed group whose absolute bounds contain the dragged
      // center. Collapsed groups (compact pills) must not slurp up unrelated
      // nodes that happen to overlap their footprint.
      let targetGroupId: string | undefined;
      let targetGroupAbsX = 0;
      let targetGroupAbsY = 0;
      for (const other of allNodes) {
        if (other.type !== 'group' || other.id === draggedNode.id) continue;
        if ((other.data as { collapsed?: boolean }).collapsed) continue;
        const oAbs = absolutePos(other);
        const { w: ow, h: oh } = groupSize(other);
        if (draggedCx >= oAbs.x && draggedCx <= oAbs.x + ow &&
            draggedCy >= oAbs.y && draggedCy <= oAbs.y + oh) {
          targetGroupId = other.id;
          targetGroupAbsX = oAbs.x;
          targetGroupAbsY = oAbs.y;
          break;
        }
      }

      const parentChanged = targetGroupId !== draggedNode.parentId;
      if (!nudged && !parentChanged) return;

      // New local coords = absolute − new-parent absolute. With no new parent
      // (top-level), the fallback `0` collapses to `local = absolute`. In the
      // same-parent case the loop above resolves the current parent and this
      // expression simplifies algebraically to `finalPosX/Y` — no special case.
      const newLocalX = Math.round(draggedAbsX - targetGroupAbsX);
      const newLocalY = Math.round(draggedAbsY - targetGroupAbsY);

      const updated: AppNode[] = allNodes.map((n) => {
        if (n.id !== draggedNode.id) return n;
        // Strip extent + parentId then rebuild from scratch. We never reattach
        // `extent: 'parent'` — that constraint is what would prevent users
        // from dragging children back out of the group.
        const { extent: _extent, parentId: _pid, ...rest } = n as AppNode & { extent?: unknown; parentId?: string };
        void _extent; void _pid;
        return {
          ...rest,
          ...(targetGroupId ? { parentId: targetGroupId } : {}),
          position: { x: newLocalX, y: newLocalY },
        } as AppNode;
      }) as AppNode[];

      // React Flow requires the parent to come BEFORE its children in the array.
      if (parentChanged && targetGroupId) {
        const draggedIdx = updated.findIndex((n) => n.id === draggedNode.id);
        const groupIdx = updated.findIndex((n) => n.id === targetGroupId);
        if (draggedIdx >= 0 && groupIdx >= 0 && draggedIdx < groupIdx) {
          const [draggedItem] = updated.splice(draggedIdx, 1);
          updated.splice(groupIdx, 0, draggedItem);
        }
      }

      store.setNodes(updated);
    },
    [clearEdgeHighlight],
  );

  // Track whether a connection attempt succeeded; if not, open add-node menu
  const connectSucceeded = useRef(false);
  const pendingSourceRef = useRef<{ nodeId: string; handleId: string } | null>(null);

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: { nodeId: string | null; handleId: string | null; handleType: string | null }) => {
      connectSucceeded.current = false;
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
    (event: MouseEvent | TouchEvent) => {
      if (connectSucceeded.current) {
        pendingSourceRef.current = null;
        return;
      }
      // If this connection was initiated from an edge disconnect, don't open the menu
      if (isEdgeDisconnecting) {
        setEdgeDisconnecting(false);
        pendingSourceRef.current = null;
        return;
      }
      // Connection dropped on empty space — open add-node menu with source pin info
      const clientX = 'clientX' in event ? event.clientX : event.changedTouches[0].clientX;
      const clientY = 'clientY' in event ? event.clientY : event.changedTouches[0].clientY;
      const pending = pendingSourceRef.current;
      openContextMenu(clientX, clientY, 'canvas', undefined, undefined, pending?.nodeId, pending?.handleId);
      pendingSourceRef.current = null;
    },
    [openContextMenu],
  );

  // Track whether a reconnect was successful (dropped on a valid handle)
  const reconnectSuccessful = useRef(false);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      connectSucceeded.current = true;
      useAppStore.getState().pushHistory();
      // Read fresh edges from store to avoid stale closure
      const currentEdges = useAppStore.getState().edges;

      // Enforce single-input: remove any existing edge to the same target handle
      const filtered = currentEdges.filter(
        (e) =>
          !(e.target === connection.target && e.targetHandle === connection.targetHandle),
      );

      const newEdge: AppEdge = {
        id: generateEdgeId(
          connection.source,
          connection.sourceHandle ?? 'out',
          connection.target,
          connection.targetHandle ?? 'in',
        ),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: 'typed',
        animated: true,
        data: { dataType: 'any' },
      };
      setEdges(addEdge(newEdge, filtered) as AppEdge[]);
    },
    [setEdges],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, 'canvas');
    },
    [openContextMenu]
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: AppNode) => {
      event.preventDefault();
      const menuType =
        node.type === 'group'
          ? 'group'
          : node.data.registryType === 'output'
            ? 'shader'
            : 'node';
      openContextMenu(event.clientX, event.clientY, menuType, node.id);
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
    useAppStore.getState().pushHistory();
  }, []);

  // Drag-to-delete: handle successful reconnect
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      reconnectSuccessful.current = true;
      const currentEdges = useAppStore.getState().edges;
      setEdges(reconnectEdge(oldEdge, newConnection, currentEdges) as AppEdge[]);
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
    },
    [removeEdge]
  );

  // Content browser drag-and-drop: allow drop on canvas
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    // Highlight the nearest edge for drop-on-edge insertion preview (asset browser drags).
    const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const store = useAppStore.getState();
    updateEdgeHighlight(findNearestEdge(pos.x, pos.y, store.nodes, store.edges));
  }, [screenToFlowPosition, updateEdgeHighlight]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      clearEdgeHighlight();

      // Saved-group drag payload takes precedence over a regular node-type drag
      // (the two payloads can't both be set at once but we check this one first
      // so the regular path doesn't accidentally swallow it).
      const savedGroupId = event.dataTransfer.getData(SAVED_GROUP_DRAG_TYPE);
      if (savedGroupId) {
        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        useAppStore.getState().instantiateSavedGroup(savedGroupId, position);
        return;
      }

      const nodeType = event.dataTransfer.getData('application/reactflow-type');
      if (!nodeType) return;

      const def = NODE_REGISTRY.get(nodeType);
      if (!def) return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const costs = complexityData.costs as Record<string, number>;
      const cost = costs[def.type] ?? 0;

      // Read from store directly — `nodes` from the closure may be stale if the
      // user added a node between render and drop (e.g. via context menu).
      const currentNodes = useAppStore.getState().nodes;

      let newNodeId: string | undefined;

      if (def.type === 'output') {
        if (currentNodes.some((n) => n.data.registryType === 'output')) return;
        const newNode: AppNode = {
          id: generateId(),
          type: 'output',
          position,
          data: { registryType: 'output', label: 'Output', cost: 0 } as OutputNodeData,
        };
        addNode(newNode);
        newNodeId = newNode.id;
      } else {
        let values = { ...def.defaultValues };
        if (def.type === 'property_float') {
          let maxNum = 0;
          for (const n of currentNodes) {
            if (n.data.registryType !== 'property_float') continue;
            const name = String(getNodeValues(n)?.name ?? '');
            const m = name.match(/^property(\d+)$/);
            if (m) maxNum = Math.max(maxNum, Number(m[1]));
          }
          values = { ...values, name: `property${maxNum + 1}` };
        }
        const newNode = {
          id: generateId(),
          type: getFlowNodeType(def),
          position,
          data: { registryType: def.type, label: def.label, cost, values } as ShaderNodeData,
        } as AppNode;
        addNode(newNode);
        newNodeId = newNode.id;
      }

      // Drop-on-edge: if the new node landed on an edge, insert it inline.
      if (newNodeId && def.inputs.length > 0 && def.outputs.length > 0) {
        tryInsertOnEdge(newNodeId, def, position.x, position.y);
      }
    },
    [screenToFlowPosition, addNode, clearEdgeHighlight],
  );

  // Pick a contrast color for the canvas-scoped badge text + 1-channel edges
  // (black on light bg, white on dark bg). Same value drives both, so they
  // always flip together when the user picks a new background.
  const contrastColor = getContrastColor(nodeEditorBgColor);
  const contrastShadow = contrastColor === '#000000'
    ? 'rgba(255, 255, 255, 0.65)'
    : 'rgba(0, 0, 0, 0.65)';
  const canvasCssVars = {
    '--node-cost-text': contrastColor,
    '--node-cost-text-shadow': contrastShadow,
    '--canvas-bg': nodeEditorBgColor,
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

  return (
    <div className="node-editor" style={canvasCssVars}>
      <div className="node-editor__canvas" ref={canvasRef}>
        <div className="node-editor__cost-overlay">
          <CostBar />
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onPaneClick={closeContextMenu}
          onReconnectStart={onReconnectStart}
          onReconnect={onReconnect}
          onReconnectEnd={onReconnectEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={{ type: 'typed', animated: true }}
          deleteKeyCode={null}
          panActivationKeyCode={null}
          edgesReconnectable
          connectionRadius={CONNECTION_RADIUS}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1, 2]}
          zoomOnScroll
          fitView
          minZoom={0.1}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
          style={{ background: nodeEditorBgColor }}
        >
          <Background
            variant={BackgroundVariant.Cross}
            gap={20}
            size={1}
            color="#BBBBBB"
          />
          <Controls
            showInteractive={false}
            style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <label
              className="react-flow__controls-button node-editor__bg-color-btn"
              title="Canvas background color"
            >
              <span
                className="node-editor__bg-color-swatch"
                style={{ background: nodeEditorBgColor }}
              />
              <input
                type="color"
                value={nodeEditorBgColor}
                onChange={(e) => setNodeEditorBgColor(e.target.value)}
              />
            </label>
          </Controls>
          <MiniMap
            position="top-left"
            nodeColor={(node) => {
              const cost = ((node as AppNode).data as { cost?: number }).cost ?? 0;
              return getCostColor(cost, costColorLow, costColorHigh);
            }}
            style={{ backgroundColor: 'var(--bg-panel)' }}
            maskColor="rgba(255, 255, 255, 0.7)"
          />
        </ReactFlow>

        {contextMenu.open && <ContextMenu />}
      </div>
      <ContentBrowser />
    </div>
  );
}
