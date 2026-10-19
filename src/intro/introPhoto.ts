/**
 * The photo the image slide drops (ImageScene.tsx): a phone-camera-sized
 * landscape painted on a canvas and saved as a JPEG, so the slide can run the
 * app's REAL import encode on it — the format, the resolution and both file
 * sizes it shows are measured, not written into the slide.
 *
 * Painted rather than shipped: the app serves no photo (public/images holds
 * icons and logos), and a 12-megapixel file in the bundle would cost every
 * download for one slide. A fixed-seed grain gives it a photo's texture, which
 * is what makes its JPEG weigh what a real one does.
 */

/** An iPhone's 12 MP frame — the commonest photo a user drops. */
export const INTRO_PHOTO = { width: 4032, height: 3024, name: 'photo.jpg' } as const;

/** Deterministic, so every run of the slide encodes the same picture. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mountain ridge by midpoint displacement: `n + 1` heights across the frame. */
function ridge(rand: () => number, n: number, rough: number): number[] {
  const h = new Array<number>(n + 1).fill(0);
  h[0] = rand();
  h[n] = rand();
  for (let step = n; step > 1; step >>= 1) {
    const amp = rough * (step / n);
    for (let i = step >> 1; i < n; i += step) {
      h[i] = (h[i - (step >> 1)] + h[i + (step >> 1)]) / 2 + (rand() - 0.5) * amp;
    }
  }
  return h;
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rand = rng(20261018);
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#24315e');
  sky.addColorStop(0.55, '#c8668a');
  sky.addColorStop(1, '#f6b26b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const sun = ctx.createRadialGradient(w * 0.66, h * 0.5, 0, w * 0.66, h * 0.5, h * 0.32);
  sun.addColorStop(0, 'rgba(255,244,214,1)');
  sun.addColorStop(0.18, 'rgba(255,226,160,0.95)');
  sun.addColorStop(1, 'rgba(255,190,120,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);

  const layers = [
    { base: 0.5, height: 0.16, color: '#7b5a86' },
    { base: 0.58, height: 0.14, color: '#4f3c66' },
    { base: 0.68, height: 0.12, color: '#2b2440' },
  ];
  const N = 256;
  for (const layer of layers) {
    const r = ridge(rand, N, 1.6);
    ctx.fillStyle = layer.color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i <= N; i++) ctx.lineTo((i / N) * w, h * (layer.base - layer.height * r[i]));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }

  const lake = ctx.createLinearGradient(0, h * 0.74, 0, h);
  lake.addColorStop(0, 'rgba(246,178,107,0.55)');
  lake.addColorStop(1, 'rgba(20,24,48,0.9)');
  ctx.fillStyle = lake;
  ctx.fillRect(0, h * 0.74, w, h * 0.26);

  // Film grain: one fixed tile, overlaid across the frame.
  const tile = document.createElement('canvas');
  tile.width = tile.height = 256;
  const tctx = tile.getContext('2d');
  if (tctx) {
    const img = tctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(rand() * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 40;
    }
    tctx.putImageData(img, 0, 0);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (pattern) {
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

/** The photo as the File a drop would hand the app, or null where this
 *  browser cannot paint or encode one. */
export async function makeIntroPhoto(): Promise<File | null> {
  const canvas = document.createElement('canvas');
  canvas.width = INTRO_PHOTO.width;
  canvas.height = INTRO_PHOTO.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  paint(ctx, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  // Release the 48 MB backing store now rather than at the next GC.
  canvas.width = canvas.height = 0;
  return blob ? new File([blob], INTRO_PHOTO.name, { type: 'image/jpeg' }) : null;
}
