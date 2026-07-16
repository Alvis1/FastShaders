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
  NoteNodeData,
  BoundarySocket,
  TSLDataType,
} from '@/types';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import complexityData from '@/registry/complexity.json';
import { bridgeEdgesAcrossDeletedNodes, restoreCollapsedEdges } from '@/utils/edgeUtils';
import { normalizeChainOperands } from '@/utils/chainOperands';
import { nodeCostPoints } from '@/utils/nodeCost';
import { makeDataNodeData } from '@/utils/dataNode';
import { makeImageNodeData, sanitizeImageNodes } from '@/utils/imageNode';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { encodeImageFile } from '@/utils/imageImport';
import { transposeCsv, type ParsedCsv } from '@/utils/csvParser';

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

/**
 * JSON.parse reviver that drops dangerous structural keys.
 *
 * Without this a payload like `{"__proto__":{"polluted":1}}` ends up as a
 * literal own key on the parsed object — harmless in isolation under modern
 * V8, but the result then flows through `structuredClone`, spreads, and
 * `getNodeValues(node).<dynamic-key>` lookups across the engine. Stripping
 * `__proto__` / `constructor` / `prototype` at parse time means a tampered
 * localStorage value or a shared `.fastshader` file can't smuggle these
 * keys into the running app at all.
 */
function safeJsonReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

function loadSavedGroups(): SavedGroup[] {
  try {
    const raw = localStorage.getItem(SAVED_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw, safeJsonReviver);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (g): g is SavedGroup =>
          g && typeof g.id === 'string' && Array.isArray(g.nodes) && Array.isArray(g.edges),
      )
      // Bound image payloads from a (possibly tampered) localStorage value —
      // instantiating a group clones these nodes straight into the graph.
      // Hard violations only, same rule as loadGraph.
      .map((g) => ({ ...g, nodes: sanitizeImageNodes(g.nodes, false).nodes }));
  } catch {
    return [];
  }
}

// Once-per-failure-streak guards so a quota-stuck store doesn't re-alert on
// every debounced write; reset by the next successful write.
let graphQuotaWarned = false;
let groupsQuotaWarned = false;

function persistSavedGroups(groups: SavedGroup[]) {
  try {
    localStorage.setItem(SAVED_GROUPS_KEY, JSON.stringify(groups));
    groupsQuotaWarned = false;
  } catch {
    // Quota exceeded or private mode. The in-memory library stays usable this
    // session but will NOT survive a reload — tell the user (ground truth:
    // warn from the actual failure, not a size guess).
    if (!groupsQuotaWarned) {
      groupsQuotaWarned = true;
      useAppStore.getState().enqueueLimitNotice({
        id: generateId(),
        kind: 'storage-quota',
        detail: 'saved groups',
      });
    }
  }
}

/**
 * Clone a group snapshot (container + members + internal edges) with fresh ids,
 * anchored at `position`. First node in `snapshot.nodes` must be the group
 * container; the rest are its members.
 */
