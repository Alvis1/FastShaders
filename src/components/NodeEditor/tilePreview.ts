/**
 * Shared CPU preview plumbing for content-browser asset tiles (TextureCard,
 * PresetCard): a tiny per-pixel shading loop plus the math helpers the
 * per-asset shade functions are written against.
 */

/**
 * CPU render resolution for an asset tile's preview.
 *
 * Tiles display the preview at the card's full content width (~124px), so a
 * 64px render was being upscaled ~2x and read soft. Rendering at 128 costs 4x
 * the per-pixel work, but it happens once per tile on mount of the tab that
 * shows it — a handful of tiles, off any interactive path.
 */
export const PREVIEW_SIZE = 128;

export function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

export function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Run `shade` for every pixel of a PREVIEW_SIZE tile, x/y mapped to [-1, 1]. */
export function renderPixels(
  ctx: CanvasRenderingContext2D,
  shade: (x: number, y: number) => [number, number, number],
) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      const [r, g, b] = shade(x, y);
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
