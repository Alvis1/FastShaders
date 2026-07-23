/**
 * "Download Shader" bundle assembly — extracted from CodeEditor so the
 * js-vs-zip decision, the entry list, and the README text are pure and
 * unit-testable without DOM. CodeEditor keeps only the blob/anchor plumbing.
 *
 * The download becomes a .zip when the graph embeds images (each image rides
 * alongside as a regular file) and/or a custom preview mesh is loaded (the
 * model file ships under models/ so the shader+mesh pair works in Podest and
 * in a plain A-Frame page). A bare graph stays a single self-contained .js.
 */

import { buildZip } from './zipWriter';
import type { PreviewMesh } from './previewMesh';

export interface ExportImageFile {
  name: string;
  bytes: Uint8Array<ArrayBufferLike>;
}

/** The mesh fields the bundle needs — decoupled from the live store shape. */
export type ExportMesh = Pick<PreviewMesh, 'name' | 'kind' | 'bytes'>;

export type ExportBundle =
  | { kind: 'js'; fileName: string; mime: 'application/javascript'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'zip'; fileName: string; mime: 'application/zip'; bytes: Uint8Array<ArrayBuffer> };

/** The A-Frame pairing snippet for a bundled model (README + docs use it). */
export function meshPairingSnippet(mesh: ExportMesh, jsName: string): string {
  return mesh.kind === 'obj'
    ? `<a-entity obj-model="obj: url(models/${mesh.name})" shader="src: ${jsName}" position="0 1.5 -3"></a-entity>`
    : `<a-entity gltf-model="url(models/${mesh.name})" shader="src: ${jsName}" position="0 1.5 -3"></a-entity>`;
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

export function buildExportBundle(
  baseName: string,
  embeddedScript: string,
  images: ExportImageFile[],
  mesh: ExportMesh | null,
): ExportBundle {
  const enc = new TextEncoder();
  const scriptBytes = enc.encode(embeddedScript);
  if (images.length === 0 && !mesh) {
    return { kind: 'js', fileName: `${baseName}.js`, mime: 'application/javascript', bytes: scriptBytes };
  }
  const zip = buildZip([
    { name: `${baseName}.js`, data: scriptBytes },
    ...images.map((f) => ({ name: `images/${f.name}`, data: f.bytes })),
    ...(mesh ? [{ name: `models/${mesh.name}`, data: mesh.bytes }] : []),
    { name: 'README.txt', data: enc.encode(buildExportReadme(baseName, images.length > 0, mesh)) },
  ]);
  return { kind: 'zip', fileName: `${baseName}.zip`, mime: 'application/zip', bytes: zip };
}
