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
 *  rules (everything else always shows its registry ports). */
export function usesExposedPorts(def: NodeDefinition | undefined): boolean {
  return !!def && (def.category === 'noise' || def.type === 'output' || def.type === 'imageNode');
}

/** The node's effective exposed list, resolving the Output node's implicit
 *  defaults. An EXPLICIT empty array stays empty (user hid everything). */
export function effectiveExposedPorts(node: AppNode): string[] {
  const raw = (node.data as { exposedPorts?: string[] }).exposedPorts;
  if (raw !== undefined) return raw;
  return node.data.registryType === 'output' ? OUTPUT_DEFAULT_EXPOSED : [];
}

/**
 * Auto-expose param ports that already have incoming edges, on every node
 * that uses exposedPorts. Mutates `node.data.exposedPorts` in place (callers
 * feed freshly-parsed or about-to-be-set node arrays). Nodes whose connected
 * ports are already covered are left untouched — an Output node keeps its
 * implicit-undefined defaults.
 */
export function autoExposeConnectedParamPorts(nodes: AppNode[], edges: AppEdge[]): void {
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
): string[] {
  const current = new Set(exposedPorts);
  if (current.has(portId)) {
    current.delete(portId);
    removeEdgesForPort(nodeId, portId);
  } else {
    current.add(portId);
  }
  return Array.from(current);
}
