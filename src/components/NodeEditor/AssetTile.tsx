import { useCallback, useEffect, useRef } from 'react';
import { startTileDrag, tileGhostZoom, tileActivationProps, setHtml5TileDrag } from './tileDrag';
import { useAssetTooltip } from './AssetTooltip';
import { AssetCostBadge } from './AssetCostBadge';
import { PREVIEW_SIZE } from './tilePreview';

interface AssetTileProps {
  kind: 'preset' | 'texture';
  id: string;
  /** dataTransfer type of the HTML5 drag. */
  dragType: string;
  /** Display texts, already in the UI language. */
  name: string;
  tooltipText: string;
  activationLabel: string;
  countLabel: string;
  color: string;
  totalCost: number;
  /** Paints the picture. Must be STABLE per asset: the canvas repaints when it changes. */
  paint?: (ctx: CanvasRenderingContext2D) => void;
}

/** The ready-made asset tile (PresetCard, TextureCard): picture, frame, drag and click-to-add. */
export function AssetTile({
  kind, id, dragType, name, tooltipText, activationLabel, countLabel, color, totalCost, paint,
}: AssetTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) paint?.(ctx);
  }, [paint]);

  const onDragStart = useCallback(
    (event: React.DragEvent) => {
      event.dataTransfer.setData(dragType, id);
      event.dataTransfer.effectAllowed = 'move';
      // Record the payload for dragover (dataTransfer is unreadable there) so
      // the canvas can withhold the drop-on-edge highlight: an asset drop never
      // splices. Teardown rides ContentBrowser's root onDragEnd.
      setHtml5TileDrag({ kind, id });
    },
    [dragType, kind, id],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      const tile = event.currentTarget as HTMLElement;
      startTileDrag(
        event.nativeEvent,
        { kind, id },
        `<div class="saved-group-card saved-group-card--preview" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
      );
    },
    [kind, id],
  );

  const { tooltip, tooltipHandlers } = useAssetTooltip(tooltipText);

  return (
    <div
      className="saved-group-card saved-group-card--preview"
      draggable
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      {...tileActivationProps({ kind, id }, activationLabel)}
      {...tooltipHandlers}
    >
      {tooltip}
      <AssetCostBadge cost={totalCost} />
      <div
        className="saved-group-card__frame"
        style={{ background: `${color}1A`, borderColor: `${color}66` }}
      >
        <div className="saved-group-card__header" style={{ background: color }}>
          <span className="saved-group-card__title">{name}</span>
        </div>
        <div className="saved-group-card__body">
          <canvas
            ref={canvasRef}
            width={PREVIEW_SIZE}
            height={PREVIEW_SIZE}
            // Fills the card's content width: the tile is meant to be the image.
            style={{ width: '100%', height: 'auto', aspectRatio: '1 / 1', display: 'block', borderRadius: 0, imageRendering: 'auto' }}
          />
          <span className="saved-group-card__count" style={{ marginTop: 2 }}>{countLabel}</span>
        </div>
      </div>
    </div>
  );
}
