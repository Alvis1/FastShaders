/**
 * WHAT an export carries — the format and the model under models/ — decided
 * per SURFACE. EXPORT is CONTEXTUAL (owner, 2026-09-28): what the 3D preview
 * SHOWS decides what the button writes, and the popover's one smaller button
 * is the other way, for that one export. Nothing about it is stored.
 *
 *  - EXPORT ('primary'):
 *      a dropped model on screen that one `.glb` can hold → that `.glb` (the
 *        model, its textures and the shader inside);
 *      a dropped model on screen that it cannot (an OBJ, a Gaussian splat, an
 *        external-data or unreadable glTF) → the `.zip` with the model under
 *        models/, as before;
 *      a BUILT-IN shape (sphere, cube, plane, the Raymarch window, the Utah
 *        teapot, the Stanford bunny), or nothing → the shader file alone: a
 *        bare `.js`, or a `.zip` when the graph embeds images.
 *  - The popover's smaller button ('alternate', `exportAlternate`):
 *      a built-in shape on screen → "Export with model": the `.zip` with the
 *        shape written as an `.obj` (engine/builtinModelObj.ts);
 *      a dropped model EXPORT would pack into a `.glb` → "Export .zip": the
 *        shader file with the model under models/.
 *      Otherwise there is no other way to offer, and no button.
 *  - A DOCUMENT save ('document') — NEW's Export Current, the Work-folder
 *    Save, the study package — carries what it always did: the dropped model
 *    whenever one is loaded (`exportIncludeMesh`), whatever the preview shows,
 *    and never a built-in shape (the project block already records which one
 *    was showing); it is the `.glb` whenever that model can be packed, so a
 *    Work-folder file opened as a `.glb` saves back as one — EXCEPT a
 *    Work-folder Save back to a `.js`/`.zip` it tracks, or (nothing tracked,
 *    after a relaunch) that the folder holds as a bundle and not as a `.glb`:
 *    those stay the bundle (utils/workFolderFile.ts `keepsBundleFormat`,
 *    `untrackedKeepsBundle` → `ShaderExportAsks.bundleOnly`).
 *  - A study session never exports a built-in shape and never a `.glb`;
 *    EXPORT there follows the document rule, so the study package keeps its
 *    shape, and its popover keeps the "Export model" checkbox for
 *    `exportIncludeMesh`.
 *
 * Pure apart from the bunny text cache; `ShaderPreview` reports the shown
 * shape to the store (`previewShape`), which is how this knows it.
 */
import type { PreviewMesh } from '@/utils/previewMesh';
import type { ExportMesh } from '@/utils/exportBundle';
import { bunnyTextNow } from '@/utils/builtinModelText';
import { effectiveExportFormat, glbExportAvailability, type ExportFormat } from '@/utils/glbExportAvailability';
import type { GeometryType } from './tslToPreviewHTML';
import { BUILTIN_MODEL_FILE, builtinModelObj, isBuiltinShape, type BuiltinShape } from './builtinModelObj';

/** What the 3D pane RENDERS (`ShaderPreview` is the one writer; session-only). */
export interface PreviewShape {
  geometry: GeometryType;
  /** The subdivision the shape is tessellated at (the teapot's resolution). */
  subdivision: number;
  /** The Raymarch window radius (marchSphere only). */
  marchWindow: number;
}

export type ActivePreviewModel =
  | { kind: 'dropped'; mesh: PreviewMesh }
  | { kind: 'builtin'; shape: BuiltinShape }
  | null;

/**
 * The model on screen. Before the preview has reported (no `shape`), a loaded
 * dropped model counts as shown — the rule every export followed before shapes
 * were exportable.
 */
export function activePreviewModel(shape: PreviewShape | null, mesh: PreviewMesh | null): ActivePreviewModel {
  if (!shape || shape.geometry === 'custom') return mesh ? { kind: 'dropped', mesh } : null;
  return isBuiltinShape(shape.geometry) ? { kind: 'builtin', shape: shape.geometry } : null;
}

export interface ExportModelState {
  previewMesh: PreviewMesh | null;
  previewShape: PreviewShape | null;
  exportIncludeMesh: boolean;
}

/** Which export a surface makes (see the module header). */
export type ExportSurface = 'primary' | 'alternate' | 'document';

/** The model a DOCUMENT save carries (see the module header) — the ONE statement of that rule. */
export function documentExportModel(s: ExportModelState): PreviewMesh | null {
  return s.exportIncludeMesh && s.previewMesh ? s.previewMesh : null;
}

