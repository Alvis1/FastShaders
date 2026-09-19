/**
 * The preview's GEOMETRY preference: what `fs:previewGeometry` may hold, and
 * which shape the pane really shows for it.
 *
 * A LEAF (one type-only import), so the rule is node-testable — ShaderPreview
 * itself imports React, CSS and the whole engine and has never been rendered
 * in a test.
 *
 * WHY THE TWO ARE SEPARATE. 'custom' means "the dropped model", and the model
 * is session state restored ASYNCHRONOUSLY from IndexedDB
 * (`previewMeshCache`), so on every boot there is a window in which the
 * preference is valid and the mesh has not arrived yet. `validateGeometry`
 * used to resolve that by DOWNGRADING 'custom' to 'sphere' whenever no mesh
 * was loaded — and `usePersistedState` writes its seeded value straight back,
 * so every boot overwrote the stored 'custom' with 'sphere' for ~250 ms
 * (MEASURED) before the restore could put it back. A reload, a vite dev
 * full-reload or a crash inside that window destroyed the preference
 * permanently: the mesh still came back from IndexedDB (so the Model entry
 * sat in the dropdown, named after the user's file) while the viewport
 * rendered a sphere, and no later boot ever recovered — the owner's "the
 * model disappears and there is a sphere, although the top selection shows
 * that it is the mesh".
 *
 * So the stored value is kept VERBATIM and the fallback is DERIVED at render
 * (`shownGeometry`) — the `effectiveTab` rule the optional-categories
 * convention states for `fs:assetTab`, for the same reason: writing a
 * derived downgrade back discards a preference the user never changed.
 * ONE derivation feeds both the document and the `<select>`, so the picker
 * and the viewport cannot disagree about which shape is on screen.
 */
import type { GeometryType } from '@/engine/tslToPreviewHTML';

/**
 * The stored `fs:previewGeometry` value, or 'sphere' for anything unknown.
 *
 * 'custom' is accepted whether or not a mesh is loaded: it is a PREFERENCE,
 * not a claim about the current session. `shownGeometry` is what turns it
 * into the shape actually rendered. Module scope and free of side effects —
 * `usePersistedState` requires a stable identity, and this one no longer
 * reads the store at all.
 */
export function validateGeometry(v: string | null): GeometryType {
  if (
    v === 'cube' || v === 'plane' || v === 'sphere' ||
    v === 'teapot' || v === 'bunny' || v === 'custom'
  ) {
    return v;
  }
  return 'sphere';
}

/**
 * The geometry the pane SHOWS for a stored preference: 'custom' only while a
 * mesh is actually loaded, everything else verbatim. The caller applies the
 * Raymarch window override (`MARCH_WINDOW_GEOMETRY`) on top of this — that one
 * is a property of the graph, not of the preference.
 */
export function shownGeometry(stored: GeometryType, hasMesh: boolean): GeometryType {
  return stored === 'custom' && !hasMesh ? 'sphere' : stored;
}
