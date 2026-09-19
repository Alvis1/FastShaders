/**
 * Can the loaded preview model be packed into ONE `.glb`, and which format
 * does EXPORT therefore take right now? (GLB Phase 7 Step 7.)
 *
 * A LEAF: type-only imports, no store, no i18n, so every surface can ask it
 * per render without joining the costTable-style import cycle — its callers
 * pass `isEvalMode()` in rather than it reading the session.
 *
 * It reads only the session-only facts `createPreviewMesh` already derived
 * (`PreviewMesh.gltf`, `.gltfReadRefusal`), so asking costs no re-parse. The
 * BUILD has its own refusals (a module error, a model mismatch, a repack cap);
 * those surface in the export dialog's failed view, not here.
 *
 * `effectiveExportFormat` is the one answer every surface uses (the
 * `effectiveTab` precedent): the flag is DERIVED at render and never written
 * back, so unloading the model leaves it set and reloading one brings the
 * `.glb` straight back.
 */
import type { PreviewMesh } from './previewMesh';

/** Why one `.glb` is not on offer. Each maps to a sentence in glbExportCopy. */
export type GlbExportUnavailable = 'no-model' | 'obj' | 'external-data' | 'unreadable';

export type GlbExportAvailability =
  | { ok: true }
  | { ok: false; reason: GlbExportUnavailable; name?: string };

export type ExportFormat = 'bundle' | 'glb';

/** The mesh fields this decision reads — nothing else may be consulted. */
export type GlbExportMesh = Pick<PreviewMesh, 'kind' | 'name' | 'gltf' | 'gltfReadRefusal'> | null;

/** Pure; reads only session-only mesh facts (no parse). */
export function glbExportAvailability(mesh: GlbExportMesh): GlbExportAvailability {
  if (!mesh) return { ok: false, reason: 'no-model' };
  if (mesh.kind === 'obj') return { ok: false, reason: 'obj', name: mesh.name };
  // `gltf`: an object = read OK; null = refused; undefined = never computed
  // (an older session record, or a mesh built by hand) — treated as unreadable,
  // the safe direction, since the export would have to parse it anyway.
  if (mesh.gltf) return { ok: true };
  return {
    ok: false,
    reason: mesh.gltfReadRefusal === 'external-data' ? 'external-data' : 'unreadable',
    name: mesh.name,
  };
}

/**
 * THE effective export format. `exportAsGlb` is compared EXACTLY against true:
 * it is store state a future import path could hand junk, and a coercing read
 * would turn `'false'` into a `.glb` export.
 */
export function effectiveExportFormat(
  exportAsGlb: boolean,
  mesh: GlbExportMesh,
  evalMode: boolean,
): ExportFormat {
  return !evalMode && exportAsGlb === true && glbExportAvailability(mesh).ok ? 'glb' : 'bundle';
}
