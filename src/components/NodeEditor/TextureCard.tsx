import { useCallback, useRef, useEffect, memo } from 'react';
import type { BuiltinTexture } from '@/registry/builtinTextures';
import { perlin2D } from '@/utils/noisePreview';
import { startTileDrag, tileGhostZoom, tileActivationProps, setHtml5TileDrag } from './tileDrag';
import { useAssetTooltip } from './AssetTooltip';
import { AssetCostBadge } from './AssetCostBadge';
import { PREVIEW_SIZE, clamp01, lerp3, smoothstep, renderPixels } from './tilePreview';
// This tile's `.saved-group-card*` classes are defined in ContentBrowser.css,
// which until now was imported by ContentBrowser.tsx and NOTHING else — so on
// node-editor.html (which mounts TextureCard directly, never the browser) the
// texture tiles rendered with NO styling at all: no `zoom: 0.67`, no 108px
// width, no frame, header or title rules, just a bare block filling the cell.
// Owning the stylesheet here makes the component self-contained; the bundler
// dedupes the second import, and every selector in the file is
// `.content-browser*` / `.saved-group-card*`, which exist in no other
// stylesheet — so nothing it brings along can match on a page that has no
// content browser.
import './ContentBrowser.css';

export const BUILTIN_TEXTURE_DRAG_TYPE = 'application/fastshaders-builtin-texture';

interface TextureCardProps {
  texture: BuiltinTexture;
}

// ─── preview renderers ──────────────────────────────────────────────────────

function renderPolkaDotsPreview(ctx: CanvasRenderingContext2D) {
  const scale = 3;
  const xsize = Math.exp(0.5 * 5 - 5); // size=0.5 → exp(-2.5)
  const xblur = Math.pow(0.25, 4);
  const dot: [number, number, number] = [0.15, 0.15, 0.5];
  const bg: [number, number, number] = [1, 0.97, 0.92];

  renderPixels(ctx, (x, y) => {
    const cx = ((x * scale % 1) + 1) % 1 - 0.5;
    const cy = ((y * scale % 1) + 1) % 1 - 0.5;
    const dist = Math.sqrt(cx * cx + cy * cy);
    const k = smoothstep(xsize - xblur, xsize + xblur, dist);
    return lerp3(dot, bg, k);
  });
}

function renderGridPreview(ctx: CanvasRenderingContext2D) {
  const count = 8, thickness = 0.05;
  const line: [number, number, number] = [0.1, 0.1, 0.1];
  const bg: [number, number, number] = [0.95, 0.95, 0.95];

  renderPixels(ctx, (x, y) => {
    const gx = x * count;
    const gy = y * count;
    const distX = Math.abs(gx - Math.round(gx));
    const distY = Math.abs(gy - Math.round(gy));
    const d = Math.min(distX, distY);
    const k = smoothstep(thickness, thickness + 0.01, d);
    return lerp3(line, bg, k);
  });
}

function renderTigerFurPreview(ctx: CanvasRenderingContext2D) {
  const fur: [number, number, number] = [1.0, 0.67, 0];
  const belly: [number, number, number] = [1.0, 1.0, 0.93];
  const xscale = 2;
  const eScale = Math.exp(xscale);

  renderPixels(ctx, (x, y) => {
    const stripeX = x * eScale * xscale;
    const stripeY = y * eScale / 9;
    const n = perlin2D(stripeX, stripeY);
    const k = 1 - smoothstep(-0.3, 0.3, n - 0.2);
    const bellyT = smoothstep(-1, 0.5, y);
    const base = lerp3(belly, fur, bellyT);
    return [clamp01(base[0] * k), clamp01(base[1] * k), clamp01(base[2] * k)];
  });
}

function renderStaticNoisePreview(ctx: CanvasRenderingContext2D) {
  renderPixels(ctx, (x, y) => {
    // remap [-1, 1] back to this renderer's [0, 80] noise domain
    const k = clamp01(perlin2D((x + 1) * 40, (y + 1) * 40) * 0.5 + 0.5);
    return [k, k, k];
  });
}

/** Per-iteration seed offsets that decorrelate the two axes' noise samples.
 *  Module scope, not a literal in the loop: `fabricWarp` runs once per pixel,
 *  and an inline array literal would allocate on every one. */
const FABRIC_WARP_SEEDS = [0, 100, 300, 700] as const;

/**
 * Domain-warped noise at (x, y), mirroring CRUMPLED_FABRIC_CODE's four
 * `pos_n = pos_{n-1} + noise(pos_{n-1}) * pinch` steps (builtinTextures.ts).
 * 2D stand-in for the texture's 3D mx_noise_float, same as every other tile.
 */
function fabricWarp(x: number, y: number, eScale: number, pinch: number): number {
  let wx = x * eScale, wy = y * eScale;
  // Four warp iterations, decorrelated per axis by a per-iteration seed offset
  // (stands in for the texture's axis-permuted 3D samples).
  for (const s of FABRIC_WARP_SEEDS) {
    wx += perlin2D(wx + s, wy + s) * pinch;
    wy += perlin2D(wx + s + 50, wy + s + 50) * pinch;
  }
  return perlin2D(wx, wy);
}

