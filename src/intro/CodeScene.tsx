/**
 * Intro scene — code and graph are one shader: TSL typed into the code panel,
 * Apply, and the graph builds; Time and Sin wired into a noise make it move.
 *
 * The starting code is `graphToCode` of a fresh Output, the graph each Apply
 * shows is the app's own `codeToGraph` → `autoExposeConnectedParamPorts` →
 * `autoLayout` (the code→graph sync's steps), and the cards are the tiles'
 * replicas, moved by the canvas's own frame helpers (`applyClockFrame`,
 * `applyWaveFrame`, `renderNoisePreview`) once Time drives them. Live wires
 * march as TypedEdge's do. The parser is the Babel chunk, so it is imported
 * when this slide first shows, never with the intro.
 *
 * The code panel is drawn here — Monaco would be a megabyte for six lines —
 * with the panel's own tab bar and buttons (CodeEditor.css) and the stock
 * Monaco theme colours for the tokens this code holds.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { AppEdge, AppNode } from '@/types';
import { graphToCode } from '@/engine/graphToCode';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { getLiveUpstreamSet } from '@/engine/cpuEvaluator';
import { renderNoisePreview } from '@/utils/noisePreview';
import { CardSocketLabels } from '@/components/NodeEditor/NodePreviewCard';
import { applyClockFrame } from '@/components/NodeEditor/nodes/ClockFaceSvg';
import { applyWaveFrame, type WaveformDynamicRefs } from '@/components/NodeEditor/nodes/WaveformSvg';
import '@/components/CodeEditor/CodeEditor.css';
import {
  buildCodeTour,
  codeFrame,
  codeSnapshots,
  tokenClasses,
  type CodeState,
  type CodeTour,
} from './codeTour';
import { IntroStage, STAGE_W, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import { GraphCard, IntroWire, edgePortState, wirePaths, useWireInk, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

/** The graph above, the code panel below it, as the app stacks preview and code. */
const CODE_TOP = 148;
const GRAPH_PAD = 14;
const LINE_H = 18;
/** The panel scrolled so the shader's body is in view (Monaco's scrollTop). */
const FIRST_LINE = 2;
/** Noise thumbnail repaints per second while Time drives it — the canvas
 *  ticker's rate. */
const NOISE_HZ = 15;

const REST: Point = { x: 470, y: 262 };

interface Graph {
  nodes: AppNode[];
  edges: AppEdge[];
}

interface Built {
  graphs: Graph[];
  /** The last graph's extent in flow px, by the layout engine's own size
   *  estimate — what the camera fits. */
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

const freshOutput = (): AppNode =>
  ({ id: 'intro-output', type: 'output', position: { x: 0, y: 0 }, data: { registryType: 'output', label: 'Output', cost: 0 } }) as unknown as AppNode;

/** The starting code: what the panel holds for a fresh graph. */
const START = graphToCode([freshOutput()], []).code;

/** Each Apply's graph, built the way the code→graph sync builds it. */
async function buildGraphs(): Promise<Built | null> {
  const snaps = codeSnapshots(START);
  if (!snaps) return null;
  const [{ codeToGraph }, { autoLayout, estimateNodeSize }] = await Promise.all([
    import('@/engine/codeToGraph'),
    import('@/engine/layoutEngine'),
  ]);
  const graphs: Graph[] = [{ nodes: autoLayout([freshOutput()], []), edges: [] }];
  for (const code of snaps) {
    const r = codeToGraph(code);
    if (r.errors.some((e) => e.severity !== 'warning')) return null;
    const nodes = r.nodes as AppNode[];
    const edges = r.edges as AppEdge[];
    autoExposeConnectedParamPorts(nodes, edges);
    graphs.push({ nodes: autoLayout(nodes, edges), edges });
  }
  const bounds = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const last = graphs[graphs.length - 1];
  for (const n of last.nodes) {
    const { width, height } = estimateNodeSize(n, last.edges.filter((e) => e.target === n.id).length);
    bounds.x1 = Math.min(bounds.x1, n.position.x);
    bounds.y1 = Math.min(bounds.y1, n.position.y);
    bounds.x2 = Math.max(bounds.x2, n.position.x + width);
    bounds.y2 = Math.max(bounds.y2, n.position.y + height);
  }
  return { graphs, bounds };
}

let builtPromise: Promise<Built | null> | null = null;

/** Nodes are keyed by type across Applies — each type appears once here, and
 *  the parse mints fresh ids every time. */
const keyOf = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)?.data.registryType as string | undefined;

/** The code as the panel shows it: line numbers, token colours, the caret and
 *  a selection. */