function cloneGroupSnapshot(
  snapshot: { nodes: AppNode[]; edges: AppEdge[] },
  position: { x: number; y: number },
): { group: AppNode; members: AppNode[]; edges: AppEdge[] } {
  const idMap = new Map<string, string>();
  for (const n of snapshot.nodes) idMap.set(n.id, generateId());

  const [originalGroup, ...originalMembers] = snapshot.nodes;
  const newGroupId = idMap.get(originalGroup.id)!;

  const group: AppNode = {
    ...structuredClone(originalGroup),
    id: newGroupId,
    position: { x: position.x, y: position.y },
    parentId: undefined,
    selected: false,
  } as AppNode;

  const members: AppNode[] = originalMembers.map((m) => {
    const out = {
      ...structuredClone(m),
      id: idMap.get(m.id)!,
      parentId: newGroupId,
      selected: false,
    } as AppNode & { extent?: unknown };
    delete out.extent;
    return out;
  });

  const edges: AppEdge[] = snapshot.edges.map((e) => {
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

  return { group, members, edges };
}

/** A dropped CSV whose column count exceeds COLUMN_WARN_THRESHOLD, awaiting the
 *  user's choice (cancel / place as-is / transpose) via CsvImportModal. Parsed
 *  once at drop time; position is already in flow coordinates. */
interface PendingCsvImport {
  id: string;
  fileName: string;
  columnCount: number;
  rowCount: number;
  parsed: ParsedCsv;
  position: { x: number; y: number };
}

/**
 * A limit/storage event awaiting user acknowledgement via LimitModal (shown
 * one at a time). Drop-time image notices carry the original File + drop
 * position so "Add anyway" can re-run the import with limits ignored.
 */
export interface LimitNotice {
  id: string;
  kind:
    | 'image-too-large'      // still over the per-image budget after downscale retries
    | 'image-too-many-pixels'// source dimensions exceed the decode guard
    | 'image-total-cap'      // adding it would cross the all-images budget
    | 'images-stripped'      // an imported project had payloads over the limits
    | 'storage-quota';       // a localStorage write actually failed
  fileName?: string;
  /** Free-form context for the message (count, sink name, dimensions…). */
  detail?: string;
  file?: File;
  position?: { x: number; y: number };
  /** For `image-total-cap`: the drop already encoded within the per-image
   *  budget — "Add anyway" places THIS payload instead of re-encoding at the
   *  relaxed dimension cap (which would silently produce a heavier image). */
  encoded?: { dataUrl: string; width: number; height: number };
}

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  type: 'canvas' | 'node' | 'shader' | 'edge' | 'group' | 'note' | 'stripes' | 'dataviz';
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

/**
 * Per-theme node-editor canvas defaults. The canvas backdrop is a user
 * preference remembered separately for light and dark mode; the dark default is
 * kept well below getContrastColor()'s 0.55 luminance threshold so 1-channel
 * edges + cost-badge text auto-flip to light on it.
 */
const DEFAULT_CANVAS_BG_LIGHT = '#FAFAFA';
const DEFAULT_CANVAS_BG_DARK = '#1e1f22';

/**
 * Stamp `data-theme` on <html> so the chrome tokens in tokens.css flip. The one
 * dark-mode control is the code-editor sun/moon button (codeEditorTheme), so the
 * app theme is derived from it: 'vs-dark' → dark, 'vs' → light. An inline script
 * in index.html sets this before first paint; this keeps it in sync on toggle.
 */
function applyThemeAttribute(theme: 'vs' | 'vs-dark'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme === 'vs-dark' ? 'dark' : 'light');
}

function snapshot(nodes: AppNode[], edges: AppEdge[]): HistoryEntry {
  return {
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
  };
}

const STORAGE_KEY = 'fs:graph';

/**
 * Graph auto-save is a side effect of importing this module (see the
 * `useAppStore.subscribe` at the bottom of the file), and `fs:graph` is a
 * single slot with no versioning or merge — last writer wins outright.
 *
 * That is fine while the editor is the only page mounting this store, but
 * `node-editor.html` mounts it too, purely to render read-only previews. Its
 * `nodes` hold whichever graph is being previewed — never the user's work —
 * so a write from there would destroy the real graph, unrecoverably (history
 * is in-memory only). Note the store's own actions `.map()` over `nodes`,
 * which yields a fresh array identity even when nothing matches, so an
 * incidental action on a page with an empty store is enough to arm the
 * subscribe and persist `{nodes: [], edges: []}`.
 *
 * Any entry point that mounts this store WITHOUT owning the user's graph must
 * call `setGraphPersistence(false)` before its first store write.
 */
let graphPersistence = true;

export function setGraphPersistence(enabled: boolean): void {
  graphPersistence = enabled;
}

function saveGraph(nodes: AppNode[], edges: AppEdge[]) {
  if (!graphPersistence) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, edges }));
    graphQuotaWarned = false;
  } catch {
    // Quota exceeded or private mode. Once auto-save starts failing, EVERY
    // subsequent edit is silently unsaved until the graph shrinks — surface it
    // once per failure streak so the user can act before a reload loses work.
    if (!graphQuotaWarned) {
      graphQuotaWarned = true;
      useAppStore.getState().enqueueLimitNotice({
        id: generateId(),
        kind: 'storage-quota',
        detail: 'graph auto-save',
      });
    }
  }
}

