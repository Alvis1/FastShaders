/**
 * Intro scene — click a wire to see what it carries: the chip that opens on a
 * selected wire, here on a number (Float), a range on two channels (UV), three
 * channels (Position) and a live value (Time → Sine) — one wire at a time,
 * close up, each fading in beside the same Output.
 *
 * Same rules as the other scenes: the tiles' card replicas at canvas size,
 * nothing written to the store. The chip is EdgeInfoCard's own markup and
 * text (`edgeChipChannels` / `EdgeChipValues`) over `evaluateEdgeRange` on
 * this scene's graph; it sits at the middle of the wire's arc, as the canvas
 * puts it, and a selected wire is thickened by TypedEdge's own boost. Time
 * drives the clock hand, Sine's wave and the live chip off one clock.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { evaluateEdgeRange, getEdgeOutputShape, getLiveUpstreamSet } from '@/engine/cpuEvaluator';
import {
  CardSocketLabels,
  ClockCardContent,
  MathCardContent,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { applyClockFrame } from '@/components/NodeEditor/nodes/ClockFaceSvg';
import { applyWaveFrame, type WaveformDynamicRefs } from '@/components/NodeEditor/nodes/WaveformSvg';
import { SELECTED_EDGE_BOOST } from '@/components/NodeEditor/edges/TypedEdge';
import { EdgeChipValues, edgeChipChannels } from '@/components/NodeEditor/edges/EdgeInfoCard';
import { bezierMarkAt, edgeBezier, visibleArcMidpoint } from '@/components/NodeEditor/edges/bezierGeometry';
import '@/components/NodeEditor/edges/EdgeInfoCard.css';
import type { AppEdge } from '@/types';
import {
  PHASE_NODES,
  VALUES_CLICKS,
  VALUES_OUTPUT_PORTS,
  buildValuesTour,
  valuesFrame,
  valuesGraph,
  type ValuesState,
  type ValuesTour,
  type ValuesWire,
} from './valuesTour';
import { IntroStage, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, edgePortState, wirePaths, useWireInk, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

/** The graph is drawn close up. */
const ZOOM = 1.25;
/** Where each card sits, in the graph's own px — every source beside the
 *  Output row its wire goes into; only one phase's cards show at a time. */
const AT: Record<string, Point> = {
  float: { x: 70, y: 86 },
  uv: { x: 80, y: 30 },
  position: { x: 90, y: 38 },
  time: { x: 8, y: 70 },
  sine: { x: 112, y: 60 },
  output: { x: 280, y: 24 },
};
const REST: Point = { x: 250, y: 262 };
/** The live chip's refresh rate — the canvas chip rides the 15 Hz ticker. */
const CHIP_HZ = 15;

const reg = (type: string) => NODE_REGISTRY.get(type)!;
const DEFS = {
  uv: reg('uv'),
  position: reg('positionGeometry'),
  float: reg('float'),
  time: reg('time'),
  sine: reg('sin'),
  output: reg('output'),
};

const sceneEdge = (e: AppEdge): SceneEdge => ({
  source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, targetHandle: e.targetHandle ?? 'in',
});

/** A socket on a card: a replica's handle (`data-handleid`) or a shader
 *  card's (`data-port`/`data-io`). */
function socketEl(card: Element, handle: string, io: 'in' | 'out'): Element | null {
  const side = io === 'out' ? 'right' : 'left';
  return (
    card.querySelector(`.react-flow__handle-${side}[data-handleid="${CSS.escape(handle)}"]`) ??
    card.querySelector(`[data-port="${CSS.escape(handle)}"][data-io="${io}"]`)
  );
}

interface Layout {
  /** Each wire's ends, by edge id. */
  ends: Map<string, { a: Point; b: Point }>;
  clicks: Record<ValuesWire, Point>;
  chips: Record<ValuesWire, Point>;
}

