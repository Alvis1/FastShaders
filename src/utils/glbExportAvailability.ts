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
 * `effectiveExportFormat` is the PACKABILITY half of the format answer:
 * surfaces never call it — they ask engine/exportModel.ts `exportFormatFor`,
 * which picks the model each surface would pack (`glbCandidate`) and hands it
 * here. DERIVED at render (the `effectiveTab` precedent), nothing stored, so
 * loading a packable model brings the `.glb` straight back.
 */
import type { PreviewMesh } from './previewMesh';
import type { SplatKind } from './splatSniff';

/** Why one `.glb` is not on offer. Each maps to a sentence in glbExportCopy. */
export type GlbExportUnavailable = 'no-model' | 'obj' | 'splat' | 'external-data' | 'unreadable';

/**
 * The splat kinds, spelled here rather than imported so this stays a LEAF
 * (`isSplatKind` is a value in a module that pulls in the pre-read gate). The
 * mapped type makes a fifth `SplatKind` fail `tsc` here instead of falling
 * through to 'unreadable'.
 */
const SPLAT_KIND: { readonly [K in SplatKind]: true } = { splat: true, spz: true, ply: true, ksplat: true };

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
  // A Gaussian splat scene is no glTF mesh: one `.glb` cannot hold it (the
  // KHR_gaussian_splatting form is refused on import too), so EXPORT falls back
  // to the bundle, whose zip carries the scene under models/ with the runtime
  // pairing snippet. Own sentence — the obj one would call it an .obj file.
  if (Object.prototype.hasOwnProperty.call(SPLAT_KIND, mesh.kind)) return { ok: false, reason: 'splat', name: mesh.name };
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
 * THE effective export format: ONE `.glb` exactly when the surface has a model
 * to pack (`mesh` — engine/exportModel.ts `glbCandidate` decides which, per
 * surface) and that model can be packed; the bundle otherwise, and always in a
 * study session. There is no stored choice: EXPORT is CONTEXTUAL (owner,
 * 2026-09-28) — a custom model on screen exports as the `.glb`, a built-in
 * shape as the shader file — and the popover's smaller button is the one-shot
 * other way.
 */
export function effectiveExportFormat(mesh: GlbExportMesh, evalMode: boolean): ExportFormat {
  return !evalMode && glbExportAvailability(mesh).ok ? 'glb' : 'bundle';
}
