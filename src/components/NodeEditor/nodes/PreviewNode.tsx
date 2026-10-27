import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import type { PreviewFlowNode, NodeCategory, AppNode, AppEdge, TSLDataType } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { CAT_HEX } from '@/utils/colorUtils';
import { Points } from '@/components/Points/Points';
import { useCostChrome, useLiveNodeCost, useRemeasureOnScale } from './useCostChrome';
import { useFrameLoop } from '@/hooks/useFrameLoop';
import { evaluateEdgeSource, getTargetEdges, getTimeUpstreamSet } from '@/engine/cpuEvaluator';
import { TypedHandle } from '../handles/TypedHandle';
import { renderNoisePreview, type NoiseType, type TimeInputs } from '@/utils/noisePreview';
import './PreviewNode.css';
import { hasNoiseRangeFlag, isUnsignedNoise } from '@/utils/noiseRange';
import { NODE_BORDER_WIDTH } from './nodeFrame';
import { NodeTitle } from './NodeTitle';
import { useHeaderTip } from './headerTip';

const PREVIEW_SIZE = 96;
/*
 * FRAME RATE of the ANIMATED thumbnail: the shared ticker's 15 Hz
 * (utils/frameTicker), on the same frames as every other animated surface.
 *
 * Every redraw is a full PREVIEW_SIZE² CPU noise field plus a `resolveValues`
 * walk of the upstream graph. MEASURED per call at 96 px on an M-series Mac:
 * cellNoise 0.08 ms, perlin 0.12–0.19, voronoi 0.30–0.35, fBm 0.29–0.40 (taken
 * while every call also minted a fresh 36 KB ImageData; the tick now hands
 * `noiseBufRef` back to renderNoisePreview, which reuses one buffer per card).
 * Four animated fBm/Voronoi cards — an ordinary state once a Time node feeds
 * a noise-driven shader — ate ~1.6 ms of every 16.7 ms frame at 60 Hz.
 *
 * This card ran its own 30 Hz budget until 2026-10-11, judged the floor below
 * which a translating pattern reads as stepping. The owner traded that for
 * the shared 15 Hz: the noise field is a small part of the cost — any frame
 * that writes to the canvas pays Chrome's whole-canvas layerization pass —
 * and only every surface writing on the same few frames buys it back.
 *
 * The TIME the field is sampled at is still the shared appClock, so the card
 * agrees with every other animated surface on the frames it draws.
 */
/** Registry types this preview node can render — all MaterialX noise variants. */
const NOISE_TYPES = new Set<string>([
  'perlin', 'perlinVec3',
  'fbm', 'fbmVec3',
  'cellNoise',
  'voronoi', 'voronoiVec2', 'voronoiVec3',
]);

/** Distribute handles evenly along the side, centered. Shared with the card
 *  replica (NodePreviewCard's NoiseCardContent), which draws exposed sockets. */
export function handleTop(index: number, total: number): string {
  if (total === 1) return '50%';
  const start = 25;
  const end = 75;
  const step = (end - start) / (total - 1);
  return `${start + index * step}%`;
}

/**
 * For each input port of a node, check whether time feeds into it.
 *
 * Both halves run on the UNWRAPPED view via the shared ctx — `getTargetEdges`
 * for the incoming wires and `getTimeUpstreamSet` for the walk. Scanning the
 * RAW array (as this did) reports a collapsed group's id as the producer and
 * drops every wire crossing the frame's boundary, so a noise thumbnail whose
 * Time feeder sat inside a collapsed group silently stopped animating.
 */
function getTimeInputs(nodeId: string, nodes: AppNode[], edges: AppEdge[]): TimeInputs {
  const result: TimeInputs = {};
  const timeFed = getTimeUpstreamSet(nodes, edges);
  for (const edge of getTargetEdges(nodes, edges, nodeId)) {
    const handle = edge.targetHandle;
    if (!handle) continue;
    if (timeFed.has(edge.source)) {
      (result as Record<string, boolean>)[handle] = true;
    }
  }
  return result;
}

