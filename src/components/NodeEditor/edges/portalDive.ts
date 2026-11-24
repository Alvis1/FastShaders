/**
 * A wire DIVING into a Portal's hole (owner, 2026-11-24: "let the edge dive in
 * the hole") — the pure half and the host registry behind TypedEdge's dive.
 *
 * The stretch of a wire over a hole is drawn INSIDE that Portal end's own
 * card (the hole's `tunnel-node__dive` host, registered here by the canvas
 * card), never in a layer of its own above the node layer: a layer one z-step
 * over the portal end painted over every card that covered the hole at the
 * same z (a group member dropped on it). Inside the card it paints exactly
 * where the card paints — under whatever covers the card, over the hole — and
 * it grows with the hole's own `scale`, so the copy and the hole meet at one
 * radius in every state (no band drawn twice, no gap).
 *
 * A LEAF of React and nothing else: no store, no React Flow.
 */
import { useSyncExternalStore } from 'react';

/** The collapsed group's hidden-wire class (store/useAppStore.ts). */
const COLLAPSED_EDGE_CLASS = 'fs-collapsed-edge';

/**
 * Does an edge's `className` hold `cls`? A file is adversarial: an edge's
 * `className` can be a number, a boolean or an object, and `.includes` on one
 * THREW during render — every edge renders on boot, so the app blanked on
 * every reload once the autosave had kept the graph. Only a string holds a
 * class.
 */
export function edgeClassHas(className: unknown, cls: string): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes(cls);
}

/**
 * Which ends of a wire dive, as ONE primitive for a per-edge selector: `i`
 * when it runs INTO a Portal In's hole, `o` when it comes OUT of a Portal
 * Out's, both, or '' — and '' for a wire hidden in a collapsed group (its
 * hole is not drawn either). The flow TYPES are React Flow's own node types.
 */
export function diveKeyOf(edgeClassName: unknown, sourceType: unknown, targetType: unknown): string {
  if (edgeClassHas(edgeClassName, COLLAPSED_EDGE_CLASS)) return '';
  return (targetType === 'tunnelIn' ? 'i' : '') + (sourceType === 'tunnelOut' ? 'o' : '');
}

/* ---------------- the dive hosts: one element per drawn Portal end ---------------- */

const hosts = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * The canvas card's ref for its dive host: `el` mounted for the Portal end
 * `nodeId`, or null when it unmounts. A null never removes a NEWER host that
 * a remount registered first.
 */
export function setDiveHost(nodeId: string, el: HTMLElement | null, prev?: HTMLElement | null): void {
  if (el) {
    if (hosts.get(nodeId) === el) return;
    hosts.set(nodeId, el);
    notify();
    return;
  }
  if (prev !== undefined && hosts.get(nodeId) !== prev) return;
  if (hosts.delete(nodeId)) notify();
}

/** The dive host of the Portal end `nodeId`, or null (none, or none drawn). */
export function diveHostOf(nodeId: string | null): HTMLElement | null {
  return nodeId === null ? null : hosts.get(nodeId) ?? null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** {@link diveHostOf} as a hook: re-renders when that end's host changes. */
export function useDiveHost(nodeId: string | null): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => diveHostOf(nodeId), () => null);
}
