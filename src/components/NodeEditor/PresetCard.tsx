import { useCallback, useRef, useEffect, memo } from 'react';
import type { BuiltinPreset } from '@/registry/builtinPresets';
import { perlin2D } from '@/utils/noisePreview';
import { startTileDrag, tileGhostZoom, tileActivationProps, setHtml5TileDrag } from './tileDrag';
import { useAssetTooltip } from './AssetTooltip';
import { AssetCostBadge } from './AssetCostBadge';
import { PREVIEW_SIZE, clamp01, lerp3, smoothstep, renderPixels } from './tilePreview';

export const BUILTIN_PRESET_DRAG_TYPE = 'application/fastshaders-builtin-preset';

interface PresetCardProps {
  preset: BuiltinPreset;
}

/** Per-pixel CPU approximation of a preset's look; x/y span [-1, 1], y=-1 top. */
type Shade = (x: number, y: number) => [number, number, number];

// ─── preview shade functions ────────────────────────────────────────────────
// Static snapshots of each preset's default parameters (animated presets are
// frozen mid-motion). Normal-based presets fake a sphere: nz = sqrt(1-x²-y²).

const PRESET_SHADES: Record<string, Shade> = {
  'gradient':
  (x, y) => {
    const t = clamp01((1 - y) / 2);
    return lerp3([0.102, 0.137, 0.494], [1.0, 0.541, 0.396], t);
  },
  'stripes':
  (x, y) => {
    const u = (x + 1) / 2;
    const v = (1 - y) / 2;
    const a = 30 * 0.01745329;
    const rx = u * Math.cos(a) - v * Math.sin(a);
    const s = Math.sin(rx * 20);
    const k = clamp01(smoothstep(-0.4, 0.4, s));
    const colorA: [number, number, number] = [0.149, 0.196, 0.22];
    const colorB: [number, number, number] = [0.925, 0.937, 0.945];
    return lerp3(colorA, colorB, k);
  },
  'checker':
  (x, y) => {
    const A: [number, number, number] = [0.980, 0.980, 0.980];
    const B: [number, number, number] = [0.129, 0.129, 0.129];
    const count = 8;
    const ux = (x + 1) / 2;
    // v=1 at the TOP (the file's shared convention) — with an even count a
    // flipped v inverts the parity and swaps the two colors vs the shader.
    const uy = (1 - y) / 2;
    const fx = Math.floor(ux * count);
    const fy = Math.floor(uy * count);
    const m = (((fx + fy) % 2) + 2) % 2;
    return lerp3(A, B, m);
  },
  'edge-glow':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.01, 0.02, 0.04];
    const nz = Math.sqrt(1 - r2); // ndv: normal=(x,-y,nz), viewDir=(0,0,1)
    const inv = 1 - clamp01(nz);
    const rim = Math.pow(inv, 3) * 2; // glowPower=3, intensity=2
    const base: [number, number, number] = [0.051, 0.106, 0.165]; // 0x0D1B2A
    const glow: [number, number, number] = [0, 0.898, 1]; // 0x00E5FF
    return [
      clamp01(base[0] + glow[0] * rim),
      clamp01(base[1] + glow[1] * rim),
      clamp01(base[2] + glow[2] * rim),
    ];
  },
  'pulse':
  (x: number, y: number): [number, number, number] => {
    // Spatially uniform pulse — freeze time at t = 0.26 (pulseSpeed = 2), a
    // mid-swing instant: k ≈ 0.75 shows BOTH colors (t = 0.6 froze at k ≈ 0.97,
    // rendering the card as a flat pulseColor swatch with no trace of rest).
    const t = 0.26;
    const s = Math.sin(t * 2); // ~0.497
    const k = clamp01(s * 0.5 + 0.5); // ~0.75, visibly mid-pulse
    const rest: [number, number, number] = [0x31 / 255, 0x1b / 255, 0x92 / 255];
    const pulse: [number, number, number] = [0xff / 255, 0xea / 255, 0x00 / 255];
    return lerp3(rest, pulse, k);
  },
  'uv-scroll':
  (x, y) => {
    const t = 0.6;
    const scrollSpeed = 0.3;
    const colorA: [number, number, number] = [0 / 255, 77 / 255, 64 / 255];
    const colorB: [number, number, number] = [167 / 255, 255 / 255, 235 / 255];
    const ux = (x + 1) / 2;
    const off = t * scrollSpeed;
    const fx = (ux + off) % 1;
    return lerp3(colorA, colorB, clamp01(fx));
  },
  'color-ramp':
  (x, y) => {
    const t = (x + 1) / 2;
    const base = 127 / 255;
    const amp = 127 / 255;
    const r = clamp01(base + amp * Math.cos(6.2832 * t));
    const g = clamp01(base + amp * Math.cos(6.2832 * (t + 0.33)));
    const b = clamp01(base + amp * Math.cos(6.2832 * (t + 0.67)));
    return [r, g, b];
  },
  'noise-mask':
  (x: number, y: number): [number, number, number] => {
    const n = perlin2D(x * 3, y * 3);
    // Preset remaps noise to 0..1 and thresholds at 0.5 ± 0.2. ×0.33 tames
    // perlin2D's real ~±1.5 spread (its "roughly [-1,1]" doc undersells the
    // gradient overshoot) so thresholds stay comparable to the GPU's
    // mx_noise_float — the file-wide convention (dissolve does the same).
    const k = clamp01(smoothstep(0.3, 0.7, clamp01(n * 0.33 + 0.5)));
    const colorA: [number, number, number] = [0.106, 0.369, 0.125];
    const colorB: [number, number, number] = [1.0, 0.976, 0.769];
    return lerp3(colorA, colorB, k);
  },
  'toon-ramp':
  (x: number, y: number): [number, number, number] => {
    const shadow: [number, number, number] = [74 / 255, 20 / 255, 140 / 255];
    const lit: [number, number, number] = [255 / 255, 224 / 255, 130 / 255];
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.12, 0.11, 0.16];
    const nz = Math.sqrt(1 - r2);
    const len = Math.sqrt(0.5 * 0.5 + 0.8 * 0.8 + 0.4 * 0.4);
    const nl = (x * 0.5 - y * 0.8 + nz * 0.4) / len;
    const k = clamp01(nl * 0.5 + 0.5);
    // floor(k*steps)/(steps−1), matching the preset — ÷steps would cap the
    // brightest band at 2/3 and never show litColor.
    const kq = Math.min(Math.floor(k * 3) / 2, 1);
    return lerp3(shadow, lit, kq);
  },
  'vertex-wave':
  (x: number, y: number): [number, number, number] => {
    // Displaced-sphere SILHOUETTE: the rim ripples by the same phase the
    // shader displaces vertices with (amp·sin(pos.y·freq − t·speed), t = 0.6),
    // so the card depicts displacement itself, not a painted stripe pattern.
    const waveFrequency = 8;
    const waveSpeed = 2;
    const waveAmplitude = 0.08;
    const t = 0.6;
    const phase = -y * 0.8 * waveFrequency - t * waveSpeed; // pos.y = −y·0.8 (y=−1 top)
    const ripple = waveAmplitude * Math.sin(phase);
    const R = 0.8 + ripple;
    const r = Math.sqrt(x * x + y * y);
    if (r > R) return [0.12, 0.13, 0.17];
    const q = r / R;
    const nz = Math.sqrt(Math.max(0, 1 - q * q));
    // sphere shading + a faint swell-band in the same phase, so the wave
    // reads across the body and not just at the rim
    const swell = 0.5 + 0.5 * Math.sin(phase);
    const g = clamp01(0.3 + 0.55 * nz + 0.15 * swell);
    return [g, g, clamp01(g * 1.06)];
  },
  'top-cover':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.09, 0.08, 0.08];
    // Sphere normal at this pixel: (x, -y, nz); y = -1 is the top row, so n.y = -y.
    const ny = -y;
    const base: [number, number, number] = [0.365, 0.251, 0.216];   // 0x5D4037
    const cover: [number, number, number] = [0.980, 0.980, 0.980];  // 0xFAFAFA
    // coverage 0.6 -> snow line 1−0.6 = 0.4, softness 0.2 -> smoothstep(0.2, 0.6, n.y)
    const k = clamp01(smoothstep(0.2, 0.6, ny));
    return lerp3(base, cover, k);
  },
  'dissolve':
  (x, y) => {
    // ×0.8 maps the tile to the sphere's ±0.8 geometry domain; ×0.33 tames
    // perlin2D's ±1.5 spread (the file-wide convention — see noise-mask).
    const n = perlin2D(x * 4 * 0.8, y * 4 * 0.8);
    const n01 = clamp01(n * 0.33 + 0.5);
    const solid = smoothstep(0.45, 0.53, n01);
    const band = solid * (1 - solid) * 4;
    const body: [number, number, number] = [0.216, 0.278, 0.310];
    const edge: [number, number, number] = [1.0, 0.427, 0.0];
    return [
      clamp01(body[0] * solid + edge[0] * band),
      clamp01(body[1] * solid + edge[1] * band),
      clamp01(body[2] * solid + edge[2] * band),
    ];
  },
  'hologram':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.02, 0.03, 0.04];
    const nz = Math.sqrt(1 - r2);
    const rim = Math.pow(1 - clamp01(nz), 2);
    const py = -y * 0.8;
    const s = Math.sin(py * 40 + 0.6 * 5);
    const s01 = s * 0.5 + 0.5;
    const scanDim = s01 * 0.4;
    const lifted = rim + scanDim + 0.15;
    return [clamp01((0x18 / 255) * lifted), clamp01(lifted), clamp01(lifted)];
  },
  'force-field':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.02, 0.02, 0.05];
    const nz = Math.sqrt(1 - r2);
    const rim = (1 - nz) * (1 - nz);
    const u = 0.5 + Math.atan2(x, nz) / (2 * Math.PI);
    const v = 0.5 - Math.asin(-y) / Math.PI;
    const gx = u * 12;
    const dx = Math.abs(gx - Math.round(gx));
    const gy = v * 12;
    const dy = Math.abs(gy - Math.round(gy));
    const d = Math.min(dx, dy);
    const lines = 1 - smoothstep(0.03, 0.08, d);
    const p = 0.5 + (Math.sin(1.8) + 1) * 0.25;
    const k = (rim + lines * 0.5) * p;
    return [clamp01(0.486 * k), clamp01(0.302 * k), clamp01(k)];
  },
  'stylized-water':
  (x, y) => {
    // Mirrors the shader exactly (frozen at t = 0.6): warp the coordinate, then
    // three plane waves from one sin, then the "top two tie" cell-wall test.
    // The sphere is faked as in the other normal-based shades: nz = sqrt(1-x²-y²).
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.055, 0.075, 0.09];
    const nz = Math.sqrt(1 - r2);
    const R = 0.8, waterScale = 4, ts = 0.6 * 0.35;
    const s = [x * R * waterScale, y * R * waterScale, nz * R * waterScale];
    const wob = [Math.sin(s[0]), Math.sin(s[1]), Math.sin(s[2])];
    const fd = [1.7, 0.47, 0.75];
    const p = [
      s[0] + fd[0] * ts + wob[1],
      s[1] + fd[1] * ts + wob[2],
      s[2] + fd[2] * ts + wob[0],
    ];
    const cells = [2.41, 3.29, 2.87];
    const w = [
      Math.sin(p[0] * cells[0]),
      Math.sin(p[1] * cells[1]),
      Math.sin(p[2] * cells[2]),
    ];
    const hi = Math.max(w[0], w[1]);
    const lo = Math.min(w[0], w[1]);
    const tie = Math.max(hi, w[2]) - Math.max(lo, Math.min(hi, w[2]));
    const web = Math.max(tie * -4.4 + 1.5, 0);
    const glow = web * web;
    // viewDir = (0,0,1), so the world normal's facing term is just nz.
    const base = lerp3([0.004, 0.341, 0.608], [0.302, 0.816, 0.882], clamp01(nz * 0.55));
    const light = glow * 0.9;
    return [
      clamp01(base[0] + 0.75 * light),
      clamp01(base[1] + 0.95 * light),
      clamp01(base[2] + light),
    ];
  },
};

