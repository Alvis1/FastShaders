import { memo, useCallback, useMemo } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { fillTemplate } from '@/utils/fillTemplate';
import { t } from '@/i18n';
import { TUNNEL_IN_TYPE, TUNNEL_OUT_TYPE } from '@/utils/passThrough';
import {
  PORTAL_LINK_DRAG_TYPE,
  setHtml5TileDrag,
  startTileDrag,
  tileActivationProps,
  tileGhostZoom,
  type TilePayload,
} from './tileDrag';
import { useAssetTooltip } from './AssetTooltip';
import { TunnelFace } from './nodes/TunnelNode';
import { passThroughTypeOf } from './nodes/passThroughLook';
import { TUNNEL_LAYOUT_W } from './nodes/passThroughGeometry';
import { PORTAL_IN_TOOLTIP, PORTAL_OUT_TOOLTIP } from './portalSearch';

/**
 * One portal tile of the asset bar: the Portal In ("a new portal"), or a
 * Portal Out of the live portal `entranceId`. Drawn with the canvas card's
 * own face (`TunnelFace`) inside a wrapper wide enough for the name label, so
 * the tile is the card, never a restyled copy. Every way of adding a tile
 * (HTML5 drag, touch drag, click, Enter) reaches `placeTilePayload`, which
 * adds through the Add-node menu's own portal actions (portalActions.ts) —
 * one undo entry, `node-add` with the type `tunnelIn` / `tunnelOut`.
 */
export const PortalTileCard = memo(function PortalTileCard({
  entranceId,
  name,
}: {
  /** The portal an exit tile belongs to; null for the Portal In tile. */
  entranceId: string | null;
  name: string;
}) {
  const language = useAppStore((s) => s.language);
  // The portal's resolved type, for the rim (a primitive per notify).
  const type = useAppStore((s) => (entranceId === null ? null : passThroughTypeOf(s.nodes, s.edges, entranceId)));
  const payload = useMemo<TilePayload>(
    () => (entranceId === null
      ? { kind: 'node', nodeType: TUNNEL_IN_TYPE }
      : { kind: 'node', nodeType: TUNNEL_OUT_TYPE, link: entranceId }),
    [entranceId],
  );
  const label = entranceId === null
    ? t('Portal In', language)
    : fillTemplate(t('Portal Out: {name}', language), { name: name || '…' });
  const { tooltip, tooltipHandlers } = useAssetTooltip(
    `${label}. ${t(entranceId === null ? PORTAL_IN_TOOLTIP : PORTAL_OUT_TOOLTIP, language)}`,
  );

  const onDragStart = useCallback((event: React.DragEvent) => {
    if (payload.kind !== 'node') return;
    event.dataTransfer.setData('application/reactflow-type', payload.nodeType);
    if (payload.link) event.dataTransfer.setData(PORTAL_LINK_DRAG_TYPE, payload.link);
    event.dataTransfer.effectAllowed = 'move';
    setHtml5TileDrag(payload);
  }, [payload]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const tile = event.currentTarget as HTMLElement;
    startTileDrag(
      event.nativeEvent,
      payload,
      `<div class="node-preview-card" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
    );
  }, [payload]);

  return (
    <div
      className="node-preview-card"
      draggable
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      {...tileActivationProps(payload, label)}
      {...tooltipHandlers}
    >
      {tooltip}
      {/* A wrapper the width the layout reserves for a portal end, so the
          name above the hole and the exit count beside it stay on the tile.
          A Portal Out's face shows only its portal's NAME, so its tile says
          what it is in a caption under the hole (outside the card: the tile
          scales the card, never restyles it). The Portal In's face already
          reads "Portal In". */}
      <div style={TILE_FACE_STYLE}>
        <TunnelFace
          kind={entranceId === null ? 'in' : 'out'}
          selected={false}
          type={type}
          dangling={false}
          name={entranceId === null ? '' : name}
          exits={null}
          language={language}
        />
        {entranceId !== null && (
          <span className="portal-tile__kind">{t('Portal Out', language)}</span>
        )}
      </div>
    </div>
  );
});

const TILE_FACE_STYLE = {
  width: TUNNEL_LAYOUT_W,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  pointerEvents: 'none',
} as const;