export function ValuesScene() {
  const stage = useIntroStage();
  const ink = useWireInk();
  const graph = useMemo(valuesGraph, []);
  const live = useMemo(() => getLiveUpstreamSet(graph.nodes, graph.edges), [graph]);
  const chrome = {
    uv: useCardChrome(DEFS.uv),
    position: useCardChrome(DEFS.position),
    float: useCardChrome(DEFS.float),
    time: useCardChrome(DEFS.time),
    sine: useCardChrome(DEFS.sine),
    output: useCardChrome(DEFS.output),
  };

  const layerRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<SVGGElement>(null);
  const curve = useRef<SVGPathElement>(null);
  const drop = useRef<SVGLineElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const pill = useRef<SVGRectElement>(null);
  const label = useRef<SVGTextElement>(null);
  const wave = useMemo<WaveformDynamicRefs>(() => ({ curve, drop, dot, pill, text: label }), []);
  const clockRef = useRef<number | null>(null);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [tour, setTour] = useState<ValuesTour | null>(null);
  const [state, setState] = useState<ValuesState>({ phase: VALUES_CLICKS[0], selected: false, pressed: false });
  /** Seconds on the scene's clock, as the live chip last showed them. */
  const [liveT, setLiveT] = useState(0);

  // The wire each click selects, by the node it leaves.
  const wireOf = useMemo(() => {
    const m = new Map<ValuesWire, AppEdge>();
    for (const w of VALUES_CLICKS) m.set(w, graph.edges.find((e) => e.source === w && e.target === 'output')!);
    return m;
  }, [graph]);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const layer = layerRef.current;
    if (!stageEl || !layer) return;
    const measure = () => {
      const measured = stageMeasurer(stageEl);
      if (!measured) return;
      const base = layer.getBoundingClientRect();
      // In the graph's own px: the wires and the chip are drawn inside the
      // zoomed layer; only the pointer is in stage px.
      const box = (el: Element | null) => {
        const b = measured(el, base, { x: 0, y: 0 });
        return b && { x: b.x / ZOOM, y: b.y / ZOOM, w: b.w / ZOOM, h: b.h / ZOOM };
      };
      const ends = new Map<string, { a: Point; b: Point }>();
      for (const e of graph.edges) {
        const src = layer.querySelector(`[data-node="${e.source}"]`);
        const tgt = layer.querySelector(`[data-node="${e.target}"]`);
        const a = src && box(socketEl(src, e.sourceHandle ?? 'out', 'out'));
        const b = tgt && box(socketEl(tgt, e.targetHandle ?? 'in', 'in'));
        if (!a || !b) return;
        ends.set(e.id, { a: { x: a.x + a.w, y: a.y + a.h / 2 }, b: { x: b.x, y: b.y + b.h / 2 } });
      }
      const clicks = {} as Record<ValuesWire, Point>;
      const chips = {} as Record<ValuesWire, Point>;
      for (const w of VALUES_CLICKS) {
        const { a, b } = ends.get(wireOf.get(w)!.id)!;
        const seg = edgeBezier(a.x, a.y, Position.Right, b.x, b.y, Position.Left);
        // Clicked a third of the way along; the chip opens mid-arc.
        const c = bezierMarkAt(seg, 0.3);
        clicks[w] = { x: c.x * ZOOM, y: c.y * ZOOM };
        const m = visibleArcMidpoint([seg], null)!;
        chips[w] = { x: m[0], y: m[1] };
      }
      setLayout({ ends, clicks, chips });
      setTour(buildValuesTour({ clicks, rest: REST }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of layer.querySelectorAll('[data-node]')) ro.observe(el);
    return () => ro.disconnect();
  }, [graph, wireOf, stage.scale, stage.stageRef]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!tour || !scene || !cursor) return;
    let shown: ValuesState | null = null;
    let tick = -1;
    const lastLabel = { current: null as string | null };
    const paint = (time: number) => {
      const f = valuesFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      layerRef.current?.style.setProperty('--fs-intro-phase', String(f.fade));
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
      // Time drives the hand, the wave and the live chip, as on the canvas.
      const tt = time / 1000;
      applyClockFrame(handRef, tt % 60);
      applyWaveFrame(wave, Math.sin, 'sin', tt, lastLabel);
      const next = Math.floor(tt * CHIP_HZ);
      if (next !== tick) {
        tick = next;
        setLiveT(next / CHIP_HZ);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.stills.uv);
      return;
    }
    let raf = 0;
    clockRef.current ??= performance.now();
    const t0 = clockRef.current;
    const loop = (now: number) => {
      paint(now - t0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tour, wave, stage.sceneRef, stage.cursorRef]);

  const shownEdge = wireOf.get(state.phase)!;
  const selectedEdge = state.selected ? shownEdge : undefined;
  const onShow = new Set(PHASE_NODES[state.phase]);
  const wires = layout
    ? graph.edges.flatMap((e) => {
        const end = layout.ends.get(e.id);
        if (!end || !onShow.has(e.source) || !onShow.has(e.target)) return [];
        const ch = edgePortState(graph.nodes, graph.edges, sceneEdge(e)).ch;
        const boost = e === selectedEdge ? SELECTED_EDGE_BOOST : 1;
        return [{ id: e.id, live: live.has(e.source), count: ch, boost, d: wirePaths(end.a, end.b, Position.Right, boost, ch) }];
      })
    : [];

  // The chip, as EdgeInfoCard words it: the selected wire's range at the
  // scene's time (only the live wire's moves).
  const chip = selectedEdge
    ? edgeChipChannels(
        evaluateEdgeRange(selectedEdge, graph.nodes, graph.edges, live.has(selectedEdge.source) ? liveT : 0),
        getEdgeOutputShape(selectedEdge, graph.nodes, graph.edges),
      )
    : null;
  const chipAt = state.selected && layout ? layout.chips[state.phase] : null;

  // The Output row the shown wire goes into; the live one moves with the
  // chip's clock, as the canvas's live edge value does.
  const wired = {
    [shownEdge.targetHandle ?? 'color']: live.has(shownEdge.source)
      ? edgeChipChannels(evaluateEdgeRange(shownEdge, graph.nodes, graph.edges, liveT), 1).values[0]
      : edgePortState(graph.nodes, graph.edges, sceneEdge(shownEdge)).val,
  };
  /** The shown phase's cards, wires and chip fade with it; the Output stays. */
  const phaseFade = { opacity: 'var(--fs-intro-phase, 1)' } as const;
  const floatNode = graph.nodes.find((n) => n.id === 'float')!;

  const card = (id: keyof typeof DEFS, content: React.ReactNode) => (
    <div
      key={id}
      data-node={id}
      className="react-flow__node fs-intro__node"
      style={{
        left: AT[id].x,
        top: AT[id].y,
        // Opacity, not visibility: the wave's frame helper sets its dot's
        // own visibility, which would show through a hidden card.
        ...(id === 'output' ? null : onShow.has(id) ? phaseFade : { opacity: 0 }),
      }}
    >
      {content}
    </div>
  );

  return (
    <IntroStage stage={stage}>
      <div ref={layerRef} className="fs-intro__graph" style={{ transform: `scale(${ZOOM})` }}>
        <svg className="fs-intro__wires" style={phaseFade}>
          {wires.map((w) => (
            <IntroWire key={w.id} ink={ink} live={w.live} count={w.count} boost={w.boost} d={w.d} />
          ))}
        </svg>
        <CardSocketLabels.Provider value={true}>
          {card('uv', <ShaderCardContent {...chrome.uv} />)}
          {card('position', <ShaderCardContent {...chrome.position} />)}
          {card('float', <ShaderCardContent {...chrome.float} values={floatNode.data.values as Record<string, number>} />)}
          {card('time', <ClockCardContent {...chrome.time} handRef={handRef} />)}
          {card('sine', <MathCardContent {...chrome.sine} xWired dynamicRefs={wave} />)}
          {card('output', <OutputCardContent {...chrome.output} exposedPorts={VALUES_OUTPUT_PORTS} wired={wired} />)}
        </CardSocketLabels.Provider>
        {chip && chipAt && (
          <div
            className="edge-info-card"
            style={{ left: 0, top: 0, ...phaseFade, transform: `translate(-50%, -50%) translate(${chipAt.x}px, ${chipAt.y}px)` }}
          >
            <EdgeChipValues count={chip.count} values={chip.values} />
          </div>
        )}
      </div>
    </IntroStage>
  );
}