export function loadGraph(): { nodes: AppNode[]; edges: AppEdge[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw, safeJsonReviver);
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

      // Migrate: image nodes follow the noise nodes' opt-in exposedPorts rules
      // — auto-expose any param port that already has an edge so its socket
      // keeps rendering (graphs saved before the opt-in change, or hand-edited
      // files, may carry edges without the matching exposedPorts entry). Shared
      // with the project-import path so the two surfaces stay in lockstep.
      autoExposeConnectedParamPorts(data.nodes, data.edges);

      // Bound image payloads from a (possibly tampered) localStorage value.
      // Hard violations only — soft caps were already enforced at drop time,
      // and stripping a user-approved oversize payload here would clobber it
      // on the next auto-save.
      data.nodes = sanitizeImageNodes(data.nodes, false).nodes;

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

  // History (undo / redo). past/future are stacks of past states. `pushHistory`
  // snapshots the current state onto `past` before a mutation; `undo` moves the
  // tail of `past` to `future`; `redo` does the reverse. Any fresh mutation
  // clears `future` (standard undo-history semantics).
  past: HistoryEntry[];
  future: HistoryEntry[];
  isUndoRedo: boolean;

  // UI
  contextMenu: ContextMenuState;
  /** Queue of over-wide CSV drops awaiting a user decision (shown one at a time). */
  pendingCsvImports: PendingCsvImport[];
  /** Queue of limit/storage notices awaiting acknowledgement (LimitModal). */
  pendingLimitNotices: LimitNotice[];
  /** User opt-out of the image size limits (persisted; set via the LimitModal
   *  checkbox). Hard security ceilings still apply. */
  ignoreImageLimits: boolean;
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

  // Node editor background color (canvas backdrop). `nodeEditorBgColor` is the
  // EFFECTIVE value for the active theme (what the canvas + edge-contrast read);
  // the light/dark slots below remember each theme's pick independently.
  nodeEditorBgColor: string;
  nodeEditorBgColorLight: string;
  nodeEditorBgColorDark: string;

  // Code editor theme ('vs' = light, 'vs-dark' = dark). Also drives the app-wide
  // dark theme via the `data-theme` attribute on <html>.
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
  /**
   * Replace an edge's routing waypoints (visual-only). `history` pushes an undo
   * entry (once per gesture: at drag-start / on add / on remove — NOT on every
   * drag-move frame). Passing `undefined`/`[]` clears them.
   */
  setEdgeWaypoints: (
    edgeId: string,
    waypoints: Array<{ x: number; y: number }> | undefined,
    opts?: { history?: boolean },
  ) => void;
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
  /**
   * While true, `pushHistory` collapses to the single snapshot taken by
   * `beginInteraction`. See `beginInteraction`.
   */
  coalescingHistory: boolean;
  /**
   * Bracket a continuous gesture (e.g. scrubbing a DragNumberInput) so it lands
   * as ONE undo entry. Snapshots the pre-gesture state once, then suppresses
   * further pushes — which also stops the per-frame `structuredClone` of the
   * entire graph — until `endInteraction`. Safe to call when already bracketing.
   */
  beginInteraction: () => void;
  /** End the gesture opened by `beginInteraction`. Idempotent. */
  endInteraction: () => void;

  // UI actions
  openContextMenu: (x: number, y: number, type: 'canvas' | 'node' | 'shader' | 'edge' | 'group' | 'note' | 'stripes' | 'dataviz', nodeId?: string, edgeId?: string, sourceNodeId?: string, sourceHandleId?: string) => void;
  closeContextMenu: () => void;
  /** Add a CSV import awaiting a decision to the queue. */
  enqueueCsvImport: (item: PendingCsvImport) => void;
  /** Resolve the head of the CSV-import queue and advance to the next. */
  resolveCsvImport: (action: 'cancel' | 'continue' | 'transpose') => void;
  /** Add a limit/storage notice to the LimitModal queue. */
  enqueueLimitNotice: (notice: LimitNotice) => void;
  /** Resolve the head of the limit-notice queue. `proceed` re-imports the
   *  carried file with limits ignored. `ignoreFuture` is the checkbox state —
   *  it can turn the persisted opt-out on OR off. Every dismissal path in the
   *  UI commits it (the preference is orthogonal to whether this one image is
   *  added, so it must not depend on which cancel gesture was used); null is
   *  still honoured as "leave unchanged" for non-UI callers. */
  resolveLimitNotice: (action: 'dismiss' | 'proceed', ignoreFuture: boolean | null) => void;
  setIgnoreImageLimits: (v: boolean) => void;
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
  /** Delete a group AND every member node inside it. Edges are spliced across the removal set. */
  deleteGroup: (groupId: string) => void;
  /** Patch a group node's data (label / color). */
  updateGroupData: (groupId: string, data: Partial<GroupNodeData>) => void;
  /** Add a free-floating sticky note at the given flow-space position. */
  addNote: (position: { x: number; y: number }) => void;
  /** Patch a note node's data (heading / text / color / scale). */
  updateNoteData: (noteId: string, data: Partial<NoteNodeData>) => void;
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
  past: [],
  future: [],
  isUndoRedo: false,
  contextMenu: { open: false, x: 0, y: 0, type: 'canvas' },
  pendingCsvImports: [],
  pendingLimitNotices: [],
  ignoreImageLimits: loadString('fs:ignoreImageLimits', '0') === '1',
  splitRatio: loadRatio('fs:splitRatio', 0.6),
  rightSplitRatio: loadRatio('fs:rightSplitRatio', 0.6),
  shaderName: loadString('fs:shaderName', 'My Shader'),
  selectedHeadsetId: loadString('fs:headsetId', 'quest3'),
  nodeVarNames: {},
  costColorLow: loadString('fs:costColorLow', '#8BC34A'),
  costColorHigh: loadString('fs:costColorHigh', '#FF5722'),
  nodeEditorBgColorLight: loadString('fs:nodeEditorBgColor', DEFAULT_CANVAS_BG_LIGHT),
  nodeEditorBgColorDark: loadString('fs:nodeEditorBgColorDark', DEFAULT_CANVAS_BG_DARK),
  // Effective canvas backdrop = the active theme's slot.
  nodeEditorBgColor:
    loadString('fs:codeEditorTheme', 'vs') === 'vs-dark'
      ? loadString('fs:nodeEditorBgColorDark', DEFAULT_CANVAS_BG_DARK)
      : loadString('fs:nodeEditorBgColor', DEFAULT_CANVAS_BG_LIGHT),
  codeEditorTheme: (loadString('fs:codeEditorTheme', 'vs') === 'vs-dark' ? 'vs-dark' : 'vs'),
  savedGroups: loadSavedGroups(),

  setNodes: (nodes, source = 'graph') =>
    set({ nodes, syncSource: source, isUndoRedo: false }),

  setEdges: (edges, source = 'graph') =>
    set((state) => {
      // Compact grown variadic-arithmetic operands after any disconnect (a gap
      // row is removed and the rest shift up). Idempotent no-op otherwise.
      const norm = normalizeChainOperands(state.nodes, edges);
      return {
        edges: norm.edges,
        ...(norm.changed ? { nodes: norm.nodes } : {}),
        syncSource: source,
        isUndoRedo: false,
      };
    }),

  onNodesChange: (changes) =>
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as AppNode[],
      syncSource: 'graph',
    })),

  onEdgesChange: (changes) =>
    set((state) => {
      const applied = applyEdgeChanges(changes, state.edges) as AppEdge[];
      // Only removals can open a gap in a variadic operand list.
      if (!changes.some((c) => c.type === 'remove')) {
        return { edges: applied, syncSource: 'graph' as const };
      }
      const norm = normalizeChainOperands(state.nodes, applied);
      return {
        edges: norm.edges,
        ...(norm.changed ? { nodes: norm.nodes } : {}),
        syncSource: 'graph' as const,
      };
    }),

  addNode: (node) => {
    get().pushHistory();
    set((state) => ({ nodes: [...state.nodes, node], syncSource: 'graph', isUndoRedo: false }));
  },

  removeNode: (nodeId) => {
    get().pushHistory();
    set((state) => {
      const nodes = state.nodes.filter((n) => n.id !== nodeId);
      // Splice-delete: outgoing edges of the removed node re-parent to its
      // first connected input's upstream so the signal stays wired up.
      const bridged = bridgeEdgesAcrossDeletedNodes(state.edges, new Set([nodeId]));
      const norm = normalizeChainOperands(nodes, bridged);
      return { nodes: norm.nodes, edges: norm.edges, syncSource: 'graph', isUndoRedo: false };
    });
  },

  removeEdge: (edgeId) => {
    get().pushHistory();
    set((state) => {
      const norm = normalizeChainOperands(
        state.nodes,
        state.edges.filter((e) => e.id !== edgeId),
      );
      return {
        edges: norm.edges,
        ...(norm.changed ? { nodes: norm.nodes } : {}),
        syncSource: 'graph',
        isUndoRedo: false,
      };
    });
  },

  setEdgeWaypoints: (edgeId, waypoints, opts) => {
    if (opts?.history) get().pushHistory();
    set((state) => ({
      edges: state.edges.map((e) =>
        e.id === edgeId
          ? {
              ...e,
              data: {
                ...(e.data ?? { dataType: 'any' }),
                waypoints: waypoints && waypoints.length ? waypoints : undefined,
              },
            }
          : e,
      ) as AppEdge[],
      // Waypoints are visual — mark the change graph-sourced so the sync engine
      // regenerates code (a no-op string it dedupes) without a code→graph loop.
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

  coalescingHistory: false,

  beginInteraction: () =>
    set((state) => {
      if (state.coalescingHistory) return {};
      // Snapshots inline rather than delegating to pushHistory because — unlike
      // pushHistory — this deliberately does NOT honour `isUndoRedo`. That flag
      // guards the sync engine's own reconciliation right after an undo; a
      // pointer gesture is unambiguously a fresh user mutation, and letting a
      // not-yet-cleared flag suppress THIS snapshot while coalescing is switched
      // on would swallow the entire gesture's history and leave it unundoable.
      return {
        past: [...state.past, snapshot(state.nodes, state.edges)].slice(-MAX_HISTORY),
        future: [],
        coalescingHistory: true,
        isUndoRedo: false,
      };
    }),

  endInteraction: () => {
    if (!get().coalescingHistory) return;
    set({ coalescingHistory: false });
  },

  pushHistory: () =>
    set((state) => {
      if (state.isUndoRedo) return {};
      // One snapshot per bracketed gesture. A value scrub fires a change per
      // pointermove frame; without this each frame would deep-clone the whole
      // graph (megabytes once images are embedded) AND bury undo under dozens
      // of sub-pixel entries.
      if (state.coalescingHistory) return {};
      const entry = snapshot(state.nodes, state.edges);
      return {
        past: [...state.past, entry].slice(-MAX_HISTORY),
        future: [],
      };
    }),

  undo: () =>
    set((state) => {
      const prev = state.past[state.past.length - 1];
      if (!prev) return {};
      const current = snapshot(state.nodes, state.edges);
      return {
        nodes: structuredClone(prev.nodes),
        edges: structuredClone(prev.edges),
        past: state.past.slice(0, -1),
        future: [...state.future, current].slice(-MAX_HISTORY),
        syncSource: 'graph',
        isUndoRedo: true,
      };
    }),

  redo: () =>
    set((state) => {
      const next = state.future[state.future.length - 1];
      if (!next) return {};
      const current = snapshot(state.nodes, state.edges);
      return {
        nodes: structuredClone(next.nodes),
        edges: structuredClone(next.edges),
        future: state.future.slice(0, -1),
        past: [...state.past, current].slice(-MAX_HISTORY),
        syncSource: 'graph',
        isUndoRedo: true,
      };
    }),

  openContextMenu: (x, y, type, nodeId, edgeId, sourceNodeId, sourceHandleId) =>
    set({ contextMenu: { open: true, x, y, type, nodeId, edgeId, sourceNodeId, sourceHandleId } }),

  closeContextMenu: () =>
    set({ contextMenu: { open: false, x: 0, y: 0, type: 'canvas' } }),

  enqueueCsvImport: (item) =>
    set((state) => ({ pendingCsvImports: [...state.pendingCsvImports, item] })),

  resolveCsvImport: (action) => {
    const head = get().pendingCsvImports[0];
    if (!head) return;
    const dequeue = () =>
      set((state) => ({ pendingCsvImports: state.pendingCsvImports.slice(1) }));

    if (action === 'cancel') { dequeue(); return; }

    let parsed = head.parsed;
    if (action === 'transpose') {
      const t = transposeCsv(head.parsed);
      if (!t.ok) {
        // Can't transpose (would exceed the column cap) — surface it and skip
        // rather than placing an invalid node.
        window.alert(`Could not transpose "${head.fileName}":\n${t.error}`);
        dequeue();
        return;
      }
      parsed = t.data;
    }

    const cost = (complexityData.costs as Record<string, number>).dataNode ?? 2;
    get().addNode({
      id: generateId(),
      type: 'shader',
      position: head.position,
      data: makeDataNodeData(parsed, cost, head.fileName),
    } as AppNode);
    dequeue();
  },

  enqueueLimitNotice: (notice) =>
    set((state) => ({ pendingLimitNotices: [...state.pendingLimitNotices, notice] })),

  resolveLimitNotice: (action, ignoreFuture) => {
    const head = get().pendingLimitNotices[0];
    if (!head) return;
    if (ignoreFuture !== null && ignoreFuture !== get().ignoreImageLimits) {
      get().setIgnoreImageLimits(ignoreFuture);
    }
    set((state) => ({ pendingLimitNotices: state.pendingLimitNotices.slice(1) }));

    if (action !== 'proceed' || !head.file || !head.position) return;
    const { file, position, encoded } = head;
    const cost = (complexityData.costs as Record<string, number>).imageNode ?? 2;
    const place = (dataUrl: string, width: number, height: number) =>
      get().addNode({
        id: generateId(),
        type: 'shader',
        position,
        data: makeImageNodeData(dataUrl, width, height, cost, file.name),
      } as AppNode);

    if (encoded) {
      // Already encoded within the per-image budget (only the total cap hit).
      place(encoded.dataUrl, encoded.width, encoded.height);
      return;
    }
    // Re-run the import with the soft limits off (hard ceilings still apply).
    void encodeImageFile(file, true).then((res) => {
      if (!res.ok) {
        window.alert(`Could not load "${file.name}" as an image.`);
        return;
      }
      place(res.dataUrl, res.width, res.height);
    });
  },

  setIgnoreImageLimits: (v) => {
    try { localStorage.setItem('fs:ignoreImageLimits', v ? '1' : '0'); } catch { /* */ }
    set({ ignoreImageLimits: v });
  },

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
    // Remember the pick per theme: the picker edits the ACTIVE theme's canvas
    // only, so switching themes restores the other theme's backdrop.
    const isDark = get().codeEditorTheme === 'vs-dark';
    const key = isDark ? 'fs:nodeEditorBgColorDark' : 'fs:nodeEditorBgColor';
    try { localStorage.setItem(key, hex); } catch { /* */ }
    set(
      isDark
        ? { nodeEditorBgColor: hex, nodeEditorBgColorDark: hex }
        : { nodeEditorBgColor: hex, nodeEditorBgColorLight: hex },
    );
  },

  setCodeEditorTheme: (theme) => {
    try { localStorage.setItem('fs:codeEditorTheme', theme); } catch { /* */ }
    // Flip the app-wide chrome (tokens.css [data-theme="dark"]) and swap the
    // effective canvas backdrop to the newly-active theme's remembered color.
    applyThemeAttribute(theme);
    const state = get();
    const nodeEditorBgColor =
      theme === 'vs-dark' ? state.nodeEditorBgColorDark : state.nodeEditorBgColorLight;
    set({ codeEditorTheme: theme, nodeEditorBgColor });
  },

  groupSelection: (nodeIds) => {
    if (nodeIds.length < 2) return null;
    const state = get();
    // Only group nodes that exist and are not already groups/notes themselves.
    const members = state.nodes.filter(
      (n) => nodeIds.includes(n.id) && n.type !== 'group' && n.type !== 'note',
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
    const groupData = groupNode.data as GroupNodeData;
    const wasCollapsed = !!groupData.collapsed;

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
        // If the group was collapsed, members carry `fs-collapsed-member`;
        // drop it so they render normally after being lifted.
        if (wasCollapsed) {
          const { className: _c, ...liftedRest } = lifted as AppNode & { className?: string };
          void _c;
          return liftedRest as AppNode;
        }
        return lifted;
      });

    // Collapsed groups rewrite boundary edges to point at the group's
    // synthetic handles (__in_*, __out_*) and mark internal edges with
    // `fs-collapsed-edge` to hide them. Without restoring here, deleting
    // a collapsed group leaves behind stale boundary edges pointing at the
    // now-missing group (ghost edges) and internal edges that stay
    // `display: none` even though both endpoints still exist.
    let newEdges = state.edges;
    if (wasCollapsed) {
      newEdges = restoreCollapsedEdges(state.edges, state.nodes, groupNode);
    }

    set({ nodes: newNodes, edges: newEdges, syncSource: 'graph', isUndoRedo: false });
  },

  deleteGroup: (groupId) => {
    const state = get();
    const groupNode = state.nodes.find((n) => n.id === groupId);
    if (!groupNode || groupNode.type !== 'group') return;

    // Everything to remove: the group node + every descendant (handles nested
    // groups correctly by walking parentId transitively).
    const toRemove = new Set<string>([groupId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of state.nodes) {
        if (!toRemove.has(n.id) && n.parentId && toRemove.has(n.parentId)) {
          toRemove.add(n.id);
          grew = true;
        }
      }
    }

    get().pushHistory();
    // Splice-delete edges across the removed run so signal stays wired when
    // the group sat mid-graph; then drop any edge still touching the removal set.
    const bridged = bridgeEdgesAcrossDeletedNodes(state.edges, toRemove);
    const edges = bridged.filter((e) => !toRemove.has(e.source) && !toRemove.has(e.target));
    const norm = normalizeChainOperands(
      state.nodes.filter((n) => !toRemove.has(n.id)),
      edges,
    );
    set({
      nodes: norm.nodes,
      edges: norm.edges,
      syncSource: 'graph',
      isUndoRedo: false,
    });
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

  addNote: (position) => {
    const note = {
      id: generateId(),
      type: 'note',
      position,
      // React Flow honors width/height directly on the node; NodeResizer mutates them.
      width: 240,
      height: 150,
      // Dragged only by the header bar so the body textarea stays editable.
      dragHandle: '.note-node__header',
      data: {
        registryType: 'note',
        heading: 'Note',
        text: '',
        color: '#fff7cc',
        headerColor: '#ffd24a',
        scale: 1,
      } as NoteNodeData,
    } as AppNode;
    get().pushHistory();
    // Prepend so the note keeps a stable slot at the front of the array. Its
    // on-screen layer is driven by the note's CSS z-index (above the graph),
    // not array order. Notes are never parents/children, so this can't break
    // the group parent-before-child ordering invariant.
    set((state) => ({ nodes: [note, ...state.nodes], syncSource: 'graph', isUndoRedo: false }));
  },

  // No pushHistory here: notes are low-stakes annotations and inline typing
  // would otherwise flood the 50-entry history buffer on every keystroke.
  updateNoteData: (noteId, data) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === noteId ? { ...n, data: { ...n.data, ...data } } : n,
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
      const def = NODE_REGISTRY.get(n.data.registryType);
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
      const def = NODE_REGISTRY.get(n.data.registryType);
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

    /** Sum of GPU costs of every member node, displayed above the group as a
     *  badge. Uses nodeCostPoints so variadic arithmetic members are counted at
     *  their operand-scaled cost, matching the live total. */
    let groupCostSum = 0;
    for (const m of state.nodes) {
      if (!memberIds.has(m.id)) continue;
      groupCostSum += nodeCostPoints(m, state.edges);
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

      // Two-phase commit: React Flow only measures a handle's bounding rect
      // after the Handle component mounts + ResizeObserver fires, so the
      // synthetic sockets minted above aren't yet in `nodeLookup.handleBounds`
      // when EdgeWrapper renders this turn. If we rewired the boundary edges
      // in the same `set()`, React Flow's `getEdgePosition` would log
      // "Couldn't create edge for target handle id: __in_..." for every
      // boundary edge before `updateNodeInternals` corrects things on the next
      // render. We avoid the warning by deferring the rewire one frame:
      //   1. commit the node updates (handles render → ResizeObserver fires)
      //      and mark each boundary edge `hidden: true` so React Flow doesn't
      //      try to draw it against unmeasured handles
      //   2. on the next rAF, swap in `updatedEdges` (now safe to look up)
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
              // Keep `measured` in sync with the new size. React Flow's
              // ResizeObserver will eventually re-measure and overwrite this,
              // but our unparent-on-drag logic reads `measured.width` first and
              // would otherwise see the pre-toggle dimensions until that tick.
              measured: { width: COLLAPSED_W, height: collapsedH },
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
        edges: s.edges.map((e) => {
          const srcInside = memberIds.has(e.source);
          const tgtInside = memberIds.has(e.target);
          if (srcInside && tgtInside) {
            // Internal edge — same final state as `updatedEdges` so phase 2 is a no-op for it.
            return { ...e, className: 'fs-collapsed-edge' };
          }
          if (srcInside !== tgtInside) {
            // Boundary edge: hide it for this one frame so React Flow doesn't
            // try to position it against the not-yet-measured synthetic handle.
            return { ...e, hidden: true };
          }
          return e;
        }),
        syncSource: 'graph',
        isUndoRedo: false,
      }));

      // Phase 2 — rewire the boundary edges to the synthetic sockets. Handles
      // have mounted and been measured by the time this rAF callback runs, so
      // the lookups in `getEdgePosition` succeed and no devWarn fires.
      requestAnimationFrame(() => {
        set((s) => {
          // If the user already expanded the group (or undid the collapse)
          // during the one-frame gap, abort — phase 2 would otherwise
          // overwrite the now-restored edges with stale rewired ones.
          const group = s.nodes.find((n) => n.id === groupId);
          if (!group || group.type !== 'group' || !(group.data as GroupNodeData).collapsed) {
            return {};
          }
          return { edges: updatedEdges, syncSource: 'graph', isUndoRedo: false };
        });
      });
      return;
    }

    // === Expand ===
    // Restore boundary edges to their original child endpoints, unhide internal
    // edges, unhide member nodes, and clear the synthetic socket lists on the group.
    const restoredEdges = restoreCollapsedEdges(state.edges, state.nodes, groupNode);

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
            // See collapse branch: force `measured` to match so the unparent-
            // on-drag hit-test uses the expanded frame immediately, without
            // waiting for the ResizeObserver tick that would otherwise leave
            // it reporting the pill footprint.
            measured: { width: data.width, height: data.height },
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
    const texture = getBuiltinTextures().find((t) => t.id === textureId);
    if (!texture || texture.nodes.length === 0) return;
    const { group, members, edges } = cloneGroupSnapshot(texture, position);
    const state = get();
    get().pushHistory();
    set({
      nodes: [group, ...state.nodes, ...members] as AppNode[],
      edges: [...state.edges, ...edges] as AppEdge[],
      syncSource: 'graph',
      isUndoRedo: false,
    });
  },

  instantiateSavedGroup: (savedId, position) => {
    const state = get();
    const saved = state.savedGroups.find((g) => g.id === savedId);
    if (!saved || saved.nodes.length === 0) return;
    const { group, members, edges } = cloneGroupSnapshot(saved, position);
    // React Flow requires the parent container before its children in the array.
    get().pushHistory();
    set({
      nodes: [group, ...state.nodes, ...members] as AppNode[],
      edges: [...state.edges, ...edges] as AppEdge[],
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
