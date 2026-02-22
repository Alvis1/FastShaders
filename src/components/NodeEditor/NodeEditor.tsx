import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  reconnectEdge,
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
import { TexturePreviewNode } from './nodes/TexturePreviewNode';
import { TypedEdge } from './edges/TypedEdge';
import { ContextMenu } from './menus/ContextMenu';
import { CostBar } from '@/components/Layout/CostBar';
import { getCostColor } from '@/utils/colorUtils';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { isEdgeDisconnecting, setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import type { AppNode, AppEdge } from '@/types';
import './NodeEditor.css';

const nodeTypes = {
  shader: ShaderNode,
  color: ColorNode,
  preview: PreviewNode,
  mathPreview: MathPreviewNode,
  clock: ClockNode,
  output: OutputNode,
  texturePreview: TexturePreviewNode,
};

const edgeTypes = {
  typed: TypedEdge,
};

export function NodeEditor() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const onNodesChange = useAppStore((s) => s.onNodesChange);
  const onEdgesChange = useAppStore((s) => s.onEdgesChange);
  const setEdges = useAppStore((s) => s.setEdges);
  const removeEdge = useAppStore((s) => s.removeEdge);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const contextMenu = useAppStore((s) => s.contextMenu);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);

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
        return {
          ...structuredClone(node),
          id: newId,
          position: { x: node.position.x + 30, y: node.position.y + 30 },
          selected: true,
        } as AppNode;
      });

      const sourceIds = new Set(sourceNodes.map((n) => n.id));
      const edgeClones: AppEdge[] = store.edges
        .filter((e) => sourceIds.has(e.source) && sourceIds.has(e.target))
        .map((e) => ({
          ...structuredClone(e),
          id: generateEdgeId(
            idMap.get(e.source) ?? e.source,
            e.sourceHandle ?? 'out',
            idMap.get(e.target) ?? e.target,
            e.targetHandle ?? 'in',
          ),
          source: idMap.get(e.source) ?? e.source,
          target: idMap.get(e.target) ?? e.target,
        }));

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

      // Ctrl+D — duplicate selected
      if (mod && e.key === 'd') {
        const selected = useAppStore.getState().nodes.filter((n) => n.selected);
        if (selected.length === 0) return;
        e.preventDefault();
        clipboardRef.current = structuredClone(selected);
        pasteNodes(selected);
      }

      // Delete / Backspace — remove selected nodes
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const store = useAppStore.getState();
        const selected = store.nodes.filter((n) => n.selected);
        if (selected.length === 0) return;
        e.preventDefault();

        const selectedIds = new Set(selected.map((n) => n.id));
        store.pushHistory();
        store.setNodes(store.nodes.filter((n) => !selectedIds.has(n.id)) as AppNode[]);
        store.setEdges(
          store.edges.filter((edge) => !selectedIds.has(edge.source) && !selectedIds.has(edge.target)) as AppEdge[],
        );
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Save history when user starts dragging a node (so position change is undoable)
  const onNodeDragStart = useCallback(() => {
    useAppStore.getState().pushHistory();
  }, []);

  // Drop-on-edge: insert dragged node between source and target
  // + Anti-overlap: nudge dropped node so it doesn't sit on top of another
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: AppNode) => {
      const store = useAppStore.getState();
      const allNodes = store.nodes;

      type Measured = AppNode & { measured?: { width?: number; height?: number } };
      const getSize = (n: AppNode) => ({
        w: (n as Measured).measured?.width ?? 120,
        h: (n as Measured).measured?.height ?? 40,
      });

      const { w: nw, h: nh } = getSize(draggedNode);
      const cx = draggedNode.position.x + nw / 2;
      const cy = draggedNode.position.y + nh / 2;

      // --- Drop-on-edge insertion ---
      const def = NODE_REGISTRY.get(draggedNode.data.registryType);
      if (def && def.inputs.length > 0 && def.outputs.length > 0) {
        const THRESHOLD = 40;

        for (const edge of store.edges) {
          if (edge.source === draggedNode.id || edge.target === draggedNode.id) continue;

          const srcNode = allNodes.find((n) => n.id === edge.source);
          const tgtNode = allNodes.find((n) => n.id === edge.target);
          if (!srcNode || !tgtNode) continue;

          const { w: sw, h: sh } = getSize(srcNode);
          const { h: th } = getSize(tgtNode);

          const sx = srcNode.position.x + sw;
          const sy = srcNode.position.y + sh / 2;
          const tx = tgtNode.position.x;
          const ty = tgtNode.position.y + th / 2;

          const cp = Math.max(Math.abs(tx - sx) * 0.5, 50);

          let minDist = Infinity;
          for (let t = 0; t <= 1; t += 0.05) {
            const mt = 1 - t;
            const mt2 = mt * mt;
            const mt3 = mt2 * mt;
            const t2 = t * t;
            const t3 = t2 * t;
            const bx = mt3 * sx + 3 * mt2 * t * (sx + cp) + 3 * mt * t2 * (tx - cp) + t3 * tx;
            const by = mt3 * sy + 3 * mt2 * t * sy + 3 * mt * t2 * ty + t3 * ty;
            const dist = Math.hypot(bx - cx, by - cy);
            if (dist < minDist) minDist = dist;
          }

          if (minDist < THRESHOLD) {
            const inputPort = def.inputs[0];
            const outputPort = def.outputs[0];

            const newEdge1: AppEdge = {
              id: generateEdgeId(edge.source, edge.sourceHandle ?? 'out', draggedNode.id, inputPort.id),
              source: edge.source,
              target: draggedNode.id,
              sourceHandle: edge.sourceHandle,
              targetHandle: inputPort.id,
              type: 'typed',
              animated: true,
              data: { dataType: 'any' },
            };

            const newEdge2: AppEdge = {
              id: generateEdgeId(draggedNode.id, outputPort.id, edge.target, edge.targetHandle ?? 'in'),
              source: draggedNode.id,
              target: edge.target,
              sourceHandle: outputPort.id,
              targetHandle: edge.targetHandle,
              type: 'typed',
              animated: true,
              data: { dataType: 'any' },
            };

            const newEdges = store.edges
              .filter((e) => e.id !== edge.id)
              .concat(newEdge1, newEdge2);

            store.setEdges(newEdges as AppEdge[]);
            break;
          }
        }
      }

      // --- Anti-overlap: nudge node if it sits on top of another ---
      const GAP = 10;
      let posX = draggedNode.position.x;
      let posY = draggedNode.position.y;
      let nudged = false;

      for (const other of allNodes) {
        if (other.id === draggedNode.id) continue;
        const { w: ow, h: oh } = getSize(other);

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

      if (nudged) {
        const updated = allNodes.map((n) =>
          n.id === draggedNode.id
            ? { ...n, position: { x: Math.round(posX), y: Math.round(posY) } }
            : n,
        ) as AppNode[];
        store.setNodes(updated);
      }
    },
    [],
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
      const menuType = node.data.registryType === 'output' ? 'shader' : 'node';
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

  return (
    <div className="node-editor">
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
        onNodeDragStop={onNodeDragStop}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneClick={closeContextMenu}
        onReconnectStart={onReconnectStart}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'typed', animated: true }}
        deleteKeyCode={null}
        panActivationKeyCode={null}
        edgesReconnectable
        connectionRadius={40}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        zoomOnScroll
        fitView
        minZoom={0.1}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#DDDDDD"
        />
        <Controls
          showInteractive={false}
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        />
        <MiniMap
          nodeColor={(node) => getCostColor((node.data as { cost?: number }).cost ?? 0, costColorLow, costColorHigh)}
          style={{ backgroundColor: 'var(--bg-panel)' }}
          maskColor="rgba(255, 255, 255, 0.7)"
        />
      </ReactFlow>

      {contextMenu.open && <ContextMenu />}
    </div>
  );
}
