import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type {
  AppNode,
  AppEdge,
  SyncSource,
  ParseError,
  GroupNodeData,
  BoundarySocket,
  TSLDataType,
} from '@/types';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import complexityData from '@/registry/complexity.json';

/**
 * A user-saved group: the group node + every member node + every edge that lives
 * entirely inside the group. Stored verbatim with original IDs; instantiation
 * remaps them at drop time.
 */
export interface SavedGroup {
  id: string;
  name: string;
  color: string;
  nodes: AppNode[];
  edges: AppEdge[];
}

const SAVED_GROUPS_KEY = 'fs:savedGroups';

function loadSavedGroups(): SavedGroup[] {
  try {
    const raw = localStorage.getItem(SAVED_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (g): g is SavedGroup =>
        g && typeof g.id === 'string' && Array.isArray(g.nodes) && Array.isArray(g.edges),
    );
  } catch {
    return [];
  }
}

function persistSavedGroups(groups: SavedGroup[]) {
  try {
    localStorage.setItem(SAVED_GROUPS_KEY, JSON.stringify(groups));
  } catch { /* quota exceeded or private mode */ }
}

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  type: 'canvas' | 'node' | 'shader' | 'edge' | 'group';
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

function loadString(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
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
      // Migrate: legacy tsl-textures nodes are removed — drop them entirely
      // so the graph still loads. Edges that referenced them are also pruned
      // below. Nodes saved with the (now-removed) `texturePreview` flow type
      // or any `tslTex_*` registry type fall into this bucket.
      const droppedNodeIds = new Set<string>();
      data.nodes = data.nodes.filter((node: { id: string; type?: string; data?: { registryType?: string } }) => {
        if (
          node.type === 'texturePreview' ||
          node.data?.registryType?.startsWith?.('tslTex_')
        ) {
          droppedNodeIds.add(node.id);
          return false;
        }
        return true;
      });
      if (droppedNodeIds.size > 0) {
        data.edges = data.edges.filter(
          (edge: { source: string; target: string }) =>
            !droppedNodeIds.has(edge.source) && !droppedNodeIds.has(edge.target),
        );
      }

      // Migrate: noise-category nodes should use 'preview' type
      const noiseTypes = new Set([
        'fractal',
        'perlin',
        'perlinVec3',
        'fbm',
        'fbmVec3',
        'cellNoise',
        'voronoi',
        'voronoiVec2',
        'voronoiVec3',
      ]);
      for (const node of data.nodes) {
        if (node.type === 'shader' && noiseTypes.has(node.data?.registryType)) {
          node.type = 'preview';
        }
        // Migrate: drop `extent: 'parent'` from any persisted member node so
        // drag-out-to-detach works on graphs saved before that change.
        if (node.extent === 'parent') {
          delete node.extent;
        }
        // Migrate: uniform_float → property_float
        if (node.data?.registryType === 'uniform_float') {
          node.data.registryType = 'property_float';
          if (!node.data.values) node.data.values = {};
          if (!node.data.values.name) {
            const label = node.data.label;
            node.data.values.name = (label === 'Uniform (float)' || label === 'uniform')
              ? 'property1'
              : label;
          }
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
  { id: 'quest3', label: 'Meta Quest 3', maxPoints: 200 },
  { id: 'quest3s', label: 'Meta Quest 3s', maxPoints: 110 },
  { id: 'quest2', label: 'Meta Quest 2', maxPoints: 90 },
  { id: 'steamframe', label: 'Steam Frame', maxPoints: 220 },
  { id: 'pico4', label: 'Pico 4', maxPoints: 80 },
  { id: 'visionpro', label: 'Apple Vision Pro (M5)', maxPoints: 350 },
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

  // Node variable names (from code generation)
  nodeVarNames: Record<string, string>;

  // Cost color poles
  costColorLow: string;
  costColorHigh: string;

  // Node editor background color (canvas backdrop)
  nodeEditorBgColor: string;

  // Code editor theme ('vs' = light, 'vs-dark' = dark)
  codeEditorTheme: 'vs' | 'vs-dark';

  // User's library of saved groups (persisted to localStorage)
  savedGroups: SavedGroup[];

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

  // Complexity actions
  setTotalCost: (cost: number) => void;

  // Sync actions
  setSyncInProgress: (v: boolean) => void;

  // History actions
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  // UI actions
  openContextMenu: (x: number, y: number, type: 'canvas' | 'node' | 'shader' | 'edge' | 'group', nodeId?: string, edgeId?: string, sourceNodeId?: string, sourceHandleId?: string) => void;
  closeContextMenu: () => void;
  setSplitRatio: (ratio: number) => void;
  setRightSplitRatio: (ratio: number) => void;

  // Shader name + headset actions
  setShaderName: (name: string) => void;
  setSelectedHeadsetId: (id: string) => void;

  // Node variable name actions
  setNodeVarNames: (names: Record<string, string>) => void;

  // Cost color actions
  setCostColorLow: (hex: string) => void;
  setCostColorHigh: (hex: string) => void;

  // Node editor background actions
  setNodeEditorBgColor: (hex: string) => void;

  // Code editor theme actions
  setCodeEditorTheme: (theme: 'vs' | 'vs-dark') => void;

  // Group actions
  /** Wraps the given node ids in a new group node and returns the group id (or null if <2 nodes). */
  groupSelection: (nodeIds: string[]) => string | null;
  /** Dissolves a group: detaches member parentIds and restores absolute positions, then deletes the group node. */
  ungroup: (groupId: string) => void;
  /** Patch a group node's data (label / color). */
  updateGroupData: (groupId: string, data: Partial<GroupNodeData>) => void;
  /** Collapse/expand a group: hide its children + their edges and shrink to a pill, or restore. */
  toggleGroupCollapsed: (groupId: string) => void;

  // Saved group library actions
  /** Snapshot a group + its members + internal edges into the savedGroups library. */
  saveGroupToLibrary: (groupId: string) => void;
  /** Remove a saved group from the library by id. */
  deleteSavedGroup: (savedId: string) => void;
  /** Drop a copy of a saved group onto the canvas at `position` (flow coords). */
  instantiateSavedGroup: (savedId: string, position: { x: number; y: number }) => void;
  /** Drop a built-in texture group onto the canvas at `position` (flow coords). */
  instantiateBuiltinTexture: (textureId: string, position: { x: number; y: number }) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  nodes: [],
  edges: [],
  code: '',
  previewCode: '',
  codeErrors: [],
  totalCost: 0,
  syncSource: 'graph',
  syncInProgress: false,
  codeSyncRequested: false,
  history: [],
  historyIndex: -1,
  isUndoRedo: false,
  contextMenu: { open: false, x: 0, y: 0, type: 'canvas' },
  splitRatio: loadRatio('fs:splitRatio', 0.6),
  rightSplitRatio: loadRatio('fs:rightSplitRatio', 0.6),
  shaderName: loadString('fs:shaderName', 'My Shader'),
  selectedHeadsetId: loadString('fs:headsetId', 'quest3'),
  nodeVarNames: {},
  costColorLow: loadString('fs:costColorLow', '#8BC34A'),
  costColorHigh: loadString('fs:costColorHigh', '#FF5722'),
  nodeEditorBgColor: loadString('fs:nodeEditorBgColor', '#FAFAFA'),
  codeEditorTheme: (loadString('fs:codeEditorTheme', 'vs') === 'vs-dark' ? 'vs-dark' : 'vs'),
  savedGroups: loadSavedGroups(),

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

  setTotalCost: (cost) => set({ totalCost: cost }),

  setSyncInProgress: (v) => set({ syncInProgress: v }),

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

  setNodeVarNames: (names) => set({ nodeVarNames: names }),

  setCostColorLow: (hex) => {
    try { localStorage.setItem('fs:costColorLow', hex); } catch { /* */ }
    set({ costColorLow: hex });
  },

  setCostColorHigh: (hex) => {
    try { localStorage.setItem('fs:costColorHigh', hex); } catch { /* */ }
    set({ costColorHigh: hex });
  },

  setNodeEditorBgColor: (hex) => {
    try { localStorage.setItem('fs:nodeEditorBgColor', hex); } catch { /* */ }
    set({ nodeEditorBgColor: hex });
  },

  setCodeEditorTheme: (theme) => {
    try { localStorage.setItem('fs:codeEditorTheme', theme); } catch { /* */ }
    set({ codeEditorTheme: theme });
  },

  groupSelection: (nodeIds) => {
    if (nodeIds.length < 2) return null;
    const state = get();
    // Only group nodes that exist and are not already groups themselves.
    const members = state.nodes.filter(
      (n) => nodeIds.includes(n.id) && n.type !== 'group',
    );
    if (members.length < 2) return null;

    // Members can already have a parentId (nested grouping is possible) — but if
    // every member shares the SAME parent, the new group should slide in under
    // that parent so the relative-position math stays correct. Otherwise we group
    // at root level and reset parents.
    const firstParent = members[0].parentId;
    const sameParent = members.every((n) => n.parentId === firstParent);
    const newParentId = sameParent ? firstParent : undefined;

    // Compute the bounding box in the coordinate space of the new parent.
    // React Flow node.position is relative to parentId; if we're moving members
    // out of their parent we'd need to translate, but `sameParent` short-circuits
    // that — positions stay valid as-is.
    type Measured = AppNode & { measured?: { width?: number; height?: number }; width?: number; height?: number };
    const getSize = (n: AppNode) => ({
      w: (n as Measured).measured?.width ?? (n as Measured).width ?? 160,
      h: (n as Measured).measured?.height ?? (n as Measured).height ?? 60,
    });

    const PADDING = 24;
    const HEADER_H = 22;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of members) {
      const { w, h } = getSize(m);
      minX = Math.min(minX, m.position.x);
      minY = Math.min(minY, m.position.y);
      maxX = Math.max(maxX, m.position.x + w);
      maxY = Math.max(maxY, m.position.y + h);
    }

    const groupX = minX - PADDING;
    const groupY = minY - PADDING - HEADER_H;
    const groupW = (maxX - minX) + PADDING * 2;
    const groupH = (maxY - minY) + PADDING * 2 + HEADER_H;

    const groupId = generateId();
    const groupNode: AppNode = {
      id: groupId,
      type: 'group',
      position: { x: groupX, y: groupY },
      // React Flow honors width/height directly on group nodes for the parent box.
      width: groupW,
      height: groupH,
      parentId: newParentId,
      // Members render after the group; selecting the group should still let
      // child clicks pass through, so we leave selectable on but draggable too.
      data: {
        registryType: 'group',
        label: 'Group',
        color: '#6366f1',
        width: groupW,
        height: groupH,
      } as GroupNodeData,
    } as AppNode;

    get().pushHistory();

    // Re-parent members: their position becomes relative to the group origin.
    // Intentionally NOT setting `extent: 'parent'` — we want users to be able
    // to drag children out of the group, and onNodeDragStop reconciles
    // parentId based on the final drop position.
    const memberIds = new Set(members.map((m) => m.id));
    const newNodes: AppNode[] = state.nodes.map((n) => {
      if (!memberIds.has(n.id)) return n;
      return {
        ...n,
        parentId: groupId,
        position: {
          x: n.position.x - groupX,
          y: n.position.y - groupY,
        },
      } as AppNode;
    });

    // React Flow requires the parent to come BEFORE its children in the array.
    // Insert the group at the front, then keep the original order for everything else.
    const reordered: AppNode[] = [groupNode, ...newNodes];

    set({ nodes: reordered, syncSource: 'graph', isUndoRedo: false });
    return groupId;
  },

  ungroup: (groupId) => {
    const state = get();
    const groupNode = state.nodes.find((n) => n.id === groupId);
    if (!groupNode || groupNode.type !== 'group') return;

    get().pushHistory();

    const groupX = groupNode.position.x;
    const groupY = groupNode.position.y;
    const grandParentId = groupNode.parentId;

    const newNodes: AppNode[] = state.nodes
      .filter((n) => n.id !== groupId)
      .map((n) => {
        if (n.parentId !== groupId) return n;
        // Lift child back to grandparent's coordinate space.
        const { extent: _extent, parentId: _parentId, ...rest } = n as AppNode & { extent?: unknown; parentId?: string };
        void _extent; void _parentId;
        const lifted: AppNode = {
          ...rest,
          position: {
            x: n.position.x + groupX,
            y: n.position.y + groupY,
          },
        } as AppNode;
        if (grandParentId) {
          (lifted as { parentId?: string }).parentId = grandParentId;
        }
        return lifted;
      });

    set({ nodes: newNodes, syncSource: 'graph', isUndoRedo: false });
  },

  updateGroupData: (groupId, data) => {
    get().pushHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === groupId ? { ...n, data: { ...n.data, ...data } } : n,
      ) as AppNode[],
      syncSource: 'graph',
      isUndoRedo: false,
    }));
  },

  toggleGroupCollapsed: (groupId) => {
    const state = get();
    const groupNode = state.nodes.find((n) => n.id === groupId);
    if (!groupNode || groupNode.type !== 'group') return;

    const groupData = groupNode.data as GroupNodeData;
    const isCurrentlyCollapsed = !!groupData.collapsed;
    const willBeCollapsed = !isCurrentlyCollapsed;

    // Members are nodes whose parentId points at this group.
    const memberIds = new Set(
      state.nodes.filter((n) => n.parentId === groupId).map((n) => n.id),
    );
    const nodeById = new Map(state.nodes.map((n) => [n.id, n]));

    /** Look up the data type of a port on a given node, falling back to 'any'. */
    const portDataType = (
      nodeId: string,
      handleId: string | null | undefined,
      side: 'input' | 'output',
    ): TSLDataType => {
      const n = nodeById.get(nodeId);
      if (!n) return 'any';
      const def = NODE_REGISTRY.get((n.data as { registryType: string }).registryType);
      if (!def) return 'any';
      const ports = side === 'input' ? def.inputs : def.outputs;
      const port = ports.find((p) => p.id === (handleId ?? (side === 'output' ? 'out' : 'in')));
      return port?.dataType ?? 'any';
    };

    /** Look up a port's display label. Falls back to the handle id when missing. */
    const portLabel = (
      nodeId: string,
      handleId: string | null | undefined,
      side: 'input' | 'output',
    ): string | undefined => {
      const n = nodeById.get(nodeId);
      if (!n) return handleId ?? undefined;
      const def = NODE_REGISTRY.get((n.data as { registryType: string }).registryType);
      if (!def) return handleId ?? undefined;
      const ports = side === 'input' ? def.inputs : def.outputs;
      const port = ports.find((p) => p.id === (handleId ?? (side === 'output' ? 'out' : 'in')));
      return port?.label ?? handleId ?? undefined;
    };

    /** Look up a node's display label, used to name boundary sockets. */
    const nodeLabel = (nodeId: string): string | undefined => {
      const n = nodeById.get(nodeId);
      if (!n) return undefined;
      const data = n.data as { label?: string; values?: { name?: string }; registryType?: string };
      // Property nodes are named by the user — show that instead of the generic label.
      if (data.registryType === 'property_float' && data.values?.name) {
        return String(data.values.name);
      }
      return data.label || undefined;
    };

    /** Sum of GPU costs of every member node, displayed above the group as a badge. */
    const costMap = complexityData.costs as Record<string, number>;
    let groupCostSum = 0;
    for (const m of state.nodes) {
      if (!memberIds.has(m.id)) continue;
      const rt = (m.data as { registryType?: string }).registryType;
      if (rt) groupCostSum += costMap[rt] ?? 0;
    }

    // Compact pill size when collapsed; restore to remembered expanded size otherwise.
    type Sized = AppNode & { width?: number; height?: number };
    const currentWidth = (groupNode as Sized).width ?? groupData.width ?? 200;
    const currentHeight = (groupNode as Sized).height ?? groupData.height ?? 120;

    get().pushHistory();

    if (willBeCollapsed) {
      // === Collapse ===
      // Walk every edge and bucket: internal (both endpoints inside), input
      // boundary (target is inside), output boundary (source is inside).
      const collapsedInputs: BoundarySocket[] = [];
      const collapsedOutputs: BoundarySocket[] = [];
      // Dedupe so multiple edges off the same internal source share one output socket.
      const outputSocketByPin = new Map<string, BoundarySocket>();
      // Inputs are inherently single (single-input enforcement) but key for safety.
      const inputSocketByPin = new Map<string, BoundarySocket>();

      const updatedEdges: AppEdge[] = state.edges.map((e) => {
        const srcInside = memberIds.has(e.source);
        const tgtInside = memberIds.has(e.target);

        if (srcInside && tgtInside) {
          // Internal edge — hide visually via CSS className (`display: none`)
          // instead of `hidden: true`. The latter would unmount the edge from
          // React Flow's render tree; the className approach keeps it in place
          // so the live evaluation walker still sees it.
          return { ...e, className: 'fs-collapsed-edge' };
        }

        if (srcInside && !tgtInside) {
          // Output boundary: source pin sits inside, target lives outside.
          // Socket name = the internal child producing the value (the source).
          const pinKey = `${e.source}\0${e.sourceHandle ?? 'out'}`;
          let socket = outputSocketByPin.get(pinKey);
          if (!socket) {
            socket = {
              socketId: `__out_${e.source}_${e.sourceHandle ?? 'out'}`,
              originalNodeId: e.source,
              originalHandleId: e.sourceHandle ?? 'out',
              dataType: portDataType(e.source, e.sourceHandle, 'output'),
              name: nodeLabel(e.source),
            };
            outputSocketByPin.set(pinKey, socket);
            collapsedOutputs.push(socket);
          }
          return {
            ...e,
            // Re-issue the edge id so React Flow remounts the SVG path with
            // the new endpoint coordinates.
            id: generateEdgeId(groupId, socket.socketId, e.target, e.targetHandle ?? 'in'),
            source: groupId,
            sourceHandle: socket.socketId,
            className: undefined,
          };
        }

        if (!srcInside && tgtInside) {
          // Input boundary: target pin sits inside, source lives outside.
          // Socket name = the input port label of the internal child the edge
          // terminates at, so users see what value they're feeding (e.g.
          // "Position", "Scale") rather than the upstream feeder's label.
          const pinKey = `${e.target}\0${e.targetHandle ?? 'in'}`;
          let socket = inputSocketByPin.get(pinKey);
          if (!socket) {
            socket = {
              socketId: `__in_${e.target}_${e.targetHandle ?? 'in'}`,
              originalNodeId: e.target,
              originalHandleId: e.targetHandle ?? 'in',
              dataType: portDataType(e.target, e.targetHandle, 'input'),
              name: portLabel(e.target, e.targetHandle, 'input'),
            };
            inputSocketByPin.set(pinKey, socket);
            collapsedInputs.push(socket);
          }
          return {
            ...e,
            id: generateEdgeId(e.source, e.sourceHandle ?? 'out', groupId, socket.socketId),
            target: groupId,
            targetHandle: socket.socketId,
            className: undefined,
          };
        }

        return e;
      });

      // Pill size scales with the number of sockets so they all fit.
      // Width is intentionally compact — labels live next to the handles, not
      // inside a wide body, so the pill stays small horizontally.
      // SOCKET_TOP_PAD here mirrors the value in GroupNode.tsx — keep them in
      // sync so handle dots stay below the colored header strip.
      const COLLAPSED_W = 130;
      const SOCKET_H = 18;
      const HEADER_H = 28;
      const SOCKET_TOP_PAD = 8;
      const socketCount = Math.max(collapsedInputs.length, collapsedOutputs.length);
      const collapsedH = HEADER_H + SOCKET_TOP_PAD + Math.max(1, socketCount) * SOCKET_H + 6;

      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id === groupId) {
            const data = { ...(n.data as GroupNodeData) } as GroupNodeData;
            data.collapsed = true;
            data.expandedWidth = currentWidth;
            data.expandedHeight = currentHeight;
            data.width = COLLAPSED_W;
            data.height = collapsedH;
            data.collapsedInputs = collapsedInputs;
            data.collapsedOutputs = collapsedOutputs;
            // Sum of GPU cost across all members — drives the cost badge above
            // the pill so users can see the perf impact without expanding.
            data.cost = groupCostSum;
            return {
              ...n,
              width: COLLAPSED_W,
              height: collapsedH,
              data,
            } as AppNode;
          }
          if (memberIds.has(n.id)) {
            // Strip extent: parent so the shrunk parent box doesn't clamp child positions.
            const { extent: _extent, ...rest } = n as AppNode & { extent?: unknown };
            void _extent;
            // Use a className instead of `hidden: true` so the React component
            // stays mounted — that keeps preview rAF loops running while the
            // group is collapsed (animated noise/math/clock previews don't pause).
            return { ...rest, className: 'fs-collapsed-member' } as AppNode;
          }
          return n;
        }),
        edges: updatedEdges,
        syncSource: 'graph',
        isUndoRedo: false,
      }));
      return;
    }

    // === Expand ===
    // Restore boundary edges to their original child endpoints, unhide internal
    // edges, unhide member nodes, and clear the synthetic socket lists on the group.
    const inputSocketLookup = new Map<string, BoundarySocket>();
    const outputSocketLookup = new Map<string, BoundarySocket>();
    for (const s of groupData.collapsedInputs ?? []) inputSocketLookup.set(s.socketId, s);
    for (const s of groupData.collapsedOutputs ?? []) outputSocketLookup.set(s.socketId, s);

    const restoredEdges: AppEdge[] = state.edges.map((e) => {
      // Output boundary restoration: edge currently points FROM the group, restore source.
      if (e.source === groupId && e.sourceHandle && outputSocketLookup.has(e.sourceHandle)) {
        const socket = outputSocketLookup.get(e.sourceHandle)!;
        return {
          ...e,
          id: generateEdgeId(
            socket.originalNodeId,
            socket.originalHandleId,
            e.target,
            e.targetHandle ?? 'in',
          ),
          source: socket.originalNodeId,
          sourceHandle: socket.originalHandleId,
        };
      }
      // Input boundary restoration: edge currently points TO the group, restore target.
      if (e.target === groupId && e.targetHandle && inputSocketLookup.has(e.targetHandle)) {
        const socket = inputSocketLookup.get(e.targetHandle)!;
        return {
          ...e,
          id: generateEdgeId(
            e.source,
            e.sourceHandle ?? 'out',
            socket.originalNodeId,
            socket.originalHandleId,
          ),
          target: socket.originalNodeId,
          targetHandle: socket.originalHandleId,
        };
      }
      // Internal edges (both endpoints in members) get their hide-class stripped.
      if (memberIds.has(e.source) && memberIds.has(e.target)) {
        const { className: _c, ...rest } = e as AppEdge & { className?: string };
        void _c;
        return rest as AppEdge;
      }
      return e;
    });

    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id === groupId) {
          const data = { ...(n.data as GroupNodeData) } as GroupNodeData;
          data.collapsed = false;
          data.width = data.expandedWidth ?? currentWidth;
          data.height = data.expandedHeight ?? currentHeight;
          delete data.collapsedInputs;
          delete data.collapsedOutputs;
          // Drop the cached cost — the expanded frame doesn't show a badge.
          delete data.cost;
          return {
            ...n,
            width: data.width,
            height: data.height,
            data,
          } as AppNode;
        }
        if (memberIds.has(n.id)) {
          // Strip the hide-class. We don't re-attach `extent: 'parent'` —
          // letting members be dragged outside is what enables drag-out-to-detach.
          const { className: _c, ...rest } = n as AppNode & { className?: string };
          void _c;
          return rest as AppNode;
        }
        return n;
      }),
      edges: restoredEdges,
      syncSource: 'graph',
      isUndoRedo: false,
    }));
  },

  saveGroupToLibrary: (groupId) => {
    const state = get();
    const groupNode = state.nodes.find((n) => n.id === groupId);
    if (!groupNode || groupNode.type !== 'group') return;

    // Snapshot the group itself + every direct child + every edge whose source
    // and target both live inside the group. Edges that cross the group
    // boundary are intentionally dropped — they reference nodes that won't
    // exist when the snippet is later dropped onto a different graph.
    const members = state.nodes.filter((n) => n.parentId === groupId);
    const memberIds = new Set([groupId, ...members.map((m) => m.id)]);
    const internalEdges = state.edges.filter(
      (e) => memberIds.has(e.source) && memberIds.has(e.target),
    );

    const groupData = groupNode.data as GroupNodeData;
    const saved: SavedGroup = {
      id: generateId(),
      name: groupData.label || 'Group',
      color: groupData.color || '#6366f1',
      // Deep clone so later edits to the live graph don't mutate the saved copy.
      nodes: structuredClone([groupNode, ...members]),
      edges: structuredClone(internalEdges),
    };

    const next = [...state.savedGroups, saved];
    persistSavedGroups(next);
    set({ savedGroups: next });
  },

  deleteSavedGroup: (savedId) => {
    const next = get().savedGroups.filter((g) => g.id !== savedId);
    persistSavedGroups(next);
    set({ savedGroups: next });
  },

  instantiateBuiltinTexture: (textureId, position) => {
    const textures = getBuiltinTextures();
    const texture = textures.find((t) => t.id === textureId);
    if (!texture || texture.nodes.length === 0) return;

    const idMap = new Map<string, string>();
    for (const n of texture.nodes) idMap.set(n.id, generateId());

    const [originalGroup, ...originalMembers] = texture.nodes;
    const newGroupId = idMap.get(originalGroup.id)!;

    const clonedGroup: AppNode = {
      ...structuredClone(originalGroup),
      id: newGroupId,
      position: { x: position.x, y: position.y },
      parentId: undefined,
      selected: false,
    } as AppNode;

    const clonedMembers: AppNode[] = originalMembers.map((m) => {
      const cloned = structuredClone(m);
      const newId = idMap.get(m.id)!;
      const out = {
        ...cloned,
        id: newId,
        parentId: newGroupId,
        selected: false,
      } as AppNode & { extent?: unknown };
      delete out.extent;
      return out;
    });

    const clonedEdges: AppEdge[] = texture.edges.map((e: AppEdge) => {
      const src = idMap.get(e.source) ?? e.source;
      const tgt = idMap.get(e.target) ?? e.target;
      return {
        ...structuredClone(e),
        id: generateEdgeId(src, e.sourceHandle ?? 'out', tgt, e.targetHandle ?? 'in'),
        source: src,
        target: tgt,
        selected: false,
      };
    });

    const state = get();
    get().pushHistory();
    set({
      nodes: [clonedGroup, ...state.nodes, ...clonedMembers] as AppNode[],
      edges: [...state.edges, ...clonedEdges] as AppEdge[],
      syncSource: 'graph',
      isUndoRedo: false,
    });
  },

  instantiateSavedGroup: (savedId, position) => {
    const state = get();
    const saved = state.savedGroups.find((g) => g.id === savedId);
    if (!saved || saved.nodes.length === 0) return;

    // Build an oldId → newId map up front so we can rewrite parentId + edges.
    const idMap = new Map<string, string>();
    for (const n of saved.nodes) idMap.set(n.id, generateId());

    // The first node in `saved.nodes` is always the group container itself
    // (saveGroupToLibrary writes it that way). Anchor it at the drop point and
    // let React Flow translate the children automatically via parentId.
    const [originalGroup, ...originalMembers] = saved.nodes;
    const newGroupId = idMap.get(originalGroup.id)!;

    const clonedGroup: AppNode = {
      ...structuredClone(originalGroup),
      id: newGroupId,
      position: { x: position.x, y: position.y },
      // Wipe parentId — saved snippets are always dropped at root level.
      parentId: undefined,
      selected: false,
    } as AppNode;

    const clonedMembers: AppNode[] = originalMembers.map((m) => {
      const cloned = structuredClone(m);
      const newId = idMap.get(m.id)!;
      // Re-parent under the new group; positions are already group-relative.
      // No `extent: 'parent'` — drag-out-to-detach relies on members being free
      // to leave the group's bounds.
      const out = {
        ...cloned,
        id: newId,
        parentId: newGroupId,
        selected: false,
      } as AppNode & { extent?: unknown };
      delete out.extent;
      return out;
    });

    const clonedEdges: AppEdge[] = saved.edges.map((e) => {
      const src = idMap.get(e.source) ?? e.source;
      const tgt = idMap.get(e.target) ?? e.target;
      return {
        ...structuredClone(e),
        id: generateEdgeId(src, e.sourceHandle ?? 'out', tgt, e.targetHandle ?? 'in'),
        source: src,
        target: tgt,
        selected: false,
      };
    });

    get().pushHistory();
    set({
      // Group container must come BEFORE its children in the array (React Flow
      // requirement). Append everything else after the existing graph.
      nodes: [clonedGroup, ...state.nodes, ...clonedMembers] as AppNode[],
      edges: [...state.edges, ...clonedEdges] as AppEdge[],
      syncSource: 'graph',
      isUndoRedo: false,
    });
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
