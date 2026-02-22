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
  type: 'canvas' | 'node' | 'shader' | 'edge';
  nodeId?: string;
  edgeId?: string;
  /** Source pin info when menu was opened by dragging from an output handle. */
  sourceNodeId?: string;
  sourceHandleId?: string;
}

interface HistoryEntry {
  nodes: AppNode[];
  edges: AppEdge[];
}

const MAX_HISTORY = 50;

function loadRatio(key: string, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '');
    return isNaN(v) ? fallback : Math.max(0.25, Math.min(0.75, v));
  } catch {
    return fallback;
  }
}

function snapshot(nodes: AppNode[], edges: AppEdge[]): HistoryEntry {
  return {
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
  };
}

const STORAGE_KEY = 'fs:graph';

function saveGraph(nodes: AppNode[], edges: AppEdge[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, edges }));
  } catch { /* quota exceeded or private mode */ }
}

export function loadGraph(): { nodes: AppNode[]; edges: AppEdge[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Array.isArray(data.nodes) && Array.isArray(data.edges)) {
      // Migrate: noise-category nodes should use 'preview' type
      const noiseTypes = new Set(['noise', 'fractal', 'voronoi']);
      for (const node of data.nodes) {
        if (node.type === 'shader' && noiseTypes.has(node.data?.registryType)) {
          node.type = 'preview';
        }
        // Migrate: texture-category nodes should use 'texturePreview' type
        if (node.type === 'shader' && node.data?.registryType?.startsWith('tslTex_')) {
          node.type = 'texturePreview';
        }
      }

      // Migrate: output nodes without exposedPorts — auto-expose any ports with edges
      const defaultExposed = new Set(['color', 'roughness', 'position']);
      for (const node of data.nodes) {
        if (node.data?.registryType === 'output' && !node.data.exposedPorts) {
          const connectedPorts = new Set<string>();
          for (const edge of data.edges) {
            if (edge.target === node.id && edge.targetHandle) {
              connectedPorts.add(edge.targetHandle);
            }
          }
          // Merge defaults with any connected ports
          const merged = new Set([...defaultExposed, ...connectedPorts]);
          node.data.exposedPorts = Array.from(merged);
        }
      }

      return data;
    }
  } catch { /* corrupt data */ }
  return null;
}

export interface VRHeadset {
  id: string;
  label: string;
  maxPoints: number;
}

export const VR_HEADSETS: VRHeadset[] = [
  { id: 'quest3', label: 'Meta Quest 3', maxPoints: 150 },
  { id: 'quest3s', label: 'Meta Quest 3s', maxPoints: 120 },
  { id: 'steamframe', label: 'Steam Frame', maxPoints: 300 },
  { id: 'pico4', label: 'Pico 4', maxPoints: 100 },
  { id: 'visionpro', label: 'Apple Vision Pro', maxPoints: 400 },
];

interface AppState {
  // Graph
  nodes: AppNode[];
  edges: AppEdge[];

  // Code
  code: string;
  previewCode: string;
  codeErrors: ParseError[];

  // Complexity
  totalCost: number;

  // Sync
  syncSource: SyncSource;
  syncInProgress: boolean;

  // Script mode (tsl-textures code evaluated directly)
  activeScript: string | null;

  // History (undo / redo)
  history: HistoryEntry[];
  historyIndex: number;
  isUndoRedo: boolean;

  // UI
  contextMenu: ContextMenuState;
  splitRatio: number;
  rightSplitRatio: number;

  // Shader name + headset
  shaderName: string;
  selectedHeadsetId: string;

  // Cost color poles
  costColorLow: string;
  costColorHigh: string;

  // Graph actions
  setNodes: (nodes: AppNode[], source?: SyncSource) => void;
  setEdges: (edges: AppEdge[], source?: SyncSource) => void;
  onNodesChange: (changes: NodeChange<AppNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<AppEdge>[]) => void;
  addNode: (node: AppNode) => void;
  removeNode: (nodeId: string) => void;
  removeEdge: (edgeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<AppNode['data']>) => void;

  // Code actions
  setCode: (code: string, source?: SyncSource) => void;
  setCodeErrors: (errors: ParseError[]) => void;
  codeSyncRequested: boolean;
  requestCodeSync: () => void;
  commitPreview: () => void;

  // Complexity actions
  setTotalCost: (cost: number) => void;

  // Sync actions
  setSyncInProgress: (v: boolean) => void;
  setActiveScript: (script: string | null) => void;

  // History actions
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  // UI actions
  openContextMenu: (x: number, y: number, type: 'canvas' | 'node' | 'shader' | 'edge', nodeId?: string, edgeId?: string, sourceNodeId?: string, sourceHandleId?: string) => void;
  closeContextMenu: () => void;
  setSplitRatio: (ratio: number) => void;
  setRightSplitRatio: (ratio: number) => void;

  // Shader name + headset actions
  setShaderName: (name: string) => void;
  setSelectedHeadsetId: (id: string) => void;

