/**
 * A node's MAIN input: the socket a connection lands on when nothing more
 * specific was aimed at — the Factor of a Mix, the X of a Smoothstep, otherwise
 * the top input.
 *
 * Every gesture that connects without naming a socket asks here: a node dragged
 * onto another (dragConnect.ts), a palette tile dragged onto a node, a wire
 * dropped on empty canvas, a node dropped on a wire (edgeSplice.ts). One answer
 * keeps them from disagreeing — the registry's input ORDER is a codegen and
 * layout contract (it is the order the TSL call takes its arguments in), so it
 * cannot be reshuffled to put the factor first; this table is the exception list.
 *
 * Only a type whose main input is NOT its first needs an entry. Keyed by type in
 * a `Map`: a node type is adversarial text, and a plain object would answer
 * `constructor`.
 */
import type { NodeDefinition } from '@/types';

const PRIMARY_INPUT_OVERRIDES: ReadonlyMap<string, string> = new Map([
  // mix(a, b, t): the blend FACTOR is what a wire usually brings (a noise, a
  // mask, a gradient); A and B are the two things blended.
  ['mix', 't'],
  // smoothstep(edge0, edge1, x): the value being shaped is X, not an edge.
  ['smoothstep', 'x'],
]);

/** The id of the main input socket, or null for a node with no inputs. An
 *  override naming a port the def does not have falls back to the first. */
export function primaryInputId(def: Pick<NodeDefinition, 'type' | 'inputs'> | undefined): string | null {
  if (!def || def.inputs.length === 0) return null;
  const override = PRIMARY_INPUT_OVERRIDES.get(def.type);
  if (override !== undefined && def.inputs.some((i) => i.id === override)) return override;
  return def.inputs[0].id;
}
