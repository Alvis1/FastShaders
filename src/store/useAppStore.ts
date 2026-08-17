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
import { getNodeValues } from '@/types';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { autoLayout } from '@/engine/layoutEngine';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import complexityData from '@/registry/complexity.json';
import { bridgeEdgesAcrossDeletedNodes, restoreCollapsedEdges, unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { safeJsonReviver } from '@/utils/safeJson';
import { authoredUniformChange } from '@/utils/uniformOverride';
import { normalizeChainOperands } from '@/utils/chainOperands';
import { nodeCostPoints, setCostOverrides, computeReachableCost, sanitizeCostMap } from '@/utils/nodeCost';
import { type ParsedCostFile, type CostProfile, profileFromParsed, sanitizeCostMeta } from '@/utils/costOverride';
import { makeDataNodeData, sanitizeDataNodes } from '@/utils/dataNode';
import { sanitizeDataRangeNodes } from '@/utils/dataRangeFormula';
import { makeImageNodeFromEncode, resolveImageDrop, sanitizeImageNodes, type ImageOriginInfo } from '@/utils/imageNode';
import { stashImageOrigin } from '@/utils/imageOriginCache';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { selectionOnlyGraphChange } from '@/utils/graphSemantics';
import { sanitizeDrawings, MAX_STROKES, MAX_TOTAL_POINTS, type DrawStroke } from '@/utils/drawings';
import {
  sanitizePalettes,
  sanitizePaletteName,
  mintPaletteId,
  MAX_PALETTES_PER_SHADER,
  type Palette,
} from '@/utils/palettes';
import { sanitizeEdgeExtras } from '@/utils/edgeExtras';
import type { PreviewMesh } from '@/utils/previewMesh';
import { savePreviewMeshToCache } from '@/utils/previewMeshCache';
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

// Exported for savedGroupsSanitize.test.ts — module init calls it against the
// real localStorage, the test re-runs it against a stubbed one.
export function loadSavedGroups(): SavedGroup[] {
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
      // This is the THIRD untrusted restore path (same localStorage trust
      // level as fs:graph), and instantiating a group clones these
      // nodes/edges straight into the live graph — so it gets the same
      // repairs loadGraph and applyProjectToStore run: image/data payload
      // bounds, edge-`data` sanitizing (TypedEdge dereferences `waypoints`
      // during RENDER, no error boundary), and exposedPorts normalization
      // (ShaderNode does `new Set(data.exposedPorts)` during render, and
      // `new Set(5)` throws).
      .map((g) => {
        autoExposeConnectedParamPorts(g.nodes, g.edges);
        return {
          ...g,
          nodes: sanitizeDataRangeNodes(
            sanitizeDataNodes(sanitizeImageNodes(g.nodes, false).nodes).nodes,
          ),
          edges: sanitizeEdgeExtras(g.edges),
        };
      });
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
    | 'image-revert-cap'     // restoring an image's original would cross it
    | 'image-device-downscaled' // resized to fit the target device's texture cap (informational)
    | 'images-stripped'      // an imported project had payloads over the limits
    | 'storage-quota';       // a localStorage write actually failed
  fileName?: string;
  /** Free-form context for the message (count, sink name, dimensions…). */
  detail?: string;
  file?: File;
  position?: { x: number; y: number };
  /** For `image-total-cap`: the drop already encoded within the per-image
   *  budget — "Add anyway" places THIS payload instead of re-encoding at the
   *  relaxed dimension cap (which would silently produce a heavier image).
   *  `origin` rides along so the override keeps the drop's revert stash. */
  encoded?: { dataUrl: string; width: number; height: number; origin?: ImageOriginInfo };
  /** The drop's convert-or-keep choice, carried so an "Add anyway" re-encode
   *  doesn't silently convert an image the user asked to keep as-is. */
  convert?: boolean;
  /** For `image-device-downscaled`: informational context only — the node is
   *  already placed; this notice just tells the user what was resized and why. */
  downscale?: {
    deviceLabel: string;
    cap: number;
    sourceW: number;
    sourceH: number;
    finalW: number;
    finalH: number;
  };
}

/**
 * Which settings menu the right-click opens. Most nodes take the generic
 * `'node'` menu; the dataviz family each have their own because their controls
 * are neither plain numbers nor exposable ports (a colormap picker, a mode list
 * with explanations). `NODE_MENU_TYPES` in NodeEditor maps registryType → the
 * matching entry here — keep the two in step.
 */
export type ContextMenuType =
  | 'canvas'
  | 'node'
  | 'shader'
  | 'edge'
  | 'group'
  | 'note'
  | 'stripes'
  | 'dataviz'
  | 'colormap'
  | 'dataRange';

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  type: ContextMenuType;
  nodeId?: string;
  edgeId?: string;
  /** Source pin info when menu was opened by dragging from an output handle. */
  sourceNodeId?: string;
  sourceHandleId?: string;
}

interface HistoryEntry {
  nodes: AppNode[];
  edges: AppEdge[];
  // Board drawings ride history too, but BY REFERENCE (not structuredClone):
  // committed strokes are immutable and every drawings mutation replaces the
  // array, so the old reference is a safe, pointer-sized snapshot — this keeps
  // 40k-point ink out of the 50-entry deep-clone buffer.
  drawings: DrawStroke[];
  // Shader-scoped colour palettes ride history on exactly the same terms as
  // `drawings`: BY REFERENCE, because every palette action REPLACES the array
  // rather than mutating it, so the old reference is already an immutable
  // snapshot. structuredCloning them would put 16×64 hex strings into all 50
  // history entries for nothing.
  shaderPalettes: Palette[];
}

const MAX_HISTORY = 50;

function loadRatio(key: string, fallback: number, min = 0.25, max = 0.75): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '');
    return isNaN(v) ? fallback : Math.max(min, Math.min(max, v));
  } catch {
    return fallback;
  }
}

/**
 * The preview/code seam, as the TOP pane's (= the 3D preview's) share.
 *
 * The panes swapped — the preview used to sit BELOW the code editor, and
 * `fs:rightSplitRatio` stored the CODE editor's share. Reading the legacy key
 * and inverting it keeps each user's proportions across the change instead of
 * snapping everyone back to the default (or, worse, silently reading a
 * code-height as a preview-height). Read ONCE into the new key and never
 * written again — the same one-way migration the asset bar's legacy
 * collapse/zoom keys get.
 */
const RIGHT_SPLIT_KEY = 'fs:previewSplitRatio';
const RIGHT_SPLIT_LEGACY_KEY = 'fs:rightSplitRatio';
/** Preview floor / code-editor collapse ceiling; mirrors SplitPane's clampCross
 *  (which is the pixel-accurate bound during a drag). */
export const RIGHT_SPLIT_MIN = 0.25;
export const RIGHT_SPLIT_MAX = 0.99;

function loadRightSplitRatio(): number {
  const v = loadRatio(RIGHT_SPLIT_KEY, NaN, RIGHT_SPLIT_MIN, RIGHT_SPLIT_MAX);
  if (!Number.isNaN(v)) return v;
  // No new key yet: invert the legacy code-share if there is one. Its own
  // bounds (0.01–0.75) are applied BEFORE the flip, so a collapsed code pane
  // inverts to a near-full preview and then re-clamps.
  const legacy = loadRatio(RIGHT_SPLIT_LEGACY_KEY, NaN, 0.01, 0.75);
  if (Number.isNaN(legacy)) return 0.4;
  return Math.max(RIGHT_SPLIT_MIN, Math.min(RIGHT_SPLIT_MAX, 1 - legacy));
}

