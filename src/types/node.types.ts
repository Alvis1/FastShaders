import type { Node, Edge } from '@xyflow/react';

export type TSLDataType = 'float' | 'int' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'any';

export interface PortDefinition {
  id: string;
  label: string;
  dataType: TSLDataType;
  /**
   * Optional one-line hint for a socket whose BEHAVIOUR is surprising, surfaced
   * as a `title` on the surfaces that draw the port (ShaderSettingsMenu's
   * Output Ports list; OutputNode's canvas row). Keyed through `t()` like every
   * other UI string, so it can be translated in lv.json's `ui` map.
   *
   * Deliberately NOT NodeDefinition.description: that field is part of the
   * ranked search corpus (`nodeMatchRank`), and nodeSearch.test.ts sweeps it
   * for cross-node name collisions — prose naming other nodes belongs here.
   */
  description?: string;
}

export type NodeCategory =
  | 'input'
  | 'type'
  | 'arithmetic'
  | 'math'
  | 'interpolation'
  | 'logic'
  | 'vector'
  | 'noise'
  | 'dataviz'
  | 'texture'
  | 'presets'
  | 'unknown'
  | 'output';

export interface NodeDefinition {
  type: string;
  label: string;
  category: NodeCategory;
  tslFunction: string;
  tslImportModule: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  defaultValues?: Record<string, string | number>;
  description?: string;
  /**
   * Grows its operand sockets: one extra empty socket appears below the last
   * wired operand. See `effectiveInputs` in the registry for the count rule.
   *
   * This is the UI/socket half only. `chainable` additionally means the node
   * FOLDS its operands (see below); `append` grows sockets but builds a vector,
   * so it sets this flag alone.
   */
  variadic?: boolean;
  /**
   * Variadic operand node that folds (arithmetic add/sub/mul/div): emits a
   * variadic TSL call (`add(a, b, c, …)`), fills absent operands with
   * `chainIdentity`, and is priced as N−1 operations. Implies `variadic`.
   *
   * Do NOT set this for a node that merely grows sockets — nodeCost's N−1
   * scaling and the evaluator's identity fold both assume a real fold.
   */
  chainable?: boolean;
  /**
   * Identity operand for a `chainable` node: the value an unconnected socket
   * contributes to the fold (0 for add/sub, 1 for mul/div). Also seeds the
   * inline default shown in each empty operand box. Only read when `chainable`.
   */
  chainIdentity?: number;
  /**
   * Per-node ceiling on grown operand sockets, below the global
   * MAX_CHAIN_OPERANDS. Arithmetic folds over any number of operands, but
   * `append` builds a VECTOR — and GPU vector types stop at vec4 — so it caps
   * at 4. Only read when the node grows operands (`chainable` or `variadic`
   * — see growsOperands()).
   */
  maxOperands?: number;
}

export interface ShaderNodeData {
  registryType: string;
  label: string;
  cost: number;
  values: Record<string, string | number>;
  exposedPorts?: string[];
  /**
   * Per-instance output ports, overriding the registry definition's static
   * `outputs`. Used by the Data node, whose output count equals the dropped
   * CSV's column count (one float output per column). When present, ShaderNode
   * renders these instead of `def.outputs`; ids are always `col0`, `col1`, …
   * (labels carry the human column names, never reaching generated code).
   */
  dynamicOutputs?: PortDefinition[];
  [key: string]: unknown;
}

export interface MaterialSettings {
  transparent?: boolean;
  side?: 'front' | 'back' | 'double';
  depthWrite?: boolean;
  /** How displacement is applied: 'normal' = along surface normal, 'offset' = raw vec3 offset. */
  displacementMode?: 'normal' | 'offset';
  /**
   * Weld coincident primitive vertices before displacing (default on, i.e.
   * undefined === true). A BoxGeometry splits every face into its own verts, so
   * normal-based displacement pushes the shared corners apart and the faces
   * separate; welding collapses them into one shared, smooth-normal vertex so
   * the surface deforms as a single skin. Only affects primitive previews with
   * displacement — OBJ models always weld via fit-bounds. */
  mergeVertices?: boolean;
  /** Alpha clip threshold. 0 = disabled, >0 = discard fragments below this alpha value. */
  alphaTest?: number;
}

/**
 * One material on the Output node — a set of channel values plus the sub-mesh
 * it shades. The rules live in `utils/outputMaterials.ts`; this is only the
 * shape, declared here so that module can import the AppNode types without a
 * cycle.
 */
