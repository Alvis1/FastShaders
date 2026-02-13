import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  type OnConnect,
  type Connection,
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
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const contextMenu = useAppStore((s) => s.contextMenu);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const newEdge: AppEdge = {
        id: generateEdgeId(
          connection.source,
          connection.sourceHandle ?? 'out',
          connection.target,
          connection.targetHandle ?? 'in'
        ),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: 'typed',
        animated: true,
        data: { dataType: 'any' },
      };
      setEdges(addEdge(newEdge, edges) as AppEdge[]);
    },
    [edges, setEdges]
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
        onPaneClick={closeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'typed', animated: true }}
        fitView
        minZoom={0.1}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#333355"
        />
        <Controls
          showInteractive={false}
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        />
        <MiniMap
          nodeColor={(node) => getCostColor((node.data as { cost?: number }).cost ?? 0)}
          style={{ backgroundColor: 'var(--bg-panel)' }}
          maskColor="rgba(0, 0, 0, 0.4)"
        />
      </ReactFlow>

      {contextMenu.open && <ContextMenu />}
    </div>
  );
}