function loadString(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function loadCostProfiles(): CostProfile[] {
  try {
    const raw = localStorage.getItem('fs:costProfiles');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as Record<string, unknown>).id === 'string')
      .map((p) => {
        // Adversarial: a tampered fs:costProfiles must not inject unknown keys,
        // junk budgets, or a non-array meta.reasons (which would crash the
        // CostBar's reasons.join). sanitizeCostMap + sanitizeCostMeta + the
        // Number guards are the full trust boundary for a persisted profile.
        const costs = sanitizeCostMap((p as { costs?: unknown }).costs);
        const maxPoints = Number((p as { maxPoints?: unknown }).maxPoints);
        const maxTextureDim = Number((p as { maxTextureDim?: unknown }).maxTextureDim);
        return {
          id: String((p as { id: string }).id),
          label: typeof (p as { label?: unknown }).label === 'string' ? String((p as { label: string }).label) : 'measured',
          maxPoints: Number.isFinite(maxPoints) && maxPoints > 0 ? maxPoints : 200,
          maxTextureDim: Number.isFinite(maxTextureDim) && maxTextureDim > 0 ? maxTextureDim : 2048,
          costs,
          meta: sanitizeCostMeta((p as { meta?: unknown }).meta),
        } as CostProfile;
      })
      .filter((p) => Object.keys(p.costs).length > 0);
  } catch { return []; }
}
const bootCostProfiles = loadCostProfiles();
const bootSelectedId = loadString('fs:headsetId', 'quest3');
// Apply the active profile's measured costs to the nodeCost module BEFORE React
// mounts, so the first CostBar/badge render already reflects the selected device.
setCostOverrides(bootCostProfiles.find((p) => p.id === bootSelectedId)?.costs ?? null);

/**
 * Per-theme node-editor canvas defaults. The canvas backdrop is a user
 * preference remembered separately for light and dark mode; the dark default is
 * kept well below getContrastColor()'s 0.55 luminance threshold so 1-channel
 * edges + cost-badge text auto-flip to light on it.
 */
const DEFAULT_CANVAS_BG_LIGHT = '#FAFAFA';
// Grey, not near-black: matches the dark chrome ramp in tokens.css. The canvas
// is what the (fixed off-white) nodes sit on, so this is the single biggest
// lever on how harsh dark mode reads. Sits just under --bg-app so the graph
// still reads as recessed behind the panels around it.
const DEFAULT_CANVAS_BG_DARK = '#41454d';

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

/**
 * Stamp `lang` on <html> so the document advertises its UI language (a11y +
 * spellcheck). Latvian is a display-only overlay — nothing stored, generated,
 * or searched changes — so this attribute + a React re-render is all a language
 * switch needs. Mirrors applyThemeAttribute; an inline guard in index.html sets
 * it before first paint and this keeps it in sync on toggle.
 */
function applyLangAttribute(lang: 'en' | 'lv'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('lang', lang);
}

function snapshot(
  nodes: AppNode[],
  edges: AppEdge[],
  drawings: DrawStroke[],
  shaderPalettes: Palette[],
): HistoryEntry {
  return {
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
    drawings, // by reference — see HistoryEntry
    shaderPalettes, // by reference — see HistoryEntry
  };
}

/** The current state's history snapshot. One call site per `set` that records
 *  history, so a new by-reference slice can never be added to `HistoryEntry`
 *  and forgotten at one of them. */
function snapshotOf(state: {
  nodes: AppNode[];
  edges: AppEdge[];
  drawings: DrawStroke[];
  shaderPalettes: Palette[];
}): HistoryEntry {
  return snapshot(state.nodes, state.edges, state.drawings, state.shaderPalettes);
}

/**
 * Clean one incoming palette and give it an id unique among the ones this
 * shader already holds. `sanitizePalettes` mints a fresh id here (nothing is
 * passed in, so a caller can never smuggle one) and de-dupes within its own
 * batch — but not against the LIVE list, which a project import can have seeded
 * from a crafted file whose ids happen to match the local mint format.
 */
function makePalette(
  input: { name?: string; colors: readonly string[]; names?: readonly string[] },
  existing: Palette[],
): Palette | null {
  const [clean] = sanitizePalettes([
    { name: input.name, colors: input.colors, names: input.names },
  ]);
  if (!clean) return null;
  const taken = new Set(existing.map((p) => p.id));
  let id = clean.id;
  while (taken.has(id)) id = mintPaletteId();
  return { ...clean, id };
}

/**
 * The name a document starts life with — at first boot AND after NEW, so the
 * two are indistinguishable. Exported because the shader name is a FILE name
 * everywhere it leaves the app (export download, desktop Work-folder save), so
 * "a document nobody has named" needs one spelling, not two.
 */
export const DEFAULT_SHADER_NAME = 'My Shader';

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

