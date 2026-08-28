/**
 * The one home for the opt-in parameter-socket (`exposedPorts`) rules shared
 * by every surface — see NODE_DESIGN_REQUIREMENTS.md → "Exposed parameter
 * sockets". Node components render only exposed params, the settings menus
 * toggle them, and every path where an edge can arrive (connect/reconnect
 * gestures, code→graph sync, project import, localStorage load) auto-exposes
 * the connected port so no edge ever points at a hidden socket.
 */

import type { AppNode, AppEdge, NodeDefinition, ShaderNodeData } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { removeEdgesForPort } from '@/utils/edgeUtils';

/** Output-node channels visible by default (no need to expose via settings).
 *  These are IMPLICIT — a fresh Output node has `exposedPorts: undefined` —
 *  so any union must start from the effective list, never `[]`, or exposing
 *  one new channel would hide the defaults. */
export const OUTPUT_DEFAULT_EXPOSED = ['color', 'roughness', 'position'];

/** Nodes whose optional parameter sockets follow the opt-in exposedPorts
 *  rules (everything else always shows its registry ports).
 *
 *  `time` is here for its `speed` multiplier: the Time node is otherwise a
 *  plain zero-input source, and its speed must stay a hidden-by-default param
 *  — the parser auto-creates a Time node for a bare `time` identifier ONLY
 *  while the def declares no registry inputs (see ensureBareInputNode), so
 *  `speed` lives in defaultValues and surfaces as a socket exactly the way the
 *  noise nodes' `pos`/`scale` do. */
export function usesExposedPorts(def: NodeDefinition | undefined): boolean {
  return (
    !!def &&
    (def.category === 'noise' ||
      def.type === 'output' ||
      def.type === 'imageNode' ||
      def.type === 'time' ||
      def.type === 'micNode' ||
      RAMP_COLOR_NODES.has(def.type))
  );
}

/** Nodes whose two ramp ends (`lowColor`/`highColor`) are opt-in colour
 *  sockets: hidden until ticked in the settings menu, wired edge overrides the
 *  stored swatch. Both nodes draw the same two swatches and share one emitter
 *  branch shape, so they must move together — wiring one and not the other is a
 *  difference no user could infer. */
export const RAMP_COLOR_NODES = new Set(['stripes', 'dataviz']);

/** The ramp ports themselves — the ONLY inputs those nodes hide. `signal` is
 *  always visible (it is how the node is used at all), so this list is what
 *  keeps the exposure filter from swallowing it. */
export const RAMP_COLOR_PORTS = new Set(['lowColor', 'highColor']);

/**
 * A ramp node's def with its unexposed colour ports removed — the ONE filter
 * behind both the live ShaderNode and every preview surface (asset tile,
 * node-editor overview, Node Designer stage), so a tile cannot advertise a
 * socket the freshly dropped node does not have.
 *
 * `defaultValues` is deliberately KEPT (unlike the imageNode filter): those
 * entries are what draw the inline swatches, which is the whole point of the
 * node. Returns the def UNCHANGED when nothing is filtered, so the common case
 * costs no new object identity for the memos downstream.
 */
export function effectiveRampDef<T extends NodeDefinition>(def: T, exposed: Iterable<string>): T {
  if (!RAMP_COLOR_NODES.has(def.type)) return def;
  const on = exposed instanceof Set ? exposed : new Set(exposed);
  const inputs = def.inputs.filter((inp) => !RAMP_COLOR_PORTS.has(inp.id) || on.has(inp.id));
  return inputs.length === def.inputs.length ? def : { ...def, inputs };
}

/** The node's effective exposed list, resolving the Output node's implicit
 *  defaults. An EXPLICIT empty array stays empty (user hid everything).
 *
 *  Total by construction: `exposedPorts` arrives from tampered `fs:graph` /
 *  shared `.fastshader` JSON, and every caller either spreads the result or
 *  calls `.includes`/`new Set` on it — a bare `return raw` handed a number
 *  straight through and threw at graphToCode's `new Set(...)` and
 *  autoExposeConnectedParamPorts. `normalizeExposedPorts` repairs the stored
 *  value at ingestion; this is the reader-side floor under it. */
export function effectiveExposedPorts(node: AppNode): string[] {
  const raw = (node.data as { exposedPorts?: unknown }).exposedPorts;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  return node.data.registryType === 'output' ? OUTPUT_DEFAULT_EXPOSED : [];
}

