/**
 * The painted sky "Do it for me" brings to a picture step (tutorialPicture.ts):
 * a real PNG — every chunk's CRC right, its pixels exactly the painted ones
 * once inflated and unfiltered here with node's own zlib — that the app's
 * image gate accepts as a payload, within the per-image cap, the same bytes on
 * every run.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { crc32 } from '@/utils/zipWriter';
import { base64ToBytes } from '@/utils/binaryCodec';
import { decodeImageNode, validImageDataUrl, MAX_IMAGE_ENCODED_CHARS } from '@/utils/imageNode';
import { TUTORIAL_PICTURE, encodeRgbPng, paintSkyPanorama, primeTutorialPicture, tutorialPicture } from './tutorialPicture';

const { width: W, height: H } = TUTORIAL_PICTURE;

/** Every chunk of a PNG: type, data, and whether its CRC is right. */
function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Array<{ type: string; data: Uint8Array; crcOk: boolean }> = [];
  for (let at = 8; at < png.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    out.push({ type, data, crcOk: view.getUint32(at + 8 + len) === crc32(png.subarray(at + 4, at + 8 + len)) });
    at += 12 + len;
  }
  return out;
}

/** The inverse of a PNG's per-row filters, for 8-bit RGB. */
function unfilter(raw: Uint8Array, w: number, h: number): Uint8Array {
  const stride = w * 3;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const a = i >= 3 ? px[y * stride + i - 3] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 3 ? px[(y - 1) * stride + i - 3] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + i] = (v + pred) & 255;
    }
  }
  return px;
}

describe('the painted sky', () => {
  it('is a real PNG of exactly the painted pixels', async () => {
    const pixels = paintSkyPanorama(W, H);
    const png = await encodeRgbPng(W, H, pixels);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const list = chunks(png);
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(list.every((c) => c.crcOk)).toBe(true);
    const ihdr = new DataView(list[0].data.buffer, list[0].data.byteOffset, 13);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), list[0].data[8], list[0].data[9]]).toEqual([W, H, 8, 2]);
    const decoded = unfilter(new Uint8Array(inflateSync(list[1].data)), W, H);
    expect(Buffer.from(decoded).equals(Buffer.from(pixels))).toBe(true);
  });

  it('is a sky over a checkered floor: blue overhead, both checks underfoot', () => {
    const px = paintSkyPanorama(W, H);
    const at = (x: number, y: number) => [...px.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    const [r, , b] = at(W / 2, 0);
    expect(b).toBeGreaterThan(r + 60);
    // Straight down the floor shows its checks: both a light and a dark one along the bottom row.
    const lum = Array.from({ length: W }, (_, x) => at(x, H - 1).reduce((s, v) => s + v, 0) / 3);
    expect(Math.max(...lum)).toBeGreaterThan(200);
    expect(Math.min(...lum)).toBeLessThan(80);
  });

  it('is a payload the image gate accepts, within the per-image cap, the same on every call', async () => {
    const pic = await primeTutorialPicture();
    expect(pic).not.toBeNull();
    expect(tutorialPicture()).toBe(pic);
    expect(await primeTutorialPicture()).toBe(pic);
    expect(pic).toMatchObject({ width: W, height: H, fileName: 'sky.png' });
    expect(validImageDataUrl(pic!.dataUrl)).toBe(pic!.dataUrl);
    const decoded = decodeImageNode({ imageB64: pic!.dataUrl, width: W, height: H });
    expect(decoded).toMatchObject({ mime: 'png', width: W, height: H });
    expect(pic!.dataUrl.length).toBeLessThan(Math.min(MAX_IMAGE_ENCODED_CHARS, 80_000));
    const again = await encodeRgbPng(W, H, paintSkyPanorama(W, H));
    expect(Buffer.from(base64ToBytes(pic!.dataUrl.split(',')[1])).equals(Buffer.from(again))).toBe(true);
  });
});
