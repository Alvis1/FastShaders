import { memo, useEffect, useRef, useCallback, useMemo, type CSSProperties } from 'react';
import { Position, useStore, type NodeProps } from '@xyflow/react';
import { makeConnectionRevealSelector } from './connectionReveal';
import type { MathPreviewFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { valueNum } from '@/utils/valueCoerce';
import { useAppStore } from '@/store/useAppStore';
import { CAT_HEX } from '@/utils/colorUtils';
import { Points } from '@/components/Points/Points';
import { useCostChrome, useLiveNodeCost, useRemeasureOnScale } from './useCostChrome';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { WaveformSvg, applyWaveFrame, type WaveformDynamicRefs } from './WaveformSvg';
import { useFrameLoop } from '@/hooks/useFrameLoop';
import { evaluateEdgeSource, getFieldUpstreamSet, getTargetEdges, getTimeUpstreamSet } from '@/engine/cpuEvaluator';
import './MathPreviewNode.css';
import { NODE_BORDER_WIDTH } from './nodeFrame';
import { NodeTitle } from './NodeTitle';
import { useHeaderTip } from './headerTip';

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
  // Early return above the hooks is safe: React Flow keys node components by id
  // and registryType never changes on a mounted node.
  if (!def) return null;
  const headerTip = useHeaderTip(def);

  // The element whose visibility gates the animated tick (the plot's wrapper,
  // which lives as long as the card).
  const plotRef = useRef<HTMLDivElement>(null);
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

  // A wire hunting nearby forces the input socket's name-tooltip visible
  // (floated left of the dot) — same rule as every node with input sockets.
  const near = useStore(
    useMemo(() => makeConnectionRevealSelector(id, true), [id]),
  );

  const func = MATH_FUNCTIONS[data.registryType] ?? Math.sin;
  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  // Priced LIVE under the selected device's table, never the creation-time
  // `data.cost` snapshot (useLiveNodeCost says why).
  const cost = useLiveNodeCost(id, data);
  const { costColor, headerTextColor, costTextColor, costScale, points } = useCostChrome(cost);
  useRemeasureOnScale(id, costScale);

  // ── Upstream-derived render inputs, without a whole-array subscription ──
  // Subscribing to s.nodes/s.edges re-rendered every sin/cos card on every
  // store notify (a drag pointermove mints new array identities, so the memo()
  // above is bypassed), each render paying an O(E) edges.find plus a full
  // graph walk for the time check. Same idiom as PreviewNode's `inputsKey` and
  // ShaderNode's `edgeKey`: fold everything the waveform depends on into ONE
  // primitive string, so a position-only notify produces an identical string
  // and Object.is bails before any re-render.
  //
  // The key needs exactly three facts, each protecting a different thing:
  //   * the X feeder's node id — decides hasConnection (socket vs the inline
  //     number widget) AND is the animated tick's evaluation target;
  //   * whether Time is upstream of it — picks the animated branch;
  //   * whether a sampled FIELD is upstream of it — X then has no single
  //     value, so the card shows NO dot and no readout (the point the CPU
  //     evaluator would hand back is one arbitrary centre sample, and printing
  //     it as "the" value is the lie edgeValueLabel's field rule exists to
  //     stop). A time-fed field still scrolls the curve, as decoration.
  // The upstream VALUE is deliberately NOT folded in: the static branch
  // renders phase 0 with no readout for a connected input and therefore never
  // reads it, and the animated branch re-reads the graph every frame. If the
  // static branch is ever changed to show the arriving value, this key MUST
  // grow a component carrying that value.
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
  // The field check rides the same shared ctx, so it unwraps the same way.
  // The flags are two fixed leading chars (time, field) so the key needs no
  // separator (a raw NUL would make grep treat this file as binary — see
  // SoundNode/OutputNode).
  const xKey = useAppStore((s) => {
    const e = getTargetEdges(s.nodes, s.edges, id).find((x) => x.targetHandle === 'x');
    if (!e) return '';
    const timeFed = getTimeUpstreamSet(s.nodes, s.edges).has(e.source);
    const fieldFed = getFieldUpstreamSet(s.nodes, s.edges).has(e.source);
    // The SOCKET rides the key too — re-wiring from one output of a source to
    // another leaves source/target/targetHandle identical, so a source-only
    // key would keep the waveform on the old channel.
    return `${timeFed ? '1' : '0'}${fieldFed ? '1' : '0'}${e.source}|${e.sourceHandle ?? ''}`;
  });
  const hasConnection = xKey !== '';
  const [xSource, xHandle] = hasConnection
    ? (() => { const r = xKey.slice(2); const i = r.lastIndexOf('|'); return [r.slice(0, i), r.slice(i + 1) || null]; })()
    : [null, null];
  const hasTime = xKey.charCodeAt(0) === 49; // '1' — ''.charCodeAt(0) is NaN
  const hasField = xKey.charCodeAt(1) === 49;
  // A dot and a number only for a value that IS one number: an unwired X (its
  // own box), or a time-fed chain the CPU evaluates point-wise. A connected
  // static X shows the bare curve, as before; a field never gets a readout.
  const showReadout = !hasField && (hasTime || !hasConnection);

  const inputX = valueNum(data.values?.x ?? 0);

  // Animated branch: the WaveformSvg's initial render is declarative (it also
  // fully covers the static branches), and the shared frame ticker
  // (utils/frameTicker, 15 Hz, skipped while the card is off-screen or
  // collapsed away) only OVERWRITES the dynamic attributes via applyWaveFrame —
  // and only the ones whose value moved.
  useFrameLoop(
    hasTime,
    plotRef,
    () => {
      // A (re)start can follow a readout REMOUNT (showReadout flipping with
      // the field flag), whose fresh text element holds the declarative
      // label: forget what the last loop wrote so the first tick rewrites it.
      lastLabelRef.current = null;
      return (t) => {
        // `t` is the shared app clock — every animated surface (this card, the
        // noise previews, the edge info chip) evaluates the same t per tick, so
        // their displayed values agree; per-loop epochs made a sin card show
        // sin(48.3) while the freshly-hovered edge chip showed sin(0.15).
        //
        // Evaluate the actual input flowing into this node's X port by walking
        // the upstream graph with the current time. The graph is read FRESH
        // from the store each tick (PreviewNode does the same): this component
        // no longer subscribes to nodes/edges, so a mirror ref would never be
        // refreshed and the waveform WOULD freeze on upstream edits. A FIELD is
        // never evaluated point-wise (one centre sample is not its value).
        const { nodes, edges } = useAppStore.getState();
        const evaluated = xSource && !hasField
          ? evaluateEdgeSource({ source: xSource, sourceHandle: xHandle }, nodes, edges, t)?.[0] ?? null
          : null;
        const x = evaluated !== null && Number.isFinite(evaluated) ? evaluated : null;
        // The curve follows X when X is known, else scrolls by the clock as
        // decoration; the dot and readout follow X ALONE — `t` is never
        // printed as the value of a wire that is not t ("…" instead).
        applyWaveFrame(dynamicRefs, func, data.registryType, x ?? t, lastLabelRef, x);
      };
    },
    [data.registryType, func, xSource, xHandle, hasField, dynamicRefs],
  );

  // Static branches: snap the dynamic attributes to the declared state. A
  // previous animated life leaves imperative writes React's vdom diff cannot
  // see (its old and new vdom agree, so it never re-patches the attributes
  // the animated tick moved) — without this, unwiring Time froze the curve at the
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
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid ${catHex}`, transform: `scale(${costScale})`, transformOrigin: 'top left' } as CSSProperties}
    >
      {/* Cost badge above node */}
      {cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}><Points value={points} /></span>}

      {/* Header */}
      <div className="node-base__header" style={{ background: costColor }} {...headerTip}>
        <NodeTitle text={varName ?? data.label} style={{ color: headerTextColor }} bare={headerTip !== null} />
      </div>

      {/* Waveform plot (SVG — crisp under viewport zoom, unlike the old
          fixed-72px canvas bitmap; also one fewer canvas inside the React
          Flow viewport, which is the surface WebKit's compositing bug bites).
          Declarative render covers the static branches; the frame loop above
          overwrites via dynamicRefs when Time is upstream. */}
      <div className="math-preview-node__canvas-wrap" ref={plotRef}>
        <WaveformSvg
          func={func}
          funcLabel={data.registryType}
          phase={hasConnection ? 0 : inputX}
          showReadout={showReadout}
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
