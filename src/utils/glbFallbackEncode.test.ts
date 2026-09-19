/**
 * The PNG/JPEG fallback encoder (utils/glbFallbackEncode.ts) under node,
 * against a fake canvas — the imageImportEncode.test.ts harness in miniature.
 * It supplies the three DOM pieces the encoder touches (`createImageBitmap`,
 * `document.createElement('canvas')`, and a canvas whose `toBlob` answers with
 * bytes of a chosen length), so its decisions run exactly as written.
 *
 * The rule worth a test is the SIZE bound: an oversized copy is a `null` like
 * every other failure, so the texture ships WebP-only. Handing it back instead
 * refuses the whole export — the repacker's `validate` rejects a fallback over
 * `GLTF_IMAGE_MAX_BYTES` with `bad-input` BEFORE the webpMode branch, so both
 * measure passes fail, `prepareSingleGlb` answers `bad-input` and the dialog
 * shows "The model could not be read." with no WebP-only escape.
 *
 * Every global is stubbed in beforeEach and undone in afterEach
 * (`isolate: false`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGlbFallback } from './glbFallbackEncode';
import { GLTF_IMAGE_MAX_BYTES } from './gltfReader';
import type { RepackPayload } from './glbRepack';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What the next `toBlob` answers: a buffer of this many bytes, PNG-headed. */
const state = { size: 64, type: 'image/png' };

function pngBuffer(size: number): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).set(PNG_MAGIC.slice(0, Math.min(size, PNG_MAGIC.length)));
  return buf;
}

class FakeCanvas {
  width = 0;
  height = 0;
  getContext(): unknown {
    return { drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.of(0, 0, 0, 255) }) };
  }
  toBlob(cb: (b: unknown) => void, mime: string): void {
    const type = state.type || mime;
    const size = state.size;
    queueMicrotask(() => cb({ type, arrayBuffer: async () => pngBuffer(size) }));
  }
}

/** The payload is only ever decoded, so its bytes need not be a real WebP. */
const payload: RepackPayload = { mime: 'image/webp', bytes: new Uint8Array(16), lossless: true };

beforeEach(() => {
  state.size = 64;
  state.type = 'image/png';
  vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
  vi.stubGlobal('createImageBitmap', async (_src: unknown) => ({ width: 8, height: 8, close() {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('encodeGlbFallback', () => {
  it('returns the copy at an ordinary size', async () => {
    const fb = await encodeGlbFallback(payload, 8, 8);
    expect(fb?.mime).toBe('image/png');
    expect(fb?.bytes.length).toBe(64);
  });

  it("accepts a copy of exactly GLTF_IMAGE_MAX_BYTES (the repacker's own bound)", async () => {
    state.size = GLTF_IMAGE_MAX_BYTES;
    const fb = await encodeGlbFallback(payload, 8, 8);
    expect(fb?.bytes.length).toBe(GLTF_IMAGE_MAX_BYTES);
  });

  it('refuses one byte more, so the texture ships WebP-only instead of failing the export', async () => {
    state.size = GLTF_IMAGE_MAX_BYTES + 1;
    const fb = await encodeGlbFallback(payload, 8, 8);
    // Assert on the LENGTH: a 64 MiB array in a failure diff exhausts the heap.
    expect(fb === null ? null : fb.bytes.length).toBeNull();
  });

  it('still refuses a mislabelled encode and a resized bitmap', async () => {
    state.type = 'image/jpeg';
    expect(await encodeGlbFallback(payload, 8, 8)).toBeNull();
    state.type = 'image/png';
    expect(await encodeGlbFallback(payload, 16, 16)).toBeNull();
  });
});
