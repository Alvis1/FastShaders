/**
 * BAKE TO TEXTURE — the pure half that decides WHAT a bake renders and
 * WHETHER it can (docs/dev/baking.md).
 *
 * A bake turns the value leaving a socket into an Image node: the sandboxed
 * preview renders that socket flat across a UV layout, and the pixels become a
 * picture. That is exact only for a value that is a function of the SURFACE
 * POINT — what is the same every frame from every camera. So every node type is
 * given ONE class here (`bakeClassOf`, pinned by a sweep over the registry), and
 * a socket's upstream decides:
 *
 *   - `uv`       reads the texture coordinate only → the UV SQUARE layout: one
 *                full 0..1 square, usable on any mesh, no seams;
 *   - `surface`  reads the mesh itself (position, normal, tangent, vertex
 *                colour, or a noise of the position) → the MESH layout: the
 *                shown model rasterized through its own unwrap, which needs
 *                UVs that do not overlap (not the built-in Cube or Teapot);
 *   - `view`     depends on the camera or the screen (view position, camera
 *                position, screen UV, Fresnel, ray direction, a screen-space
 *                normal) → refused, since no texture can hold it;
 *   - `live`     Time and Sound → baked frozen at the moment of the bake;
 *   - `tuned`    a property or slider → frozen at its current value;
 *   - `derivative` measures screen pixels (stripes, isolines, the wireframe
 *                grid) → baked at texel scale, a warning;
 *   - `refuse`   cannot be reproduced at all (an unknown expression, the
 *                wireframe's barycentric edges).
 *
 * What a socket READS is classified on the unwrapped, mute-bypassed graph —
 * what codegen emits — so a collapsed group or a muted node never changes the
 * answer. Which WIRES carry it out (`bakeSockets`) is read on the unwrapped
 * graph WITHOUT the bypass: those are the wires the commit moves.
 */
