/**
 * "Show me which mesh that is" — from any authoring surface to the 3D preview.
 *
 * A window CustomEvent rather than a store field or a prop chain, for the same
 * reason `fs-tile-drop` is one: the sender is a context menu that may be
 * anywhere in the tree, the receiver is the preview pane, and the payload is a
 * transient hint with no place in application state. Putting it in the store
 * would push a re-render through every subscriber for something that is over
 * in a few hundred milliseconds and must never be persisted, undone, or
 * exported.
 *
 * The preview forwards it to the sandboxed iframe as `fs:highlight-mesh`.
 * Nothing observes the result: a highlight that cannot be shown (no model
 * loaded, the preview pane collapsed, the document mid-rebuild) is simply not
 * shown, which is the correct behaviour for a hover hint.
 */

/** Highlight the named mesh, or clear the highlight when passed null. */
export const MESH_HIGHLIGHT_EVENT = 'fs:mesh-highlight';

export interface MeshHighlightDetail {
  name: string | null;
}

export function highlightMesh(name: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<MeshHighlightDetail>(MESH_HIGHLIGHT_EVENT, { detail: { name } }),
  );
}
