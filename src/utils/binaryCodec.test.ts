import { describe, it, expect } from 'vitest';
import {
  bytesToBase64,
  base64ToBytes,
  float32ToBase64,
  base64ToFloat32,
  toHalfFloat,
  fromHalfFloat,
  float16ToBase64,
} from './binaryCodec';

describe('binaryCodec: bytes ↔ base64', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('handles a large buffer without overflowing fromCharCode', () => {
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const round = base64ToBytes(bytesToBase64(big));
    expect(round.length).toBe(big.length);
    expect(round[0]).toBe(0);
    expect(round[199_999]).toBe(199_999 & 0xff);
  });
});

describe('binaryCodec: Float32 ↔ base64', () => {
  it('round-trips a Float32Array exactly', () => {
    const arr = new Float32Array([0, 1e-6, 0.0042, -3.5, 1234.5]);
    const round = base64ToFloat32(float32ToBase64(arr));
    expect(Array.from(round)).toEqual(Array.from(arr));
  });

  it('preserves length for 8001 samples (F1.csv size)', () => {
    const arr = new Float32Array(8001);
    for (let i = 0; i < arr.length; i++) arr[i] = Math.sin(i * 0.01);
    const round = base64ToFloat32(float32ToBase64(arr));
    expect(round.length).toBe(8001);
    expect(round[4000]).toBeCloseTo(arr[4000], 6);
  });
});

describe('binaryCodec: half-float', () => {
  it('round-trips [0,1] values within float16 precision', () => {
    for (const v of [0, 0.25, 0.5, 0.5005, 0.999, 1]) {
      expect(fromHalfFloat(toHalfFloat(v))).toBeCloseTo(v, 2);
    }
  });

  it('encodes exact powers/halves losslessly', () => {
    for (const v of [0, 0.5, 1, 2, -1, 0.25]) {
      expect(fromHalfFloat(toHalfFloat(v))).toBe(v);
    }
  });

  it('round-trips NaN and ±Infinity', () => {
    expect(Number.isNaN(fromHalfFloat(toHalfFloat(NaN)))).toBe(true);
    expect(fromHalfFloat(toHalfFloat(Infinity))).toBe(Infinity);
    expect(fromHalfFloat(toHalfFloat(-Infinity))).toBe(-Infinity);
  });

  it('saturates large finite values to ±Infinity (not NaN)', () => {
    expect(fromHalfFloat(toHalfFloat(70000))).toBe(Infinity);
    expect(fromHalfFloat(toHalfFloat(1e30))).toBe(Infinity);
    expect(fromHalfFloat(toHalfFloat(-70000))).toBe(-Infinity);
    // The raw bit patterns are exactly the Inf encodings, never NaN.
    expect(toHalfFloat(70000)).toBe(0x7c00);
    expect(toHalfFloat(-70000)).toBe(0xfc00);
  });

  it('float16ToBase64 produces 2 bytes/sample and decodes back', () => {
    const values = [0, 0.5, 1];
    const b64 = float16ToBase64(values);
    const bytes = base64ToBytes(b64);
    expect(bytes.length).toBe(6); // 3 × uint16
    const u16 = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(fromHalfFloat(u16[1])).toBe(0.5);
  });
});
