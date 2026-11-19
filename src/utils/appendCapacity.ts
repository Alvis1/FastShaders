/**
 * How far a vector-CONCATENATING variadic node (today: `append`) may grow.
 *
 * The arithmetic folds and `append` share one socket-growth rule
 * (`effectiveInputs`, gated by `growsOperands`), but they do NOT share a
 * ceiling. A fold consumes every operand it is given — `mul(a, b, c, d, e)` is
 * one more multiplication — so the only bound it needs is
 * `MAX_CHAIN_OPERANDS`. `append` builds a VECTOR, and a GPU vector holds four
 * channels: its real budget is measured in CHANNELS, not sockets, and ONE
 * wired vec3 already spends three of them.
 *
 * `maxOperands: 4` alone cannot express that. It bounds the socket COUNT, which
 * is the right number only when every operand is a scalar. Wire a vec3 into
 * `a` and the node still offered `b`, `c` and `d` — while
 * `buildAppendConstructor` (graphToCode) trimmed the argument list back to four
 * channels and silently dropped the overflow. So a wire could land on a
 * live-looking socket, draw a real edge, and never reach the shader: measured,
 * `append(vec3 -> a, float -> b, float -> c)` emitted `vec4(vec31, float1)` and
 * the `c` wire simply vanished.
 *
 * This module is the socket-side half of that same cap, so the affordance stops
 * promising what the emitter cannot deliver. The emitter's trim STAYS as the
 * backstop — `values`/edges arrive from adversarial `.fastshader` input and may
 * describe an overflowing node this rule would never have offered.
 *
 * Pure (node-env testable); callers supply the live channel widths.
 */

import type { NodeDefinition } from '@/types';
import { effectiveInputs } from '@/registry/nodeRegistry';

/** Channels in the widest GPU vector type — there is no vec5. */
export const VECTOR_CHANNEL_LIMIT = 4;

/**
 * Channels arriving on one operand socket, or undefined when nothing is wired
 * there. Unknown/blank resolves to 1 — an unwired operand still emits a `0`
 * argument and therefore still costs a channel.
 */
export type ChannelOf = (portId: string) => number | undefined;

/**
 * Does this node concatenate its grown operands into a fixed-width vector
 * (rather than folding them)?
 *
 * Keyed on the FLAG PAIR, not on `def.type === 'append'`, so a second
 * constructor-style variadic node inherits the cap instead of quietly
 * reintroducing the dropped-wire bug. `chainable` implies `variadic`
 * (node.types.ts), so excluding it leaves exactly the concatenating ones.
 */
export function concatenatesOperands(def: NodeDefinition | undefined): boolean {
  return !!def && def.variadic === true && def.chainable !== true;
}

/**
 * Channels the node's EMITTED operands already consume.
 *
 * `portIds` must be the operands that actually reach codegen — i.e.
 * `effectiveInputs(def, connected, false, valued)` — never the list carrying
 * the trailing empty grow slot, which is exactly the socket this number
 * decides the fate of.
 */
export function appendChannelsUsed(portIds: Iterable<string>, channelOf: ChannelOf): number {
  let total = 0;
  for (const id of portIds) {
    const ch = channelOf(id);
    // A non-finite or nonsensical width degrades to one channel rather than
    // poisoning the sum: channelCount runs a full upstream CPU eval, which
    // returns null for anything it cannot evaluate.
    total += Number.isFinite(ch) && (ch as number) >= 1 ? Math.floor(ch as number) : 1;
  }
  return total;
}

/**
 * True when one more operand socket could not contribute a channel, so the
 * grow affordance must not be offered.
 *
 * Returns false for every node that is not a concatenating variadic — the
 * arithmetic folds keep growing to `MAX_CHAIN_OPERANDS` exactly as before.
 *
 * Note this bounds only the TRAILING EMPTY slot. Operands that already carry an
 * edge always keep their socket, even when they overflow: unmounting a handle
 * an edge points at leaves that edge in the store rendering nothing (the
 * documented React Flow failure mode), which is strictly worse than an operand
 * the emitter trims.
 */
export function appendGrowthExhausted(
  def: NodeDefinition,
  connectedHandles: Iterable<string>,
  valuedHandles: Iterable<string>,
  channelOf: ChannelOf,
): boolean {
  if (!concatenatesOperands(def)) return false;
  const emitted = effectiveInputs(def, connectedHandles, false, valuedHandles);
  return appendChannelsUsed(emitted.map((p) => p.id), channelOf) >= VECTOR_CHANNEL_LIMIT;
}

/** One WIRED operand the vector has no room for: `kept` of its `of` channels
 *  reach the constructor (0 = the whole operand is dropped). */
export interface AppendTrim {
  portId: string;
  kept: number;
  of: number;
}

/**
 * The wired operands the EMITTER trims, in socket order — the same walk as
 * graphToCode's `buildAppendConstructor` (an overflowing operand is swizzled
 * down to the room left, later ones are dropped), so the canvas can SAY what
 * the constructor does: `append(vec3, vec3)` is `vec4(a, b.x)`, and a Time
 * wired into that second vector's Z reached nothing (a study participant's
 * "vector add seemed not to work", 2026-11-19). `appendTrim.test.ts` holds the
 * two walks together against the emitted text. Empty for every other node.
 */
export function appendTrimmedOperands(
  def: NodeDefinition | undefined,
  connectedHandles: Iterable<string>,
  valuedHandles: Iterable<string>,
  channelOf: ChannelOf,
): AppendTrim[] {
  if (!def || !concatenatesOperands(def)) return [];
  const out: AppendTrim[] = [];
  let total = 0;
  for (const port of effectiveInputs(def, connectedHandles, false, valuedHandles)) {
    const ch = channelOf(port.id);
    const wired = ch !== undefined;
    const width = wired && Number.isFinite(ch) && (ch as number) >= 1 ? Math.floor(ch as number) : 1;
    const room = VECTOR_CHANNEL_LIMIT - total;
    if (width <= room) {
      total += width;
      continue;
    }
    // An unwired operand past the limit is a `0` nobody asked for: not news.
    if (wired) out.push({ portId: port.id, kept: Math.max(room, 0), of: width });
    total = VECTOR_CHANNEL_LIMIT;
  }
  return out;
}
