import { useCallback, useRef } from 'react';
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
} from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { ShaderNode } from './nodes/ShaderNode';
import { OutputNode } from './nodes/OutputNode';
import { TypedEdge } from './edges/TypedEdge';
import { ContextMenu } from './menus/ContextMenu';
import { getCostColor } from '@/utils/colorUtils';
import { generateEdgeId } from '@/utils/idGenerator';
import type { AppNode, AppEdge } from '@/types';
import './NodeEditor.css';

const nodeTypes = {
  shader: ShaderNode,
  output: OutputNode,
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

  // Track whether a reconnect was successful (dropped on a valid handle)
  const reconnectSuccessful = useRef(false);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
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

  // Drag-to-delete: track reconnect start
  const onReconnectStart = useCallback(() => {
    reconnectSuccessful.current = false;
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
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
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
        edgesReconnectable
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
          nodeColor={(node) => getCostColor((node.data as { cost?: number }).cost ?? 0)}
          style={{ backgroundColor: 'var(--bg-panel)' }}
          maskColor="rgba(255, 255, 255, 0.7)"
        />
      </ReactFlow>

      {contextMenu.open && <ContextMenu />}
    </div>
  );
}
