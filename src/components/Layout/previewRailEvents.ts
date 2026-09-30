/**
 * The rail's two requests, as CustomEvents on `window`.
 *
 * The rail is chrome outside <ReactFlow>, so it asks, and NodeEditor (which
 * owns `fitView`, the node list and the one add path) answers — the
 * `fs:preview-model-file` / `fs:mesh-highlight` idiom.
 *
 * Deliberately not store state: "the user asked to look at this node" is not a
 * fact about the graph and must never reach history, the autosave or a shared
 * file — the `previewLinkHit` rule.
 */

/** Glide the canvas to an Output node. */
export const RAIL_FOCUS_EVENT = 'fs:rail-focus-node';
/** Add the graph's first Output node (the hollow socket's click). */
export const RAIL_ADD_OUTPUT_EVENT = 'fs:rail-add-output';

export function requestFocusNode(id: string): void {
  window.dispatchEvent(new CustomEvent(RAIL_FOCUS_EVENT, { detail: { id } }));
}

export function requestAddFirstOutput(): void {
  window.dispatchEvent(new CustomEvent(RAIL_ADD_OUTPUT_EVENT));
}

/** The id off a focus event, or null — the detail crosses no trust boundary
 *  (same document, our own dispatch), but it is read strictly all the same so a
 *  forged event cannot reach `focusNode` with a non-string. */
export function focusRequestId(e: Event): string | null {
  const id = (e as CustomEvent<{ id?: unknown }>).detail?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
