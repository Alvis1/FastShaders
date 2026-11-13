/**
 * The picture "Do it for me" brings to a lesson step that asks for one — Shiny
 * or Dull's "drag a picture onto the canvas", whose next step wires it into
 * Environment. The lesson data is a leaf and carries no bytes, and the app
 * serves no photo (public/images holds icons and logos), so the picture is
 * PAINTED here: an equirectangular sky over a checkered floor, the test scene a
 * chrome ball is classically shown against — the horizon, the sun and the
 * checks all read at a glance in a reflection, at Roughness 0.1 too.
 *
 * Pure pixels, encoded as a PNG through `CompressionStream('deflate')` (the
 * zlib stream a PNG's IDAT is), so the SAME bytes come out in every browser and
 * under vitest — a canvas `toDataURL` differs per engine and does not exist in
 * node. 1024 × 512 (power of two on both axes, the drop's hygiene), about 40 KB
 * of base64. Encoded once per session AHEAD of the step (`primeTutorialPicture`,
 * from the lesson panel), so the auto path stays synchronous: it runs inside
 * `evalAutomated`, which tags only the writes made during its call.
 */

import { bytesToBase64 } from '@/utils/binaryCodec';
import { crc32 } from '@/utils/zipWriter';

export const TUTORIAL_PICTURE = { width: 1024, height: 512, fileName: 'sky.png' } as const;

export interface TutorialPicture {
  dataUrl: string;
  width: number;
  height: number;
  fileName: string;
}

type Rgb = readonly [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const ZENITH = hex('#2f6fb8');
const SKY_HORIZON = hex('#dcebf5');
const HAZE = hex('#c9c2b4');
const TILE_LIGHT = hex('#efe9dc');
const TILE_DARK = hex('#3c3a37');
const SUN = hex('#fffaeb');
/** The sun's direction: 52° round from the picture's centre, 36° up. */
const SUN_LON = 0.9;
const SUN_LAT = 0.62;
/** Checks per unit at a camera height of 1: two across the floor under the camera. */
const CHECKS = 2;
/** Samples per axis on the floor, where the checks' edges would otherwise stair-step. */
const SS = 3;

/** The unit direction an equirectangular pixel looks along (y up). */
function direction(lon: number, lat: number): [number, number, number] {
  const c = Math.cos(lat);
  return [c * Math.sin(lon), Math.sin(lat), -c * Math.cos(lon)];
}

/**
 * The panorama's pixels, RGB, top row first (the zenith), deterministic. The
 * sky is a gradient by height with a sun disc and its glow; below the horizon
 * a floor of checks one unit under the camera, fading into haze with distance
 * so the checks never alias into a moiré at the horizon.
 */
export function paintSkyPanorama(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const sun = direction(SUN_LON, SUN_LAT);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const lat = (0.5 - (y + 0.5) / height) * Math.PI;
      let col: Rgb;
      if (lat >= 0) {
        col = mix(SKY_HORIZON, ZENITH, Math.pow(lat / (Math.PI / 2), 0.6));
        const d = direction(lon, lat);
        const ang = Math.acos(Math.min(1, d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]));
        const disc = ang < 0.045 ? 1 : ang < 0.06 ? (0.06 - ang) / 0.015 : 0;
        col = mix(col, SUN, Math.min(1, disc + Math.exp((-ang * ang) / 0.02) * 0.35));
      } else {
        let r = 0, g = 0, b = 0, dist = 0;
        for (let j = 0; j < SS; j++) {
          for (let i = 0; i < SS; i++) {
            const lo = ((x + (i + 0.5) / SS) / width - 0.5) * 2 * Math.PI;
            const la = Math.min(-1e-4, (0.5 - (y + (j + 0.5) / SS) / height) * Math.PI);
            const d = direction(lo, la);
            const s = 1 / -d[1];
            const tile = (Math.floor(d[0] * s * CHECKS) + Math.floor(d[2] * s * CHECKS)) & 1 ? TILE_LIGHT : TILE_DARK;
            r += tile[0]; g += tile[1]; b += tile[2]; dist += s;
          }
        }
        const n = SS * SS;
        const fog = 1 - Math.exp(-Math.max(0, dist / n - 1) / 9);
        col = mix([r / n, g / n, b / n], HAZE, fog);
      }
      const o = (y * width + x) * 3;
      rgb[o] = Math.round(col[0]);
      rgb[o + 1] = Math.round(col[1]);
      rgb[o + 2] = Math.round(col[2]);
    }
  }
  return rgb;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Each row behind the filter that leaves it smallest (libpng's minimum-sum rule). */
function filterRows(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const out = new Uint8Array((stride + 1) * height);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const cur = rgb[y * stride + i];
        const a = i >= 3 ? rgb[y * stride + i - 3] : 0;
        const b = y > 0 ? rgb[(y - 1) * stride + i] : 0;
        const c = y > 0 && i >= 3 ? rgb[(y - 1) * stride + i - 3] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur - pred) & 255;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    for (let i = 0; i < stride; i++) {
      const cur = rgb[y * stride + i];
      const a = i >= 3 ? rgb[y * stride + i - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 3 ? rgb[(y - 1) * stride + i - 3] : 0;
      const pred = best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? (a + b) >> 1 : paeth(a, b, c);
      row[i] = (cur - pred) & 255;
    }
    out[y * (stride + 1)] = best;
    out.set(row, y * (stride + 1) + 1);
  }
  return out;
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An 8-bit RGB PNG of `rgb` (top row first). */
export async function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', await zlibDeflate(filterRows(width, height, rgb))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

let ready: TutorialPicture | null = null;
let pending: Promise<TutorialPicture | null> | null = null;

/**
 * Paint and encode the picture once per session. Never rejects: a browser
 * without CompressionStream answers null and "Do it for me" stays off on that
 * one step (the reader can still drop a picture of their own); a later call
 * tries again.
 */
export function primeTutorialPicture(): Promise<TutorialPicture | null> {
  pending ??= (async () => {
    try {
      const { width, height, fileName } = TUTORIAL_PICTURE;
      const png = await encodeRgbPng(width, height, paintSkyPanorama(width, height));
      ready = { dataUrl: `data:image/png;base64,${bytesToBase64(png)}`, width, height, fileName };
      return ready;
    } catch {
      pending = null;
      return null;
    }
  })();
  return pending;
}

/** The picture once `primeTutorialPicture` has finished, else null. */
export function tutorialPicture(): TutorialPicture | null {
  return ready;
}
