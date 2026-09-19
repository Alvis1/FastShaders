/**
 * The rail's two requests, as CustomEvents on `window`.
 *
 * The 3D preview pane is a different React tree from the canvas — a sibling of
 * the node editor under SplitPane — so its rail has no React Flow handle to
 * glide with and no business calling `addNode` itself. It asks, and NodeEditor
 * (which owns `fitView`, the node list and the one add path) answers. The
 * `fs:preview-model-file` / `fs:mesh-highlight` idiom: a CustomEvent is how a
 * surface in this app reaches a capability that lives in another pane.
 *
 * The CANVAS rail goes the same way even though it could call `focusNode`
 * directly, so there is ONE path to debug rather than two that can drift.
 *
 * Deliberately not store state: "the user asked to look at this node" is not a
 * fact about the graph and must never reach history, the autosave or a shared
 * file — the `previewLinkHit` / `hoveredNodeId` rule.
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
