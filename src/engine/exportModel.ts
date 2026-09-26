/**
 * WHICH model an export carries under models/.
 *
 *  - EXPORT (the toolbar button) carries the model the preview SHOWS, per the
 *    popover's "Export model" row: a dropped model while it is on screen
 *    (`exportIncludeMesh`, on by default, as before), or a BUILT-IN shape —
 *    sphere, cube, plane, the Raymarch window, the Utah teapot, the Stanford
 *    bunny — written as an `.obj` (engine/builtinModelObj.ts) when
 *    `exportBuiltinModel` is ticked (off by default, so a plain shader still
 *    exports as a bare `.js`).
 *  - A DOCUMENT save — NEW's Export Current, the Work-folder Save, the study
 *    package — carries what it always did: the dropped model whenever one is
 *    loaded and the row is on for it, whatever the preview shows, and never a
 *    built-in shape (the project block already records which one was showing).
 *  - A study session never exports a built-in shape; EXPORT there follows the
 *    document rule, so the study package keeps its shape.
 *
 * Pure apart from the bunny text cache; `ShaderPreview` reports the shown
 * shape to the store (`previewShape`), which is how this knows it.
 */
import type { PreviewMesh } from '@/utils/previewMesh';
import type { ExportMesh } from '@/utils/exportBundle';
import { bunnyTextNow } from '@/utils/builtinModelText';
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
  exportBuiltinModel: boolean;
}

/** The model a DOCUMENT save carries (see the module header). */
export function documentExportModel(s: ExportModelState): ExportMesh | null {
  return s.exportIncludeMesh && s.previewMesh ? s.previewMesh : null;
}

/** The model EXPORT carries (see the module header). */
export function activeExportModel(s: ExportModelState, evalMode: boolean): ExportMesh | null {
  if (evalMode) return documentExportModel(s);
  const active = activePreviewModel(s.previewShape, s.previewMesh);
  if (!active) return null;
  if (active.kind === 'dropped') return s.exportIncludeMesh ? active.mesh : null;
  return s.exportBuiltinModel && s.previewShape ? builtinExportMesh(active.shape, s.previewShape) : null;
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
