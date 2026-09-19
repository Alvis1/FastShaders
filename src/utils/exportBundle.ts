/**
 * "Download Shader" bundle assembly — extracted from CodeEditor so the
 * js-vs-zip decision, the entry list, and the README text are pure and
 * unit-testable without DOM. CodeEditor keeps only the blob/anchor plumbing.
 *
 * The download becomes a .zip when the graph embeds images (each image rides
 * alongside as a regular file) and/or a custom preview mesh is loaded (the
 * model file ships under models/ so the shader+mesh pair works in Podest and
 * in a plain A-Frame page). A bare graph stays a single self-contained .js.
 * Every bundle also carries its size facts (ExportBundleSize), counted from the
 * SAME entry list the zip is written from, for the export pre-flight
 * (utils/exportPreflight.ts).
 */

import { buildZip, type ZipEntry } from './zipWriter';
import type { PreviewMesh } from './previewMesh';

export interface ExportImageFile {
  name: string;
  bytes: Uint8Array<ArrayBufferLike>;
}

/** The mesh fields the bundle needs — decoupled from the live store shape. */
export type ExportMesh = Pick<PreviewMesh, 'name' | 'kind' | 'bytes'>;

/**
 * Size facts every bundle carries, counted the way zipReader counts (read by the
 * export pre-flight, utils/exportPreflight.ts).
 */
export interface ExportBundleSize {
  /**
   * Bytes the bundle unpacks to: for a zip, the sum of every entry's data
   * (buildZip writes STORE only and no directory entries, so this is exactly
   * readZip's running total); for a bare .js, its UTF-8 length.
   */
  unpackedBytes: number;
  /** The model's own bytes inside the bundle; 0 when none rides along. */
  meshBytes: number;
  /**
   * `unpackedBytes` of the SAME export built with no mesh (which may be a bare
   * .js). Equals `unpackedBytes` when `meshBytes` is 0.
   */
  unpackedBytesWithoutMesh: number;
  /**
   * Entries the bundle holds, as readZip counts them against `MAX_ENTRIES`
   * (buildZip writes no directory entries, so this is the entry list's length);
   * 1 for a bare .js. One `images/` entry per DISTINCT image (MIME + decoded
   * bytes), so this — unlike the size — can cross the reader's cap with tiny
   * images.
   */
  entryCount: number;
  /** `entryCount` of the SAME export built with no mesh. */
  entryCountWithoutMesh: number;
}

export type ExportBundle = (
  | { kind: 'js'; fileName: string; mime: 'application/javascript'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'zip'; fileName: string; mime: 'application/zip'; bytes: Uint8Array<ArrayBuffer> }
) & ExportBundleSize;

/**
 * The A-Frame pairing snippet for a bundled model (README + docs use it).
 * `0 1.6 -3` is eye height, three metres out — the same placement the A-Frame
 * tab's page uses (OBJECT_POSITION in engine/tslToAFrameHTML.ts; kept a
 * literal here so this pure util doesn't pull in the engine chain).
 */
export function meshPairingSnippet(mesh: ExportMesh, jsName: string): string {
  return mesh.kind === 'obj'
    ? `<a-entity obj-model="obj: url(models/${mesh.name})" shader="src: ${jsName}" position="0 1.6 -3"></a-entity>`
    : `<a-entity gltf-model="url(models/${mesh.name})" shader="src: ${jsName}" position="0 1.6 -3"></a-entity>`;
}

export function buildExportReadme(
  baseName: string,
  hasImages: boolean,
  mesh: ExportMesh | null,
): string {
  const selfContained = hasImages
    ? 'Fully self-contained (the images\nare embedded inside it as data: URLs): load it with a-frame-shaderloader,'
    : 'Fully self-contained: load it with a-frame-shaderloader,';
  const lines = [
    'FastShaders export',
    '==================',
    '',
    `${baseName}.js — the shader module. ${selfContained}`,
    'drop it into Podest (the FastShaders viewer), or drag it back into the editor to',
    'continue working — the full node graph rides along in its',
    'FASTSHADERS_PROJECT_V1 block.',
    '',
  ];
  if (hasImages) {
    lines.push(
      'images/ — the same images as regular files, for reuse or editing.',
      'Re-drop an edited image onto the editor canvas to swap it in.',
      '',
    );
  }
  if (mesh) {
    lines.push(
      `models/${mesh.name} — the 3D model the shader was previewed on.`,
      'Pair them in an A-Frame page:',
      '',
      `  ${meshPairingSnippet(mesh, `${baseName}.js`)}`,
      '',
      'or drop this whole .zip into Podest to see the shader on the model.',
      '',
    );
  }
  lines.push(
    'Tip: dragging this whole .zip into the FastShaders editor loads the',
    `project too (it reads the .js inside${mesh ? ' and reloads the model into the preview' : ''}).`,
    '',
  );
  return lines.join('\n');
}

/** The zip entries in write order, or null when the bundle stays a bare .js. */
function bundleEntries(
  baseName: string,
  scriptBytes: Uint8Array<ArrayBuffer>,
  images: ExportImageFile[],
  mesh: ExportMesh | null,
): ZipEntry[] | null {
  if (images.length === 0 && !mesh) return null;
  return [
    { name: `${baseName}.js`, data: scriptBytes },
    ...images.map((f) => ({ name: `images/${f.name}`, data: f.bytes })),
    ...(mesh ? [{ name: `models/${mesh.name}`, data: mesh.bytes }] : []),
    {
      name: 'README.txt',
      data: new TextEncoder().encode(buildExportReadme(baseName, images.length > 0, mesh)),
    },
  ];
}

/** Sum of the entries' data — what readZip counts against its cap. */
function entryBytes(entries: ZipEntry[]): number {
  return entries.reduce((s, e) => s + e.data.length, 0);
}

/** Bytes a bundle with these parts unpacks to (see ExportBundleSize.unpackedBytes). */
export function unpackedBundleBytes(
  baseName: string,
  scriptBytes: Uint8Array<ArrayBuffer>,
  images: ExportImageFile[],
  mesh: ExportMesh | null,
): number {
  const entries = bundleEntries(baseName, scriptBytes, images, mesh);
  return entries === null ? scriptBytes.length : entryBytes(entries);
}

export function buildExportBundle(
  baseName: string,
  embeddedScript: string,
  images: ExportImageFile[],
  mesh: ExportMesh | null,
): ExportBundle {
  const scriptBytes = new TextEncoder().encode(embeddedScript);
  const entries = bundleEntries(baseName, scriptBytes, images, mesh);
  const unpackedBytes = entries === null ? scriptBytes.length : entryBytes(entries);
  const meshBytes = mesh ? mesh.bytes.length : 0;
  const entryCount = entries === null ? 1 : entries.length;
  const size: ExportBundleSize = {
    unpackedBytes,
    meshBytes,
    unpackedBytesWithoutMesh: mesh
      ? unpackedBundleBytes(baseName, scriptBytes, images, null)
      : unpackedBytes,
    entryCount,
    // Dropping the model removes its one entry; with no images left the
    // bundle becomes a bare .js (1).
    entryCountWithoutMesh: mesh ? (images.length === 0 ? 1 : entryCount - 1) : entryCount,
  };
  if (entries === null) {
    return { kind: 'js', fileName: `${baseName}.js`, mime: 'application/javascript', bytes: scriptBytes, ...size };
  }
  return { kind: 'zip', fileName: `${baseName}.zip`, mime: 'application/zip', bytes: buildZip(entries), ...size };
}
