import { memo, useEffect, useMemo, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import { MicNodeButton } from './MicNodeButton';
import { MIC_DEFAULT_VALUES } from '@/utils/micNode';
import './MicNode.css';

/**
 * The Mic node — its own React Flow component rather than a ShaderNode.
 *
 * WHY: ShaderNode derives socket positions from in-flow ROWS, so the layout is
 * whatever the row helper produces — which is why this node kept fighting it
 * (settings paired with outputs by index, and filtering inputs to the exposed
 * ones re-flowed the whole card). Every node that looks deliberate — Time, the
 * noise family — is a component like this one: header plus fixed content, with
 * every handle ABSOLUTELY POSITIONED at a chosen offset. Nothing a socket does
 * can then move anything else.
 *
 * Positions below are px from the top of the BODY (not the card), so the header
 * can grow — a long name wraps in some languages — without dragging the sockets
 * with it.
 */

/** Body height. Everything below is placed inside it. */
const BODY_H = 172;
/** The two parameter rows: socket on the left edge, value chip beside it. */
const PARAM_TOPS = [26, 54];
/** The four outputs, spread down the right edge beside the arm light. */
const OUT_TOPS = [86, 108, 130, 152];

export const MicNode = memo(function MicNode({ id, data, selected }: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  if (!def) return null;

  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);

  // Opt-in parameter sockets, same rules as the noise nodes' pos/scale: hidden
  // until ticked in Node Settings, revealed dimmed while a wire is dragged
  // nearby, permanent once a connection lands.
  const updateNodeInternals = useUpdateNodeInternals();
  const revealHidden = useStore(useMemo(() => makeConnectionRevealSelector(id, true), [id]));
  const exposed = useMemo(() => new Set(data.exposedPorts ?? []), [data.exposedPorts]);

  // Which params currently carry an edge — a wired value overrides the stored
  // number (the codegen rule), so the chip must not keep offering to edit it.
  const wired = useStore(
    useMemo(
      () => (s: { edges: { target: string; targetHandle?: string | null }[] }) => {
        const hit: string[] = [];
        for (const e of s.edges) {
          if (e.target === id && e.targetHandle) hit.push(e.targetHandle);
        }
        return hit.sort().join('|');
      },
      [id],
    ),
  );
  const wiredSet = useMemo(() => new Set(wired.split('|').filter(Boolean)), [wired]);

  // React Flow only knows a handle's bounds after a re-measure, so a socket
  // that mounts on exposure needs this or edges into it never render.
  const mountedKey = [...exposed].sort().join(',') + (revealHidden ? '|R' : '');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, mountedKey, updateNodeInternals]);

  return (
    <div
      className={`node-base mic-node ${selected ? 'node-base--selected' : ''}`}
      style={
        {
          background: 'var(--node-bg)',
          border: `1.5px solid ${catHex}`,
          transform: `scale(${costScale})`,
          transformOrigin: 'top left',
          '--node-cat': catHex,
        } as CSSProperties
      }
    >
      {data.cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>
          {varName ?? data.label}
        </span>
      </div>

      <div className="mic-node__body" style={{ height: BODY_H }}>
        {def.inputs.map((inp, i) => {
          const show = exposed.has(inp.id) || revealHidden;
          const isWired = wiredSet.has(inp.id);
          const top = PARAM_TOPS[i] ?? PARAM_TOPS[PARAM_TOPS.length - 1];
          return (
            <div key={inp.id}>
              {show && (
                <TypedHandle
                  type="target"
                  position={Position.Left}
                  id={inp.id}
                  dataType={inp.dataType}
                  label={inp.label}
                  reveal={revealHidden}
                  style={{
                    top,
                    ...(exposed.has(inp.id) ? null : { opacity: REVEAL_TEMP_OPACITY }),
                  }}
                />
              )}
              <div className="mic-node__val" style={{ top }}>
                {isWired ? (
                  <span className="mic-node__wired">wired</span>
                ) : (
                  <DragNumberInput
                    compact
                    value={Number(data.values?.[inp.id] ?? MIC_DEFAULT_VALUES[inp.id] ?? 0)}
                    onChange={(v) => updateNodeData(id, { values: { ...data.values, [inp.id]: String(v) } })}
                  />
                )}
              </div>
            </div>
          );
        })}

        <MicNodeButton nodeId={id} values={data.values} />

        {def.outputs.map((out, i) => (
          <TypedHandle
            key={out.id}
            type="source"
            position={Position.Right}
            id={out.id}
            dataType={out.dataType}
            label={out.label}
            style={{ top: OUT_TOPS[i] ?? OUT_TOPS[OUT_TOPS.length - 1] }}
          />
        ))}
      </div>
    </div>
  );
});
