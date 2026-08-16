import { memo, useEffect, useRef, useCallback, useMemo, type CSSProperties } from 'react';
import { Position, useStore, type NodeProps } from '@xyflow/react';
import { makeConnectionRevealSelector } from './connectionReveal';
import type { MathPreviewFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { WaveformSvg, applyWaveFrame, type WaveformDynamicRefs } from './WaveformSvg';
import { appTime } from '@/utils/appClock';
import { evaluateEdgeSource, getTargetEdges, getTimeUpstreamSet } from '@/engine/cpuEvaluator';
import './MathPreviewNode.css';

/** Map registryType to its math function. */
const MATH_FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
};

export const MathPreviewNode = memo(function MathPreviewNode({
  id,
  data,
  selected,
}: NodeProps<MathPreviewFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  // Rules-of-Hooks note: this return sits ABOVE the hooks below. Safe because
  // `def` cannot flip defined<->undefined on a MOUNTED instance: React Flow keys
  // node components by node.id, every registryType the app writes is in
  // NODE_REGISTRY (`unknown` included), and nothing mutates registryType in place
  // to or from an unregistered value. A tampered .fastshader with an unknown
  // registryType renders null for the whole life of that node. Moving the return
  // below the hooks is NOT a mechanical edit here (ShaderNode/PreviewNode hooks
  // dereference `def`) — see CLEAN-3.
  if (!def) return null;

  const curveRef = useRef<SVGPathElement>(null);
  const dropRef = useRef<SVGLineElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const pillRef = useRef<SVGRectElement>(null);
  const textRef = useRef<SVGTextElement>(null);
  const dynamicRefs = useMemo<WaveformDynamicRefs>(
    () => ({ curve: curveRef, drop: dropRef, dot: dotRef, pill: pillRef, text: textRef }),
    [],
  );
  const lastLabelRef = useRef<string | null>(null);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);

  // A wire hunting nearby forces the input socket's name-tooltip visible
  // (floated left of the dot) — same rule as every node with input sockets.
  const near = useStore(
    useMemo(() => makeConnectionRevealSelector(id, true), [id]),
  );

  const func = MATH_FUNCTIONS[data.registryType] ?? Math.sin;
  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);

  // ── Upstream-derived render inputs, without a whole-array subscription ──
  // Subscribing to s.nodes/s.edges re-rendered every sin/cos card on every
  // store notify (a drag pointermove mints new array identities, so the memo()
  // above is bypassed), each render paying an O(E) edges.find plus a full
  // graph walk for the time check. Same idiom as PreviewNode's
  // inputsKey (PreviewNode.tsx:117-126) and ShaderNode's edgeKey
  // (ShaderNode.tsx:291-300): fold everything the waveform depends on into ONE
  // primitive string, so a position-only notify produces an identical string
  // and Object.is bails before any re-render.
  //
  // The key needs exactly two facts, each protecting a different thing:
  //   * the X feeder's node id — decides hasConnection (socket vs the inline
  //     number widget) AND is the rAF loop's evaluation target;
  //   * whether Time is upstream of it — picks the animated branch.
  // The upstream VALUE is deliberately NOT folded in: the static branch
  // renders phase 0 with no readout for a connected input and therefore never
  // reads it, and the animated branch re-reads the graph every frame. If the
  // static branch is ever changed to show the arriving value, this key MUST
  // grow an `evaluateNodeScalar(source, ..., 0)` component.
  //
  // BOTH lookups run on the UNWRAPPED view, and that pairing is load-bearing.
  // getTargetEdges reports the real producer inside a collapsed frame (a raw
  // scan reports the GROUP id, which has no registry def — the waveform froze
  // at phase 0 whenever its Time feeder was collapsed). The time check walks
  // the graph ITSELF, so pairing it with the RAW edges would drop every wire
  // crossing the frame's boundary: Time → Multiply(inside a collapsed group)
  // → sin reads as time-less and goes static. Both calls go through the shared
  // ctx, which unwraps by construction — that is why getTimeUpstreamSet is
  // used here and not `hasTimeUpstream`, which takes the edge array as an
  // argument and so leaves the trap open at every call site.
  // The flag is a single leading char so the key needs no separator (a raw NUL
  // would make grep treat this file as binary — see MicNode/OutputNode).
  const xKey = useAppStore((s) => {
    const e = getTargetEdges(s.nodes, s.edges, id).find((x) => x.targetHandle === 'x');
    if (!e) return '';
    const timeFed = getTimeUpstreamSet(s.nodes, s.edges).has(e.source);
    // The SOCKET rides the key too — re-wiring from one output of a source to
    // another leaves source/target/targetHandle identical, so a source-only
    // key would keep the waveform on the old channel.
    return `${timeFed ? '1' : '0'}${e.source}|${e.sourceHandle ?? ''}`;
  });
  const hasConnection = xKey !== '';
  const [xSource, xHandle] = hasConnection
    ? (() => { const r = xKey.slice(1); const i = r.lastIndexOf('|'); return [r.slice(0, i), r.slice(i + 1) || null]; })()
    : [null, null];
  const hasTime = xKey.charCodeAt(0) === 49; // '1' — ''.charCodeAt(0) is NaN

  const inputX = Number(data.values?.x ?? 0);

  // Animated branch: the WaveformSvg's initial render is declarative (it also
  // fully covers the static branches), and this loop only OVERWRITES the
  // dynamic attributes via applyWaveFrame — two transform writes + a label
  // update per frame, instead of the old full 72×72 canvas repaint.
  useEffect(() => {
    if (!hasTime) return;
    let rafId: number;

    const draw = (timestamp: number) => {
      // Shared app clock — every animated surface (this card, the noise
      // previews, the edge info chip) evaluates the same t per frame, so
      // their displayed values agree; per-loop epochs made a sin card show
      // sin(48.3) while the freshly-hovered edge chip showed sin(0.15).
      const t = appTime(timestamp);

      // Evaluate the actual input flowing into this node's X port by walking
      // the upstream graph with the current time. The graph is read FRESH
      // from the store each frame (PreviewNode does the same): this component
      // no longer subscribes to nodes/edges, so a mirror ref would never be
      // refreshed and the waveform WOULD freeze on upstream edits.
      const { nodes, edges } = useAppStore.getState();
      const evaluated = xSource
        ? evaluateEdgeSource({ source: xSource, sourceHandle: xHandle }, nodes, edges, t)?.[0] ?? null
        : null;
      applyWaveFrame(dynamicRefs, func, data.registryType, evaluated ?? t, lastLabelRef);
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [data.registryType, hasTime, func, xSource, xHandle, dynamicRefs]);

  // Static branches: snap the dynamic attributes to the declared state. A
  // previous animated life leaves imperative writes React's vdom diff cannot
  // see (its old and new vdom agree, so it never re-patches the attributes
  // the rAF loop moved) — without this, unwiring Time froze the curve at the
  // last animated phase instead of returning to phase 0.
  useEffect(() => {
    if (hasTime) return;
    applyWaveFrame(dynamicRefs, func, data.registryType, hasConnection ? 0 : inputX, lastLabelRef);
  }, [hasTime, hasConnection, inputX, func, data.registryType, dynamicRefs]);

  const handleXChange = useCallback(
    (v: number) => {
      updateNodeData(id, {
        values: { ...data.values, x: v },
      } as Partial<MathPreviewFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  return (
    <div
      className={`node-base math-preview-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: `1.5px solid ${catHex}`, transform: `scale(${costScale})`, transformOrigin: 'top left', '--node-cat': catHex } as CSSProperties}
    >
      {/* Cost badge above node */}
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      {/* Header */}
      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" title={varName ?? data.label} style={{ color: headerTextColor }}>{varName ?? data.label}</span>
      </div>

      {/* Waveform plot (SVG — crisp under viewport zoom, unlike the old
          fixed-72px canvas bitmap; also one fewer canvas inside the React
          Flow viewport, which is the surface WebKit's compositing bug bites).
          Declarative render covers the static branches; the rAF effect above
          overwrites via dynamicRefs when Time is upstream. */}
      <div className="math-preview-node__canvas-wrap">
        <WaveformSvg
          func={func}
          funcLabel={data.registryType}
          phase={hasConnection ? 0 : inputX}
          showReadout={hasTime || !hasConnection}
          dynamicRefs={dynamicRefs}
        />
      </div>

      {/* Input port row at bottom */}
      <div className="math-preview-node__port-row">
        <div className="math-preview-node__left">
          {def.inputs[0] && (
            <TypedHandle
              type="target"
              position={Position.Left}
              id={def.inputs[0].id}
              dataType={def.inputs[0].dataType}
              label={def.inputs[0].label}
              reveal={near}
            />
          )}
          {!hasConnection && (
            <DragNumberInput
              compact
              value={inputX}
              onChange={handleXChange}
            />
          )}
        </div>
      </div>

      {/* Output handle — vertically centered on node */}
      {def.outputs[0] && (
        <TypedHandle
          type="source"
          position={Position.Right}
          id={def.outputs[0].id}
          dataType={def.outputs[0].dataType}
          label={def.outputs[0].label}
          style={{ top: '50%' }}
        />
      )}
    </div>
  );
});
