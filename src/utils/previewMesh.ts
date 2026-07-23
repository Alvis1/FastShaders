/**
 * Custom preview mesh (dropped 3D model) — pure helpers shared by the preview
 * drop surface, the shader zip export, and the zip import.
 *
 * A dropped/imported model file is ADVERSARIAL input (like every other import:
 * `.fastshader` files are shared between users). The bytes are never parsed on
 * the trusted side — they only ever cross into the sandboxed preview iframe
 * via postMessage, where a blob URL is minted for THREE's loaders (same
 * security model as podest.html). These helpers just bound and classify the
 * file so a hostile drop can't balloon memory or smuggle a weird name into
 * the zip export / UI labels.
 */

export type PreviewMeshKind = 'obj' | 'glb' | 'gltf';

export interface PreviewMesh {
  /** Sanitized file name — safe as a zip entry name and a UI label. */
  name: string;
  kind: PreviewMeshKind;
  bytes: Uint8Array<ArrayBuffer>;
  /**
   * Decoded text for the text formats (obj/gltf), decoded ONCE at load time —
   * the model feed re-posts on every iframe rebuild, and re-decoding megabytes
   * per rebuild would be pure waste. Absent for glb (binary).
   */
  text?: string;
  /**
   * Monotonic identity for this loaded mesh. Baked into the preview rebuild
   * key and the model-feed handshake so re-dropping a file (same name, new
   * bytes) still forces a fresh iframe, and a slow feed for a previous mesh
   * can never apply to a newer document.
   */
  id: number;
}

/** Extensions accepted by every custom-mesh surface (drop, picker, zip import). */
export const MESH_EXTENSIONS: readonly PreviewMeshKind[] = ['obj', 'glb', 'gltf'];

/** Hard cap on a model file — matches podest's zip inflate budget. */
export const MESH_MAX_BYTES = 64 * 1024 * 1024;

/** Classify a file name by extension; null when it isn't a model file. */
export function detectMeshKind(name: string): PreviewMeshKind | null {
  const m = /\.([^./\\]+)$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  return (MESH_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as PreviewMeshKind)
    : null;
}

/**
 * Bound + sanity-check model bytes before they enter the store. Returns an
 * error message (for the drop surface to show) or null when acceptable.
 * Deliberately shallow — real parsing happens inside the sandboxed iframe,
 * where a malformed file surfaces as the loader's error overlay.
 */
export function validateMeshBytes(kind: PreviewMeshKind, bytes: Uint8Array): string | null {
  if (bytes.length === 0) return 'The model file is empty.';
  if (bytes.length > MESH_MAX_BYTES) {
    return `Model too large (${(bytes.length / 1024 / 1024).toFixed(1)} MB — max ${MESH_MAX_BYTES / 1024 / 1024} MB).`;
  }
  if (kind === 'glb') {
    // GLB container magic: ASCII "glTF" as the first uint32.
    if (bytes.length < 12 ||
        bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) {
      return 'Not a valid .glb file (missing glTF header).';
    }
  }
  return null;
}

/**
 * Classify + bound + assemble a PreviewMesh from a raw file name and bytes —
 * the single constructor used by the preview drop surface AND the zip import,
 * so sanitization always happens at the store boundary. Returns an error
 * string for the caller's notice surface instead of throwing.
 */
let nextPreviewMeshId = 1;
export function createPreviewMesh(
  rawName: string,
  bytes: Uint8Array<ArrayBufferLike>,
): { mesh: PreviewMesh } | { error: string } {
  const kind = detectMeshKind(rawName);
  if (!kind) return { error: 'Not a supported model file (.obj / .glb / .gltf).' };
  const error = validateMeshBytes(kind, bytes);
  if (error) return { error };
  // Normalize to a plain-ArrayBuffer view — Blob construction and postMessage
  // need it, and zip-reader output is only typed over ArrayBufferLike.
  const owned = (bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice()) as Uint8Array<ArrayBuffer>;
  return {
    mesh: {
      name: sanitizeMeshFileName(rawName, kind),
      kind,
      bytes: owned,
      text: kind === 'glb' ? undefined : new TextDecoder().decode(owned),
      id: nextPreviewMeshId++,
    },
  };
}

/**
 * Sanitize a dropped file's name into something safe as a zip entry and UI
 * label: strip any directory part, allow only word chars/dot/dash, cap the
 * length, and guarantee the kind's extension survives.
 */
export function sanitizeMeshFileName(rawName: string, kind: PreviewMeshKind): string {
  const base = rawName.split(/[/\\]/).pop() ?? '';
  let stem = base
    .replace(/\.[^./\\]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  // Windows-reserved device names (CON, NUL, COM1, …) break extraction of the
  // exported zip on Windows — prefix rather than reject.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return `${stem || 'model'}.${kind}`;
}