export interface OutputMaterial {
  /** The sub-meshes this material shades — a material may name SEVERAL, and
   *  each becomes its own `parts` entry. Material 0 is the default when the
   *  list is empty/absent; every ADDED material must name at least one, or it
   *  means nothing. Read through `materialTargetNames`, never directly. */
  meshTargets?: string[];
  /** LEGACY single target, still READ (never written) so a graph or a saved
   *  group from before the list existed keeps what it shaded. */
  meshTarget?: { name: string };
  exposedPorts?: string[];
  values?: Record<string, string | number>;
  materialSettings?: MaterialSettings;
}

export interface OutputNodeData {
  registryType: 'output';
  label: string;
  cost: number;
  materialSettings?: MaterialSettings;
  exposedPorts?: string[];
  /** Stored per-channel values for UNWIRED channels (the on-node widgets):
   *  hex strings for `color`/`emissive`, numbers for
   *  `roughness`/`metalness`/`opacity`. Absent key = channel emits nothing
   *  (the historical behavior — keeps every pre-widget graph byte-identical).
   *  NB `getNodeValues()` deliberately still returns `{}` for output nodes;
   *  readers access this field directly. */
  values?: Record<string, string | number>;
  /**
   * ADDED materials — one per targeted sub-mesh (see utils/outputMaterials.ts).
   *
   * The fields above (`values`, `exposedPorts`, `materialSettings`) ARE material
   * 0: always the default, always present, and it shades every mesh no material
   * here claims. So an ABSENT `materials` key is exactly the whole-model shader
   * that predates per-mesh shading, and such a document emits byte-identically —
   * which is what keeps every saved graph, every built-in and every exported
   * `.js` valid.
   *
   * Each entry's channels are wired through NAMESPACED handles (`m1:color`),
   * material 0 keeping the bare ids every existing edge already uses.
   *
   * Deliberately a top-level field and NOT a `values` key: `values` is typed as
   * channel state and is read as such — ShaderSettingsMenu deletes a key when
   * its channel is hidden, and useSyncEngine unions `Object.keys(values)` into
   * `exposedPorts` on every Apply, which would inject the literal string
   * "materials" into the exposed-port list and then persist it.
   *
   * A material's mesh `name` is the name in the loaded SCENE (post-sanitize,
   * post-dedupe — see utils/meshInventory.ts), matched by exact string, so a
   * name shared by several meshes targets all of them. Adversarial like every
   * persisted field: validated on every restore path and again at emission.
   */
  materials?: OutputMaterial[];
  /**
   * LEGACY: the mesh a whole Output node targeted, back when each targeted mesh
   * had its own Output node. Never written any more — `foldExtraOutputs` folds
   * such a graph into the single-node shape on load — but still READ there, so
   * a session or file from that shape does not lose its wiring.
   */
  meshTarget?: { name: string };
  [key: string]: unknown;
}

/**
 * A boundary edge endpoint promoted to a synthetic handle on a collapsed group.
 * `originalNodeId/originalHandleId` are the in-group node + port the edge used
 * to terminate at — captured at collapse time so expand can rewire the edge
 * back to its real destination.
 */
export interface BoundarySocket {
  /** Synthetic handle id rendered on the group node while collapsed. */
  socketId: string;
  /** Original child node + port the edge used to point at. */
  originalNodeId: string;
  originalHandleId: string;
  dataType: TSLDataType;
  /**
   * Display name shown next to the socket. Always the label of the *source*
   * node of the edge — i.e. the upstream node producing the value through this
   * socket. For output sockets that's the internal child; for input sockets
   * that's the external feeder.
   */
  name?: string;
}

export interface GroupNodeData {
  registryType: 'group';
  label: string;
  /** Hex color used for the header strip + tinted body. */
  color: string;
  /** Cached size — React Flow uses width/height on the node itself for groups. */
  width: number;
  height: number;
  /** When true, members + their edges are hidden and the group renders as a compact pill. */
  collapsed?: boolean;
  /** Saved expanded dimensions so toggling collapsed → expanded restores the original frame. */
  expandedWidth?: number;
  expandedHeight?: number;
  /** While collapsed: input sockets exposed on the group (one per crossing edge). */
  collapsedInputs?: BoundarySocket[];
  /** While collapsed: output sockets exposed on the group (one per upstream pin). */
  collapsedOutputs?: BoundarySocket[];
  /** Sum of GPU costs of all members — populated while collapsed for the cost badge. */
  cost?: number;
  /** Title font size multiplier (1 = default, 2 = 2x, etc.). */
  titleSize?: number;
  [key: string]: unknown;
}