export const PreviewNode = memo(function PreviewNode({
  id,
  data,
  selected,
}: NodeProps<PreviewFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  // Early return above the hooks is safe: React Flow keys node components by id
  // and registryType never changes on a mounted node.
  if (!def) return null;
  const headerTip = useHeaderTip(def);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Scratch pixel buffer for the thumbnail, ONE per card for the life of the
  // component. renderNoisePreview overwrites every byte of it and
  // putImageData copies it into the canvas synchronously, so the same buffer
  // can serve every tick of the animated loop — see the FRAME RATE note. It
  // lives in a ref rather than inside either effect so re-arming the
  // loop (a dependency change: a new registryType, edited values, a fresh
  // timeInputs identity) reuses the buffer instead of allocating another, and
  // so the static and animated effects — which are mutually exclusive on
  // `hasAnyTime` — share the one allocation.
  const noiseBufRef = useRef<ImageData | null>(null);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const updateNodeInternals = useUpdateNodeInternals();

  // An approaching wire reveals ALL param sockets (names on their tooltips)
  // so any parameter can be wired without a menu round-trip; landing the
  // connection makes the exposure permanent (onConnect auto-expose).
  const revealHidden = useStore(
    useMemo(() => makeConnectionRevealSelector(id, true), [id]),
  );
  // Param sockets = permanently exposed ports, plus (while revealing) every
  // exposable param from the registry defaults. Temporary ones render dimmed.
  //
  // Sockets follow the REGISTRY's defaultValues order, not the stored
  // exposedPorts order. `exposedPorts` records the order the user ticked the
  // boxes in (NodeSettingsMenu's toggle appends to a Set), so exposing `scale`
  // before `pos` used to render the sockets scale-over-pos while the settings
  // menu — which maps Object.entries(def.defaultValues) — still listed pos
  // first. Same list, two orders. Registry order is the one the menu shows, so
  // it wins here too. OutputNode/ShaderNode already get this for free by
  // filtering def.inputs; noise params live in defaultValues instead.
  const exposedList = data.exposedPorts ?? [];
  const paramPorts = useMemo(() => {
    const registryOrder = Object.keys(def.defaultValues ?? {});
    const wanted = new Set(revealHidden ? [...exposedList, ...registryOrder] : exposedList);
    const ordered = registryOrder.filter((k) => wanted.has(k));
    // Anything exposed that the registry doesn't declare (legacy or
    // hand-edited .fastshader) keeps its stored order, appended after.
    // `signed` is a compile-time emission switch, not a value — there is
    // nothing a wire could drive. It is not in defaultValues so it can never
    // arrive here through the UI, but this loop adopts any hand-edited
    // exposedPorts entry verbatim, and a dead socket that silently eats its
    // wire on the next Apply is worse than no socket.
    for (const k of wanted) if (!ordered.includes(k) && k !== 'signed') ordered.push(k);
    return ordered;
  }, [revealHidden, exposedList.join('|'), def]);

  // Tell React Flow to re-measure handles whenever the RENDERED port set
  // changes (settings toggle, auto-attach, or the drag reveal). Without this,
  // dynamically mounted handles aren't in React Flow's bounds map, so edges
  // connected to them silently fail to render until a full re-measure.
  const exposedKey = paramPorts.join('|');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedKey, updateNodeInternals]);

  // ── Upstream-derived render inputs, without a whole-array subscription ──
  // Subscribing to s.nodes/s.edges re-rendered every noise card 60×/s during
  // any drag (each pointermove mints new array identities, bypassing memo()),
  // and the static-thumbnail effect below re-shaded ~27k noise samples per
  // card per frame. Instead — same idiom as ShaderNode's edgeKey — fold
  // everything this card's thumbnail depends on (per-input upstream scalar at
  // t=0 and time-ness) into ONE primitive string: position-only notifies
  // produce an identical string and Object.is bails before any re-render. The
  // evaluator's shared per-graph ctx makes the per-notify evals cache-cheap.
  const inputsKey = useAppStore((s) => {
    let key = '';
    for (const e of getTargetEdges(s.nodes, s.edges, id)) {
      if (!e.targetHandle) continue;
      const v = evaluateEdgeSource(e, s.nodes, s.edges, 0)?.[0] ?? null;
      const timeFed = getTimeUpstreamSet(s.nodes, s.edges).has(e.source);
      key += `${e.source}\u0000${e.sourceHandle ?? ''}\u0000${e.targetHandle}\u0000${v ?? 'n'}\u0000${timeFed ? 1 : 0}\u0001`;
    }
    return key;
  });

  // getTimeInputs allocates a fresh object, so rebuild it from getState() only
  // when the folded key actually changes. The JSON.stringify second stage then
  // stabilizes the *reference* by CONTENT: inputsKey also
  // changes on upstream VALUE edits, and handing the animated loop a fresh
  // (but equal) object each time would tear it down and re-arm it on every
  // scrub frame.
  const timeInputsRaw = useMemo(() => {
    const { nodes, edges } = useAppStore.getState();
    return getTimeInputs(id, nodes, edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, inputsKey]);
  const timeInputsKey = JSON.stringify(timeInputsRaw);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const timeInputs = useMemo(() => timeInputsRaw, [timeInputsKey]);
  const hasAnyTime = Object.values(timeInputs).some(Boolean);

  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  // Priced LIVE under the selected device's table, as ShaderNode is — never
  // the creation-time `data.cost` snapshot (useLiveNodeCost says why).
  const cost = useLiveNodeCost(id, data);
  const { costColor, headerTextColor, costTextColor, costScale, points } = useCostChrome(cost);
  useRemeasureOnScale(id, costScale);

  /**
   * Resolve each scalar input: connected edge → evaluate upstream, else →
   * data.values fallback. Iterates the same UNWRAPPED edge view `inputsKey`
   * folds (getTargetEdges translates collapsed-group boundary edges to their
   * real child producers) — key and render must consume the SAME graph, or a
   * thumbnail rendered while a feeder's group is collapsed sticks on defaults
   * after expand (the key wouldn't change, so nothing re-fires the effect).
   */
  const resolveValues = (
    currentNodes: AppNode[],
    currentEdges: AppEdge[],
    time: number,
  ): Record<string, string | number> => {
    const resolved: Record<string, string | number> = { ...data.values };
    const wired = new Set<string>();
    for (const edge of getTargetEdges(currentNodes, currentEdges, id)) {
      const handle = edge.targetHandle;
      // A socket reads its FIRST wire, as codegen and the evaluator do.
      if (!handle || wired.has(handle)) continue;
      wired.add(handle);
      // Per-SOCKET: an HSL Lightness wire into `scale` must sample the
      // noise at L, not at channel 0's Hue.
      const val = evaluateEdgeSource(edge, currentNodes, currentEdges, time)?.[0] ?? null;
      if (val !== null) resolved[handle] = val;
    }
    return resolved;
  };

  // Static (non-time-driven) noise preview: one-shot render. Keyed on the
  // folded inputsKey (not nodes/edges identity) so the thumbnail refreshes
  // when an upstream value changes but NOT on every drag frame; the arrays are
  // read imperatively at render time. Plain putImageData — no frame loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !NOISE_TYPES.has(data.registryType) || hasAnyTime) return;
    // willReadFrequently keeps these canvases CPU-backed (both effects): an
    // accelerated canvas layer makes Safari rasterize the zoomed viewport at
    // 1× and stretch the bitmap — every node goes blurry.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const { nodes, edges } = useAppStore.getState();
    const resolved = resolveValues(nodes, edges, 0);
    const imageData = renderNoisePreview(
      data.registryType as NoiseType, PREVIEW_SIZE, resolved, 0, {}, noiseBufRef.current,
    );
    noiseBufRef.current = imageData;
    ctx.putImageData(imageData, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.registryType, data.values, inputsKey, hasAnyTime]);

  // Animated (time-driven) noise preview, on the shared frame ticker
  // (utils/frameTicker — see the FRAME RATE note at the top of this file).
  // The tick reads fresh graph state straight from the store (this component
  // no longer subscribes to nodes/edges at all), so its deps stay stable
  // across unrelated drags and the loop never tears down mid-animation. The
  // remaining deps (registryType, the stabilized timeInputs, this node's own
  // values) change only on real edits to this node's upstream.
  //
  // Nothing culls a node in this editor: React Flow renders every one
  // (`onlyRenderVisibleElements` is left at its default false), and a member
  // of a COLLAPSED group is hidden purely in CSS and stays MOUNTED. The ticker
  // skips this card while its canvas is off-screen or `display: none` —
  // collapsing a frame full of animated noise cards used to buy back exactly
  // zero CPU. NB that skip must NOT reach the static one-shot effect above:
  // it has no later frame to catch up on, and a hidden canvas keeps its
  // bitmap, so drawing into it is exactly what makes the thumbnail correct
  // the moment the group expands.
  useFrameLoop(
    NOISE_TYPES.has(data.registryType) && hasAnyTime,
    canvasRef,
    () => {
      // willReadFrequently: see the static effect above.
      const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true }) ?? null;
      return (t) => {
        if (!ctx) return;
        // `t` is the shared app clock (utils/appClock) — a private per-loop
        // epoch made every animated surface disagree with every other; one
        // epoch also lets cpuEvaluator's per-time cache buckets be shared
        // across surfaces within a tick.
        const { nodes, edges } = useAppStore.getState();
        const resolved = resolveValues(nodes, edges, t);
        const imageData = renderNoisePreview(
          data.registryType as NoiseType,
          PREVIEW_SIZE,
          resolved,
          t,
          timeInputs,
          noiseBufRef.current,
        );
        // Keep whatever came back: the first call (or one after PREVIEW_SIZE
        // ever changed) allocates, every later one hands the same buffer back.
        noiseBufRef.current = imageData;
        ctx.putImageData(imageData, 0, 0);
      };
    },
    [data.registryType, data.values, hasAnyTime, timeInputs],
  );

  return (
    <div
      className={`node-base preview-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid ${catHex}`, transform: `scale(${costScale})`, transformOrigin: 'top left' } as CSSProperties}
    >
      {/* Cost badge above node */}
      {cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}><Points value={points} /></span>}

      {/* Header */}
      <div className="node-base__header" style={{ background: costColor }} {...headerTip}>
        <NodeTitle text={varName ?? data.label} style={{ color: headerTextColor }} bare={headerTip !== null} />
      </div>

      {/* Preview canvas */}
      <div className="preview-node__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={PREVIEW_SIZE}
          height={PREVIEW_SIZE}
          className="preview-node__canvas"
        />
      </div>
      {/* Marks the SURPRISING state, not the new default: a signed node is the
          one the user did not choose — it arrives from a preset or a file saved
          before the flag existed — so a fresh canvas stays quiet, and a missing
          or garbage flag (which falls back to signed) shows the chip rather
          than hiding it. Absolutely positioned like ClockNode's ×speed chip so
          it cannot disturb the measured box that handle placement and
          drag-connect hit boxes depend on. */}
      {hasNoiseRangeFlag(data.registryType) && !isUnsignedNoise(data.registryType, data.values) && (
        <span className="preview-node__range">±1</span>
      )}

      {/* Input handles — static + exposed dynamic ports on left side (plus,
          while a wire is nearby, every hidden param — dimmed — so the drag
          can snap to it). During the reveal EVERY input socket forces its
          name-tooltip visible, floated left of the dot, so the user can read
          each target while aiming (`reveal` prop). */}
      {(() => {
        const exposedSet = new Set(exposedList);
        const allInputs = [
          ...def.inputs.map((p) => ({ id: p.id, dataType: p.dataType, label: p.label, temp: false })),
          ...paramPorts.map((key) => ({
            id: key,
            dataType: (key === 'pos' ? 'vec3' : 'float') as TSLDataType,
            label: key,
            temp: !exposedSet.has(key),
          })),
        ];
        return allInputs.map((input, i) => (
          <TypedHandle
            key={input.id}
            type="target"
            position={Position.Left}
            id={input.id}
            dataType={input.dataType}
            label={input.label}
            reveal={revealHidden}
            style={{
              top: handleTop(i, allInputs.length),
              ...(input.temp ? { opacity: REVEAL_TEMP_OPACITY } : null),
            }}
          />
        ));
      })()}

      {/* Output handles — centered on right side */}
      {def.outputs.map((output, i) => (
        <TypedHandle
          key={output.id}
          type="source"
          position={Position.Right}
          id={output.id}
          dataType={output.dataType}
          label={output.label}
          style={{ top: handleTop(i, def.outputs.length) }}
        />
      ))}
    </div>
  );
});