function saveGraph(
  nodes: AppNode[],
  edges: AppEdge[],
  drawings: DrawStroke[],
  palettes: Palette[],
) {
  if (!graphPersistence) return;
  // Node env (tests) has no localStorage at all — that's not a quota
  // condition, so bail before the try/catch would surface a bogus notice.
  if (typeof localStorage === 'undefined') return;
  try {
    // Strip ephemeral per-element UI state: selection/drag/resize flags are
    // meaningless across a reload (and the autosave subscriber deliberately
    // skips selection-only updates, so persisting them would go stale anyway).
    const bareNodes = nodes.map(({ selected, dragging, resizing, ...n }) => n);
    const bareEdges = edges.map(({ selected, ...e }) => e);
    // Board drawings share the graph slot — visual siblings of nodes/edges,
    // loaded/saved together. Palettes ride the same slot for the same reason:
    // they belong to the SHADER, not to the browser profile. Both are omitted
    // when empty so a shader that has neither writes the payload it always did.
    const payload = {
      nodes: bareNodes,
      edges: bareEdges,
      ...(drawings.length ? { drawings } : {}),
      ...(palettes.length ? { palettes } : {}),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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

export function loadGraph(): {
  nodes: AppNode[];
  edges: AppEdge[];
  drawings: DrawStroke[];
  palettes: Palette[];
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw, safeJsonReviver);
    if (Array.isArray(data.nodes) && Array.isArray(data.edges)) {
      // Migrate: legacy tsl-textures nodes are removed — drop them entirely
      // so the graph still loads. Edges that referenced them are also pruned
      // below. Nodes saved with the (now-removed) `texturePreview` flow type
      // or any `tslTex_*` registry type fall into this bucket.
      // Migrate: micNode moved off ShaderNode onto its own MicNode component
      // (flow type 'mic'). Graphs saved before that carry type 'shader' and
      // would keep rendering through the old row layout, which no longer has
      // any micNode handling at all — so re-derive it.
      for (const node of data.nodes as { type?: string; data?: { registryType?: string } }[]) {
        if (node?.data?.registryType === 'micNode') node.type = 'mic';
      }
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

      // Data-node CSV blobs are adversarial for the same reason. The cap is the
      // construction bound, so no payload this app wrote can be affected.
      data.nodes = sanitizeDataNodes(data.nodes).nodes;

      // A Data Range formula is a user-authored STRING, so it is bounded here
      // for the same reason — it rides ~50 history snapshots, every autosave and
      // every export. This is a RESOURCE bound, not the security control: the
      // grammar gate lives at the emitter, which is the only place the string
      // could become code.
      data.nodes = sanitizeDataRangeNodes(data.nodes);

      // Edge `data` is adversarial too, and it is the one graph payload nothing
      // validated — TypedEdge maps `waypoints` and dereferences `w.x` during
      // RENDER, with no error boundary anywhere in the app, so `waypoints:
      // [null]` from a tampered value blanks the whole editor on every boot.
      data.edges = sanitizeEdgeExtras(data.edges);

      // Board drawings are adversarial too (tampered localStorage) — bound them.
      data.drawings = sanitizeDrawings(data.drawings);

      // Palettes likewise: `fs:graph` is user-writable, palette names are
      // RENDERED and palette ids are used as React keys / object lookups, so
      // this value gets the same trust boundary an imported file gets. An
      // absent key sanitizes to [] — which is exactly the pre-palette payload.
      data.palettes = sanitizePalettes(data.palettes);

      return data;
    }
  } catch { /* corrupt data */ }
  return null;
}

export interface VRHeadset {
  id: string;
  label: string;
  maxPoints: number;
  /** Recommended max texture (longest-side) dimension for this device's GPU.
   *  Dropped images are downscaled to fit it (see `encodeImageFile`); it is an
   *  upper bound, not a target — the per-image byte budget can shrink further. */
  maxTextureDim: number;
}

export const VR_HEADSETS: VRHeadset[] = [
  // The ONE measured device — ShaderCarousel/benchData/quest3-20260723 is the
  // calibration basis for complexity.json's prices AND this budget. The
  // paper-spec presets (Quest 2/3S, Steam Frame, Pico 4, Vision Pro) were
  // REMOVED 2026-08-14 by owner decision: an unmeasured budget certifies
  // shaders for hardware nobody ran, and the CostBar's benchmark import is
  // exactly how a device earns a row — run ShaderCarousel on it, import the
  // result JSON, and it appears under "Measured" with its own prices. A
  // persisted fs:headsetId naming a removed preset degrades to this entry
  // (every resolver falls back to VR_HEADSETS[0]). For the record, the
  // pixel-scaling arithmetic for a same-GPU sibling: Quest 3S = 200 ×
  // (2064·2208)/(1832·1920) ≈ 260 (same Adreno 740, fewer pixels to fill).
  { id: 'quest3', label: 'Meta Quest 3', maxPoints: 200, maxTextureDim: 2048 },
];

/** Recommended max texture dimension for a headset id (falls back to the first
 *  preset for an unknown id — matches CostBar's headset lookup). */
export function deviceMaxTextureDim(headsetId: string): number {
  return (VR_HEADSETS.find((h) => h.id === headsetId) ?? VR_HEADSETS[0]).maxTextureDim;
}

/**
 * Resolve the active device's label + points budget from a selection id that
 * may be either a built-in headset id OR a measured cost-profile id. Shared by
 * the CostBar and the Output-node settings so both show the same budget when a
 * measured profile is selected. Unknown ids fall back to the first headset.
 */
export function resolveDeviceBudget(
  id: string,
  profiles: { id: string; label: string; maxPoints: number }[],
): { label: string; maxPoints: number; isProfile: boolean } {
  const p = profiles.find((x) => x.id === id);
  if (p) return { label: p.label, maxPoints: p.maxPoints, isProfile: true };
  const h = VR_HEADSETS.find((x) => x.id === id) ?? VR_HEADSETS[0];
  return { label: h.label, maxPoints: h.maxPoints, isProfile: false };
}

/**
 * Image-downscale texture cap for the active device — a measured profile carries
 * the cap it inherited at import, otherwise the headset's `maxTextureDim`. Keeps
 * the texture cap consistent with the selection when a cost profile is active
 * (selecting a profile must not silently loosen a stricter headset's cap).
 */
export function resolveDeviceTextureDim(
  id: string,
  profiles: { id: string; maxTextureDim: number }[],
): number {
  return profiles.find((x) => x.id === id)?.maxTextureDim ?? deviceMaxTextureDim(id);
}

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
  /** Suppress the informational "image resized for your device" notice
   *  (persisted; set via that notice's "Don't show again" checkbox). Distinct
   *  from `ignoreImageLimits` — this hides a warning, it doesn't lift a cap. */
  hideImageDownscaleWarning: boolean;
  /** Drop-time image conversion (WebP + power-of-two): ask each time, or a
   *  remembered answer. Persisted to `fs:imageConvert`. Conversion is lossy in
   *  ways the app can't judge for the user (a normal map wants "keep", a photo
   *  wants "convert") and it cannot tell which it has at drop time — hence a
   *  choice rather than a default. */
  imageConvertMode: 'ask' | 'always' | 'never';
  /** Suppress the "not optimized" one-liner shown when a requested conversion
   *  fell back (persisted; set from that line's "?" panel). It reports a
   *  browser capability, so once understood it has nothing left to say. */
  hideImageConvertNotice: boolean;
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

  // Measured cost profiles (dropped benchmark tables). Listed in the
  // performance-device dropdown alongside VR_HEADSETS; the active one (selected
  // via selectedHeadsetId, which may hold a profile id) applies its costs over
  // complexity.json AND its budget. `costVersion` bumps whenever the active
  // table changes so cost readers (badges) re-render.
  costProfiles: CostProfile[];
  costVersion: number;

  // Node editor background color (canvas backdrop). `nodeEditorBgColor` is the
  // EFFECTIVE value for the active theme (what the canvas + edge-contrast read);
  // the light/dark slots below remember each theme's pick independently.
  nodeEditorBgColor: string;
  nodeEditorBgColorLight: string;
  nodeEditorBgColorDark: string;

  // Code editor theme ('vs' = light, 'vs-dark' = dark). Also drives the app-wide
  // dark theme via the `data-theme` attribute on <html>.
  codeEditorTheme: 'vs' | 'vs-dark';

  // UI language ('en' = English, 'lv' = Latvian). Latvian is a display-only
  // overlay resolved at render (with English fallback); canonical English is
  // kept everywhere strings are stored, generated, or searched. See src/i18n.
  language: 'en' | 'lv';

  // User's library of saved groups (persisted to localStorage)
  savedGroups: SavedGroup[];

  // Custom preview mesh (a dropped/imported .obj/.glb/.gltf) — the model the
  // preview's 'custom' geometry renders. SESSION-ONLY: deliberately absent
  // from history snapshots, graph autosave, and the project embed (the bytes
  // can be tens of MB; the zip export carries the model as a file instead).
  previewMesh: PreviewMesh | null;
  // Whether Export bundles the loaded preview mesh into the zip (the EXPORT
  // button's right-click setting). SESSION-ONLY like the mesh it governs — a
  // persisted "off" would silently strip models from exports weeks later.
  exportIncludeMesh: boolean;
  // The preview top bar's WGSL/GLSL toggle — true forces the sandboxed 3D
  // preview onto the WebGL2/GLSL backend (what the immersive popup and Safari
  // always run), so backend-dependent shader behavior is checkable without a
  // headset. SESSION-ONLY like exportIncludeMesh: a persisted force would
  // leave the preview silently degraded weeks later, which reads as "WebGPU
  // broke" rather than "I left a diagnostic on".
  previewForceWebGL2: boolean;

  // Board drawings (freehand ink annotations) — VISUAL-ONLY, like notes /
  // waypoints. Separate slice so graphToCode / cpuEvaluator / the sync engine
  // never see them; they ride graph autosave + history + the project embed.
  drawings: DrawStroke[];
  // Draw-tool prefs (persisted). `drawToolActive` / `drawEraser` are session
  // UI state (not persisted).
  drawColor: string;
  drawOpacity: number;
  drawWidth: number;
  drawToolActive: boolean;
  drawEraser: boolean;

  /**
   * The shader's own colour palettes — SHADER-SCOPED, exactly like `drawings`:
   * they ride the `fs:graph` autosave, undo history and the
   * FASTSHADERS_PROJECT_V1 project block, so opening a shader gives you the
   * palettes it was authored with. There is deliberately NO cross-shader
   * library; moving a palette between shaders is an explicit file export/import
   * (which is also what makes it shareable with someone who does not have this
   * browser profile). `BUILTIN_PALETTES` stay read-only in code and are never
   * copied in here — the UI shows them below the shader's own.
   *
   * Invisible to graphToCode / cpuEvaluator / the sync engine: a palette is
   * authoring metadata, so it can never change a single byte of emitted shader
   * code.
   */
  shaderPalettes: Palette[];

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
  /**
   * Start a fresh shader: the graph becomes a single Output node and edges +
   * board ink are dropped. One undo entry restores the whole previous document
   * (nodes, edges and drawings are exactly what a history snapshot holds).
   */
  newGraph: () => void;

  // Drawing actions
  /** Commit one finished stroke (one undo entry). Caps drop the oldest ink. */
  addStroke: (stroke: DrawStroke) => void;
  /** Remove strokes by id (eraser / clear-selection); one undo entry. */
  eraseStrokeIds: (ids: string[]) => void;
  /** Drop every stroke (one undo entry). */
  clearDrawings: () => void;
  /** Replace the drawings array wholesale WITHOUT history (load / import / undo internals). */
  setDrawings: (drawings: DrawStroke[]) => void;
  setDrawColor: (color: string) => void;
  setDrawOpacity: (opacity: number) => void;
  setDrawWidth: (width: number) => void;
  /** Enter/leave draw mode. Leaving also clears the eraser sub-mode. */
  setDrawToolActive: (active: boolean) => void;
  setDrawEraser: (eraser: boolean) => void;

  // Palette actions
  //
  // ALL FOUR CRUD ACTIONS SNAPSHOT INLINE (see `newGraph`, which documents the
  // same trap) instead of calling `pushHistory`. `pushHistory` hard-bails while
  // `coalescingHistory` is set, and the colour picker brackets every pick with
  // `useHistoryBracket`, which holds that bracket open for a 600 ms IDLE window
  // AFTER the pick lands. A palette edit made inside that window — "pick a
  // colour, then hit Add palette", the single most likely real sequence — would
  // therefore be silently NOT recorded: the edit becomes unrecoverable and the
  // next Cmd+Z jumps back past the colour pick. Closing the bracket first is
  // not the fix either; that would split the pick's own single undo entry.
  /** Append one palette (sanitized; id minted locally). Returns the new id, or
   *  null when it had no usable colour or the per-shader cap is full. */
  addPalette: (input: { name?: string; colors: readonly string[]; names?: readonly string[] }) => string | null;
  /** Rename and/or recolour one palette. No-op (and NO history entry) when the
   *  id is unknown or the patch changes nothing. */
  updatePalette: (
    id: string,
    patch: { name?: string; colors?: readonly string[]; names?: readonly string[] },
  ) => void;
  /** Remove one palette. No-op when the id is unknown. */
  deletePalette: (id: string) => void;
  /** Move one palette to `toIndex` (clamped). Order is user-meaningful, so this
   *  is a real edit with its own undo entry. */
  reorderPalette: (id: string, toIndex: number) => void;
  /** Replace the palette list wholesale WITHOUT history (load / import / undo
   *  internals). Mirrors `setDrawings` — including its contract: the CALLER
   *  owns sanitization, because every ingestion path already has a boundary
   *  (`loadGraph`, `applyProjectToStore`, the file parser) and re-sanitizing
   *  here would mint a new array identity on every call, which the autosave
   *  subscriber uses to decide whether anything changed. */
  setShaderPalettes: (palettes: Palette[]) => void;

  // Code actions
  setCode: (code: string, source?: SyncSource) => void;
  setCodeErrors: (errors: ParseError[]) => void;
  codeSyncRequested: boolean;
  requestCodeSync: () => void;

  // Complexity actions
  setTotalCost: (cost: number) => void;
  importCostProfile: (parsed: ParsedCostFile) => void;
  deleteCostProfile: (id: string) => void;

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
   * How many live `beginInteraction` calls the open bracket carries. The
   * bracket is a single global flag, but gestures can overlap (a settings
   * menu's idle-timed text bracket + a DragNumberInput scrub): nesting-aware
   * begin/end means a deferred close from one gesture can never terminate a
   * bracket another gesture is still riding — which would flood history with
   * per-frame full-graph snapshots for the rest of the scrub.
   */
  interactionDepth: number;
  /**
   * Bracket a continuous gesture (e.g. scrubbing a DragNumberInput) so it lands
   * as ONE undo entry. Snapshots the pre-gesture state once, then suppresses
   * further pushes — which also stops the per-frame `structuredClone` of the
   * entire graph — until `endInteraction`. Safe to call when already bracketing
   * (increments the nesting depth instead of re-snapshotting).
   */
  beginInteraction: () => void;
  /** End one `beginInteraction`. Closes the bracket only at depth 0. Idempotent. */
  endInteraction: () => void;

  // UI actions
  openContextMenu: (x: number, y: number, type: ContextMenuType, nodeId?: string, edgeId?: string, sourceNodeId?: string, sourceHandleId?: string) => void;
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
  setHideImageDownscaleWarning: (v: boolean) => void;
  setImageConvertMode: (v: 'ask' | 'always' | 'never') => void;
  setHideImageConvertNotice: (v: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  setRightSplitRatio: (ratio: number) => void;

  // Shader name + headset actions
  setShaderName: (name: string) => void;
  /**
   * Load/replace/clear the custom preview mesh — never history, autosave, or
   * the project embed. The bytes ARE mirrored into an IndexedDB cache so the
   * mesh survives a reload (utils/previewMeshCache.ts); pass
   * `{ persist: false }` from the restore path itself, which would otherwise
   * write the bytes it just read straight back.
   */
  setPreviewMesh: (mesh: PreviewMesh | null, opts?: { persist?: boolean }) => void;
  setExportIncludeMesh: (include: boolean) => void;
  setPreviewForceWebGL2: (force: boolean) => void;
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

  // Language actions
  setLanguage: (lang: 'en' | 'lv') => void;

  // Group actions
  /** Wraps the given node ids in a new group node and returns the group id (or null if <2 nodes). */
  groupSelection: (nodeIds: string[]) => string | null;
  /**
   * Auto-layout the currently selected nodes in place (right-click a selection
   * → Organize): re-runs the top-aligned longest-path layout on just the
   * selected subgraph, re-anchored at the selection's old top-left corner.
   * A selected group rides as one unit (its members follow via parentId).
   */
  organizeSelection: () => void;
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
  /** Drop a built-in preset group onto the canvas at `position` (flow coords). */
  instantiateBuiltinPreset: (presetId: string, position: { x: number; y: number }) => void;
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
  hideImageDownscaleWarning: loadString('fs:hideImageDownscaleWarning', '0') === '1',
  imageConvertMode: (() => {
    const v = loadString('fs:imageConvert', 'ask');
    return v === 'always' || v === 'never' ? v : 'ask';
  })(),
  hideImageConvertNotice: loadString('fs:hideImageConvertNotice', '0') === '1',
  splitRatio: loadRatio('fs:splitRatio', 0.6),
  rightSplitRatio: loadRightSplitRatio(),
  shaderName: loadString('fs:shaderName', DEFAULT_SHADER_NAME),
  selectedHeadsetId: bootSelectedId,
  nodeVarNames: {},
  costColorLow: loadString('fs:costColorLow', '#8BC34A'),
  costColorHigh: loadString('fs:costColorHigh', '#FF5722'),
  costProfiles: bootCostProfiles,
  costVersion: 0,
  nodeEditorBgColorLight: loadString('fs:nodeEditorBgColor', DEFAULT_CANVAS_BG_LIGHT),
  nodeEditorBgColorDark: loadString('fs:nodeEditorBgColorDark', DEFAULT_CANVAS_BG_DARK),
  // Effective canvas backdrop = the active theme's slot.
  nodeEditorBgColor:
    loadString('fs:codeEditorTheme', 'vs') === 'vs-dark'
      ? loadString('fs:nodeEditorBgColorDark', DEFAULT_CANVAS_BG_DARK)
      : loadString('fs:nodeEditorBgColor', DEFAULT_CANVAS_BG_LIGHT),
  codeEditorTheme: (loadString('fs:codeEditorTheme', 'vs') === 'vs-dark' ? 'vs-dark' : 'vs'),
  language: (loadString('fs:lang', 'en') === 'lv' ? 'lv' : 'en'),
  savedGroups: loadSavedGroups(),
  previewMesh: null,
  exportIncludeMesh: true,
  previewForceWebGL2: false,

  // Drawings are hydrated from fs:graph by App.tsx (loadGraph) alongside the
  // graph; tool prefs are their own persisted keys.
  drawings: [],
  drawColor: (() => { const c = loadString('fs:drawColor', '#e8455f'); return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : '#e8455f'; })(),
  drawOpacity: (() => { const v = parseFloat(loadString('fs:drawOpacity', '1')); return isNaN(v) ? 1 : Math.min(1, Math.max(0.05, v)); })(),
  drawWidth: (() => { const v = parseFloat(loadString('fs:drawWidth', '3')); return isNaN(v) ? 3 : Math.min(200, Math.max(0.5, v)); })(),
  drawToolActive: false,
  drawEraser: false,

  // Palettes are hydrated from fs:graph by App.tsx (loadGraph) alongside the
  // graph and the ink, and replaced wholesale by a project import.
  shaderPalettes: [],

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
    // `values` gates the lookup: most callers patch label/exposedPorts/settings,
    // and a value edit is a per-pointermove event on a scrub.
    const before = 'values' in data ? get().nodes.find((n) => n.id === nodeId) : undefined;
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n
      ) as AppNode[],
      syncSource: 'graph',
      isUndoRedo: false,
    }));
    // Editing a named property's NUMBER is the one act that outranks a value
    // the user tuned in the preview's Uniforms overlay — the preview persists
    // tuning by name and re-pushes it after every rebuild, so without this the
    // node said one thing and the shader ran another, forever, and on a binary
    // channel like Discard that reads as the app being broken.
    //
    // This is the authoring CHOKEPOINT: every caller is a node widget or a
    // settings menu. Import, undo/redo, the code→graph sync and "Set as
    // default" all go through setNodes and correctly stay silent. Announcing
    // the node id (rather than letting the preview infer intent from "the
    // literal for this NAME moved") is what makes the rule immune to a
    // nodes-array reorder flipping which of two same-named properties owns the
    // bare identifier — which would otherwise destroy tuning after a group drag.
    if (before && typeof window !== 'undefined') {
      const change = authoredUniformChange(
        before,
        get().nodes.find((n) => n.id === nodeId),
        get().nodeVarNames,
      );
      if (change) {
        window.dispatchEvent(new CustomEvent('fs:uniform-authored', { detail: change }));
      }
    }
  },

  newGraph: () => {
    // The name resets too, and that is load-bearing rather than tidiness: the
    // shader name is what every export path turns into a FILE name, and the
    // desktop Work folder now adopts the opened file's name on load (see
    // utils/workFolderFile.ts). Keeping it would leave the name box — and so
    // the derived save target — pointing at the file just opened. It is half of
    // the fix; the `fs:graph-new` dispatch below is the other half, and NEITHER
    // is redundant: the reset moves the DERIVED name, the event drops the
    // TRACKED file, and a document already at the default name needs the second
    // one because it kebabs to the same file the reset would produce. Not
    // undoable (`shaderName` is absent from HistoryEntry), which is acceptable
    // for a visible text box.
    try { localStorage.setItem('fs:shaderName', DEFAULT_SHADER_NAME); } catch { /* quota */ }
    set((state) => ({
      shaderName: DEFAULT_SHADER_NAME,
      // Snapshots inline rather than delegating to pushHistory for the same
      // reason beginInteraction does: pushHistory honours `isUndoRedo`, and a
      // not-yet-cleared flag (set by an undo whose sync reconciliation hasn't
      // run yet) would silently swallow THIS entry — leaving the user's whole
      // document unrecoverable behind an unundoable clear. A NEW click is
      // unambiguously a fresh user mutation. Snapshot + clear in ONE `set` so
      // no subscriber can observe a cleared graph with un-snapshotted history.
      past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
      future: [],
      // A shader needs somewhere to end up, so the blank document is the one
      // node that can't be added back from the palette twice (AddNodeMenu and
      // the tile drop both refuse a second Output).
      nodes: [
        {
          id: generateId(),
          type: 'output',
          position: { x: 0, y: 0 },
          data: { registryType: 'output', label: 'Output', cost: 0 },
        } as AppNode,
      ],
      edges: [],
      drawings: [],
      // A new shader starts with no palettes of its own, exactly as a fresh
      // boot does — they belong to the document being cleared, and the one
      // undo entry above puts them back with it. The BUILTIN_PALETTES the UI
      // shows underneath are code, not user data, so they are unaffected.
      shaderPalettes: [],
      syncSource: 'graph',
      isUndoRedo: false,
    }));
    // The blank document has no file behind it. The name reset above cannot say
    // that on its own — a document already AT the default kebabs to the same
    // file name, so the desktop Work folder would keep treating the shader it
    // last opened as this one's home and replace it on the next Save, silently
    // (work_folder_write has no undo). Its own event, not `fs:graph-imported`:
    // that one arms NodeEditor's import auto-fit, and startNewShader already
    // schedules its own.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fs:graph-new'));
    }
  },

  // ── Drawing actions ──────────────────────────────────────────────────────
  // Drawings are visual-only: these NEVER touch syncSource, so the graph→code
  // effect (which watches nodes/edges) doesn't re-run. History + autosave pick
  // them up via `drawings` identity.
  addStroke: (stroke) => {
    get().pushHistory();
    set((state) => {
      let next = [...state.drawings, stroke];
      // Cap the stroke count — the board is full, drop the OLDEST ink.
      if (next.length > MAX_STROKES) next = next.slice(next.length - MAX_STROKES);
      // Cap the total point budget the same way.
      let total = next.reduce((n, s) => n + s.points.length, 0);
      while (total > MAX_TOTAL_POINTS * 2 && next.length > 1) {
        total -= next[0].points.length;
        next = next.slice(1);
      }
      return { drawings: next, isUndoRedo: false };
    });
  },

  eraseStrokeIds: (ids) => {
    if (!ids.length) return;
    const drop = new Set(ids);
    if (!get().drawings.some((s) => drop.has(s.id))) return;
    get().pushHistory();
    set((state) => ({ drawings: state.drawings.filter((s) => !drop.has(s.id)), isUndoRedo: false }));
  },

  clearDrawings: () => {
    if (!get().drawings.length) return;
    get().pushHistory();
    set({ drawings: [], isUndoRedo: false });
  },

  setDrawings: (drawings) => set({ drawings }),

  setDrawColor: (color) => {
    const c = /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : get().drawColor;
    try { localStorage.setItem('fs:drawColor', c); } catch { /* quota */ }
    set({ drawColor: c });
  },
  setDrawOpacity: (opacity) => {
    const o = Math.min(1, Math.max(0.05, Number.isFinite(opacity) ? opacity : 1));
    try { localStorage.setItem('fs:drawOpacity', String(o)); } catch { /* quota */ }
    set({ drawOpacity: o });
  },
  setDrawWidth: (width) => {
    const w = Math.min(200, Math.max(0.5, Number.isFinite(width) ? width : 3));
    try { localStorage.setItem('fs:drawWidth', String(w)); } catch { /* quota */ }
    set({ drawWidth: w });
  },
  setDrawToolActive: (active) => set(active ? { drawToolActive: true } : { drawToolActive: false, drawEraser: false }),
  setDrawEraser: (eraser) => set({ drawEraser: eraser }),

  // ── Palette actions ──────────────────────────────────────────────────────
  // Visual-only, like drawings: these NEVER touch syncSource, so the graph→code
  // effect doesn't re-run and no emitted byte can move. History + autosave pick
  // them up via `shaderPalettes` identity.
  //
  // Every one of them snapshots INLINE (`past` written in the same `set` as the
  // mutation) rather than delegating to `pushHistory` — see the interface
  // declaration above for the 600 ms colour-picker bracket that would otherwise
  // swallow the entry.
  addPalette: (input) => {
    const existing = get().shaderPalettes;
    if (existing.length >= MAX_PALETTES_PER_SHADER) return null;
    const created = makePalette(input, existing);
    if (!created) return null;
    set((state) => ({
      past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
      future: [],
      shaderPalettes: [...state.shaderPalettes, created],
      isUndoRedo: false,
    }));
    return created.id;
  },

  updatePalette: (id, patch) =>
    set((state) => {
      const idx = state.shaderPalettes.findIndex((p) => p.id === id);
      if (idx < 0) return {};
      const current = state.shaderPalettes[idx];
      const name =
        patch.name === undefined ? current.name : sanitizePaletteName(patch.name, current.name);
      // Colours go through the same whitelist an imported file gets — the
      // picker is not the only caller (a paste box hands over raw strings).
      // `colors` and `names` are patched TOGETHER through the one sanitizer
      // call, because that call is what keeps them positionally aligned: it
      // rebuilds both from the same loop, so a colour it rejects drops its
      // label with it. Patching them in two calls would let a rejected colour
      // shift every later name onto the wrong swatch.
      const patchedColors = patch.colors === undefined ? current.colors : patch.colors;
      const patchedNames = patch.names === undefined ? current.names : patch.names;
      const cleaned =
        patch.colors === undefined && patch.names === undefined
          ? { colors: current.colors, names: current.names }
          : sanitizePalettes([{ colors: patchedColors, names: patchedNames }])[0];
      // A recolour that leaves nothing valid is REFUSED rather than turned into
      // an empty row the user cannot tell from a rendering bug — the same call
      // sanitizePalettes itself makes when it drops a colourless palette.
      if (!cleaned) return {};
      const { colors, names } = cleaned;
      const sameNames =
        (names?.length ?? 0) === (current.names?.length ?? 0) &&
        (names ?? []).every((n, i) => n === (current.names ?? [])[i]);
      const unchanged =
        name === current.name &&
        colors.length === current.colors.length &&
        colors.every((c, i) => c === current.colors[i]) &&
        sameNames;
      // No change means no undo entry: a rename dialog that re-commits the same
      // text must not bury the user's real edits under no-op steps.
      if (unchanged) return {};
      const next = [...state.shaderPalettes];
      // `names` is spread conditionally so an unlabelled palette keeps NO key
      // at all — the autosave payload and project block then stay byte-identical
      // to what a build without per-colour names wrote.
      next[idx] = names ? { id: current.id, name, colors, names } : { id: current.id, name, colors };
      return {
        past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
        future: [],
        shaderPalettes: next,
        isUndoRedo: false,
      };
    }),

  deletePalette: (id) =>
    set((state) => {
      if (!state.shaderPalettes.some((p) => p.id === id)) return {};
      return {
        past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
        future: [],
        shaderPalettes: state.shaderPalettes.filter((p) => p.id !== id),
        isUndoRedo: false,
      };
    }),

  reorderPalette: (id, toIndex) =>
    set((state) => {
      const from = state.shaderPalettes.findIndex((p) => p.id === id);
      if (from < 0 || !Number.isFinite(toIndex)) return {};
      // Clamped rather than rejected: a drag past either end of the list means
      // "first" / "last", which is what the user did.
      const to = Math.max(0, Math.min(state.shaderPalettes.length - 1, Math.trunc(toIndex)));
      if (to === from) return {};
      const next = [...state.shaderPalettes];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return {
        past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
        future: [],
        shaderPalettes: next,
        isUndoRedo: false,
      };
    }),

  setShaderPalettes: (palettes) => set({ shaderPalettes: palettes }),

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

  importCostProfile: (parsed) => {
    // Budget for the new profile = the currently-active device's budget, so the
    // bar's scale doesn't jump on import; the meaningful change is the repriced
    // table. Re-importing the same run replaces its entry (stable id).
    const { costProfiles, selectedHeadsetId } = get();
    const { maxPoints } = resolveDeviceBudget(selectedHeadsetId, costProfiles);
    const maxTextureDim = resolveDeviceTextureDim(selectedHeadsetId, costProfiles);
    const profile = profileFromParsed(parsed, maxPoints, maxTextureDim);
    const nextProfiles = [...costProfiles.filter((p) => p.id !== profile.id), profile];
    try { localStorage.setItem('fs:costProfiles', JSON.stringify(nextProfiles)); } catch { /* quota */ }
    // Persist selection + activate: set the list first so setSelectedHeadsetId
    // can resolve the new profile, then select it (applies costs + recompute).
    set({ costProfiles: nextProfiles });
    get().setSelectedHeadsetId(profile.id);
  },

  deleteCostProfile: (id) => {
    const { costProfiles, selectedHeadsetId } = get();
    const nextProfiles = costProfiles.filter((p) => p.id !== id);
    try { localStorage.setItem('fs:costProfiles', JSON.stringify(nextProfiles)); } catch { /* */ }
    set({ costProfiles: nextProfiles });
    // If the removed profile was active, fall back to the default headset — this
    // clears the override (base costs) and recomputes via setSelectedHeadsetId.
    if (selectedHeadsetId === id) get().setSelectedHeadsetId(VR_HEADSETS[0].id);
  },

  setSyncInProgress: (v) => set({ syncInProgress: v }),

  coalescingHistory: false,
  interactionDepth: 0,

  beginInteraction: () =>
    set((state) => {
      if (state.coalescingHistory) {
        // Nested gesture riding the open bracket — count it so a deferred
        // close from the outer gesture can't cut this one short.
        return { interactionDepth: state.interactionDepth + 1 };
      }
      // Snapshots inline rather than delegating to pushHistory because — unlike
      // pushHistory — this deliberately does NOT honour `isUndoRedo`. That flag
      // guards the sync engine's own reconciliation right after an undo; a
      // pointer gesture is unambiguously a fresh user mutation, and letting a
      // not-yet-cleared flag suppress THIS snapshot while coalescing is switched
      // on would swallow the entire gesture's history and leave it unundoable.
      return {
        past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
        future: [],
        coalescingHistory: true,
        interactionDepth: 1,
        isUndoRedo: false,
      };
    }),

  endInteraction: () => {
    const state = get();
    if (!state.coalescingHistory) return;
    if (state.interactionDepth > 1) {
      set({ interactionDepth: state.interactionDepth - 1 });
      return;
    }
    set({ coalescingHistory: false, interactionDepth: 0 });
  },

  pushHistory: () =>
    set((state) => {
      if (state.isUndoRedo) return {};
      // One snapshot per bracketed gesture. A value scrub fires a change per
      // pointermove frame; without this each frame would deep-clone the whole
      // graph (megabytes once images are embedded) AND bury undo under dozens
      // of sub-pixel entries.
      if (state.coalescingHistory) return {};
      const entry = snapshotOf(state);
      return {
        past: [...state.past, entry].slice(-MAX_HISTORY),
        future: [],
      };
    }),

  undo: () =>
    set((state) => {
      const prev = state.past[state.past.length - 1];
      if (!prev) return {};
      const current = snapshotOf(state);
      return {
        nodes: structuredClone(prev.nodes),
        edges: structuredClone(prev.edges),
        drawings: prev.drawings, // by reference — immutable strokes
        shaderPalettes: prev.shaderPalettes, // by reference — replaced, never mutated
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
      const current = snapshotOf(state);
      return {
        nodes: structuredClone(next.nodes),
        edges: structuredClone(next.edges),
        drawings: next.drawings, // by reference — immutable strokes
        shaderPalettes: next.shaderPalettes, // by reference — replaced, never mutated
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
    // Same construction path as the canvas drop (makeImageNodeFromEncode), so
    // an "Add anyway" image is indistinguishable from a normal one — provenance
    // included. Dropping it here is what would leave every override-placed
    // image permanently un-revertible.
    const place = (
      enc: { dataUrl: string; width: number; height: number },
      origin?: ImageOriginInfo,
    ) =>
      get().addNode({
        id: generateId(),
        type: 'shader',
        position,
        data: makeImageNodeFromEncode(enc, cost, file.name, origin),
      } as AppNode);

    if (encoded) {
      // Already encoded within the per-image budget (only the total cap hit).
      // The stash was written before the notice was raised, so its id is
      // carried here rather than re-derived.
      place(encoded, encoded.origin);
      return;
    }
    // Re-run the import with the soft limits off (hard ceilings still apply).
    // Still honour the device cap as the dimension floor (see encodeImageFile).
    void encodeImageFile(
      file,
      true,
      resolveDeviceTextureDim(get().selectedHeadsetId, get().costProfiles),
      head.convert === false ? 'keep' : 'convert',
    ).then((res) => {
      if (!res.ok) {
        window.alert(`Could not load "${file.name}" as an image.`);
        return;
      }
      // Same rule as the drop path: a power-of-two snap that can't be stashed
      // is discarded rather than shipped irreversibly (resolveImageDrop).
      const { payload, origin } = resolveImageDrop(res, file.name, (p) =>
        stashImageOrigin(p, Date.now()),
      );
      place(payload, origin);
    });
  },

  setIgnoreImageLimits: (v) => {
    try { localStorage.setItem('fs:ignoreImageLimits', v ? '1' : '0'); } catch { /* */ }
    set({ ignoreImageLimits: v });
  },

  setHideImageDownscaleWarning: (v) => {
    try { localStorage.setItem('fs:hideImageDownscaleWarning', v ? '1' : '0'); } catch { /* */ }
    set({ hideImageDownscaleWarning: v });
  },

  setImageConvertMode: (v) => {
    try { localStorage.setItem('fs:imageConvert', v); } catch { /* */ }
    set({ imageConvertMode: v });
  },

  setHideImageConvertNotice: (v) => {
    try { localStorage.setItem('fs:hideImageConvertNotice', v ? '1' : '0'); } catch { /* */ }
    set({ hideImageConvertNotice: v });
  },

  setSplitRatio: (ratio) => {
    const clamped = Math.max(0.25, Math.min(0.75, ratio));
    try { localStorage.setItem('fs:splitRatio', String(clamped)); } catch { /* */ }
    set({ splitRatio: clamped });
  },

  setRightSplitRatio: (ratio) => {
    // The 0.99 ceiling, not 0.75: the seam may ride DOWN to the code editor's
    // tab bar. The pixel-accurate ceiling lives in SplitPane (CROSS_MIN_PANE_PX)
    // — a ratio can't express "the tab bar's height" without knowing the pane
    // in px, so this stays the persistence-level safety net.
    const clamped = Math.max(RIGHT_SPLIT_MIN, Math.min(RIGHT_SPLIT_MAX, ratio));
    try { localStorage.setItem(RIGHT_SPLIT_KEY, String(clamped)); } catch { /* */ }
    set({ rightSplitRatio: clamped });
  },

  setShaderName: (name) => {
    try { localStorage.setItem('fs:shaderName', name); } catch { /* */ }
    set({ shaderName: name });
  },

  setPreviewMesh: (mesh, opts) => {
    set({ previewMesh: mesh });
    // Fire-and-forget: the cache is a convenience, so a quota/private-mode
    // failure must never make the drop itself fail. savePreviewMeshToCache
    // resolves on every error path rather than rejecting.
    if (opts?.persist !== false) void savePreviewMeshToCache(mesh);
  },

  setExportIncludeMesh: (include) => set({ exportIncludeMesh: include }),

  setPreviewForceWebGL2: (force) => set({ previewForceWebGL2: force }),

  setSelectedHeadsetId: (id) => {
    // Selecting a device may be a measured cost profile (its id) or a built-in
    // headset — apply the matching cost table (profile costs, else base) and
    // recompute the total + Output-node cost, bumping costVersion so badges
    // repaint. Ignore an id that resolves to NEITHER (e.g. a foreign `cp:` id
    // embedded in an imported project the user doesn't have) — persisting and
    // applying it would silently clobber the user's real device selection with a
    // dangling phantom. Keeping the current selection is the correct fallback.
    const { costProfiles, nodes, edges } = get();
    const isKnown = VR_HEADSETS.some((h) => h.id === id) || costProfiles.some((p) => p.id === id);
    if (!isKnown) return;
    try { localStorage.setItem('fs:headsetId', id); } catch { /* */ }
    setCostOverrides(costProfiles.find((p) => p.id === id)?.costs ?? null);
    const total = computeReachableCost(nodes, unwrapCollapsedGroupEdges(nodes, edges));
    const outputNode = nodes.find((n) => n.data.registryType === 'output');
    set((state) => ({
      selectedHeadsetId: id,
      costVersion: state.costVersion + 1,
      totalCost: total,
      ...(outputNode && outputNode.data.cost !== total
        ? { nodes: state.nodes.map((n) => (n.id === outputNode.id ? { ...n, data: { ...n.data, cost: total } } : n)) as AppNode[] }
        : {}),
    }));
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

  setLanguage: (lang) => {
    try { localStorage.setItem('fs:lang', lang); } catch { /* */ }
    applyLangAttribute(lang);
    set({ language: lang });
  },

  groupSelection: (nodeIds) => {
    if (nodeIds.length < 2) return null;
    const state = get();
    // Only group nodes that exist and are not already groups themselves.
    // Notes ARE groupable: a note is usually the label for the very cluster
    // being grouped, so leaving it behind stranded the annotation outside the
    // frame it describes. It has no shader semantics either way — graphToCode
    // ignores it exactly like it ignores the group container.
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
    /**
     * Extra room above the topmost member, on top of PADDING.
     *
     * A member's cost badge is absolutely positioned at `top: -14px` and rides
     * the card's cost-scale transform (up to 1.35x, so ~19px above the card).
     * With only PADDING between the header and the card, a costly node's badge
     * sat flush against the header bar — the number and the group title read as
     * one collided row. This buys the badge its own clear band.
     */
    const BADGE_CLEARANCE = 14;
    const TOP_PADDING = PADDING + BADGE_CLEARANCE;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of members) {
      const { w, h } = getSize(m);
      minX = Math.min(minX, m.position.x);
      minY = Math.min(minY, m.position.y);
      maxX = Math.max(maxX, m.position.x + w);
      maxY = Math.max(maxY, m.position.y + h);
    }

    const groupX = minX - PADDING;
    const groupY = minY - TOP_PADDING - HEADER_H;
    const groupW = (maxX - minX) + PADDING * 2;
    const groupH = (maxY - minY) + TOP_PADDING + PADDING + HEADER_H;

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

  organizeSelection: () => {
    const state = get();
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    // Notes are free-floating annotations — the graph layout has no meaningful
    // place for them, so they stay put.
    const selected = state.nodes.filter((n) => n.selected && n.type !== 'note');
    if (selected.length < 2) return;
    const selectedIds = new Set(selected.map((n) => n.id));

    // Layout units: a selected node rides with its parent when that parent (or
    // any ancestor group) is also selected — laying both out independently
    // would move the member twice.
    const hasSelectedAncestor = (n: AppNode): boolean => {
      let pid = n.parentId;
      while (pid) {
        if (selectedIds.has(pid)) return true;
        pid = byId.get(pid)?.parentId;
      }
      return false;
    };
    const units = selected.filter((n) => !hasSelectedAncestor(n));
    if (units.length < 2) return;
    const unitIds = new Set(units.map((n) => n.id));

    // Absolute position of a (possibly group-nested) node.
    const absOf = (n: AppNode): { x: number; y: number } => {
      let x = n.position.x;
      let y = n.position.y;
      let pid = n.parentId;
      while (pid) {
        const p = byId.get(pid);
        if (!p) break;
        x += p.position.x;
        y += p.position.y;
        pid = p.parentId;
      }
      return { x, y };
    };

    // Edges between units, with endpoints lifted to their unit: an edge into a
    // selected group's member connects the GROUP unit (collapsed groups already
    // carry rewritten boundary edges pointing at the group node itself).
    const unitOf = (id: string): string | null => {
      let n = byId.get(id);
      while (n) {
        if (unitIds.has(n.id)) return n.id;
        n = n.parentId ? byId.get(n.parentId) : undefined;
      }
      return null;
    };
    const seenPairs = new Set<string>();
    const unitEdges: AppEdge[] = [];
    for (const e of state.edges) {
      const src = unitOf(e.source);
      const tgt = unitOf(e.target);
      if (!src || !tgt || src === tgt) continue;
      const key = `${src}\0${tgt}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      unitEdges.push({ ...e, source: src, target: tgt });
    }

    // Lay out the units in absolute space (autoLayout assigns fresh positions;
    // spreading keeps `measured` on each node so the real DOM boxes are used),
    // then translate the result back onto the selection's old top-left corner
    // so the organized cluster stays where the user had it.
    const absUnits = units.map((n) => ({ ...n, position: absOf(n) }) as AppNode);
    const laid = autoLayout(absUnits, unitEdges, 'LR');
    let oldMinX = Infinity, oldMinY = Infinity, newMinX = Infinity, newMinY = Infinity;
    for (const n of absUnits) {
      oldMinX = Math.min(oldMinX, n.position.x);
      oldMinY = Math.min(oldMinY, n.position.y);
    }
    for (const n of laid) {
      newMinX = Math.min(newMinX, n.position.x);
      newMinY = Math.min(newMinY, n.position.y);
    }
    const dx = oldMinX - newMinX;
    const dy = oldMinY - newMinY;
    const newAbs = new Map(
      laid.map((n) => [n.id, { x: n.position.x + dx, y: n.position.y + dy }]),
    );

    // Frame (w/h) of a node, same source precedence NodeEditor uses for its
    // group-containment test: measured DOM box → explicit props → data dims.
    const frameSize = (n: AppNode, gw: number, gh: number): { w: number; h: number } => {
      const m = (n as { measured?: { width?: number; height?: number } }).measured;
      const sz = n as AppNode & { width?: number; height?: number };
      const d = n.data as { width?: number; height?: number };
      return { w: m?.width ?? sz.width ?? d.width ?? gw, h: m?.height ?? sz.height ?? d.height ?? gh };
    };

    get().pushHistory();
    set({
      nodes: state.nodes.map((n) => {
        const abs = newAbs.get(n.id);
        if (!abs) return n;
        // A repositioned member's parent group is always UNSELECTED (a selected
        // parent would make this node a non-unit, so it wouldn't be in newAbs),
        // hence its frame is unmoved. If the layout pushed the member's CENTRE
        // out of that frame, DETACH it — same guard the drag path applies via
        // reparentedNode. Leaving it parented-but-outside would hide it (no cue)
        // the moment the group is collapsed (memberIds = parentId === groupId).
        if (n.parentId) {
          const parent = byId.get(n.parentId);
          const pAbs = parent ? absOf(parent) : { x: 0, y: 0 };
          if (parent?.type === 'group' && !(parent.data as { collapsed?: boolean }).collapsed) {
            const { w: gw, h: gh } = frameSize(parent, 200, 120);
            const { w: nw, h: nh } = frameSize(n, 120, 40);
            const cx = abs.x + nw / 2;
            const cy = abs.y + nh / 2;
            const inside = cx >= pAbs.x && cx <= pAbs.x + gw && cy >= pAbs.y && cy <= pAbs.y + gh;
            if (!inside) {
              const { parentId: _pid, ...rest } = n as AppNode & { parentId?: string };
              void _pid;
              return { ...rest, position: abs } as AppNode;
            }
          }
          // Still inside — keep membership, back to parent-relative coords.
          return { ...n, position: { x: abs.x - pAbs.x, y: abs.y - pAbs.y } } as AppNode;
        }
        return { ...n, position: abs } as AppNode;
      }),
      syncSource: 'graph',
      isUndoRedo: false,
    });
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
    // not array order. A note CAN become a group child (dragged into a frame,
    // or swept up by Ctrl+G), but never at birth — it is created parentless —
    // and both paths that adopt one re-sort it after its parent, so the
    // parent-before-child ordering invariant survives the prepend.
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
      const data = n.data as { label?: string; registryType?: string };
      // Property nodes are named by the user — show that instead of the
      // generic label. Values go through getNodeValues (the convention —
      // never cast node.data for values).
      if (data.registryType === 'property_float') {
        const name = getNodeValues(n).name;
        if (name) return String(name);
      }
      return data.label || undefined;
    };

    /** Sum of GPU costs of every member node, displayed above the collapsed
     *  pill as an informational badge and refreshed at every collapse. It is
     *  DELIBERATELY not the budget: `computeReachableCost` walks the members
     *  themselves (via `unwrapCollapsedGroupEdges`), so this number may include
     *  members the Output never reaches. Uses nodeCostPoints so variadic
     *  arithmetic members are priced at their operand-scaled cost. */
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
              // The toggle anchors at the TOP-RIGHT corner: the pill appears
              // where the frame's top-right was (React Flow positions are
              // top-left, so x shifts by the width delta; y stays). The expand
              // branch shifts back by the inverse delta, so a collapse/expand
              // round-trip restores the exact position — and with it every
              // hidden member's absolute spot. The delta is a width
              // difference, so it's parent-invariant for nested groups.
              position: { x: n.position.x + (currentWidth - COLLAPSED_W), y: n.position.y },
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
            // Top-right anchor, inverse of the collapse shift: the frame grows
            // LEFTWARD from wherever the pill's top-right sits now (following
            // any pill drags), and an untouched pill restores the pre-collapse
            // position exactly. `currentWidth` here is the pill's width;
            // legacy groups without expandedWidth get delta 0.
            position: { x: n.position.x + (currentWidth - data.width), y: n.position.y },
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

  instantiateBuiltinPreset: (presetId, position) => {
    const preset = getBuiltinPresets().find((p) => p.id === presetId);
    if (!preset || preset.nodes.length === 0) return;
    const { group, members, edges } = cloneGroupSnapshot(preset, position);
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

/**
 * Test hook: with `isolate: false` the vitest worker shares this module, so a
 * store-mutating suite's pending 300ms save could fire mid-way through the
 * NEXT file. Suites that arm it call this in cleanup. No production callers.
 */
export function cancelPendingGraphSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
useAppStore.subscribe(
  (state, prev) => {
    if (
      state.nodes !== prev.nodes ||
      state.edges !== prev.edges ||
      state.drawings !== prev.drawings ||
      state.shaderPalettes !== prev.shaderPalettes
    ) {
      // A bare selection click / Escape replaces the arrays without changing
      // anything the payload stores — don't arm a full-graph JSON.stringify
      // (multi-MB once images are embedded) for it. Positions, values,
      // waypoints and topology all fail this predicate and still save.
      if (
        state.drawings === prev.drawings &&
        state.shaderPalettes === prev.shaderPalettes &&
        selectionOnlyGraphChange(prev.nodes, state.nodes, prev.edges, state.edges)
      ) {
        return;
      }
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(
        () => saveGraph(state.nodes, state.edges, state.drawings, state.shaderPalettes),
        300,
      );
    }
  },
);
