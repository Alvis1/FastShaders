/**
 * "Load this model in the 3D preview" — from the node canvas to the preview.
 *
 * A `.obj`/`.glb`/`.gltf` dropped on the NODE CANVAS is not placed there; it is
 * handed to the preview's own model path (ShaderPreview's `loadMeshFile`), so
 * there is ONE validation, ONE notice and ONE geometry switch whichever surface
 * the file landed on. The geometry choice is ShaderPreview-local persisted
 * state, so the canvas could not switch it itself anyway.
 *
 * A window CustomEvent rather than a store field or a prop chain, for the
 * reason `meshHighlight` and `fs-tile-drop` are one: sender and receiver are far
 * apart in the tree and the payload is transient — a File that must never be
 * persisted, undone or exported. Deliberately a different name from the
 * iframe's postMessage `fs:preview-drop`: this one only ever comes from a real
 * DOM drop in the parent document, so the preview needs no confirm for it.
 *
 * If the preview is not mounted, nothing listens and the drop does nothing —
 * the preview pane is always mounted in the editor layout.
 *
 * A model dropped WITH a shader (the canvas's project branch) pairs with the
 * shader just imported and is NEVER offered to the GLB import dialog:
 * `pairedWithShader` rides the event, and only a literal `true` counts.
 */

export const PREVIEW_MODEL_FILE_EVENT = 'fs:preview-model-file';

export interface PreviewModelFileDetail {
  file: File;
  /** The model arrived beside a shader that was just imported. */
  pairedWithShader: boolean;
}

/** Ask the 3D preview to load `file` as its custom model. */
export function requestPreviewModelLoad(file: File, opts?: { pairedWithShader?: boolean }): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<PreviewModelFileDetail>(PREVIEW_MODEL_FILE_EVENT, {
      detail: { file, pairedWithShader: opts?.pairedWithShader === true },
    }),
  );
}

/** The File an `fs:preview-model-file` event carries, or null for anything else. */
export function previewModelFileOf(ev: Event): File | null {
  if (!(ev instanceof CustomEvent) || ev.type !== PREVIEW_MODEL_FILE_EVENT) return null;
  const detail: unknown = ev.detail;
  if (!detail || typeof detail !== 'object') return null;
  const file = (detail as { file?: unknown }).file;
  return file instanceof File ? file : null;
}

/** The File AND the pairing flag an `fs:preview-model-file` event carries, or
 *  null for anything else. The flag is true only for a literal `true`. */
export function previewModelDropOf(ev: Event): { file: File; pairedWithShader: boolean } | null {
  const file = previewModelFileOf(ev);
  if (!file) return null;
  const detail = (ev as CustomEvent).detail as { pairedWithShader?: unknown };
  return { file, pairedWithShader: detail.pairedWithShader === true };
}