/**
 * Free-floating annotation ("sticky note") placed on the canvas. Has no shader
 * semantics — graphToCode/cpuEvaluator ignore it (no registry entry) — so it's
 * purely a comment. Resizable from the bottom-right corner via NodeResizeControl
 * (width/height live on the React Flow node), recolorable, with a scalable
 * heading + body.
 */
export interface NoteNodeData {
  registryType: 'note';
  /** Heading shown in the (draggable) header bar. Edited via the settings menu. */
  heading: string;
  /** Free-form body text (inline-editable). */
  text: string;
  /** Body background color (hex). Text auto-contrasts against it. */
  color: string;
  /** Header bar color (hex), distinct from the body. */
  headerColor: string;
  /** Font-size multiplier for heading + body (1 = default). */
  scale?: number;
  [key: string]: unknown;
}

export type ShaderFlowNode = Node<ShaderNodeData, 'shader'>;
export type ColorFlowNode = Node<ShaderNodeData, 'color'>;
export type PreviewFlowNode = Node<ShaderNodeData, 'preview'>;
export type MathPreviewFlowNode = Node<ShaderNodeData, 'mathPreview'>;
export type ClockFlowNode = Node<ShaderNodeData, 'clock'>;
export type OutputFlowNode = Node<OutputNodeData, 'output'>;
export type GroupFlowNode = Node<GroupNodeData, 'group'>;
export type NoteFlowNode = Node<NoteNodeData, 'note'>;
export type AppNode =
  | ShaderFlowNode
  | ColorFlowNode
  | PreviewFlowNode
  | MathPreviewFlowNode
  | ClockFlowNode
  | OutputFlowNode
  | GroupFlowNode
  | NoteFlowNode;

export interface TypedEdgeData {
  dataType: TSLDataType;
  /**
   * Optional user-placed routing waypoints (flow-space coords) the wire curves
   * smoothly through. Purely visual — graphToCode/cpuEvaluator never read them,
   * so they don't affect the compiled shader; they persist with the graph
   * (localStorage autosave, save/load, undo) and are carried across a code→graph
   * resync by endpoint match (useSyncEngine), though a fresh `.js`/zip import
   * starts without them (the exported code carries no geometry). Added/removed
   * via double-click on the edge / on a point, or the edge context menu.
   */
  waypoints?: Array<{ x: number; y: number }>;
  [key: string]: unknown;
}

export type AppEdge = Edge<TypedEdgeData>;

/** Safely extract values from any AppNode's data. */
export function getNodeValues(node: AppNode): Record<string, string | number> {
  if (node.type === 'output' || node.type === 'group' || node.type === 'note') return {};
  const values = (node.data as ShaderNodeData).values;
  // `?? {}` guards nullish and NOTHING else, which is not enough for a field
  // that arrives verbatim from `fs:graph` / a `.fastshader` / `fs:savedGroups`.
  // A tampered `values: 5` used to reach every caller as a primitive, where
  // `'originId' in values` THROWS — and that throw, inside `loadGraph`, returns
  // null and lets the 300 ms autosave overwrite the user's entire saved graph
  // with the demo one. Closing it at this one accessor (which the codebase
  // already mandates over `node.data as ...`) covers every call site at once.
  // Identity is preserved for the normal case, so no memo is invalidated.
  return typeof values === 'object' && values !== null && !Array.isArray(values)
    ? (values as Record<string, string | number>)
    : {};
}

/** Spread-merge a patch into a node's values (mutates node.data in place). */
export function setNodeValues(node: AppNode, patch: Record<string, string | number>): void {
  (node.data as ShaderNodeData).values = { ...getNodeValues(node), ...patch };
}

/** Safely extract exposedPorts from any AppNode's data. */
export function getNodeExposedPorts(node: AppNode): string[] {
  return (node.data as ShaderNodeData).exposedPorts ?? [];
}

/**
 * TSL type name for a channel count — the vocabulary sockets are labelled in.
 * Clamped to vec4: GPU vector types stop at four components.
 */
export function channelTypeName(channels: number): TSLDataType {
  if (channels <= 1) return 'float';
  return (channels === 2 ? 'vec2' : channels === 3 ? 'vec3' : 'vec4') as TSLDataType;
}
