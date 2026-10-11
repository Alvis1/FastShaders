/**
 * The ONE React Flow type registry, shared by every surface that mounts a
 * <ReactFlow>: the editor canvas (NodeEditor.tsx) and the read-only overview
 * viewer on node-editor.html (Graphs/GraphModal.tsx).
 *
 * It is shared rather than mirrored because the mirror already drifted once:
 * GraphModal was missing `sound`, and an unregistered type falls back to React
 * Flow's DEFAULT node — a bare white box with top/bottom handles — so the Sound
 * node rendered there as something that looked like a broken node rather than
 * like itself. Nothing failed; it just looked wrong on one page. A second copy
 * is a second chance to forget the next node type.
 *
 * `audio` is gone (2026-09-08): the Audio Input node was folded into the Sound
 * node, which now carries the source picker that used to be its reason to
 * exist. A saved graph naming it is migrated to `sound` on every restore path —
 * see `registry/legacyNodeTypes.ts` — so nothing lands here as an unregistered
 * type.
 *
 * MODULE SCOPE is load-bearing, not tidiness: React Flow memoizes on the
 * identity of these objects, so a map built per render re-registers every type
 * on every frame of a drag. The `memo` wrapping below is done ONCE here for the
 * same reason.
 */
import { memo, type ComponentType, type MemoExoticComponent } from 'react';
import { ShaderNode } from '@/components/NodeEditor/nodes/ShaderNode';
import { ColorNode } from '@/components/NodeEditor/nodes/ColorNode';
import { PreviewNode } from '@/components/NodeEditor/nodes/PreviewNode';
import { MathPreviewNode } from '@/components/NodeEditor/nodes/MathPreviewNode';
import { ClockNode } from '@/components/NodeEditor/nodes/ClockNode';
import { SoundNode } from '@/components/NodeEditor/nodes/SoundNode';
import { OutputNode } from '@/components/NodeEditor/nodes/OutputNode';
import { RaymarchOutputNode } from '@/components/NodeEditor/nodes/RaymarchOutputNode';
import { SplatOutputNode } from '@/components/NodeEditor/nodes/SplatOutputNode';
import { GroupNode } from '@/components/NodeEditor/nodes/GroupNode';
import { NoteNode } from '@/components/NodeEditor/nodes/NoteNode';
import { TypedEdge } from '@/components/NodeEditor/edges/TypedEdge';

/** Every flow type's component, as written. React Flow is handed `nodeTypes`. */
export const rawNodeTypes = {
  shader: ShaderNode,
  color: ColorNode,
  preview: PreviewNode,
  mathPreview: MathPreviewNode,
  clock: ClockNode,
  sound: SoundNode,
  output: OutputNode,
  raymarchOutput: RaymarchOutputNode,
  splatOutput: SplatOutputNode,
  group: GroupNode,
  note: NoteNode,
};

/** The two props React Flow's NodeWrapper passes that change on every MOVE. */
const POSITION_PROPS: ReadonlySet<string> = new Set(['positionAbsoluteX', 'positionAbsoluteY']);

/**
 * The props comparator every node type is memoized with: `Object.is` on every
 * prop EXCEPT `positionAbsoluteX`/`positionAbsoluteY`, plus a key-count check.
 *
 * React Flow's NodeWrapper passes those two to every custom node, and a moved
 * node (and every child of a moved group) gets new internals, so with the
 * components' default `memo` compare EVERY dragged card re-rendered on every
 * pointermove for two numbers no card reads (nodeTypesMemo.test.ts pins that
 * none does: a card that needs its position reads the store, as ColorNode
 * does). Measured 2026-10-11 on a select-all drag of 171 nodes at 4x CPU
 * throttle: 55.5 → 31.7 ms of script per move, card re-renders per move
 * 168 → ~0. A card still re-renders for `selected`, `dragging`, `data`, its
 * size, and whatever its own store subscriptions ask for.
 */
export function samePropsExceptPosition(prev: object, next: object): boolean {
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (POSITION_PROPS.has(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- memo's own constraint
type AnyComponent = ComponentType<any>;
type PositionFreeTypes<T extends Record<string, AnyComponent>> = { [K in keyof T]: MemoExoticComponent<T[K]> };

function memoizeIgnoringPosition<T extends Record<string, AnyComponent>>(types: T): PositionFreeTypes<T> {
  const out: Partial<PositionFreeTypes<T>> = {};
  for (const k of Object.keys(types) as (keyof T)[]) {
    out[k] = memo(types[k], samePropsExceptPosition) as MemoExoticComponent<T[typeof k]>;
  }
  return out as PositionFreeTypes<T>;
}

/** What React Flow is handed: each raw component wrapped ONCE, at module scope,
 *  in a `memo` that ignores the node's absolute position. */
export const nodeTypes = memoizeIgnoringPosition(rawNodeTypes);

export const edgeTypes = {
  typed: TypedEdge,
};