import type { AppEdge, AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { unwrapCollapsedGroupEdges, unwrapGroupsOnly } from '@/utils/edgeUtils';
import { bypassMutedEdges } from '@/utils/nodeMute';
import { isPassThroughNode } from '@/utils/passThrough';
import { implicitRootOf, isSinkNode, drivingMarchOutput, drivingSplatOutput } from '@/utils/sdfPartition';
import { groupDescendantIds } from '@/utils/groupFrame';
import { readImageUvMapping } from '@/utils/imageUvMapping';
import { getEdgeOutputShape } from '@/engine/cpuEvaluator';
import {
  gltfIndexOf,
  indexSectionsAwake,
  isOutputNode,
  materialTargetNames,
  outputMaterials,
  readModelSignature,
  type LoadedModel,
} from '@/utils/outputMaterials';
import type { GeometryType } from '@/engine/tslToPreviewHTML';

export type BakeLayout = 'uv' | 'mesh';
export type BakeShape = 1 | 2 | 3 | 4;
export type BakeColorSpace = 'color' | 'data';

/** What one node type is to a bake. */
export type BakeClass = 'pure' | 'uv' | 'surface' | 'world' | 'view' | 'live' | 'tuned' | 'derivative' | 'refuse' | 'sink';

/** Why a socket cannot be baked. A CLOSED set: each has its own sentence in the dialog. */
export type BakeRefusal =
  | 'view'            // the camera or the screen
  | 'unknown'         // an expression the bake cannot reproduce
  | 'constant'        // one value: there is nothing to bake
  | 'uv-channels'     // reads two different UV channels
  | 'uv-channel-wired'// a UV node's Channel is a wire
  | 'needs-mesh'      // reads the mesh, and the shown model's UVs overlap (Cube, Teapot)
  | 'no-preview'      // nothing is shown to render it (embed, a splat, a march)
  | 'sdf-driven';     // a Raymarch or Splat Output drives the preview

/** A bake that can run, with notes the dialog prints. */
export type BakeWarning = 'time' | 'sound' | 'tuned' | 'derivative' | 'world' | 'displaced';

export interface BakeSocket {
  nodeId: string;
  handleId: string;
}

export interface BakeSocketPlan extends BakeSocket {
  /** The node's label + socket, for the dialog. */
  label: string;
  shape: BakeShape;
  colorSpace: BakeColorSpace;
  /** The UV channel the bake reads and the Image will sample (0..3). */
  uvSet: number;
  layout: BakeLayout;
  refusal: BakeRefusal | null;
  warnings: BakeWarning[];
  /** The edges leaving the socket to nodes outside the selection (store ids). */
  consumers: AppEdge[];
}

/** Which meshes a MESH-layout bake rasterizes — the meshes that wear a
 *  material the socket feeds. Names are scene mesh names, indices glTF
 *  material indices (`FastShaders.materialIndexOf`). Exclusions win. */
export interface BakeMeshFilter {
  all: boolean;
  names: string[];
  indices: number[];
  exceptNames: string[];
  exceptIndices: number[];
}

/** At most this many sockets leave a selection in one bake: each is a render
 *  and an encode, and a selection with more is not one texture's worth. */
export const MAX_BAKE_SOCKETS = 4;

/** The sizes a bake renders at, smallest first. Powers of two from 256: a WebGPU
 *  readback row must be a multiple of 256 bytes, which 64 RGBA32F texels are. */
export const BAKE_SIZES = [256, 512, 1024, 2048] as const;

/** The preview geometries a MESH-layout bake can unwrap: their UVs do not
 *  overlap. The Cube's faces each span the whole square and the Teapot's
 *  patches overlap; a Raymarch window is not a surface. */
const MESH_BAKE_GEOMETRIES: ReadonlySet<GeometryType> = new Set<GeometryType>(['sphere', 'plane', 'bunny', 'custom']);

export function geometryCanMeshBake(geometry: GeometryType): boolean {
  return MESH_BAKE_GEOMETRIES.has(geometry);
}

// ---------------------------------------------------------------------------
// The class table
// ---------------------------------------------------------------------------

/** Root identifiers an UNWIRED input stands for (`implicitRootOf`), and the
 *  input node types that ARE such a root. Anything not listed is refused as
 *  `view` — the conservative answer for a value whose meaning is unknown. */
const ROOT_CLASS: ReadonlyMap<string, BakeClass> = new Map<string, BakeClass>([
  ['uv', 'uv'],
  ['positionGeometry', 'surface'],
  ['positionLocal', 'surface'],
  ['normalLocal', 'surface'],
  ['normalGeometry', 'surface'],
  ['tangentLocal', 'surface'],
  ['vertexColor', 'surface'],
  ['positionWorld', 'world'],
  ['positionWorldDirection', 'world'],
  ['normalWorld', 'world'],
  ['positionView', 'view'],
  ['positionViewDirection', 'view'],
  ['normalView', 'view'],
  ['cameraPosition', 'view'],
  ['cameraNear', 'view'],
  ['cameraFar', 'view'],
  ['screenUV', 'view'],
]);

/** Node types whose class is fixed by the type alone. Everything else in the
 *  registry is `pure` (arithmetic, vectors, noise and SDF maths, colour), and
 *  reads only what its inputs read — a noise's unwired `pos` included, which
 *  `implicitRootOf` names. */
const TYPE_CLASS: ReadonlyMap<string, BakeClass> = new Map<string, BakeClass>([
  ['positionGeometry', 'surface'],
  ['positionLocal', 'surface'],
  ['normalLocal', 'surface'],
  ['tangentLocal', 'surface'],
  ['vertexColor', 'surface'],
  ['positionWorld', 'world'],
  ['positionWorldDirection', 'world'],
  ['normalWorld', 'world'],
  ['positionView', 'view'],
  ['positionViewDirection', 'view'],
  ['cameraPosition', 'view'],
  ['cameraNear', 'view'],
  ['cameraFar', 'view'],
  ['screenUV', 'view'],
  ['rayDirection', 'view'],
  ['fresnel', 'view'],
  // Its slope is the screen derivative of the VIEW position, and its result a
  // view-space normal.
  ['heightToNormal', 'view'],
  ['uv', 'uv'],
  ['time', 'live'],
  ['soundNode', 'live'],
  ['property_float', 'tuned'],
  ['property_color', 'tuned'],
  ['slider', 'tuned'],
  ['stripes', 'derivative'],
  ['isolines', 'derivative'],
  ['wireframe', 'derivative'],
  ['unknown', 'refuse'],
  ['output', 'sink'],
  ['raymarchOutput', 'sink'],
  ['splatOutput', 'sink'],
]);

/** The class of a node TYPE (the sweep test holds every registry type to it). */
export function bakeClassOf(type: string): BakeClass {
  return TYPE_CLASS.get(type) ?? 'pure';
}

/** A UV channel number as stored on a UV node: exactly 0..3, else 0. */
function storedUvChannel(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-3]$/.test(v) ? Number(v) : 0;
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

// ---------------------------------------------------------------------------
// Graph views
// ---------------------------------------------------------------------------

/** The edges codegen reads: collapsed groups unwrapped, muted nodes bypassed. */
export function bakeEdges(nodes: AppNode[], edges: AppEdge[]): AppEdge[] {
  return bypassMutedEdges(nodes, unwrapCollapsedGroupEdges(nodes, edges));
}

/** The selection as the node ids a bake reads: a group stands for every node
 *  inside it; group frames and notes themselves carry no value. */
export function expandBakeSelection(nodes: readonly AppNode[], selectedIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of selectedIds) {
    const n = byId.get(id);
    if (!n) continue;
    if (n.type === 'group') {
      for (const d of groupDescendantIds(nodes, id)) out.add(d);
    } else {
      out.add(id);
    }
  }
  for (const id of [...out]) {
    const n = byId.get(id);
    // A Branch or Portal end carries no value of its own: it is never baked.
    if (!n || n.type === 'group' || n.type === 'note' || isPassThroughNode(n) || isSinkNode(n)) out.delete(id);
  }
  return out;
}