function renderCrumpledFabricPreview(ctx: CanvasRenderingContext2D) {
  const eScale = Math.exp(1.5); // scale=2 → exp(scale − 0.5)
  const pinch = 0.5;
  // The texture's three blend colors, sRGB/255 (this file's convention):
  // mainColor 0xB0F0FF, subColor 0x4040F0, bgColor 0x003000.
  const main: [number, number, number] = [0.690, 0.941, 1.0];
  const sub: [number, number, number] = [0.251, 0.251, 0.941];
  const bg: [number, number, number] = [0, 0.188, 0];

  renderPixels(ctx, (x, y) => {
    const k = clamp01((fabricWarp(x, y, eScale, pinch) + 1) / 2);
    // main·(1−|2k−1|) + sub·k² + bg·(1−k)² — the texture's exact weights.
    const w1 = 1 - Math.abs(k * 2 - 1);
    const w2 = k * k;
    const w3 = (1 - k) * (1 - k);
    return [
      clamp01(main[0] * w1 + sub[0] * w2 + bg[0] * w3),
      clamp01(main[1] * w1 + sub[1] * w2 + bg[1] * w3),
      clamp01(main[2] * w1 + sub[2] * w2 + bg[2] * w3),
    ];
  });
}

function renderGasGiantPreview(ctx: CanvasRenderingContext2D) {
  const colorA: [number, number, number] = [1.0, 0.97, 0.94];
  const colorB: [number, number, number] = [0.94, 0.91, 0.69];
  const colorC: [number, number, number] = [0.69, 0.63, 0.82];
  const turb = 0.3, blur = 0.6;
  const xscale = 2;
  const eScale = Math.exp(xscale);

  renderPixels(ctx, (x, y) => {
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
    return [clamp01(withStorm[0] * k), clamp01(withStorm[1] * k), clamp01(withStorm[2] * k)];
  });
}

function renderMarblePreview(ctx: CanvasRenderingContext2D) {
  const vein: [number, number, number] = [0.27, 0.27, 0.83];
  const bg: [number, number, number] = [0.94, 0.97, 1.0];
  const scale = 3, sharpness = 2.5, detail = 0.3;

  renderPixels(ctx, (x, y) => {
    const sx = x * scale, sy = y * scale;
    const n1 = perlin2D(sx, sy);
    const n2 = perlin2D(sx * 2, sy * 2) * 0.5;
    const n3 = perlin2D(sx * 6, sy * 6) * 0.1;
    const nSum = n1 + n2 + n3;
    const veins = 1 - Math.pow(Math.abs(nSum), sharpness);
    const dn = Math.pow(Math.abs(perlin2D(sx * 50, sy * 50)), 3) * detail;
    const k = clamp01(veins + dn);
    return lerp3(bg, vein, k);
  });
}

function renderWoodPreview(ctx: CanvasRenderingContext2D) {
  const woodR = 0.8, woodG = 0.4, woodB = 0;
  const bgR = 0.4, bgG = 0.1, bgB = 0;

  renderPixels(ctx, (x, y) => {
    const dist = Math.sqrt(x * x + y * y);
    const noiseVal = perlin2D(x * 3, y * 3);
    const perturbed = dist + noiseVal * 0.15;
    const ringBase = perturbed * 45;
    const k1 = Math.cos(ringBase);
    const k2 = Math.cos(ringBase + k1);
    const k = (k2 + 1) / 2;
    return [
      woodR + (bgR - woodR) * k,
      woodG + (bgG - woodG) * k,
      woodB + (bgB - woodB) * k,
    ];
  });
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
      // Record the payload for dragover (dataTransfer is unreadable there) so
      // the canvas can withhold the drop-on-edge highlight — a texture drop
      // never splices, and the preview must not promise one. Teardown rides
      // ContentBrowser's root onDragEnd (endHtml5TileDrag).
      setHtml5TileDrag({ kind: 'texture', id: texture.id });
    },
    [texture.id],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      const tile = event.currentTarget as HTMLElement;
      startTileDrag(
        event.nativeEvent,
        { kind: 'texture', id: texture.id },
        `<div class="saved-group-card saved-group-card--preview" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
      );
    },
    [texture.id],
  );

  const memberCount = Math.max(0, texture.nodes.length - 1);
  const { tooltip, tooltipHandlers } = useAssetTooltip(
    `${texture.description} Click, or drag onto the canvas, to add it.`,
  );

  return (
    <div
      className="saved-group-card saved-group-card--preview"
      draggable
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      {...tileActivationProps({ kind: 'texture', id: texture.id }, `Add ${texture.name} texture`)}
      {...tooltipHandlers}
    >
      {tooltip}
      <AssetCostBadge cost={texture.totalCost} />
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
        <div className="saved-group-card__body">
          <canvas
            ref={canvasRef}
            width={PREVIEW_SIZE}
            height={PREVIEW_SIZE}
            // Fills the card's content width — the tile is meant to be the
            // image, not a small swatch adrift in a large frame.
            style={{ width: '100%', height: 'auto', aspectRatio: '1 / 1', display: 'block', borderRadius: 4, imageRendering: 'auto' }}
          />
          <span className="saved-group-card__count" style={{ marginTop: 2 }}>
            {memberCount} {memberCount === 1 ? 'node' : 'nodes'}
          </span>
        </div>
      </div>
    </div>
  );
});
