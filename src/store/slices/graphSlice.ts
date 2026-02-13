/**
 * Graph Slice
 * Manages React Flow node graph state
 */

import { StateCreator } from 'zustand';
import { FlowNode, FlowEdge } from '../../core/types';

export interface GraphSlice {
  // State
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodes: string[];

  // Actions
  setNodes: (nodes: FlowNode[]) => void;
  setEdges: (edges: FlowEdge[]) => void;
  addNode: (node: FlowNode) => void;
  removeNode: (nodeId: string) => void;
  updateNode: (nodeId: string, data: Partial<FlowNode['data']>) => void;
  addEdge: (edge: FlowEdge) => void;
  removeEdge: (edgeId: string) => void;
  setSelectedNodes: (nodeIds: string[]) => void;
  clearGraph: () => void;
}

export const createGraphSlice: StateCreator<GraphSlice> = (set) => ({
  // Initial state
  nodes: [],
  edges: [],
  selectedNodes: [],

  // Actions
  setNodes: (nodes) => set({ nodes }),

  setEdges: (edges) => set({ edges }),

  addNode: (node) =>
    set((state) => ({
      nodes: [...state.nodes, node],
    })),

  removeNode: (nodeId) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId
      ),
      selectedNodes: state.selectedNodes.filter((id) => id !== nodeId),
    })),

  updateNode: (nodeId, data) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } }
          : node
      ),
    })),

  addEdge: (edge) =>
    set((state) => ({
      edges: [...state.edges, edge],
    })),

  removeEdge: (edgeId) =>
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== edgeId),
    })),

  setSelectedNodes: (nodeIds) => set({ selectedNodes: nodeIds }),

  clearGraph: () =>
    set({
      nodes: [],
      edges: [],
      selectedNodes: [],
    }),
});
