import { useCallback, useRef, useEffect, memo } from 'react';
import type { BuiltinTexture } from '@/registry/builtinTextures';
import { perlin2D } from '@/utils/noisePreview';

export const BUILTIN_TEXTURE_DRAG_TYPE = 'application/fastshaders-builtin-texture';

interface TextureCardProps {
  texture: BuiltinTexture;
}

const PREVIEW_SIZE = 64;

/** CPU wood preview — rings from cylindrical noise + cosine banding. */
function renderWoodPreview(ctx: CanvasRenderingContext2D) {
  const w = PREVIEW_SIZE;
  const img = ctx.createImageData(w, w);
  const woodR = 0.8, woodG = 0.4, woodB = 0;
  const bgR = 0.4, bgG = 0.1, bgB = 0;

  for (let py = 0; py < w; py++) {
    for (let px = 0; px < w; px++) {
      // Map pixel to [-1, 1] space
      const x = (px / w) * 2 - 1;
      const y = (py / w) * 2 - 1;

      // Cylindrical distance (rings around center)
      const dist = Math.sqrt(x * x + y * y);

      // Add noise perturbation for natural irregularity
      const noiseVal = perlin2D(x * 3, y * 3);
      const perturbed = dist + noiseVal * 0.15;

      // Ring banding (double cosine, matching the TSL shader)
      const ringBase = perturbed * 45; // ~4.5 rings
      const k1 = Math.cos(ringBase);
      const k2 = Math.cos(ringBase + k1);
      const k = (k2 + 1) / 2;

      // Mix colors
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

// Map texture id → renderer (extend when adding new textures)
const PREVIEW_RENDERERS: Record<string, (ctx: CanvasRenderingContext2D) => void> = {
  wood: renderWoodPreview,
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
            {memberCount} nodes
          </span>
        </div>
      </div>
    </div>
  );
});
