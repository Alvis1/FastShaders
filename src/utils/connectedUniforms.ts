import type { AppNode, AppEdge } from '@/types';
import { outputNodes } from '@/utils/outputMaterials';
import { getNodeValues } from '@/types';
import { sanitizeIdentifier } from '@/utils/nameUtils';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';

/**
 * Which property uniforms the preview's Uniforms overlay should show.
 *
 * Only properties that actually REACH the Output node are listed.
 *
 * graphToCode now drops a property with NO outgoing edge, so the fully orphaned
 * case never gets this far. This rule is the stronger one and still earns its
 * keep: "has an outgoing edge" is not enough, because a property feeding a
 * dead-end subgraph — a half-built branch, or one left dangling after a delete
 * — is just as inert on screen as one feeding nothing, and scrubbing it reads
 * as a broken slider either way. Codegen deliberately uses the WEAKER test,
 * because it also runs on graphs with no Output at all (every built-in preset
 * and texture, and every saved group), where the stronger rule would delete
 * every property they have.
 *
 * Pure and node-testable: ShaderPreview has no test coverage (the vitest env is
 * `node`, no jsdom), so the rule that decides WHICH uniforms are live lives
 * here rather than inline in the .tsx — the same split uniformDefaults.ts uses.
 */

/** Sentinel: no property nodes exist at all (e.g. a direct-assignment module),
 *  so the overlay should fall back to showing every uniform it detected. */
export const ALL_UNIFORMS = '*';

/**
 * Names are matched against the uniforms extracted from the GENERATED code, so
 * they must be the EMITTED variable names.
 *
 * `varNames` maps node id → emitted name (graphToCode's output, mirrored in the
 * store as `nodeVarNames`). It is what makes collisions work: two properties
 * may share a stored name — dropping the same preset twice, or a user property
 * colliding with a preset's — and codegen uniquifies the later one (`colorA` →
 * `colorA2`). Matching on the stored name finds no `colorA2` among the
 * extracted uniforms and silently drops a live, connected slider.
 *
 * The stored name is the fallback for a node `varNames` doesn't cover, which is
 * what handles a code-panel Apply: codeToGraph mints fresh node ids, so every
 * lookup misses and the parsed name — which IS the name in the code — is used.
 *
 * Returns a stable, space-joined key so a store selector can compare it by
 * value. Sanitized names are `\w+`, so they can never contain the separator,
 * and a property literally named `*` can't fake the ALL_UNIFORMS sentinel.
 */
export function connectedUniformNamesKey(
  nodes: AppNode[],
  edges: AppEdge[],
  varNames: Record<string, string>,
): string {
  // Collapse state must not change the answer: a collapsed group rewrites its
  // boundary edges to synthetic sockets, so a raw walk would find every
  // property inside it unreachable and blank the overlay on collapse.
  const real = unwrapCollapsedGroupEdges(nodes, edges);

  // The Output node — every material's chain hangs off it, so one walk back
  // from it reaches a slider driving the default AND one driving a per-mesh
  // material. Missing the latter would leave that slider out of the Uniforms
  // overlay, which is the "scrubbing does nothing" failure this module exists
  // to prevent, one mesh away.
  const emitting = outputNodes(nodes);
  /** Nodes that feed an emitting Output, walking edges BACKWARDS from each. */
  const live = new Set<string>();
  if (emitting.length > 0) {
    const incoming = new Map<string, string[]>();
    for (const e of real) {
      const list = incoming.get(e.target);
      if (list) list.push(e.source);
      else incoming.set(e.target, [e.source]);
    }
    const queue = emitting.map((n) => n.id);
    for (const n of emitting) live.add(n.id);
    while (queue.length) {
      for (const src of incoming.get(queue.pop()!) ?? []) {
        if (live.has(src)) continue; // also the cycle guard
        live.add(src);
        queue.push(src);
      }
    }
  }

  // With no emitting Output at all there is nothing to be reachable FROM, so
  // fall back to the weaker "is wired to something" rule rather than blanking
  // the overlay.
  const wired = new Set<string>();
  if (emitting.length === 0) for (const e of real) wired.add(e.source);
  const isLive = (id: string) => (emitting.length > 0 ? live.has(id) : wired.has(id));

  let hasProp = false;
  const names: string[] = [];
  for (const n of nodes) {
    const t = n.data.registryType;
    if (t !== 'property_float' && t !== 'property_color') continue;
    hasProp = true;
    if (!isLive(n.id)) continue;
    const emitted = varNames[n.id];
    const raw = getNodeValues(n).name;
    const name = emitted ?? (raw != null && raw !== '' ? sanitizeIdentifier(String(raw)) : '');
    if (name) names.push(name);
  }

  if (!hasProp) return ALL_UNIFORMS;
  return names.sort().join(' ');
}