/**
 * Every distinct socket whose value leaves the selection, in edge order, with
 * the WIRES that carry it out. Read on the unwrapped graph but NOT through the
 * mute bypass: these are the wires the commit moves onto the Image, and a muted
 * node outside the selection must keep its place in the chain (it is fed by the
 * Image afterwards and still passes it through). Nor through the Branch/Portal
 * FOLD (`unwrapGroupsOnly`): folded, a wire out of a Portal Out would read as
 * leaving the selection itself, and the commit would move it onto the Image
 * and strand the Portal — the wire that leaves is the one INTO the Portal In.
 */
export function bakeSockets(
  nodes: AppNode[],
  edges: AppEdge[],
  selected: ReadonlySet<string>,
): { socket: BakeSocket; consumers: AppEdge[] }[] {
  const out = new Map<string, { socket: BakeSocket; consumers: AppEdge[] }>();
  for (const e of unwrapGroupsOnly(nodes, edges)) {
    if (!selected.has(e.source) || selected.has(e.target)) continue;
    const handleId = typeof e.sourceHandle === 'string' && e.sourceHandle ? e.sourceHandle : 'out';
    const key = `${e.source}\0${handleId}`;
    let entry = out.get(key);
    if (!entry) {
      entry = { socket: { nodeId: e.source, handleId }, consumers: [] };
      out.set(key, entry);
    }
    entry.consumers.push(e);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Walk {
  classes: Set<BakeClass>;
  types: Set<string>;
  uvSets: Set<number>;
  uvChannelWired: boolean;
}

function walkUpstream(nodes: AppNode[], edges: AppEdge[], startId: string): Walk {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const into = new Map<string, AppEdge[]>();
  for (const e of edges) {
    const list = into.get(e.target);
    if (list) list.push(e);
    else into.set(e.target, [e]);
  }
  const walk: Walk = { classes: new Set(), types: new Set(), uvSets: new Set(), uvChannelWired: false };
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    // A file's registryType is adversarial: String() on an object can throw.
    const type = typeof n.data.registryType === 'string' ? n.data.registryType : '';
    const incoming = into.get(id) ?? [];
    const wired = (h: string) => incoming.some((e) => e.targetHandle === h && byId.has(e.source));

    walk.types.add(type);
    let cls = bakeClassOf(type);
    if (type === 'wireframe' && implicitRootOf(n, wired) === null) cls = 'refuse'; // barycentric edges
    walk.classes.add(cls);

    if (type === 'uv') {
      if (wired('channel')) walk.uvChannelWired = true;
      else walk.uvSets.add(storedUvChannel(getNodeValues(n).channel));
    }
    const root = implicitRootOf(n, wired);
    if (root !== null) {
      const rc = ROOT_CLASS.get(root) ?? 'view';
      walk.classes.add(rc);
      if (rc === 'uv') walk.uvSets.add(type === 'imageNode' ? readImageUvMapping(getNodeValues(n)).uvSet : 0);
    }
    for (const e of incoming) stack.push(e.source);
  }
  return walk;
}

/** The node label + socket name a dialog row shows. */
function socketLabel(node: AppNode | undefined, handleId: string): string {
  if (!node) return handleId;
  const type = typeof node.data.registryType === 'string' ? node.data.registryType : '';
  const def = NODE_REGISTRY.get(type);
  const label = typeof node.data.label === 'string' && node.data.label ? node.data.label : def?.label ?? type;
  const outputs = def?.outputs ?? [];
  if (outputs.length <= 1) return label;
  const port = outputs.find((p) => p.id === handleId);
  return `${label} · ${port?.label ?? handleId}`;
}

function clampShape(n: number): BakeShape {
  return n >= 4 ? 4 : n === 3 ? 3 : n === 2 ? 2 : 1;
}

export interface BakeContext {
  /** What the preview shows; null when no preview runs (the embed). */
  geometry: GeometryType | null;
  /** A Gaussian splat is shown: nothing a bake renders lives on it. */
  splatShown: boolean;
}

/**
 * Plan every socket leaving `selectedIds`. A socket that cannot be baked keeps
 * its row with a refusal, so the dialog can say WHY rather than hide it.
 */
export function planBake(
  nodes: AppNode[],
  edges: AppEdge[],
  selectedIds: readonly string[],
  ctx: BakeContext,
): BakeSocketPlan[] {
  const selected = expandBakeSelection(nodes, selectedIds);
  const view = bakeEdges(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sinkDriven = drivingMarchOutput(nodes, view) !== null || drivingSplatOutput(nodes, view) !== null;

  return bakeSockets(nodes, edges, selected).map(({ socket, consumers }) => {
    const node = byId.get(socket.nodeId);
    const walk = walkUpstream(nodes, view, socket.nodeId);
    const c = walk.classes;
    const shape = clampShape(getEdgeOutputShape({ source: socket.nodeId, sourceHandle: socket.handleId }, nodes, edges));

    const port = node ? NODE_REGISTRY.get(node.data.registryType)?.outputs.find((p) => p.id === socket.handleId) : undefined;
    const feedsColour = consumers.some((e) => {
      const t = byId.get(e.target);
      return !!t && isOutputNode(t) && (e.targetHandle === 'color' || e.targetHandle === 'emissive');
    });
    const colorSpace: BakeColorSpace = port?.dataType === 'color' || feedsColour ? 'color' : 'data';

    const needsMesh = c.has('surface') || c.has('world');
    const layout: BakeLayout = needsMesh ? 'mesh' : 'uv';

    let refusal: BakeRefusal | null = null;
    if (c.has('refuse')) refusal = 'unknown';
    else if (c.has('view')) refusal = 'view';
    else if (walk.uvChannelWired) refusal = 'uv-channel-wired';
    else if (walk.uvSets.size > 1) refusal = 'uv-channels';
    else if (!needsMesh && !c.has('uv')) refusal = 'constant';
    else if (sinkDriven) refusal = 'sdf-driven';
    else if (ctx.geometry === null || ctx.splatShown) refusal = 'no-preview';
    else if (needsMesh && !geometryCanMeshBake(ctx.geometry)) refusal = 'needs-mesh';

    const warnings: BakeWarning[] = [];
    if (walk.types.has('time')) warnings.push('time');
    if (walk.types.has('soundNode')) warnings.push('sound');
    if (c.has('tuned')) warnings.push('tuned');
    if (c.has('derivative')) warnings.push('derivative');
    if (c.has('world')) warnings.push('world');
    if (needsMesh && consumerOutputs(nodes, view, consumers).some(outputDisplaces(view))) warnings.push('displaced');

    return {
      ...socket,
      label: socketLabel(node, socket.handleId),
      shape,
      colorSpace,
      uvSet: needsMesh ? 0 : [...walk.uvSets][0] ?? 0,
      layout,
      refusal,
      warnings,
      consumers,
    };
  });
}

/** The plain Outputs the consumers reach, walking DOWNSTREAM. */
export function consumerOutputs(nodes: AppNode[], edges: AppEdge[], consumers: readonly AppEdge[]): AppNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, AppNode>();
  const seen = new Set<string>();
  const stack = consumers.map((e) => e.target);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    if (isOutputNode(n)) {
      out.set(n.id, n);
      continue;
    }
    for (const e of edges) if (e.source === id) stack.push(e.target);
  }
  return [...out.values()];
}

