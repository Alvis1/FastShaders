import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type { AppNode, AppEdge, SyncSource, ParseError } from '@/types';

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  type: 'canvas' | 'node' | 'shader';
  nodeId?: string;
}

interface AppState {
  // Graph
  nodes: AppNode[];
  edges: AppEdge[];

  // Code
  code: string;
  codeErrors: ParseError[];

  // Complexity
  totalCost: number;

  // Sync
  syncSource: SyncSource;
  syncInProgress: boolean;

  // UI
  contextMenu: ContextMenuState;
  splitRatio: number;

  // Graph actions
  setNodes: (nodes: AppNode[], source?: SyncSource) => void;
  setEdges: (edges: AppEdge[], source?: SyncSource) => void;
  onNodesChange: (changes: NodeChange<AppNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<AppEdge>[]) => void;
  addNode: (node: AppNode) => void;
  removeNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<AppNode['data']>) => void;

  // Code actions
  setCode: (code: string, source?: SyncSource) => void;
  setCodeErrors: (errors: ParseError[]) => void;

  // Complexity actions
  setTotalCost: (cost: number) => void;

  // Sync actions
  setSyncInProgress: (v: boolean) => void;

  // UI actions
  openContextMenu: (x: number, y: number, type: 'canvas' | 'node' | 'shader', nodeId?: string) => void;
  closeContextMenu: () => void;
  setSplitRatio: (ratio: number) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  nodes: [],
  edges: [],
  code: '',
  codeErrors: [],
  totalCost: 0,
  syncSource: 'initial',
  syncInProgress: false,
  contextMenu: { open: false, x: 0, y: 0, type: 'canvas' },
  splitRatio: 0.6,

  setNodes: (nodes, source = 'graph') =>
    set({ nodes, syncSource: source }),

  setEdges: (edges, source = 'graph') =>
    set({ edges, syncSource: source }),

  onNodesChange: (changes) =>
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as AppNode[],
      syncSource: 'graph',
    })),

  onEdgesChange: (changes) =>
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges) as AppEdge[],
      syncSource: 'graph',
    })),

  addNode: (node) =>
    set((state) => ({ nodes: [...state.nodes, node], syncSource: 'graph' })),

  removeNode: (nodeId) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      syncSource: 'graph',
    })),

  updateNodeData: (nodeId, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n
      ) as AppNode[],
      syncSource: 'graph',
    })),

  setCode: (code, source = 'code') =>
    set({ code, syncSource: source }),

  setCodeErrors: (errors) => set({ codeErrors: errors }),

  setTotalCost: (cost) => set({ totalCost: cost }),

  setSyncInProgress: (v) => set({ syncInProgress: v }),

  openContextMenu: (x, y, type, nodeId) =>
    set({ contextMenu: { open: true, x, y, type, nodeId } }),

  closeContextMenu: () =>
    set({ contextMenu: { open: false, x: 0, y: 0, type: 'canvas' } }),

  setSplitRatio: (ratio) =>
    set({ splitRatio: Math.max(0.25, Math.min(0.75, ratio)) }),
}));
