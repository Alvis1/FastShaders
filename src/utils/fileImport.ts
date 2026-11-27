/**
 * The Import buttons — the canvas's, beside New, and the code panel's — open
 * EVERY kind of file FastShaders reads (owner, 2026-11-26), through ONE router:
 * NodeEditor's `importPickedFiles`, which hands each file to the path a drop of
 * it already takes. This module is what the two buttons share: what a file IS,
 * the picker's `accept` list, and the request the code panel raises (the
 * placement paths live on the canvas, as `requestPicturePlacement`'s do).
 *
 * `importFileKind` is also the canvas DROP's partition, so a drop and a pick
 * can never disagree about a file. The order is the drop's: a `.csv` first
 * (a MIME-typed oddity must not pass for anything else), then a shader, a 3D
 * model or splat, a picture — and, for the picker only, a palette or a `.json`
 * (a device profile or a palette, told apart by its content).
 */
import { MESH_EXTENSIONS, detectMeshKind } from '@/utils/previewMesh';
import { isImageFile } from '@/utils/imageImport';
import { PICTURE_EXTENSIONS } from '@/utils/pictureExtensions';
import { isZipFile } from '@/engine/projectImport';

export type ImportFileKind =
  /** A shader: `.js` / `.mjs` / `.tsl`, or a FastShaders `.zip` — opened. */
  | 'shader'
  /** A 3D model or a Gaussian splat — to the 3D view. */
  | 'model'
  /** A picture — an Image node. */
  | 'picture'
  /** A `.csv` — a Data node. */
  | 'csv'
  /** A GIMP `.gpl` palette — the Palettes dialog. */
  | 'palette'
  /** A `.json`: a device profile or a FastShaders palette, by its content. */
  | 'json'
  /** Nothing FastShaders reads. */
  | 'other';

export function importFileKind(file: File): ImportFileKind {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || file.type === 'text/csv') return 'csv';
  if (isZipFile(file) || /\.(js|mjs|tsl)$/.test(lower)) return 'shader';
  if (detectMeshKind(file.name) !== null) return 'model';
  if (isImageFile(file)) return 'picture';
  if (lower.endsWith('.gpl')) return 'palette';
  if (lower.endsWith('.json')) return 'json';
  return 'other';
}

/** Both Import buttons' tooltip (an lv.json `ui` key). */
export const IMPORT_BUTTON_TITLE =
  'Open files from your computer. A shader (.js / .zip) replaces the current one, and Ctrl+Z / ⌘Z undoes that. A 3D model, Gaussian splat, picture, .csv, palette or device profile is added.';

/** The file picker's filter: every extension `importFileKind` recognises. */
export const IMPORT_FILE_ACCEPT: string = [
  '.js', '.mjs', '.tsl', '.zip',
  ...MESH_EXTENSIONS.map((e) => `.${e}`),
  ...PICTURE_EXTENSIONS.map((e) => `.${e}`),
  'image/*',
  '.csv', 'text/csv',
  '.gpl',
  '.json', 'application/json',
].join(',');

/** The code panel's Import asks the canvas to open what was picked. */
export const IMPORT_FILES_EVENT = 'fs:import-files';

export interface ImportFilesDetail {
  files: File[];
}

export function requestFileImport(files: File[]): void {
  if (typeof window === 'undefined' || files.length === 0) return;
  window.dispatchEvent(new CustomEvent<ImportFilesDetail>(IMPORT_FILES_EVENT, { detail: { files } }));
}

/** The picked files a request carries — real `File`s only, whatever its shape. */
export function importFilesOf(ev: Event): File[] {
  const detail = (ev as CustomEvent<ImportFilesDetail | null>).detail;
  return Array.isArray(detail?.files) ? detail.files.filter((f): f is File => f instanceof File) : [];
}