/** Does this Output move its vertices? A mesh bake renders the UNDISPLACED
 *  surface, so a chain reading the position there differs from the preview. */
function outputDisplaces(edges: readonly AppEdge[]): (o: AppNode) => boolean {
  return (o) => edges.some((e) => e.target === o.id && e.targetHandle === 'position');
}

/**
 * The meshes a MESH-layout bake of this socket rasterizes: those wearing a
 * material the socket feeds. A socket that reaches the DEFAULT material (an
 * untargeted Output), or no Output at all, covers every mesh no OTHER Output
 * claims; a targeted one covers its own names and glTF indices. Index claims
 * count only while the loaded model matches their signature — dormant, the
 * default material shades those meshes, as the preview shows.
 */
export function bakeMeshFilter(
  nodes: AppNode[],
  edges: AppEdge[],
  consumers: readonly AppEdge[],
  loaded: LoadedModel,
): BakeMeshFilter {
  const view = bakeEdges(nodes, edges);
  const fed = consumerOutputs(nodes, view, consumers);
  const fedIds = new Set(fed.map((o) => o.id));
  const filter: BakeMeshFilter = { all: fed.length === 0, names: [], indices: [], exceptNames: [], exceptIndices: [] };
  const claims = (o: AppNode) => {
    const mat = outputMaterials(o)[0];
    const awake = indexSectionsAwake(readModelSignature(o.data), loaded);
    const idx = gltfIndexOf(mat);
    return { names: materialTargetNames(mat), index: awake ? idx : null, indexSection: idx !== null };
  };
  for (const o of fed) {
    const c = claims(o);
    if (c.names.length === 0 && !c.indexSection) filter.all = true;
    filter.names.push(...c.names);
    if (c.index !== null) filter.indices.push(c.index);
  }
  if (filter.all) {
    for (const o of nodes) {
      if (!isOutputNode(o) || fedIds.has(o.id)) continue;
      const c = claims(o);
      filter.exceptNames.push(...c.names);
      if (c.index !== null) filter.exceptIndices.push(c.index);
    }
  }
  return filter;
}