  // Cost color actions
  setCostColorLow: (hex: string) => void;
  setCostColorHigh: (hex: string) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  nodes: [],
  edges: [],
  code: '',
  previewCode: '',
  codeErrors: [],
  totalCost: 0,
  syncSource: 'initial',
  syncInProgress: false,
  activeScript: null,
  codeSyncRequested: false,
  history: [],
  historyIndex: -1,
  isUndoRedo: false,
  contextMenu: { open: false, x: 0, y: 0, type: 'canvas' },
  splitRatio: loadRatio('fs:splitRatio', 0.6),
  rightSplitRatio: loadRatio('fs:rightSplitRatio', 0.6),
  shaderName: (() => { try { return localStorage.getItem('fs:shaderName') || 'My Shader'; } catch { return 'My Shader'; } })(),
  selectedHeadsetId: (() => { try { return localStorage.getItem('fs:headsetId') || 'quest3'; } catch { return 'quest3'; } })(),
  costColorLow: (() => { try { return localStorage.getItem('fs:costColorLow') || '#8BC34A'; } catch { return '#8BC34A'; } })(),
  costColorHigh: (() => { try { return localStorage.getItem('fs:costColorHigh') || '#FF5722'; } catch { return '#FF5722'; } })(),

  setNodes: (nodes, source = 'graph') =>
    set({ nodes, syncSource: source, isUndoRedo: false }),

  setEdges: (edges, source = 'graph') =>
    set({ edges, syncSource: source, isUndoRedo: false }),

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

  addNode: (node) => {
    get().pushHistory();
    set((state) => ({ nodes: [...state.nodes, node], syncSource: 'graph', isUndoRedo: false }));
  },

  removeNode: (nodeId) => {
    get().pushHistory();
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      syncSource: 'graph',
      isUndoRedo: false,
    }));
  },

  removeEdge: (edgeId) => {
    get().pushHistory();
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== edgeId),
      syncSource: 'graph',
      isUndoRedo: false,
    }));
  },

  updateNodeData: (nodeId, data) => {
    get().pushHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n
      ) as AppNode[],
      syncSource: 'graph',
      isUndoRedo: false,
    }));
  },

  setCode: (code, source = 'code') => {
    // Skip no-op: prevents Monaco onChange from flipping syncSource after programmatic updates
    if (code === get().code && source === 'code') return;
    if (source === 'code') {
      // User typing — just store the code, don't update preview yet
      set({ code });
    } else {
      // Graph or initial sync — update preview immediately
      set({ code, previewCode: code, syncSource: source });
    }
  },

  setCodeErrors: (errors) => set({ codeErrors: errors }),

  requestCodeSync: () => set({ codeSyncRequested: true, previewCode: get().code }),

  commitPreview: () => set({ previewCode: get().code }),

  setTotalCost: (cost) => set({ totalCost: cost }),

  setSyncInProgress: (v) => set({ syncInProgress: v }),

  setActiveScript: (script) => set({ activeScript: script }),

  pushHistory: () =>
    set((state) => {
      if (state.isUndoRedo) return {};
      const entry = snapshot(state.nodes, state.edges);
      const past = state.history.slice(0, state.historyIndex + 1);
      const newHistory = [...past, entry].slice(-MAX_HISTORY);
      return { history: newHistory, historyIndex: newHistory.length - 1 };
    }),

  undo: () =>
    set((state) => {
      if (state.historyIndex < 0) return {};
      const entry = state.history[state.historyIndex];
      return {
        nodes: structuredClone(entry.nodes),
        edges: structuredClone(entry.edges),
        historyIndex: state.historyIndex - 1,
        syncSource: 'graph',
        isUndoRedo: true,
      };
    }),

  redo: () =>
    set((state) => {
      if (state.historyIndex >= state.history.length - 1) return {};
      const entry = state.history[state.historyIndex + 1];
      return {
        nodes: structuredClone(entry.nodes),
        edges: structuredClone(entry.edges),
        historyIndex: state.historyIndex + 1,
        syncSource: 'graph',
        isUndoRedo: true,
      };
    }),

  openContextMenu: (x, y, type, nodeId, edgeId, sourceNodeId, sourceHandleId) =>
    set({ contextMenu: { open: true, x, y, type, nodeId, edgeId, sourceNodeId, sourceHandleId } }),

  closeContextMenu: () =>
    set({ contextMenu: { open: false, x: 0, y: 0, type: 'canvas' } }),

  setSplitRatio: (ratio) => {
    const clamped = Math.max(0.25, Math.min(0.75, ratio));
    try { localStorage.setItem('fs:splitRatio', String(clamped)); } catch { /* */ }
    set({ splitRatio: clamped });
  },

  setRightSplitRatio: (ratio) => {
    const clamped = Math.max(0.25, Math.min(0.75, ratio));
    try { localStorage.setItem('fs:rightSplitRatio', String(clamped)); } catch { /* */ }
    set({ rightSplitRatio: clamped });
  },

  setShaderName: (name) => {
    try { localStorage.setItem('fs:shaderName', name); } catch { /* */ }
    set({ shaderName: name });
  },

  setSelectedHeadsetId: (id) => {
    try { localStorage.setItem('fs:headsetId', id); } catch { /* */ }
    set({ selectedHeadsetId: id });
  },

  setCostColorLow: (hex) => {
    try { localStorage.setItem('fs:costColorLow', hex); } catch { /* */ }
    set({ costColorLow: hex });
  },

  setCostColorHigh: (hex) => {
    try { localStorage.setItem('fs:costColorHigh', hex); } catch { /* */ }
    set({ costColorHigh: hex });
  },
}));

// Auto-save graph to localStorage on changes
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useAppStore.subscribe(
  (state, prev) => {
    if (state.nodes !== prev.nodes || state.edges !== prev.edges) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveGraph(state.nodes, state.edges), 300);
    }
  },
);
