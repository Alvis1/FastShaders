/**
 * Binary ↔ base64 helpers for embedding numeric arrays into generated shader
 * modules. The Data/Stripes nodes bake their dataset into a `THREE.DataTexture`
 * whose contents are carried as a base64 string inside the emitted module — so
 * the shader is fully self-contained (preview blob, standalone `.html`, and
 * exported `.js` all reconstruct the texture from the same string).
 *
 * Everything here is pure and dependency-free so it runs identically on the
 * host (encode, at code-gen) and in the sandboxed preview iframe (decode).
 */

/** Base64-encode raw bytes. Chunked so a large buffer doesn't blow the
 *  `String.fromCharCode(...spread)` argument limit / call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000; // 32 KiB per fromCharCode call
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

/** Decode a base64 string back to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Base64-encode a Float32Array (little-endian, native layout). */
export function float32ToBase64(arr: Float32Array): string {
  return bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

/** Decode base64 → Float32Array. Copies into an aligned buffer so the result is
 *  safe regardless of the source byte offset. */
export function base64ToFloat32(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(buf);
}

// --- Half-float (float16) ---------------------------------------------------
//
// WebGPU does not filter 32-bit float textures unless the `float32-filterable`
// device feature is enabled (the A-Frame bundle does not request it). 16-bit
// half-float textures ARE filterable everywhere, so the linearly-sampled
// phase/value lookups are stored as float16. The phase ramp is normalized to
// [0, 1] before encoding so float16's ~11-bit mantissa keeps it smooth.

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

/**
 * Convert a JS number to its IEEE-754 half-float (float16) bit pattern (a
 * uint16). Branch-light variant (Fabian Giesen / three.js DataUtils style),
 * correct across the full range including denormals, overflow→Inf, and NaN.
 */
export function toHalfFloat(value: number): number {
  _f32[0] = value;
  const x = _i32[0];

  let bits = (x >> 16) & 0x8000;          // sign bit
  let mantissa = (x >> 12) & 0x07ff;      // mantissa + rounding bit
  const exp = (x >> 23) & 0xff;           // biased exponent

  if (exp < 103) return bits;             // magnitude too small → ±0
  if (exp > 142) {                        // overflow → Inf (or NaN if input NaN)
    bits |= 0x7c00;
    // Preserve NaN-ness: input exp==255 with a non-zero mantissa stays NaN.
    bits |= exp === 255 && (x & 0x007fffff) !== 0 ? 0x0200 : 0;
    return bits;
  }
  if (exp < 113) {                        // subnormal half
    mantissa |= 0x0800;
    bits |= (mantissa >> (114 - exp)) + ((mantissa >> (113 - exp)) & 1);
    return bits;
  }
  bits |= ((exp - 112) << 10) | (mantissa >> 1);
  bits += mantissa & 1;                   // round to nearest, ties up
  return bits;
}

/** Convert a half-float (uint16) bit pattern back to a JS number. */
export function fromHalfFloat(half: number): number {
  const sign = (half & 0x8000) >> 15;
  const exp = (half & 0x7c00) >> 10;
  const frac = half & 0x03ff;
  let value: number;
  if (exp === 0) {
    value = (frac / 1024) * Math.pow(2, -14);
  } else if (exp === 0x1f) {
    value = frac ? NaN : Infinity;
  } else {
    value = (1 + frac / 1024) * Math.pow(2, exp - 15);
  }
  return sign ? -value : value;
}

/** Encode an array of numbers as float16 and base64 the resulting uint16 bytes. */
export function float16ToBase64(values: ArrayLike<number>): string {
  const u16 = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) u16[i] = toHalfFloat(values[i]);
  return bytesToBase64(new Uint8Array(u16.buffer));
}
