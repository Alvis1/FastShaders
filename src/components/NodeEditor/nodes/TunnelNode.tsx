import { useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TSLDataType, TunnelInFlowNode, TunnelOutFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getTypeColor } from '@/utils/colorUtils';
import { t, type Language } from '@/i18n';
import { TUNNEL_OUT_TYPE, tunnelLabelOf, tunnelLinkOf } from '@/utils/passThrough';
import { exitCountText, liveEntranceLabel, passThroughTypeOf, tunnelExitCount } from './passThroughLook';
import { TUNNEL_SIZE } from './passThroughGeometry';
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
 * interior that draws nothing, so a wire visibly ends at the rim and slips
 * UNDER it (wires draw under every node). Pressing the interior WIRES; the
 * rim band and the name label MOVE the node (the cursor says which).
 *
 * The name sits above the hole as TEXT (data is adversarial: read through
 * `tunnelLabelOf`, never coerced); an exit shows its entrance's CURRENT name,
 * read live, and falls back to its own cache only when the entrance is gone.
 * No cost chrome, never cost-scaled, never muted: it computes nothing.
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

function TunnelHole({ kind, selected, type, dangling, name, exits, language }: HoleProps) {
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
        <Handle
          type={kind === 'in' ? 'target' : 'source'}
          position={kind === 'in' ? Position.Left : Position.Right}
          id={kind}
          className="tunnel-node__handle"
          isConnectableStart
        />
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

/** The Portal In: one wire in, no output socket. Its `label` is the portal's NAME. */
export function TunnelInNode({ id, data, selected }: NodeProps<TunnelInFlowNode>) {
  const type = useAppStore((s) => passThroughTypeOf(s.nodes, s.edges, id));
  const exits = useAppStore((s) => tunnelExitCount(s.nodes, id));
  const language = useAppStore((s) => s.language);
  const name = useMemo(() => tunnelLabelOf({ data }), [data]);
  return (
    <TunnelHole
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