/** Flat tint fallback for a preset without a shade function (dev safety net). */
function fallbackShade(hex: string): Shade {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return () => [clamp01(r), clamp01(g), clamp01(b)];
}

export const PresetCard = memo(function PresetCard({ preset }: PresetCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    renderPixels(ctx, PRESET_SHADES[preset.id] ?? fallbackShade(preset.color));
  }, [preset.id, preset.color]);

  const onDragStart = useCallback(
    (event: React.DragEvent) => {
      event.dataTransfer.setData(BUILTIN_PRESET_DRAG_TYPE, preset.id);
      event.dataTransfer.effectAllowed = 'move';
      // Record the payload for dragover (dataTransfer is unreadable there) so
      // the canvas can withhold the drop-on-edge highlight — a preset drop
      // never splices, and the preview must not promise one. Teardown rides
      // ContentBrowser's root onDragEnd (endHtml5TileDrag).
      setHtml5TileDrag({ kind: 'preset', id: preset.id });
    },
    [preset.id],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      const tile = event.currentTarget as HTMLElement;
      startTileDrag(
        event.nativeEvent,
        { kind: 'preset', id: preset.id },
        `<div class="saved-group-card saved-group-card--preview" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
      );
    },
    [preset.id],
  );

  // Counts SHADER nodes: drop the group container and the explainer note, so
  // the number matches what the user will actually be reading in the graph.
  const memberCount = preset.nodes.filter(
    (n) => n.type !== 'group' && n.type !== 'note',
  ).length;
  const { tooltip, tooltipHandlers } = useAssetTooltip(
    `${preset.description} Click, or drag onto the canvas, to add it.`,
  );

  return (
    <div
      className="saved-group-card saved-group-card--preview"
      draggable
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      {...tileActivationProps({ kind: 'preset', id: preset.id }, `Add ${preset.name} preset`)}
      {...tooltipHandlers}
    >
      {tooltip}
      <AssetCostBadge cost={preset.totalCost} />
      <div
        className="saved-group-card__frame"
        style={{
          background: `${preset.color}1A`,
          borderColor: `${preset.color}66`,
        }}
      >
        <div
          className="saved-group-card__header"
          style={{ background: preset.color }}
        >
          <span className="saved-group-card__title">{preset.name}</span>
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
