import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TSLDataType, TunnelInFlowNode, TunnelOutFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getTypeColor } from '@/utils/colorUtils';
import { t, type Language } from '@/i18n';
import { TUNNEL_OUT_TYPE, tunnelLabelOf, tunnelLinkOf } from '@/utils/passThrough';
import { exitCountText, liveEntranceLabel, passThroughTypeOf, tunnelExitCount } from './passThroughLook';
import { TUNNEL_SIZE } from './passThroughGeometry';
import { setDiveHost } from '../edges/portalDive';
import './PassThroughNode.css';

/**
 * The two PORTAL ends (flow types `tunnelIn` / `tunnelOut`, utils/passThrough.ts):
 * a wire goes INTO the canvas through one hole and comes out of the others.
 *
 * Drawn as a ROUND manhole — the owner's explicit exception to the
 * square-corner house rule (2026-11-23): a rim ring in the type colour of the
 * value it carries, an interior one step darker than the canvas (the canvas
 * colour under the `--tunnel-well` tint, both themes), and a HARD inset shadow
 * so the top-left inner wall reads in shade — a node rises on a hard outer
 * shadow, a hole sinks on a hard inner one.
 *
 * The socket is the hole's CENTRE: a React Flow Handle the size of the
 * interior that draws nothing. A wire DIVES into the hole (owner, 2026-11-24):
 * TypedEdge draws it on over the rim and down into the interior, inside this
 * card (its dive host, below). Pressing the interior WIRES; the rim band and
 * the name label MOVE the node (the cursor says which).
 *
 * The name sits above the hole as TEXT (data is adversarial: read through
 * `tunnelLabelOf`, never coerced); an exit shows its entrance's CURRENT name,
 * read live, and falls back to its own cache only when the entrance is gone.
 * It is edited in the end's right-click menu (menus/PortalMenu.tsx), never on
 * the card. No cost chrome, never cost-scaled, never muted: it computes
 * nothing. A selected end casts no shadow: it grows a little and wears a
 * selection ring (owner, 2026-11-24).
 */

interface HoleProps {
  kind: 'in' | 'out';
  selected: boolean;
  /** The resolved type, or null when nothing reaches the hole. */
  type: TSLDataType | null;
  /** The exit whose entrance is gone. */
  dangling: boolean;
  name: string;
  /** The entrance's exit count, or null on an exit. */
  exits: number | null;
  language: Language;
}

function holeTitle(kind: 'in' | 'out', type: TSLDataType | null, dangling: boolean, language: Language): string {
  const name = t(kind === 'in' ? 'Portal In' : 'Portal Out', language);
  if (dangling) return `${name}: ${t('its Portal In is gone', language)}`;
  if (type === null) return `${name}: ${t('nothing goes in', language)}`;
  return name;
}

/**
 * A Portal end as drawn, with whatever sits in the hole as `children` (the
 * canvas card's socket). The canvas card and the palette's portal tiles
 * (PortalTileCard.tsx) both draw THIS, so a tile is the card at the tile's
 * scale, never a restyled copy.
 */
export function TunnelFace({ kind, selected, type, dangling, name, exits, language, children }: HoleProps & { children?: ReactNode }) {
  const canvas = useAppStore((s) => s.nodeEditorBgColor);
  const rim = dangling ? 'var(--cat-unknown)' : getTypeColor(type ?? 'any');
  const count = exits === null ? '' : exitCountText(exits);
  const cls = ['tunnel-node', `tunnel-node--${kind}`];
  if (selected) cls.push('tunnel-node--selected');
  if (type === null) cls.push('tunnel-node--unfed');
  if (dangling) cls.push('tunnel-node--dangling');
  return (
    <div className={cls.join(' ')} style={{ width: TUNNEL_SIZE, height: TUNNEL_SIZE }}>
      <div
        className="tunnel-node__hole"
        style={{ borderColor: rim, backgroundColor: canvas }}
        title={holeTitle(kind, type, dangling, language)}
      >
        {dangling && <span className="tunnel-node__unknown" aria-hidden="true">?</span>}
        {children}
      </div>
      <span
        className="tunnel-node__label"
        {...(name ? { title: name } : {})}
      >
        {name || t(kind === 'in' ? 'Portal In' : 'Portal Out', language)}
      </span>
      {count && (
        <span
          className={`tunnel-node__count${exits === 0 ? ' tunnel-node__count--none' : ''}`}
          title={t('Number of Portal Outs', language)}
        >
          {count}
        </span>
      )}
    </div>
  );
}

/**
 * The canvas card: the face with its dot-less socket in the hole, and the
 * hole's DIVE HOST — the element a wire's stretch over the hole is drawn into
 * (TypedEdge's `PortalDive`, registered through edges/portalDive.ts), last in
 * the hole so it paints over the socket and the "?", inside this card's own
 * layer: under any card that covers this one, scaled with the hole.
 */
function TunnelHole({ id, ...props }: HoleProps & { id: string }) {
  const { kind } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const setHost = useCallback((el: HTMLDivElement | null) => {
    const prev = hostRef.current;
    hostRef.current = el;
    setDiveHost(id, el, prev);
  }, [id]);
  return (
    <TunnelFace {...props}>
      <Handle
        type={kind === 'in' ? 'target' : 'source'}
        position={kind === 'in' ? Position.Left : Position.Right}
        id={kind}
        className="tunnel-node__handle"
        isConnectableStart
      />
      <div ref={setHost} className="tunnel-node__dive" aria-hidden="true" />
    </TunnelFace>
  );
}

/** The Portal In: one wire in, no output socket. Its `label` is the portal's NAME. */
export function TunnelInNode({ id, data, selected }: NodeProps<TunnelInFlowNode>) {
  const type = useAppStore((s) => passThroughTypeOf(s.nodes, s.edges, id));
  const exits = useAppStore((s) => tunnelExitCount(s.nodes, id));
  const language = useAppStore((s) => s.language);
  const name = useMemo(() => tunnelLabelOf({ data }), [data]);
  return (
    <TunnelHole
      id={id}
      kind="in"
      selected={!!selected}
      type={type}
      dangling={false}
      name={name}
      exits={exits}
      language={language}
    />
  );
}

/** A Portal Out: no input socket, any number of wires out, linked by `data.link`. */
export function TunnelOutNode({ id, data, selected }: NodeProps<TunnelOutFlowNode>) {
  const link = useMemo(() => tunnelLinkOf({ type: TUNNEL_OUT_TYPE, data }), [data]);
  const cache = useMemo(() => tunnelLabelOf({ data }), [data]);
  const type = useAppStore((s) => passThroughTypeOf(s.nodes, s.edges, id));
  const live = useAppStore((s) => liveEntranceLabel(s.nodes, link));
  const language = useAppStore((s) => s.language);
  return (
    <TunnelHole
      id={id}
      kind="out"
      selected={!!selected}
      type={type}
      dangling={live === null}
      name={live ?? cache}
      exits={null}
      language={language}
    />
  );
}
