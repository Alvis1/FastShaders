/**
 * The LED Display texture's tile thumbnail, as a PURE per-pixel shade.
 *
 * Its own module so `ledDisplayTexture.test.ts` can test what the tile DRAWS —
 * which emitter lights for which channel, where B sits, the linear drive, the
 * sRGB encode — rather than grep how it is spelled: string pins let a tile
 * that over-drives, shares one seed across the channels or turns the layout
 * upside down through untouched.
 *
 * The emitter maths is the texture's (LED_DISPLAY_CODE in builtinTextures.ts,
 * the drift pair the suite compares); the PICTURE is a stand-in, a smooth
 * colour noise sampled once per display pixel like the texture's, with seeds
 * chosen so the 7×7 crop shows what the texture does: mostly one or two lit
 * emitters per pixel, several colours, some dark ones.
 */
import { perlin2D } from '@/utils/noisePreview';
import { clamp01 } from './tilePreview';

/** The three emitter centres of one display pixel, in emitter radii — the cell
 *  is LED_CELL wide. LED_DISPLAY_CODE's `emitterX` / `emitterY`, one [x, y] per
 *  colour (v UP): R and G side by side, B centred beneath them. */
export const LED_EMITTERS: readonly (readonly [number, number])[] = [[1.1, 3.3], [3.3, 3.3], [2.2, 1.1]];
/** The cell width in emitter radii (the texture's `mul(inCell, 4.4)`). */
export const LED_CELL = 4.4;
/** The disc edge: (1 - d²) × this, clamped — a flat emitter with a soft rim. */
export const LED_DISC_EDGE = 4;
/** diodeBrightness's default. */
export const LED_BRIGHTNESS = 1;
/** Display pixels across the tile. The texture's default is 40; at 40 an emitter
 *  would be under two tile pixels wide. */
export const LED_TILE_PIXELS = 7;

/** Where each channel of the stand-in picture reads the 2D noise, so R, G and B
 *  vary independently — the texture's mx_noise_vec3, approximated. */
const LED_CHANNEL_SEEDS: readonly (readonly [number, number])[] = [[34.5, 11.4], [55.9, 13.5], [16.6, 35.1]];
/** Noise frequency per display pixel: a few colour areas across the crop. */
const LED_TILE_FREQ = 0.24;

/** The stand-in picture's level for `channel` at a display pixel's CENTRE
 *  (cell units, v up) — max(noise, 0), as the texture's `picture`. */
export function ledTileLevel(channel: number, centreX: number, centreY: number): number {
  const seed = LED_CHANNEL_SEEDS[channel];
  return Math.max(perlin2D(centreX * LED_TILE_FREQ + seed[0], centreY * LED_TILE_FREQ + seed[1]), 0);
}

/** Linear light out of one emitter: its channel's level × the disc ×
 *  brightness, at (qx, qy) inside the cell in emitter radii, v up. */
export function ledEmitter(channel: number, level: number, qx: number, qy: number): number {
  const dx = LED_EMITTERS[channel][0] - qx;
  const dy = LED_EMITTERS[channel][1] - qy;
  const disc = clamp01((1 - (dx * dx + dy * dy)) * LED_DISC_EDGE);
  return level * disc * LED_BRIGHTNESS;
}

/** Linear light to the sRGB value the canvas stores (the preview encodes the
 *  shader's linear output the same way), so a dim emitter shows as dim. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** One tile pixel, for `renderPixels`: tile coordinates -1..1 with y DOWN. */
export function ledDisplayShade(x: number, y: number): [number, number, number] {
  // The texture's UV runs 0..1 with v UP.
  const cellX = ((x + 1) / 2) * LED_TILE_PIXELS;
  const cellY = ((1 - y) / 2) * LED_TILE_PIXELS;
  // Sampled ONCE per display pixel, at its centre — the texture's hand-off.
  const centreX = Math.floor(cellX) + 0.5;
  const centreY = Math.floor(cellY) + 0.5;
  const qx = (cellX - Math.floor(cellX)) * LED_CELL;
  const qy = (cellY - Math.floor(cellY)) * LED_CELL;
  const rgb: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    // LINEAR drive: each emitter shines with its own channel, nothing more.
    rgb[i] = linearToSrgb(clamp01(ledEmitter(i, ledTileLevel(i, centreX, centreY), qx, qy)));
  }
  return rgb;
}