/**
 * The dropped model a surface would pack into ONE `.glb`, or null — the input
 * `effectiveExportFormat` checks for packability. EXPORT packs only a model
 * the preview SHOWS; the smaller button never packs; a document save packs
 * the loaded one.
 */
export function glbCandidate(s: ExportModelState, evalMode: boolean, surface: ExportSurface): PreviewMesh | null {
  if (evalMode || surface === 'alternate') return null;
  if (surface === 'document') return documentExportModel(s);
  const active = activePreviewModel(s.previewShape, s.previewMesh);
  return active?.kind === 'dropped' ? active.mesh : null;
}

/** THE format a surface writes: `.glb` or the bundle (`.js`/`.zip`). */
export function exportFormatFor(s: ExportModelState, evalMode: boolean, surface: ExportSurface): ExportFormat {
  return effectiveExportFormat(glbCandidate(s, evalMode, surface), evalMode);
}

/**
 * WHICH model an EXPORT button carries, decided without building any file —
 * the one decision `activeExportModel` builds from and the A-Frame tab names
 * its `models/` entry from, so the page names the file the download holds.
 * (Naming a built-in shape must not tessellate it: a 128-resolution teapot is
 * tens of MB of text.)
 */
export function exportModelChoice(
  s: ExportModelState,
  evalMode: boolean,
  surface: 'primary' | 'alternate' = 'primary',
): ActivePreviewModel {
  if (evalMode) {
    const doc = documentExportModel(s);
    return doc ? { kind: 'dropped', mesh: doc } : null;
  }
  const active = activePreviewModel(s.previewShape, s.previewMesh);
  if (!active) return null;
  // A dropped model on screen rides every way out: inside the .glb, or in the
  // .zip under models/.
  if (active.kind === 'dropped') return active;
  // A built-in shape: EXPORT writes the shader alone; "Export with model" adds
  // the shape's .obj.
  if (surface !== 'alternate') return null;
  // The bunny is written from the preview's fetched text; until it has arrived
  // there is no file to ship, and naming one would point the page at nothing.
  if (active.shape === 'bunny' && bunnyTextNow() === null) return null;
  return s.previewShape ? active : null;
}

/** The `models/` file name and kind a choice exports as. */
export function exportModelFile(choice: NonNullable<ActivePreviewModel>): Pick<ExportMesh, 'name' | 'kind'> {
  return choice.kind === 'dropped'
    ? { name: choice.mesh.name, kind: choice.mesh.kind }
    : { name: BUILTIN_MODEL_FILE[choice.shape], kind: 'obj' };
}

/** The model an EXPORT button carries (see the module header). */
export function activeExportModel(
  s: ExportModelState,
  evalMode: boolean,
  surface: 'primary' | 'alternate' = 'primary',
): ExportMesh | null {
  const choice = exportModelChoice(s, evalMode, surface);
  if (!choice) return null;
  if (choice.kind === 'dropped') return choice.mesh;
  return s.previewShape ? builtinExportMesh(choice.shape, s.previewShape) : null;
}

/**
 * What the popover's smaller button offers right now, or null for no button:
 * `'with-model'` with a built-in shape on screen, `'zip'` with a dropped
 * model EXPORT packs into a `.glb`. Never in a study session (EXPORT opens
 * the finish dialog there).
 */
export function exportAlternate(s: ExportModelState, evalMode: boolean): 'with-model' | 'zip' | null {
  if (evalMode) return null;
  const active = activePreviewModel(s.previewShape, s.previewMesh);
  if (!active) return null;
  if (active.kind === 'dropped') return glbExportAvailability(active.mesh).ok ? 'zip' : null;
  return exportModelChoice(s, false, 'alternate') ? 'with-model' : null;
}

// One export builds the bundle more than once (the pre-flight's rebuild, the
// `.zip` alternative of a `.glb`), and a 128-resolution teapot is tens of MB of
// text: the last file is kept, keyed on everything that shapes it.
let memo: { key: string; bunny: string | null; mesh: ExportMesh | null } | null = null;

function builtinExportMesh(shape: BuiltinShape, p: PreviewShape): ExportMesh | null {
  const bunny = shape === 'bunny' ? bunnyTextNow() : null;
  const key = `${shape}|${p.subdivision}|${p.marchWindow}`;
  if (memo && memo.key === key && memo.bunny === bunny) return memo.mesh;
  const text = builtinModelObj(shape, { subdivision: p.subdivision, marchWindow: p.marchWindow, bunnyText: bunny });
  const mesh: ExportMesh | null = text === null
    ? null
    : { name: BUILTIN_MODEL_FILE[shape], kind: 'obj', bytes: new TextEncoder().encode(text) };
  memo = { key, bunny, mesh };
  return mesh;
}
