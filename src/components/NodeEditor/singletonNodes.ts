import type { AppNode } from '@/types';

/**
 * Node types the canvas may hold exactly ONE of.
 *
 * Adding one when it already exists is not an error and must not be refused
 * silently: every add surface GLIDES to the node that is already there instead
 * (`outputFocus.focusNode`, the same framing the cost pill and the F key
 * use). So the palette tile keeps earning its place — it becomes "take me to
 * the Sound node", exactly as the Output tile did while the Output was a
 * singleton.
 *
 * Today the set holds one type. `soundNode` — the Sound node — is a singleton
 * because there is exactly ONE capture session and one analyser
 * (utils/soundSession.ts is a module singleton, deliberately, so the node's arm
 * light and the preview's control cannot disagree). A second Sound node would
 * therefore emit a second set of uniforms (`mic2_level`, …) driven by the very
 * same sound, and carry a second source picker pointed at the same session —
 * two controls for one scope, which is how the two end up disagreeing. Nothing
 * downstream would break; it would just be a node that lies about being its own
 * input. One is the honest number.
 *
 * NB this is an ADD-SURFACE rule, not a graph invariant. A `.fastshader` from
 * before the fold, or one hand-edited, may still contain two — they render and
 * emit fine, and nothing deletes one behind the user's back.
 */
export const SINGLETON_NODE_TYPES: ReadonlySet<string> = new Set(['soundNode']);

/** Is this registry type one the canvas may hold only one of? */
export function isSingletonNodeType(type: string | undefined | null): boolean {
  return typeof type === 'string' && SINGLETON_NODE_TYPES.has(type);
}

/**
 * The existing node of a singleton type, or null.
 *
 * FIRST in array order when a graph somehow holds several, which is the same
 * deterministic rule the capture pump already applies when it decides whose
 * settings drive the one analyser — so the node an add gesture glides to is the
 * node that is actually in charge.
 *
 * Returns null for a non-singleton type rather than the first node of that
 * type, so a caller can ask this one question and branch on the answer without
 * checking membership first.
 */
export function findSingletonNode(
  nodes: readonly AppNode[],
  registryType: string,
): AppNode | null {
  if (!isSingletonNodeType(registryType)) return null;
  return nodes.find((n) => n.data?.registryType === registryType) ?? null;
}
