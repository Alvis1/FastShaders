/**
 * Intro scene — look at one node, then wire it in: Alt/⌥-click a Voronoi and
 * the 3D view shows it in place of the Output's Color (Preview mode: the rest
 * of the canvas dims, a straight line marks the route); a press elsewhere ends
 * it. Ctrl/⌘-click it, pick Color in the Attach list, and the wire is real.
 *
 * The 3D view is the real preview (IntroPreview). What it runs in each state
 * is the app's own: `previewGraph` for Preview mode — the derived graph the
 * sync engine hands the pane — and the wired graph after Attach, both through
 * `graphToCode`. The canvas uses the canvas's own Preview-mode rules (the
 * `fs-previewing` dim, `data-fs-preview` ends, PreviewRoute's line classes),
 * and the list is the Attach menu's rows over the real `attachSinks`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { fillTemplate } from '@/utils/fillTemplate';
import { formatNodeLabel, portLabel, t } from '@/i18n';
import { graphToCode } from '@/engine/graphToCode';
import { buildPreviewShaderModule } from '@/engine/tslToPreviewHTML';
import { previewGraph } from '@/utils/nodePreview';
import { attachSinks, socketFeed } from '@/utils/nodeAttach';
import { CardSocketLabels, NoiseCardContent, OutputCardContent, useCardChrome } from '@/components/NodeEditor/NodePreviewCard';
import { IntroPreview } from './IntroPreview';
import { buildPreviewTour, modifierCap, previewFrame, type PreviewState, type PreviewTour } from './previewTour';
import { IntroStage, centre, paintCursor, placeMenu, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, sceneNodes, toAppEdges, useWireInk, wiredValue, wirePaths, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

const ZOOM = 0.75;
/** Flow positions. */
const PERLIN_AT: Point = { x: 24, y: 16 };
const VORONOI_AT: Point = { x: 24, y: 236 };
const OUTPUT_AT: Point = { x: 250, y: 96 };
/** The 3D pane, in stage px. */
const PANE = { x: 318, y: 36, w: 230, h: 230 };
const AWAY: Point = { x: 250, y: 30 };

const perlinDef = NODE_REGISTRY.get('perlin')!;
const voronoiDef = NODE_REGISTRY.get('voronoi')!;
const outputDef = NODE_REGISTRY.get('output')!;
const PERLIN = 'intro-perlin';
const VORONOI = 'intro-voronoi';
const OUTPUT = 'intro-output';
const SCENE = [
  { id: PERLIN, def: perlinDef },
  { id: VORONOI, def: voronoiDef },
  { id: OUTPUT, def: outputDef },
];
const BEFORE: SceneEdge[] = [{ source: PERLIN, sourceHandle: 'out', target: OUTPUT, targetHandle: 'color' }];
const AFTER: SceneEdge[] = [{ source: VORONOI, sourceHandle: 'out', target: OUTPUT, targetHandle: 'color' }];
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

const IDLE: PreviewState = { key: null, previewing: false, menu: false, attached: false, pressed: false };

/** The tsl and module each state runs. */
function shaders() {
  const nodes = sceneNodes(SCENE).map((n) => ({ ...n, position: { x: 0, y: 0 } }));
  const build = (g: { nodes: typeof nodes; edges: ReturnType<typeof toAppEdges> }) => {
    const gen = graphToCode(g.nodes, g.edges);
    return { tsl: gen.code, module: buildPreviewShaderModule(gen.code), varNames: gen.varNames };
  };
  const before = { nodes, edges: toAppEdges(BEFORE) };
  return {
    nodes,
    before: build(before),
    previewing: build(previewGraph(before.nodes, before.edges, { nodeId: VORONOI, handleId: 'out' })),
    after: build({ nodes, edges: toAppEdges(AFTER) }),
  };
}