/** Upper bound on stored exposed ports. The widest def in the registry is the
 *  Output node's 9 channels, so no app-produced graph comes near this; the cap
 *  exists because PreviewNode's socket loop is O(N^2) over this list and
 *  `exposedList.join('|')` is a per-render memo key. */
export const MAX_EXPOSED_PORTS = 64;

/**
 * Coerce every node's stored `exposedPorts` to `string[] | undefined`, in place.
 *
 * This is the ingestion guard for the field, not a nicety: only three of the
 * thirteen readers go through `effectiveExposedPorts`. OutputNode, ShaderNode,
 * MicNode, PreviewNode and ClockNode read `data.exposedPorts` RAW and do
 * `new Set(v)` / `v.includes(...)` on it during RENDER — and the app has no
 * React error boundary, so a tampered `exposedPorts: 5` from a shared
 * `.fastshader` takes the whole tree down to a blank page, is then written to
 * `fs:graph` by the 300 ms autosave, and blanks the app again on every reload.
 *
 * A non-array is DELETED rather than replaced with `[]`: an explicit empty list
 * means "the user hid every channel" (see effectiveExposedPorts above), so `[]`
 * on an Output node would render a channel-less node and emit nothing, while
 * deleting restores the implicit OUTPUT_DEFAULT_EXPOSED.
 */
export function normalizeExposedPorts(nodes: AppNode[]): void {
  for (const node of nodes) {
    const data = node?.data as ShaderNodeData | undefined;
    if (!data || data.exposedPorts === undefined) continue;
    const raw: unknown = data.exposedPorts;
    if (!Array.isArray(raw)) {
      delete data.exposedPorts;
      continue;
    }
    const clean = raw.filter((s): s is string => typeof s === 'string');
    if (clean.length > MAX_EXPOSED_PORTS) clean.length = MAX_EXPOSED_PORTS;
    if (clean.length !== raw.length) data.exposedPorts = clean;
  }
}

/**
 * Auto-expose param ports that already have incoming edges, on every node
 * that uses exposedPorts. Mutates `node.data.exposedPorts` in place (callers
 * feed freshly-parsed or about-to-be-set node arrays). Nodes whose connected
 * ports are already covered are left untouched — an Output node keeps its
 * implicit-undefined defaults.
 *
 * ALSO NORMALIZES the stored field (`normalizeExposedPorts`) before reading it:
 * this function is already the shared hook at every ingestion boundary, so it
 * is where an adversarial `exposedPorts` is repaired. Anyone adding a fourth
 * ingestion path must call it (or this) — the field is NOT typed by parsing.
 */
export function autoExposeConnectedParamPorts(nodes: AppNode[], edges: AppEdge[]): void {
  // Repair adversarial values BEFORE anything reads them. This function is
  // already the shared hook at every ingestion boundary (loadGraph,
  // applyProjectToStore, useSyncEngine), so normalising here reaches all of
  // them without adding a call site.
  normalizeExposedPorts(nodes);
  for (const node of nodes) {
    const def = NODE_REGISTRY.get(node.data.registryType);
    if (!usesExposedPorts(def)) continue;
    const connected = new Set<string>();
    for (const e of edges) {
      if (e.target === node.id && e.targetHandle) connected.add(e.targetHandle);
    }
    if (connected.size === 0) continue;
    const current = effectiveExposedPorts(node);
    const missing = [...connected].filter((p) => !current.includes(p));
    if (missing.length === 0) continue;
    (node.data as ShaderNodeData).exposedPorts = [...current, ...missing];
  }
}

/**
 * Toggle one exposed parameter socket and return the NEXT exposedPorts array
 * for the caller's updateNodeData. Hiding a port drops its edges (the
 * documented rule — a hidden socket must not keep live wires). Single
 * implementation shared by NodeSettingsMenu and ShaderSettingsMenu, which
 * previously carried drifting copies of this logic.
 */
export function toggleExposedPort(
  nodeId: string,
  exposedPorts: readonly string[],
  portId: string,
  /**
   * The HANDLE the port's edges are wired through, when it differs from the
   * port id. The Output node's added materials namespace theirs (`m2:opacity`),
   * and passing the bare id there would drop the DEFAULT material's edge
   * instead — the right number of wires disappearing from the wrong material,
   * with the hidden channel keeping its own.
   */
  handleId: string = portId,
): string[] {
  const current = new Set(exposedPorts);
  if (current.has(portId)) {
    current.delete(portId);
    removeEdgesForPort(nodeId, handleId);
  } else {
    current.add(portId);
  }
  return Array.from(current);
}
