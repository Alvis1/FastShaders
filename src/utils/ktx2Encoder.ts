/**
 * The KTX2 ENCODER SEAM (Phase 8, Part A): what an encoder is, the one place
 * one is registered, what it is asked for per texture slot, and the checked
 * call every export path goes through.
 *
 * NO ENCODER SHIPS YET (owner decision): the registry is null in every build
 * until a WASM worker (ktx2-encoder) or a native Tauri command is approved and
 * registers itself, so anything gated on `hasKtx2Encoder()` stays invisible.
 * Tests register a stub that returns fixture bytes.
 *
 * Settings are fixed rather than offered (owner decision): UASTC with zstd
 * level 18 for every slot. Never ETC1S — ETC1S can never transcode to ASTC 4x4,
 * which is the Quest's format, while UASTC reaches ASTC, BC7 and ETC2.
 *
 * The input is always RAW RGBA8, never an encoded image: an encoder that
 * re-decoded a PNG would apply its own colour handling to normal and data maps.
 *
 * `encodeKtx2Checked` NEVER rejects. It refuses what glTF's basisu extension
 * forbids before encoding (sides must be multiples of 4), and afterwards reads
 * the encoder's output with the trusted-side header reader: an encoder is code
 * we did not write, and a wrong-mode, wrong-size, Y-flipped or wrong-colour-
 * space file would be written into an export and look fine until another
 * viewer loaded it. Imports ktx2Header only — no DOM, no store.
 */
import { readKtx2Header } from './ktx2Header';

export type Ktx2Mode = 'uastc' | 'etc1s';

export interface Ktx2EncodeRequest {
  /** width × height × 4 bytes, rows top to bottom. */
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipmaps: boolean;
  readonly normalMap: boolean;
  readonly mode: Ktx2Mode;
  readonly zstdLevel: number;
}

