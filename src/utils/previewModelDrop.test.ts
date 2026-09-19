/**
 * The canvas → preview model hand-off (`fs:preview-model-file`). Pure event
 * plumbing; no global is stubbed (isolate:false rule), so the dispatch half is
 * only checked to be a harmless no-op without a window.
 */
import { describe, it, expect } from 'vitest';
import { PREVIEW_MODEL_FILE_EVENT, previewModelDropOf, previewModelFileOf, requestPreviewModelLoad } from './previewModelDrop';

describe('previewModelDrop', () => {
  it('has its own event name, distinct from the iframe postMessage type', () => {
    expect(PREVIEW_MODEL_FILE_EVENT).toBe('fs:preview-model-file');
    expect(PREVIEW_MODEL_FILE_EVENT).not.toBe('fs:preview-drop');
  });

  it('reads the File off a well-formed event', () => {
    const file = new File(['x'], 'a.glb');
    expect(previewModelFileOf(new CustomEvent(PREVIEW_MODEL_FILE_EVENT, { detail: { file } }))).toBe(file);
  });

  it('refuses anything that is not a File on the right event', () => {
    expect(previewModelFileOf(new CustomEvent(PREVIEW_MODEL_FILE_EVENT, { detail: { file: 'a.glb' } }))).toBeNull();
    expect(previewModelFileOf(new CustomEvent(PREVIEW_MODEL_FILE_EVENT, { detail: null }))).toBeNull();
    expect(previewModelFileOf(new CustomEvent(PREVIEW_MODEL_FILE_EVENT))).toBeNull();
    expect(previewModelFileOf(new Event(PREVIEW_MODEL_FILE_EVENT))).toBeNull();
    const file = new File(['x'], 'a.glb');
    expect(previewModelFileOf(new CustomEvent('fs:mesh-highlight', { detail: { file } }))).toBeNull();
  });

  it('requestPreviewModelLoad is a no-op without a window (node env)', () => {
    expect(() => requestPreviewModelLoad(new File([], 'a.glb'))).not.toThrow();
  });
});

describe('previewModelDropOf — the pairing flag (GLB Phase 5)', () => {
  const file = new File(['x'], 'a.glb');
  const ev = (detail: unknown) => new CustomEvent(PREVIEW_MODEL_FILE_EVENT, { detail });

  it('is true only for a literal true', () => {
    expect(previewModelDropOf(ev({ file, pairedWithShader: true }))).toEqual({ file, pairedWithShader: true });
    for (const junk of [false, 1, 'true', undefined, null, {}]) {
      expect(previewModelDropOf(ev({ file, pairedWithShader: junk }))).toEqual({ file, pairedWithShader: false });
    }
    expect(previewModelDropOf(ev({ file }))).toEqual({ file, pairedWithShader: false });
  });

  it('returns null for what previewModelFileOf refuses', () => {
    expect(previewModelDropOf(ev({ file: 'a.glb', pairedWithShader: true }))).toBeNull();
    expect(previewModelDropOf(ev(null))).toBeNull();
    expect(previewModelDropOf(new Event(PREVIEW_MODEL_FILE_EVENT))).toBeNull();
    expect(previewModelDropOf(new CustomEvent('fs:mesh-highlight', { detail: { file } }))).toBeNull();
  });

  it('previewModelFileOf is unchanged by the flag', () => {
    expect(previewModelFileOf(ev({ file, pairedWithShader: true }))).toBe(file);
  });

  it('requestPreviewModelLoad accepts the option and stays a no-op without a window', () => {
    expect(() => requestPreviewModelLoad(new File([], 'a.glb'), { pairedWithShader: true })).not.toThrow();
  });
});
