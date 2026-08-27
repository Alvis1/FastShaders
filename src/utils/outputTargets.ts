/**
 * `OutputNodeData.meshTarget` — which sub-mesh an Output shades — validated on
 * the way IN from every restore path.
 *
 * Output-node `data` had no sanitizer at all before this: `loadGraph` restores
 * `fs:graph` verbatim, `applyProjectToStore` assigns a project block's nodes
 * straight into the store (its element gate stops at `id` + `data` being
 * objects), and `loadSavedGroups` validates edges only — so a hand-edited
 * `.fastshader`, a tampered localStorage value, or a shared saved group could
 * put any shape at all on this field. That mattered little while the field did
 * not exist; it matters now, because the name reaches GENERATED CODE, and the
 * generated module is executed at the app's real origin by the XR popup.
 *
 * The value is validated here AND again at emission (`graphToCode` re-checks
 * every name before it writes one into a module). That is deliberate belt and
 * braces: this module bounds what the STORE carries — the field rides history
 * clones, the 300 ms autosave and the project embed — while emission is the
 * gate that decides what becomes code, and emission is reachable from paths
 * that never touch a restore (a node built by `codeToGraph`, for instance).
 *
 * DEDUPE is part of validation, not tidiness. Two Outputs claiming one mesh is
 * unrenderable — a mesh has one material — so the later claimant (in node-array
 * order) loses its target and becomes an ordinary untargeted Output. Doing it
 * here means a restored graph and a live one agree; emission de-dupes too, for
 * the paths that never restore.
 *
 * Pure and node-testable; the identity-stability contract mirrors
 * `sanitizeEdgeExtras` — return the SAME array when nothing needed changing, so
 * the autosave subscriber and `selectionOnlyGraphChange` can keep comparing by
 * reference.
 */

import type { AppNode } from '@/types';
import { isUsableMeshName } from './meshInventory';

/**
 * Most targeted Outputs kept. One material per targeted mesh is already the
 * practical ceiling on authoring effort, and every extra one is a whole
 * generated material: N distinct node graphs compile to N pipelines, and the
 * preview recompiles ALL of them on every 200 ms-debounced edit (measured
 * ~55-62 ms each on desktop, and Quest-class hardware is slower). A file
 * claiming more than this is not a document anyone authored by hand.
 */
export const MAX_TARGETED_OUTPUTS = 8;

/** Read a node's target name, or null when it has none / an unusable one. */
export function meshTargetName(node: AppNode): string | null {
  if (node.data.registryType !== 'output') return null;
  const raw = (node.data as { meshTarget?: unknown }).meshTarget;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = (raw as { name?: unknown }).name;
  return isUsableMeshName(name) ? name : null;
}

/**
 * Drop every unusable or duplicate `meshTarget` from a restored node list.
 *
 * Returns the same array when nothing changed. An Output that loses its target
 * keeps existing as an untargeted Output rather than being deleted: the node
 * carries the user's wiring, and silently removing it would take a subgraph
 * with it.
 */
export function sanitizeOutputTargets(nodes: AppNode[]): AppNode[] {
  let changed = false;
  const claimed = new Set<string>();
  let targeted = 0;

  const out = nodes.map((node) => {
    if (node.data.registryType !== 'output') return node;
    const raw = (node.data as { meshTarget?: unknown }).meshTarget;
    if (raw === undefined) return node;

    const name = meshTargetName(node);
    const keep = name !== null && !claimed.has(name) && targeted < MAX_TARGETED_OUTPUTS;
    if (keep) {
      claimed.add(name);
      targeted += 1;
      // Already exactly `{ name }` with nothing else on it? Leave the node
      // alone so its identity survives for the reference comparisons.
      const asRec = raw as Record<string, unknown>;
      if (Object.keys(asRec).length === 1 && asRec.name === name) return node;
      changed = true;
      const data = { ...node.data, meshTarget: { name } };
      return { ...node, data } as AppNode;
    }

    changed = true;
    const data = { ...node.data };
    delete (data as { meshTarget?: unknown }).meshTarget;
    return { ...node, data } as AppNode;
  });

  return changed ? out : nodes;
}
