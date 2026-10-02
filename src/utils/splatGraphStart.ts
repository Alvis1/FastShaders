/**
 * A Gaussian splat dropped on a graph with NO Splat Output asks whether to
 * clear the node graph (owner, 2026-10-01; `Modals/SplatGraphModal.tsx`).
 *
 * Every other sink is wrong for a splat — a plain Output is a material, which
 * a splat never takes, and a Raymarch Output cannot march through one
 * (`utils/sinkModelFit.ts`) — so a graph without a Splat Output cannot shade
 * the scene that just arrived. Clearing replaces it with ONE Splat Output,
 * the splat twin of NEW's one Output, flagged as the active sink: the user
 * chose a splat graph, so it drives from the start (the identity program
 * `return { splat: {} };` until something is wired), and a plain Output added
 * later arrives inactive instead of taking the render.
 *
 * An EMPTY canvas is not asked about — there is nothing to clear.
 */
import type { AppNode, ShaderNodeData } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getBaseCosts } from './costTable';
import { generateId } from './idGenerator';
import { initialNodeValues } from './newNodeValues';
import { ACTIVE_OUTPUT_KEY, SPLAT_OUTPUT_TYPE, isSplatOutput } from './sdfPartition';

/** True when a dropped splat should ask to clear the graph: there is a graph,
 *  and no Splat Output in it (active or not — one present is the user's). */
export function asksToClearForSplat(nodes: readonly AppNode[]): boolean {
  return nodes.length > 0 && !nodes.some(isSplatOutput);
}

/** The cleared graph's one node: a fresh Splat Output, built exactly as a
 *  palette drop builds one, plus the active flag. */
export function splatStarterNode(): AppNode {
  const def = NODE_REGISTRY.get(SPLAT_OUTPUT_TYPE)!;
  return {
    id: generateId(),
    type: SPLAT_OUTPUT_TYPE,
    position: { x: 0, y: 0 },
    data: {
      registryType: def.type,
      label: def.label,
      cost: getBaseCosts()[def.type] ?? 0,
      values: initialNodeValues(def, []),
      [ACTIVE_OUTPUT_KEY]: true,
    } as ShaderNodeData,
  } as AppNode;
}