function CodeLines({ state }: { state: CodeState }) {
  const { text, caret, sel } = state;
  const classes = useMemo(() => tokenClasses(text), [text]);
  const lines: React.ReactNode[] = [];
  let offset = 0;
  text.split('\n').forEach((line, li) => {
    const parts: React.ReactNode[] = [];
    let run = '';
    let runCls = '';
    const flush = (k: string) => {
      if (run) parts.push(<span key={k} className={runCls || undefined}>{run}</span>);
      run = '';
    };
    for (let i = 0; i <= line.length; i++) {
      const at = offset + i;
      if (caret === at) {
        flush(`r${i}`);
        parts.push(<span key={`c${i}`} className="fs-intro__caret" />);
      }
      if (i === line.length) break;
      const tok = classes[at];
      const selected = sel !== null && at >= sel.start && at < sel.end;
      const cls = [tok ? `fs-intro__tok-${tok}` : '', selected ? 'fs-intro__code-sel' : ''].filter(Boolean).join(' ');
      if (cls !== runCls) {
        flush(`r${i}`);
        runCls = cls;
      }
      run += line[i];
    }
    flush('end');
    lines.push(
      <div key={li} className="fs-intro__code-line">
        <span className="fs-intro__code-num">{li + 1}</span>
        <span className="fs-intro__code-text">{parts}</span>
      </div>,
    );
    offset += line.length + 1;
  });
  return <>{lines}</>;
}

