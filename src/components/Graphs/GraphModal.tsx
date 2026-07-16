/**
 * Read-only graph viewer for the node-editor.html overview page.
 *
 * Populates the zustand store with the subject's nodes/edges on open and clears
 * it on close — ShaderNode reads `s.nodes`/`s.edges`/`s.nodeVarNames` to derive
 * the edge values it renders, so a detached <ReactFlow> alone wouldn't paint
 * correctly. This is safe ONLY because src/nodeEditor.tsx calls
 * `setGraphPersistence(false)` before this component can ever mount — see the
 * banner in that file.
 */
import { useEffect, useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { ShaderNode } from '@/components/NodeEditor/nodes/ShaderNode';
import { ColorNode } from '@/components/NodeEditor/nodes/ColorNode';
import { PreviewNode } from '@/components/NodeEditor/nodes/PreviewNode';
import { MathPreviewNode } from '@/components/NodeEditor/nodes/MathPreviewNode';
import { OutputNode } from '@/components/NodeEditor/nodes/OutputNode';
import { ClockNode } from '@/components/NodeEditor/nodes/ClockNode';
import { GroupNode } from '@/components/NodeEditor/nodes/GroupNode';
import { NoteNode } from '@/components/NodeEditor/nodes/NoteNode';
import { TypedEdge } from '@/components/NodeEditor/edges/TypedEdge';
import type { AppNode, AppEdge } from '@/types';
import './GraphModal.css';

// Mirrors the registration in NodeEditor.tsx — same components, same keys, so
// the modal renders nodes exactly as the real editor does.
const nodeTypes = {
  shader: ShaderNode,
  color: ColorNode,
  preview: PreviewNode,
  mathPreview: MathPreviewNode,
  clock: ClockNode,
  output: OutputNode,
  group: GroupNode,
  note: NoteNode,
};

const edgeTypes = {
  typed: TypedEdge,
};

export interface GraphModalProps {
  title: string;
  subtitle?: string;
  nodes: AppNode[];
  edges: AppEdge[];
  /** Optional TSL source shown in a collapsible panel under the graph. */
  code?: string;
  onClose: () => void;
}

export function GraphModal({ title, subtitle, nodes, edges, code, onClose }: GraphModalProps) {
  const setNodes = useAppStore((s) => s.setNodes);
  const setEdges = useAppStore((s) => s.setEdges);

  // Feed the store so ShaderNode's edge-value derivation sees the same graph
  // React Flow is rendering. Cleared on unmount.
  useEffect(() => {
    setNodes(nodes);
    setEdges(edges);
    return () => {
      setNodes([]);
      setEdges([]);
    };
  }, [nodes, edges, setNodes, setEdges]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nodeCount = useMemo(() => nodes.filter((n) => n.type !== 'group').length, [nodes]);
  const groupCount = useMemo(() => nodes.filter((n) => n.type === 'group').length, [nodes]);

  return (
    <div className="gm__backdrop" onClick={onClose}>
      <div className="gm__panel" onClick={(e) => e.stopPropagation()}>
        <header className="gm__head">
          <div className="gm__titles">
            <h2 className="gm__title">{title}</h2>
            {subtitle && <span className="gm__sub">{subtitle}</span>}
          </div>
          <span className="gm__counts">
            {nodeCount} node{nodeCount === 1 ? '' : 's'}
            {groupCount > 0 && ` · ${groupCount} group${groupCount === 1 ? '' : 's'}`}
            {` · ${edges.length} edge${edges.length === 1 ? '' : 's'}`}
          </span>
          <button className="gm__close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="gm__flow">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>

        {code && (
          <details className="gm__code">
            <summary>TSL source ({code.split('\n').length} lines)</summary>
            <pre>{code}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
