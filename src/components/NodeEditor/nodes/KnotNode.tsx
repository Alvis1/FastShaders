import { Position, type NodeProps } from '@xyflow/react';
import type { KnotFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getTypeColor } from '@/utils/colorUtils';
import { t } from '@/i18n';
import { TypedHandle } from '../handles/TypedHandle';
import { passThroughTypeOf } from './passThroughLook';
import { KNOT_SIZE } from './passThroughGeometry';
import './PassThroughNode.css';

/**
 * The BRANCH (flow type `knot`, utils/passThrough.ts): one wire in, any number
 * out, computing nothing — the engines read straight through it.
 *
 * A small SQUARE in the type colour of the value it carries, with the two
 * ordinary sockets on its left and right edges. Square on purpose: a routing
 * point on a wire is a ROUND contrast-coloured dot (TypedEdge), and the two
 * looking alike is what made a tester expect to drag wires out of routing
 * points (owner, 2026-11-23). No cost chrome and never cost-scaled: it costs
 * nothing. Its colour is a store selector returning a PRIMITIVE (one resolver
 * walk per graph version for every pass-through, passThroughLook.ts).
 */
export function KnotNode({ id, selected }: NodeProps<KnotFlowNode>) {
  const type = useAppStore((s) => passThroughTypeOf(s.nodes, s.edges, id));
  const language = useAppStore((s) => s.language);
  const dataType = type ?? 'any';
  return (
    <div
      className={`knot-node${selected ? ' knot-node--selected' : ''}${type === null ? ' knot-node--unfed' : ''}`}
      style={{ width: KNOT_SIZE, height: KNOT_SIZE, background: getTypeColor(dataType) }}
      aria-label={t('Branch', language)}
    >
      <TypedHandle type="target" position={Position.Left} id="in" dataType={dataType} label="Value" />
      <TypedHandle type="source" position={Position.Right} id="out" dataType={dataType} label="Value" />
    </div>
  );
}
