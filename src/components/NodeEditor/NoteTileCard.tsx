import { memo, useCallback, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { getContrastColor } from '@/utils/colorUtils';
import {
  NOTE_BODY_COLOR,
  NOTE_HEADER_COLOR,
  NOTE_MIN_HEIGHT,
  NOTE_MIN_WIDTH,
  NOTE_TILE_TYPE,
} from '@/utils/noteDefaults';
import { t, type Language } from '@/i18n';
import { setHtml5TileDrag, startTileDrag, tileActivationProps, tileGhostZoom, type TilePayload } from './tileDrag';
import { useAssetTooltip } from './AssetTooltip';
import './nodes/NoteNode.css';

const PAYLOAD: TilePayload = { kind: 'node', nodeType: NOTE_TILE_TYPE };

/** The tile's hover text — also the `lv.json` key. */
export const NOTE_TILE_TIP = 'A sticky note for writing on the canvas. It does not change the shader.';

/**
 * The asset bar's Note tile: a fresh note drawn with the canvas note's OWN
 * classes (`.note-node`, NoteNode.css) and colours (utils/noteDefaults), at the
 * smallest size a note can be resized to — a real size of the real node, so
 * the tile scales the note without restyling it, and is never the tallest tile
 * in the strip (which would shrink every other tile to fit it). Inert: the
 * body is text, not a textarea.
 *
 * It rides the `node` payload with the note's flow type, so every way of adding
 * a tile (HTML5 drag, touch drag, click, Enter) reaches `placeTilePayload`,
 * which hands it to the store's `addNote` — the same action the Add menu's
 * row runs. A note has no registry definition, so the drag-connect and
 * drop-on-edge previews already skip it.
 */
export const NoteTileCard = memo(function NoteTileCard() {
  const language = useAppStore((s) => s.language);
  const { tooltip, tooltipHandlers } = useAssetTooltip(t(NOTE_TILE_TIP, language));

  const onDragStart = useCallback((event: React.DragEvent) => {
    event.dataTransfer.setData('application/reactflow-type', NOTE_TILE_TYPE);
    event.dataTransfer.effectAllowed = 'move';
    setHtml5TileDrag(PAYLOAD);
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const tile = event.currentTarget as HTMLElement;
    startTileDrag(
      event.nativeEvent,
      PAYLOAD,
      `<div class="node-preview-card" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
    );
  }, []);

  return (
    <div
      className="node-preview-card"
      draggable
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      {...tileActivationProps(PAYLOAD, t('Add Note', language))}
      {...tooltipHandlers}
    >
      {tooltip}
      <NoteFace width={NOTE_MIN_WIDTH} height={NOTE_MIN_HEIGHT} language={language} />
    </div>
  );
});

/**
 * A fresh note with the canvas note's OWN classes and colours, its body as
 * text rather than a textarea — the tile above, and the intro window's stage
 * (intro/DrawScene.tsx), which types into it. No text shows the placeholder,
 * faded, as the empty textarea does.
 */
export function NoteFace({ width, height, text = '', typing, language }: {
  width: number;
  height: number;
  text?: string;
  /** Drawn after the text while it is being typed (the intro's caret); the
   *  placeholder then stays away, as it does in a focused textarea. */
  typing?: ReactNode;
  language: Language;
}) {
  return (
    <div className="note-node" style={{ background: NOTE_BODY_COLOR, width, height }}>
      <div
        className="note-node__header"
        style={{ background: NOTE_HEADER_COLOR, color: getContrastColor(NOTE_HEADER_COLOR), fontSize: '12px' }}
      >
        {t('Note', language)}
      </div>
      <div
        className="note-node__body"
        style={{ color: getContrastColor(NOTE_BODY_COLOR), fontSize: '11px', ...(text ? null : { opacity: 0.5 }) }}
      >
        {text || (typing ? '' : t('Note…', language))}
        {typing}
      </div>
    </div>
  );
}