export function PreviewScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const ink = useWireInk();
  const perlinChrome = useCardChrome(perlinDef);
  const voronoiChrome = useCardChrome(voronoiDef);
  const outputChrome = useCardChrome(outputDef);
  const built = useMemo(shaders, []);

  const perlinRef = useRef<HTMLDivElement>(null);
  const voronoiRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);

  const [anchors, setAnchors] = useState<{ perlin: Point; voronoi: Point; color: Point; route: [Point, Point] } | null>(null);
  const [menuAt, setMenuAt] = useState<Point>({ x: 0, y: 0 });
  const [tour, setTour] = useState<PreviewTour | null>(null);
  const [state, setState] = useState<PreviewState>(IDLE);

  // The Attach list, from the real sink scan over the scene's graph.
  const sinks = useMemo(() => attachSinks(built.nodes, toAppEdges(BEFORE)), [built]);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const els = [perlinRef.current, voronoiRef.current, outputRef.current, menuRef.current];
    if (!stageEl || els.some((e) => !e)) return;
    const [perlinW, voronoiW, outW, menu] = els as HTMLDivElement[];
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const base = stageEl.getBoundingClientRect();
      const o = { x: 0, y: 0 };
      const pOut = box(perlinW.querySelector('.react-flow__handle-right[data-handleid="out"]'), base, o);
      const vOut = box(voronoiW.querySelector('.react-flow__handle-right[data-handleid="out"]'), base, o);
      const color = box(outW.querySelector('[data-handleid="color"]'), base, o);
      const vHead = box(voronoiW.querySelector('.node-base__header'), base, o);
      const mR = menu.getBoundingClientRect();
      const size = box(menu, mR, o);
      if (!pOut || !vOut || !color || !vHead || !size) return;
      const click = centre(vHead);
      const at = placeMenu(click, size);
      const row = box(menu.querySelector('[data-intro-row="color"]'), mR, at);
      if (!row) return;
      const flow = (p: Point) => ({ x: p.x / ZOOM, y: p.y / ZOOM });
      setAnchors({
        perlin: flow({ x: pOut.x + pOut.w, y: centre(pOut).y }),
        voronoi: flow({ x: vOut.x + vOut.w, y: centre(vOut).y }),
        color: flow({ x: color.x, y: centre(color).y }),
        // PreviewRoute's anchors: socket centres, in the stage's own px.
        route: [centre(vOut), centre(color)],
      });
      setMenuAt(at);
      setTour(buildPreviewTour({ node: click, away: AWAY, colorRow: { x: row.x + Math.min(50, row.w / 3), y: centre(row).y } }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of els as HTMLDivElement[]) ro.observe(el);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef, language]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!tour || !scene || !cursor) return;
    let shown: PreviewState | null = null;
    const paint = (time: number) => {
      const f = previewFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.previewing);
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
  }, [tour, stage.sceneRef, stage.cursorRef]);

  const edges = state.attached ? AFTER : BEFORE;
  const shown = state.attached ? built.after : state.previewing ? built.previewing : built.before;
  const wire = anchors
    ? wirePaths(state.attached ? anchors.voronoi : anchors.perlin, anchors.color, Position.Right)
    : null;
  const colorText = wiredValue(SCENE, edges, edges[0]).val;
  const feederName = (id: string) => built.before.varNames.get(id) ?? id;

  return (
    <IntroStage stage={stage} keyCap={state.key ? modifierCap(state.key, MAC) : null}>
      {/* The canvas, at 75%, wearing the canvas's Preview-mode classes. */}
      <div className={`node-editor__canvas fs-intro__canvas${state.previewing ? ' fs-previewing' : ''}`}>
        <div className="fs-intro__graph" style={{ transform: `scale(${ZOOM})` }}>
          <svg className="fs-intro__wires">
            {wire && (
              <g className="react-flow__edge">
                <IntroWire ink={ink} d={wire} />
              </g>
            )}
          </svg>
          <CardSocketLabels.Provider value={true}>
            <div ref={perlinRef} className="react-flow__node fs-intro__node" style={{ left: PERLIN_AT.x, top: PERLIN_AT.y }}>
              <NoiseCardContent {...perlinChrome} />
            </div>
            <div
              ref={voronoiRef}
              className="react-flow__node fs-intro__node"
              data-fs-preview={state.previewing ? 'src' : undefined}
              style={{ left: VORONOI_AT.x, top: VORONOI_AT.y }}
            >
              <NoiseCardContent {...voronoiChrome} />
            </div>
            <div
              ref={outputRef}
              className="react-flow__node fs-intro__node"
              data-fs-preview={state.previewing ? 'dst' : undefined}
              style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}
            >
              <OutputCardContent {...outputChrome} wired={{ color: colorText }} />
            </div>
          </CardSocketLabels.Provider>
        </div>
      </div>

      {/* Preview mode's straight route (PreviewRoute's own markup). */}
      {anchors && state.previewing && (
        <svg className="preview-route" aria-hidden="true">
          <line className="preview-route__line" x1={anchors.route[0].x} y1={anchors.route[0].y} x2={anchors.route[1].x} y2={anchors.route[1].y} />
          <circle className="preview-route__dot" r="3.5" cx={anchors.route[0].x} cy={anchors.route[0].y} />
          <circle className="preview-route__dot" r="3.5" cx={anchors.route[1].x} cy={anchors.route[1].y} />
        </svg>
      )}

      {/* The 3D view: the real preview document. */}
      <div className="fs-intro__pane" style={{ left: PANE.x, top: PANE.y, width: PANE.w, height: PANE.h }}>
        <IntroPreview tslCode={built.before.tsl} module={shown.module} />
      </div>

      {/* The Attach list (AttachMenu's rows over the real sink scan). */}
      <div
        ref={menuRef}
        className="context-menu fs-intro__menu"
        style={{ left: menuAt.x, top: menuAt.y, visibility: state.menu ? 'visible' : 'hidden' }}
      >
        <div className="context-menu__list">
          {sinks.map(({ node: sink, sockets }) => (
            <div key={sink.id}>
              <div className="context-menu__category">
                {fillTemplate(t('Attach to {name}', language), {
                  name: formatNodeLabel(outputDef.label, 'output', language, false),
                })}
              </div>
              {sockets.map((socket) => {
                const feed = socketFeed(toAppEdges(BEFORE), sink.id, socket.id);
                return (
                  <button
                    key={socket.id}
                    type="button"
                    tabIndex={-1}
                    data-intro-row={socket.id}
                    className={`context-menu__item${state.menu && state.pressed && socket.id === 'color' ? ' context-menu__item--focused' : ''}`}
                  >
                    <span>{portLabel(socket.label, language)}</span>
                    <span className="context-menu__item-category">{feed ? feederName(feed.source) : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </IntroStage>
  );
}
