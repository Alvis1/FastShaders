import { useCallback, useRef, useEffect, memo } from 'react';
import type { BuiltinTexture } from '@/registry/builtinTextures';
import { perlin2D } from '@/utils/noisePreview';

export const BUILTIN_TEXTURE_DRAG_TYPE = 'application/fastshaders-builtin-texture';

interface TextureCardProps {
  texture: BuiltinTexture;
}

const PREVIEW_SIZE = 64;

// ─── helpers ────────────────────────────────────────────────────────────────

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ─── preview renderers ──────────────────────────────────────────────────────

function renderPolkaDotsPreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const scale = 3;
  const xsize = Math.exp(0.5 * 5 - 5); // size=0.5 → exp(-2.5)
  const xblur = Math.pow(0.25, 4);
  const dot: [number, number, number] = [0.15, 0.15, 0.5];
  const bg: [number, number, number] = [1, 0.97, 0.92];

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      const cx = ((x * scale % 1) + 1) % 1 - 0.5;
      const cy = ((y * scale % 1) + 1) % 1 - 0.5;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const k = smoothstep(xsize - xblur, xsize + xblur, dist);
      const [r, g, b] = lerp3(dot, bg, k);
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderGridPreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const count = 8, thickness = 0.05;
  const line: [number, number, number] = [0.1, 0.1, 0.1];
  const bg: [number, number, number] = [0.95, 0.95, 0.95];

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      const gx = x * count;
      const gy = y * count;
      const distX = Math.abs(gx - Math.round(gx));
      const distY = Math.abs(gy - Math.round(gy));
      const d = Math.min(distX, distY);
      const k = smoothstep(thickness, thickness + 0.01, d);
      const [r, g, b] = lerp3(line, bg, k);
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderTigerFurPreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const fur: [number, number, number] = [1.0, 0.67, 0];
  const belly: [number, number, number] = [1.0, 1.0, 0.93];
  const xscale = 2;
  const eScale = Math.exp(xscale);

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      const stripeX = x * eScale * xscale;
      const stripeY = y * eScale / 9;
      const n = perlin2D(stripeX, stripeY);
      const k = 1 - smoothstep(-0.3, 0.3, n - 0.2);
      const bellyT = smoothstep(-1, 0.5, y);
      const base = lerp3(belly, fur, bellyT);
      const [r, g, b] = [base[0] * k, base[1] * k, base[2] * k];
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(clamp01(r) * 255);
      img.data[i + 1] = Math.round(clamp01(g) * 255);
      img.data[i + 2] = Math.round(clamp01(b) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderStaticNoisePreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 80;
      const y = (py / w) * 80;
      const k = clamp01(perlin2D(x, y) * 0.5 + 0.5);
      const v = Math.round(k * 255);
      const i = (py * w + px) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Compute domain-warped height at (x, y) — shared by the 3 finite-difference samples. */
function fabricHeight(x: number, y: number, eScale: number, pinch: number): number {
  let wx = x * eScale, wy = y * eScale;
  // warp iteration 1
  wx += perlin2D(wx, wy) * pinch;
  wy += perlin2D(wx + 100, wy + 100) * pinch;
  // warp iteration 2
  wx += perlin2D(wx, wy) * pinch;
  wy += perlin2D(wx + 300, wy + 300) * pinch;
  return perlin2D(wx, wy);
}

function renderCrumpledFabricPreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const eScale = Math.exp(1.5); // scale=2 → exp(1.5)
  const pinch = 0.5;
  const EPS = 0.01;
  const bump = 20;

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      // finite-difference normal from warped height field
      const h0 = fabricHeight(x, y, eScale, pinch);
      const h1 = fabricHeight(x + EPS, y, eScale, pinch);
      const h2 = fabricHeight(x, y + EPS, eScale, pinch);
      const sx = (h0 - h1) * bump;
      const sy = (h0 - h2) * bump;
      const len = Math.sqrt(sx * sx + sy * sy + 1);
      // encode tangent-space normal as color
      const r = clamp01(sx / len * 0.5 + 0.5);
      const g = clamp01(sy / len * 0.5 + 0.5);
      const b = clamp01(1 / len * 0.5 + 0.5);
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderGasGiantPreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const colorA: [number, number, number] = [1.0, 0.97, 0.94];
  const colorB: [number, number, number] = [0.94, 0.91, 0.69];
  const colorC: [number, number, number] = [0.69, 0.63, 0.82];
  const turb = 0.3, blur = 0.6;
  const xscale = 2;
  const eScale = Math.exp(xscale);

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      const sx = x * eScale, sy = y * eScale;
      // turbulence strength from y-noise
      const yt = (perlin2D(0, y) + perlin2D(0, y * 2) * 0.5 + perlin2D(1, y * 4) * 0.25);
      const xt = Math.abs(yt * turb) * 5;
      // warp position
      const wx = sx + perlin2D(sx, sy) * xt;
      const wy = sy + perlin2D(sx + 100, sy + 100) * xt;
      // band noise from warped y-axis
      const bandRaw = perlin2D(0, wy * xscale);
      // high-frequency detail
      const hfRaw = perlin2D(wx * 15, wy * 15);
      const blurInv = 1 - Math.pow(blur, 0.2);
      const bandTotal = bandRaw + hfRaw * blurInv;
      // shape bands
      const k = 1 - smoothstep(-1, 1, bandTotal - 0.5);
      // color mixing
      const yColK = perlin2D(0, y * 0.75) + 1;
      const base = lerp3(colorB, colorA, clamp01(yColK));
      const withStorm = lerp3(base, colorC, clamp01(xt * 0.3));
      const [r, g, b] = [withStorm[0] * k, withStorm[1] * k, withStorm[2] * k];
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(clamp01(r) * 255);
      img.data[i + 1] = Math.round(clamp01(g) * 255);
      img.data[i + 2] = Math.round(clamp01(b) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderMarblePreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const vein: [number, number, number] = [0.27, 0.27, 0.83];
  const bg: [number, number, number] = [0.94, 0.97, 1.0];
  const scale = 3, sharpness = 2.5, detail = 0.3;

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      const sx = x * scale, sy = y * scale;
      const n1 = perlin2D(sx, sy);
      const n2 = perlin2D(sx * 2, sy * 2) * 0.5;
      const n3 = perlin2D(sx * 6, sy * 6) * 0.1;
      const nSum = n1 + n2 + n3;
      const veins = 1 - Math.pow(Math.abs(nSum), sharpness);
      const dn = Math.pow(Math.abs(perlin2D(sx * 50, sy * 50)), 3) * detail;
      const k = clamp01(veins + dn);
      const [r, g, b] = lerp3(bg, vein, k);
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderWoodPreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const woodR = 0.8, woodG = 0.4, woodB = 0;
  const bgR = 0.4, bgG = 0.1, bgB = 0;

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;
      const dist = Math.sqrt(x * x + y * y);
      const noiseVal = perlin2D(x * 3, y * 3);
      const perturbed = dist + noiseVal * 0.15;
      const ringBase = perturbed * 45;
      const k1 = Math.cos(ringBase);
      const k2 = Math.cos(ringBase + k1);
      const k = (k2 + 1) / 2;
      const r = woodR + (bgR - woodR) * k;
      const g = woodG + (bgG - woodG) * k;
      const b = woodB + (bgB - woodB) * k;
      const i = (py * w + px) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Map texture id → renderer
const PREVIEW_RENDERERS: Record<string, (ctx: CanvasRenderingContext2D) => void> = {
  'polka-dots': renderPolkaDotsPreview,
  'grid': renderGridPreview,
  'tiger-fur': renderTigerFurPreview,
  'static-noise': renderStaticNoisePreview,
  'crumpled-fabric': renderCrumpledFabricPreview,
  'gas-giant': renderGasGiantPreview,
  'marble': renderMarblePreview,
  'wood': renderWoodPreview,
};

export const TextureCard = memo(function TextureCard({ texture }: TextureCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const renderer = PREVIEW_RENDERERS[texture.id];
    if (renderer) renderer(ctx);
  }, [texture.id]);

  const onDragStart = useCallback(
    (event: React.DragEvent) => {
      event.dataTransfer.setData(BUILTIN_TEXTURE_DRAG_TYPE, texture.id);
      event.dataTransfer.effectAllowed = 'move';
    },
    [texture.id],
  );

  const memberCount = Math.max(0, texture.nodes.length - 1);

  return (
    <div
      className="saved-group-card"
      draggable
      onDragStart={onDragStart}
      title={`${texture.name} texture — drag to canvas`}
    >
      <div
        className="saved-group-card__frame"
        style={{
          background: `${texture.color}1A`,
          borderColor: `${texture.color}66`,
        }}
      >
        <div
          className="saved-group-card__header"
          style={{ background: texture.color }}
        >
          <span className="saved-group-card__title">{texture.name}</span>
        </div>
        <div className="saved-group-card__body" style={{ alignItems: 'center', padding: '6px' }}>
          <canvas
            ref={canvasRef}
            width={PREVIEW_SIZE}
            height={PREVIEW_SIZE}
            style={{ width: 56, height: 56, borderRadius: 4, imageRendering: 'auto' }}
          />
          <span className="saved-group-card__count" style={{ marginTop: 2 }}>
            {memberCount} nodes &middot; {texture.totalCost} pts
          </span>
        </div>
      </div>
    </div>
  );
});