export interface Ktx2Encoder {
  readonly id: string;
  readonly version: string;
  readonly where: 'worker' | 'native' | 'test';
  encode(req: Ktx2EncodeRequest, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Which material slot a texture feeds; it decides colour space and normal-map handling. */
export type Ktx2Slot = 'baseColor' | 'emissive' | 'normal' | 'data';

export type Ktx2InvalidReason =
  | 'not-ktx2'
  | 'not-basis'
  | 'mode'
  | 'size'
  | 'levels'
  | 'color-space'
  | 'orientation'
  | 'too-large';

export type Ktx2EligibleRefusal = 'not-multiple-of-4' | 'too-large' | 'too-small';

export type Ktx2Refusal = Ktx2EligibleRefusal | 'encode-failed' | 'aborted' | `invalid:${Ktx2InvalidReason}`;

export type Ktx2CheckedResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: Ktx2Refusal };

export const KTX2_MAX_DIM = 4096;
export const KTX2_MIN_DIM = 4;
export const KTX2_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** UASTC + zstd 18: the recorded encode setting. */
export const KTX2_DEFAULT_ZSTD = 18;
export const KTX2_MIME = 'image/ktx2';

// Basis Universal container facts: vkFormat 0 (VK_FORMAT_UNDEFINED), the
// KHR_DF colour models, the KTX supercompression schemes and the DFD transfer
// functions (1 linear, 2 sRGB).
const VK_FORMAT_BASIS = 0;
const COLOR_MODEL_UASTC = 166;
const COLOR_MODEL_ETC1S = 163;
const SC_NONE = 0;
const SC_BASISLZ = 1;
const SC_ZSTD = 2;
const TRANSFER_LINEAR = 1;
const TRANSFER_SRGB = 2;

/* ── the registry ───────────────────────────────────────────────────────── */

let current: Ktx2Encoder | null = null;

/** Register (or with null, remove) THE encoder. Nothing registers one in a shipped build yet. */
export function setKtx2Encoder(encoder: Ktx2Encoder | null): void {
  current = encoder;
}

export function getKtx2Encoder(): Ktx2Encoder | null {
  return current;
}

export function hasKtx2Encoder(): boolean {
  return current !== null;
}

/* ── planning ───────────────────────────────────────────────────────────── */

/**
 * Whether a texture of this size may carry a KTX2 copy: integer sides, both
 * multiples of 4 (a KHR_texture_basisu MUST), each within [4, 4096].
 */
export function ktx2Eligible(
  width: number,
  height: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: Ktx2EligibleRefusal } {
  for (const side of [width, height]) {
    if (!Number.isInteger(side)) return { ok: false, reason: 'not-multiple-of-4' };
    if (side < KTX2_MIN_DIM) return { ok: false, reason: 'too-small' };
    if (side > KTX2_MAX_DIM) return { ok: false, reason: 'too-large' };
  }
  if (width % 4 !== 0 || height % 4 !== 0) return { ok: false, reason: 'not-multiple-of-4' };
  return { ok: true };
}

/** floor(log2(max side)) + 1 with mipmaps, else 1. The 40 × 40 fixture has 6. */
export function expectedKtx2Levels(width: number, height: number, mipmaps: boolean): number {
  if (!mipmaps) return 1;
  const side = Math.max(width, height);
  if (!Number.isInteger(side) || side < 1) return 1;
  return 32 - Math.clz32(side);
}

/**
 * The request for one texture. baseColor and emissive are sRGB colour; a
 * normal map is linear with normal-map handling; every other slot (roughness,
 * metalness, opacity) is linear data. Always UASTC + zstd 18; mips follow the
 * texture's own sampler (a data map sampled without mipmaps gets one level).
 */
export function ktx2RequestFor(
  slot: Ktx2Slot,
  px: { readonly rgba: Uint8Array; readonly width: number; readonly height: number },
  sampler: { readonly mipmapped: boolean },
): Ktx2EncodeRequest {
  const linear = slot === 'normal' || slot === 'data';
  return {
    rgba: px.rgba,
    width: px.width,
    height: px.height,
    colorSpace: linear ? 'linear' : 'srgb',
    mipmaps: sampler.mipmapped === true,
    normalMap: slot === 'normal',
    mode: 'uastc',
    zstdLevel: KTX2_DEFAULT_ZSTD,
  };
}

/* ── checking ───────────────────────────────────────────────────────────── */

/**
 * Whether `bytes` is exactly the KTX2 file `req` asked for: Basis (vkFormat 0),
 * the requested mode (UASTC colour model 166 with no or zstd supercompression;
 * ETC1S 163 with BasisLZ), the exact size as one 2D image (pixelDepth 0,
 * layerCount 0, faceCount 1 — what KHR_texture_basisu requires), the expected level
 * count, the transfer function matching the colour space, never Y-flipped
 * (`KTXorientation` absent or starting `rd`), and at most 32 MiB.
 */
export function validateKtx2Output(
  bytes: Uint8Array,
  req: Pick<Ktx2EncodeRequest, 'width' | 'height' | 'colorSpace' | 'mipmaps' | 'mode'>,
): { readonly ok: true } | { readonly ok: false; readonly reason: Ktx2InvalidReason } {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'not-ktx2' };
  if (bytes.byteLength > KTX2_MAX_OUTPUT_BYTES) return { ok: false, reason: 'too-large' };
  const h = readKtx2Header(bytes);
  if (!h) return { ok: false, reason: 'not-ktx2' };
  if (h.vkFormat !== VK_FORMAT_BASIS || (h.colorModel !== COLOR_MODEL_UASTC && h.colorModel !== COLOR_MODEL_ETC1S)) {
    return { ok: false, reason: 'not-basis' };
  }
  const sc = h.supercompressionScheme;
  const modeOk =
    req.mode === 'uastc'
      ? h.colorModel === COLOR_MODEL_UASTC && (sc === SC_NONE || sc === SC_ZSTD)
      : h.colorModel === COLOR_MODEL_ETC1S && sc === SC_BASISLZ;
  if (!modeOk) return { ok: false, reason: 'mode' };
  if (
    h.pixelWidth !== req.width ||
    h.pixelHeight !== req.height ||
    // KHR_texture_basisu allows only a plain 2D image: pixelDepth 1 is a 3D
    // texture and layerCount 1 an array one. The loader's `> 1` caps are
    // looser on purpose — they gate DISPLAY; this gates what an export writes.
    h.pixelDepth !== 0 ||
    h.layerCount !== 0 ||
    h.faceCount !== 1
  ) {
    return { ok: false, reason: 'size' };
  }
  if (Math.max(1, h.levelCount) !== expectedKtx2Levels(req.width, req.height, req.mipmaps)) {
    return { ok: false, reason: 'levels' };
  }
  if (h.transferFunction !== (req.colorSpace === 'srgb' ? TRANSFER_SRGB : TRANSFER_LINEAR)) {
    return { ok: false, reason: 'color-space' };
  }
  if (h.orientation !== null && !h.orientation.startsWith('rd')) return { ok: false, reason: 'orientation' };
  return { ok: true };
}

/**
 * Encode one texture through `encoder`, then check the result. NEVER rejects:
 * an ineligible size, an abort (before or after the encode), an encoder that
 * throws or rejects, and an output that fails `validateKtx2Output` all resolve
 * as `{ ok: false, reason }`, so one bad texture can never fail an export.
 */
export async function encodeKtx2Checked(
  encoder: Ktx2Encoder,
  req: Ktx2EncodeRequest,
  signal?: AbortSignal,
): Promise<Ktx2CheckedResult> {
  try {
    const eligible = ktx2Eligible(req.width, req.height);
    if (!eligible.ok) return { ok: false, reason: eligible.reason };
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    let bytes: unknown;
    try {
      bytes = await encoder.encode(req, signal);
    } catch {
      return { ok: false, reason: signal?.aborted ? 'aborted' : 'encode-failed' };
    }
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'invalid:not-ktx2' };
    const valid = validateKtx2Output(bytes, req);
    return valid.ok ? { ok: true, bytes } : { ok: false, reason: `invalid:${valid.reason}` };
  } catch {
    return { ok: false, reason: 'encode-failed' };
  }
}
