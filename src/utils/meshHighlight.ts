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
 *
 * Since GLB Phase 5 Step 10 a highlight may name SEVERAL meshes at once
 * (`highlightMeshes`): an import-built index section shades every mesh of a
 * glTF material, and hovering its chip lights them all. The list rides as
 * `names` beside the single `name` (kept, so every existing sender and the
 * older preview documents keep working); it is capped, and only non-empty
 * strings count.
 */

/** Highlight the named mesh, or clear the highlight when passed null. */
export const MESH_HIGHLIGHT_EVENT = 'fs:mesh-highlight';

export interface MeshHighlightDetail {
  name: string | null;
  /** Several meshes at once (an index section's); wins over `name`. */
  names?: readonly string[];
}

/** Most meshes one highlight may name — an inventory never exceeds it. */
export const MAX_HIGHLIGHT_NAMES = 256;

/** The usable subset of a name list: non-empty strings, each once, capped. */
export function sanitizeHighlightNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (out.length >= MAX_HIGHLIGHT_NAMES) break;
    if (typeof v !== 'string' || v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function highlightMesh(name: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<MeshHighlightDetail>(MESH_HIGHLIGHT_EVENT, { detail: { name } }),
  );
}

/** Highlight every named mesh at once (an empty list clears). */
export function highlightMeshes(names: readonly string[]): void {
  if (typeof window === 'undefined') return;
  const list = sanitizeHighlightNames(names);
  window.dispatchEvent(
    new CustomEvent<MeshHighlightDetail>(MESH_HIGHLIGHT_EVENT, {
      detail: { name: list[0] ?? null, names: list },
    }),
  );
}
