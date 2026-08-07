/**
 * Drop-on-edge insertion: WHICH input socket of the spliced-in node the edge's
 * source lands on.
 *
 * This used to be `def.inputs[0]` unconditionally, which silently DELETED that
 * port's existing edge whenever an already-wired node was dragged onto a new
 * wire — dropping a half-built Multiply (A already fed by a noise node) onto an
 * edge threw the noise connection away and looked like the splice had eaten it.
 * The rule is now "first FREE input socket": what the node already has stays,
 * and the edge's source goes to the next empty slot.
 *
 * Two node families need the INSTANCE's state, not just the registry def:
 *
 * - The variadic folds (`chainable` Add/Multiply/… and `append`) GROW sockets,
 *   so a node whose declared `a`/`b` are both wired still has a free `c` to
 *   offer. That is `effectiveInputs`'s trailing-empty slot — the same socket a
 *   wire dragged within reach reveals (ShaderNode's `revealGrowth`), which at
 *   rest is unmounted and materializes as a permanent row once the splice
 *   wires it. Nodes at `maxOperands` (`append` caps at 4) stop growing and
 *   fall through to the replace case below.
 * - `exposedPorts` nodes (Image, Mic) declare params hidden until ticked. They
 *   stay eligible — the caller makes the exposure permanent the same way a wire
 *   dropped on a drag-revealed socket does — so the ordering here is the plain
 *   registry order rather than a visible-first one, keeping the node's PRIMARY
 *   input (Image's `uv`) the first thing a splice reaches for.
 *
 * When every socket is taken the first port comes back anyway: a splice must
 * still splice, and the caller's single-input enforcement then replaces that
 * port's edge exactly as it always did.
 *
 * Pure (node-env testable); NodeEditor supplies the live edge/value state.
 */

import type { NodeDefinition } from '@/types';
import { effectiveInputs } from '@/registry/nodeRegistry';

/**
 * The input port a drop-on-edge splice should wire the edge's source into.
 *
 * @param def              registry definition of the node being spliced in
 * @param connectedHandles target-handle ids on this node that already carry an
 *                         incoming edge
 * @param valuedHandles    keys carrying a stored inline value — variadic row
 *                         retention (`add(x, 2, 3)`) reads them, harmless for
 *                         everything else since non-operand keys index to -1
 * @returns the port id, or null for a node with no inputs at all
 */
export function pickSpliceInputPort(
  def: NodeDefinition,
  connectedHandles: Iterable<string>,
  valuedHandles: Iterable<string> = [],
): string | null {
  if (def.inputs.length === 0) return null;
  const taken = new Set(connectedHandles);
  const ports = effectiveInputs(def, taken, true, valuedHandles);
  if (ports.length === 0) return null;
  return (ports.find((p) => !taken.has(p.id)) ?? ports[0]).id;
}
