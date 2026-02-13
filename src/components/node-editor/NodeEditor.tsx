/**
 * NodeEditor Component
 * Main React Flow container for node graph editing
 */

import { useCallback, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Connection,
  addEdge,
  useNodesState,
  useEdgesState,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { useStore } from '../../store';
import { NoiseNode } from './nodes/NoiseNode';
import { ColorNode } from './nodes/ColorNode';
import { DeformNode } from './nodes/DeformNode';
import { OutputNode } from './nodes/OutputNode';
import { BaseNode } from './nodes/BaseNode';

import styles from './NodeEditor.module.css';

// Define node types for React Flow
const nodeTypes = {
  noise: NoiseNode,
  color: ColorNode,
  deform: DeformNode,
  output: OutputNode,
  // Generic types
  mul: BaseNode,
  add: BaseNode,
  sub: BaseNode,
  div: BaseNode,
  sin: BaseNode,
  cos: BaseNode,
  vec2: BaseNode,
  vec3: BaseNode,
  mix: BaseNode,
  texture: BaseNode,
};

export const NodeEditor: React.FC = () => {
  const { nodes: storeNodes, edges: storeEdges } = useStore();

  const [nodes, setNodesState, onNodesChange] = useNodesState(storeNodes);
  const [edges, setEdgesState, onEdgesChange] = useEdgesState(storeEdges);

  // Only sync from store on initial mount, not on every change
  // This prevents flickering and allows dragging
  useEffect(() => {
    if (storeNodes.length > 0 && nodes.length === 0) {
      setNodesState(storeNodes);
    }
  }, [storeNodes, nodes.length, setNodesState]);

  useEffect(() => {
    if (storeEdges.length > 0 && edges.length === 0) {
      setEdgesState(storeEdges);
    }
  }, [storeEdges, edges.length, setEdgesState]);

  // Handle node changes - let React Flow manage the state smoothly
  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
      // Don't update store during interactions - React Flow handles it
    },
    [onNodesChange]
  );

  // Handle edge changes
  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes);
      // Don't update store during interactions - React Flow handles it
    },
    [onEdgesChange]
  );

  // Handle new connections
  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const newEdge = {
        ...connection,
        id: `e${connection.source}-${connection.target}`,
        animated: true,
      };
      const updatedEdges = addEdge(newEdge, edges);
      setEdgesState(updatedEdges);
      // Don't update store immediately - React Flow handles it
    },
    [edges, setEdgesState]
  );

  return (
    <div className={styles.nodeEditor}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-left"
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{
          animated: true,
          style: { stroke: 'var(--edge-color)', strokeWidth: 2 },
        }}
      >
        <Background gap={16} size={1} color="var(--border-color)" />
        <Controls />
        <MiniMap
          nodeColor={(node) => node.data.color || 'var(--node-color)'}
          style={{
            backgroundColor: 'var(--bg-panel)',
          }}
        />
      </ReactFlow>
    </div>
  );
};

export default NodeEditor;