export function CodeScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const dark = useAppStore((s) => s.codeEditorTheme === 'vs-dark');
  const ink = useWireInk();

  const [built, setBuilt] = useState<Built | null>(null);
  const graphs = built?.graphs ?? null;
  useEffect(() => {
    let live = true;
    builtPromise ??= buildGraphs().catch(() => null);
    void builtPromise.then((b) => {
      if (live) setBuilt(b);
    });
    return () => {
      live = false;
    };
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<SVGGElement>(null);
  const noiseRef = useRef<HTMLCanvasElement>(null);
  const curve = useRef<SVGPathElement>(null);
  const drop = useRef<SVGLineElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const pill = useRef<SVGRectElement>(null);
  const label = useRef<SVGTextElement>(null);
  const wave = useMemo<WaveformDynamicRefs>(() => ({ curve, drop, dot, pill, text: label }), []);
  const clockRef = useRef<number | null>(null);

  const [tour, setTour] = useState<CodeTour | null>(null);
  const [state, setState] = useState<CodeState>({ text: START, caret: null, sel: null, applied: 0, pressed: false });
  const [anchors, setAnchors] = useState<Map<string, Point> | null>(null);

  // The camera: the last graph fitted into the space above the panel, held
  // for every Apply so the view does not jump.
  const view = useMemo(() => {
    if (!built) return { x: GRAPH_PAD, y: GRAPH_PAD, zoom: 1 };
    const { x1, y1, x2, y2 } = built.bounds;
    // The badges ride above the cards: room for them over the top row.
    const BADGE = 28;
    const zoom = Math.min(1, (STAGE_W - 2 * GRAPH_PAD) / (x2 - x1), (CODE_TOP - 2 * GRAPH_PAD) / (y2 - y1 + BADGE));
    return {
      x: (STAGE_W - (x2 - x1) * zoom) / 2 - x1 * zoom,
      y: GRAPH_PAD + BADGE * zoom - y1 * zoom,
      zoom,
    };
  }, [built]);

  const graph = graphs?.[Math.min(state.applied, graphs.length - 1)] ?? null;
  const live = graph ? getLiveUpstreamSet(graph.nodes, graph.edges) : new Set<string>();

  // The pointer's two places, measured off the panel.
  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const panel = panelRef.current;
    if (!graphs || !stageEl || !panel) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      const apply = box?.(panel.querySelector('.code-editor__btn--apply'), stageEl.getBoundingClientRect(), { x: 0, y: 0 });
      if (apply) setTour(buildCodeTour(START, { apply: centre(apply), rest: REST }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [graphs, stage.scale, stage.stageRef, language]);

  // The sockets of whatever graph is shown, in flow px.
  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const layer = layerRef.current;
    if (!graph || !stageEl || !layer) return;
    const measure = () => {
      const s = stageEl.getBoundingClientRect().width / STAGE_W;
      const base = layer.getBoundingClientRect();
      const k = s * view.zoom;
      if (!(k > 0)) return;
      const next = new Map<string, Point>();
      for (const e of graph.edges) {
        const src = layer.querySelector(`[data-node="${CSS.escape(e.source)}"]`);
        const tgt = layer.querySelector(`[data-node="${CSS.escape(e.target)}"]`);
        const out = src?.querySelector(`.react-flow__handle-right[data-handleid="${CSS.escape(e.sourceHandle ?? 'out')}"]`);
        const inp = tgt?.querySelector(`.react-flow__handle-left[data-handleid="${CSS.escape(e.targetHandle ?? 'in')}"]`);
        if (!out || !inp) continue;
        const a = out.getBoundingClientRect();
        const b = inp.getBoundingClientRect();
        next.set(`${e.id}:a`, { x: (a.right - base.left) / k, y: (a.top + a.height / 2 - base.top) / k });
        next.set(`${e.id}:b`, { x: (b.left - base.left) / k, y: (b.top + b.height / 2 - base.top) / k });
      }
      setAnchors(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of layer.querySelectorAll('[data-node]')) ro.observe(el);
    return () => ro.disconnect();
  }, [graph, view, stage.scale, stage.stageRef]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!tour || !scene || !cursor) return;
    let shown: CodeState | null = null;
    let lastNoise = -1;
    let buf: ImageData | null = null;
    const lastLabel = { current: null as string | null };
    const paint = (time: number) => {
      const f = codeFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
      // Time drives the graph from the last Apply on: the hand, the wave and
      // the noise's scale (Sin's output) move, as on the canvas.
      const loopT = ((time % tour.tl.total) + tour.tl.total) % tour.tl.total;
      if (loopT < tour.liveFrom) {
        lastNoise = -1;
        return;
      }
      const tt = (loopT - tour.liveFrom) / 1000;
      applyClockFrame(handRef, tt % 60);
      applyWaveFrame(wave, Math.sin, 'sin', tt, lastLabel);
      const tick = Math.floor(tt * NOISE_HZ);
      const ctx = noiseRef.current?.getContext('2d', { willReadFrequently: true });
      if (ctx && tick !== lastNoise) {
        lastNoise = tick;
        buf = renderNoisePreview('perlin', 96, { scale: Math.sin(tt) }, tt, {}, buf);
        ctx.putImageData(buf, 0, 0);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.still);
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

  const wires = graph && anchors
    ? graph.edges.flatMap((e) => {
        const a = anchors.get(`${e.id}:a`);
        const b = anchors.get(`${e.id}:b`);
        if (!a || !b) return [];
        const edge: SceneEdge = { source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, targetHandle: e.targetHandle ?? 'in' };
        const ch = edgePortState(graph.nodes, graph.edges, edge).ch;
        return [{ id: e.id, live: live.has(e.source), count: ch, d: wirePaths(a, b, Position.Right, 1, ch) }];
      })
    : [];

  return (
    <IntroStage stage={stage}>
      {graph && (
        <div
          ref={layerRef}
          className="fs-intro__graph"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        >
          <svg className="fs-intro__wires">
            {wires.map((w) => (
              <IntroWire key={w.id} ink={ink} live={w.live} count={w.count} d={w.d} />
            ))}
          </svg>
          <CardSocketLabels.Provider value={true}>
            {graph.nodes.map((n) => (
              <div
                key={keyOf(graph, n.id)}
                data-node={n.id}
                className="react-flow__node fs-intro__node"
                style={{ left: n.position.x, top: n.position.y }}
              >
                <GraphCard node={n} graph={graph} live={live.has(n.id) || graph.edges.some((e) => e.target === n.id && live.has(e.source))} refs={{ hand: handRef, wave, noise: noiseRef }} />
              </div>
            ))}
          </CardSocketLabels.Provider>
        </div>
      )}
      <div ref={panelRef} className={`code-editor fs-intro__code${dark ? ' fs-intro__code--dark' : ''}`} style={{ top: CODE_TOP }}>
        {/* The panel's own tab bar (CodeEditor.tsx). */}
        <div className="code-editor__tabbar">
          <div className="code-editor__tabs">
            <button type="button" tabIndex={-1} className="code-editor__tab code-editor__tab--active">TSL</button>
            <button type="button" tabIndex={-1} className="code-editor__tab">A-Frame</button>
            <button type="button" tabIndex={-1} className="code-editor__tab">Three.js</button>
          </div>
          <div className="code-editor__actions">
            <button type="button" tabIndex={-1} className="code-editor__btn code-editor__btn--apply">
              {t('Apply', language)}
            </button>
            <button type="button" tabIndex={-1} className="code-editor__btn code-editor__btn--accent">
              {t('Import', language)}
            </button>
          </div>
        </div>
        <div className="fs-intro__code-body">
          <div style={{ transform: `translateY(${-FIRST_LINE * LINE_H}px)` }}>
            <CodeLines state={state} />
          </div>
        </div>
      </div>
    </IntroStage>
  );
}
