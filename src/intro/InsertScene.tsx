/**
 * Intro scene 2 — right-click a wire, insert a node into it, delete the node:
 * the wire joins up again.
 *
 * Same rules as ConnectScene: the tiles' card replicas at canvas size, nothing
 * written to the store's graph, a requestAnimationFrame loop that moves only the
 * pointer. The menus are the canvas menus' own markup and classes (the edge
 * menu's three rows, the search list's input and rows); the search results are
 * the real `searchNodes`, filtered by the user's own optional categories; the
 * wiring at each step comes from the canvas's own splice and delete rules
 * (insertTour.ts). Discrete changes — a menu opening, a letter typed, the node
 * landing or going — are React state, set only when the step changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY, searchNodes } from '@/registry/nodeRegistry';
import { hiddenOptionalCategories } from '@/registry/optionalCategories';
import { formatCategoryLabel, formatNodeLabel, t, type Language } from '@/i18n';
import { freshNodeCost } from '@/utils/nodeCost';
import { getCostTextColor } from '@/utils/colorUtils';
import {
  CardSocketLabels,
  NoiseCardContent,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { HOVER_EDGE_BOOST } from '@/components/NodeEditor/edges/TypedEdge';
import { bezierMarkAt, edgeBezier } from '@/components/NodeEditor/edges/bezierGeometry';
import type { NodeDefinition } from '@/types';
import {
  INSERTED,
  INSERT_QUERY,
  INSERT_SOURCE,
  INSERT_TARGET,
  buildInsertTour,
  insertFrame,
  insertWiring,
  insertedDef,
  wiringFor,
  type InsertState,
  type InsertTour,
} from './insertTour';
import { IntroStage, centre, paintCursor, placeMenu, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, wirePaths, wiredValue, useWireInk, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

const NOISE_AT: Point = { x: 28, y: 72 };
const OUTPUT_AT: Point = { x: 400, y: 44 };
/** The search list shows its first few results, as a short menu would. */
const RESULT_ROWS = 5;

const noiseDef = NODE_REGISTRY.get('perlin')!;
const outputDef = NODE_REGISTRY.get('output')!;
const SCENE_NODES = [
  { id: INSERT_SOURCE, def: noiseDef },
  { id: INSERTED, def: insertedDef },
  { id: INSERT_TARGET, def: outputDef },
];

const IDLE: InsertState = {
  menu: 'none', typed: 0, focus: null, node: 'absent', rightClick: false, pressed: false, key: false, wireHover: false,
};

/** Socket anchors: an output by its outer (right) edge, an input by its left. */
interface Anchors {
  out: Map<string, Point>;
  in: Map<string, Point>;
}

interface Layout {
  click: Point;
  edgeMenu: Point;
  addMenu: Point;
  anchors: Anchors;
}

const key = (node: string, handle: string) => `${node}\0${handle}`;

function MenuRow({ def, focused, language, costLow, costHigh, probe }: {
  def: NodeDefinition;
  focused: boolean;
  language: Language;
  costLow: string;
  costHigh: string;
  probe?: boolean;
}) {
  const cost = freshNodeCost(def.type) ?? 0;
  return (
    <button
      tabIndex={-1}
      className={`context-menu__item${focused ? ' context-menu__item--focused' : ''}`}
      data-intro-row={probe && def.type === insertedDef.type ? 'round' : undefined}
    >
      <span>
        {formatNodeLabel(def.label, def.type, language)}
        {cost > 0 && (
          <span className="context-menu__item-cost" style={{ color: getCostTextColor(cost, costLow, costHigh) }}>
            {cost}
          </span>
        )}
      </span>
      <span className="context-menu__item-category">{formatCategoryLabel(def.category, def.category, language)}</span>
    </button>
  );
}

export function InsertScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const optional = useAppStore((s) => s.optionalCategories);
  const costLow = useAppStore((s) => s.costColorLow);
  const costHigh = useAppStore((s) => s.costColorHigh);
  const noiseChrome = useCardChrome(noiseDef);
  const roundChrome = useCardChrome(insertedDef);
  const outputChrome = useCardChrome(outputDef);
  const ink = useWireInk();
  const hidden = useMemo(() => hiddenOptionalCategories(optional), [optional]);
  const wiring = useMemo(insertWiring, []);

  const noiseRef = useRef<HTMLDivElement>(null);
  const roundRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const edgeMenuRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [tour, setTour] = useState<InsertTour | null>(null);
  const [state, setState] = useState<InsertState>(IDLE);

  const results = (typed: number) => {
    const q = INSERT_QUERY.slice(0, typed);
    return q ? searchNodes(q, hidden).filter((d) => d.type !== 'output').slice(0, RESULT_ROWS) : [];
  };

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const noiseW = noiseRef.current;
    const roundW = roundRef.current;
    const outW = outputRef.current;
    const edgeMenu = edgeMenuRef.current;
    const probe = probeRef.current;
    if (!stageEl || !noiseW || !roundW || !outW || !edgeMenu || !probe) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const nR = noiseW.getBoundingClientRect();
      const oR = outW.getBoundingClientRect();
      const from = box(noiseW.querySelector('[data-handleid="out"]'), nR, NOISE_AT);
      const to = box(outW.querySelector('[data-handleid="color"]'), oR, OUTPUT_AT);
      if (!from || !to) return;
      const src = { x: from.x + from.w, y: centre(from).y };
      const tgt = { x: to.x, y: centre(to).y };
      // The right-click lands mid-wire; the inserted node's top-left lands
      // exactly there (AddNodeMenu places a new node AT the menu's point).
      const mid = bezierMarkAt(edgeBezier(src.x, src.y, Position.Right, tgt.x, tgt.y, Position.Left), 0.5);
      const click = { x: mid.x, y: mid.y };
      const rR = roundW.getBoundingClientRect();
      const rIn = box(roundW.querySelector('[data-port="x"][data-io="in"]'), rR, click);
      const rOut = box(roundW.querySelector('[data-port="out"][data-io="out"]'), rR, click);
      const rHead = box(roundW.querySelector('.node-base__header'), rR, click);
      const eR = edgeMenu.getBoundingClientRect();
      const pR = probe.getBoundingClientRect();
      const eSize = box(edgeMenu, eR, { x: 0, y: 0 });
      const pSize = box(probe, pR, { x: 0, y: 0 });
      if (!rIn || !rOut || !rHead || !eSize || !pSize) return;
      const edgeMenuAt = placeMenu(click, eSize);
      const addMenuAt = placeMenu(click, pSize);
      const insertRow = box(edgeMenu.querySelector('[data-intro-row="insert"]'), eR, edgeMenuAt);
      const roundRow = box(probe.querySelector('[data-intro-row="round"]'), pR, addMenuAt);
      if (!insertRow || !roundRow) return;
      const anchors: Anchors = {
        out: new Map([
          [key(INSERT_SOURCE, 'out'), src],
          [key(INSERTED, 'out'), { x: rOut.x + rOut.w, y: centre(rOut).y }],
        ]),
        in: new Map([
          [key(INSERT_TARGET, 'color'), tgt],
          [key(INSERTED, 'x'), { x: rIn.x, y: centre(rIn).y }],
        ]),
      };
      setLayout({ click, edgeMenu: edgeMenuAt, addMenu: addMenuAt, anchors });
      // The pointer lands on a row a little left of its centre, on the label.
      setTour(buildInsertTour({
        click,
        insertRow: { x: insertRow.x + Math.min(60, insertRow.w / 3), y: centre(insertRow).y },
        roundRow: { x: roundRow.x + Math.min(60, roundRow.w / 3), y: centre(roundRow).y },
        roundGrab: centre(rHead),
      }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [noiseW, roundW, outW, edgeMenu, probe]) ro.observe(el);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef, hidden]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!tour || !scene || !cursor) return;
    // Each step carries ONE state object, so identity says "the step changed".
    let shown: InsertState | null = null;
    const paint = (time: number) => {
      const f = insertFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed, rightClick: f.state.rightClick });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.spliced);
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

  const edges = wiringFor(state.node, wiring);
  const showRound = state.node === 'present' || state.node === 'selected';
  const intoColor = edges.find((e) => e.target === INSERT_TARGET && e.targetHandle === 'color');
  const intoRound = wiring.spliced.find((e) => e.target === INSERTED);
  const wires = layout
    ? edges.flatMap((e: SceneEdge) => {
        const a = layout.anchors.out.get(key(e.source, e.sourceHandle));
        const b = layout.anchors.in.get(key(e.target, e.targetHandle));
        if (!a || !b) return [];
        const hovered = state.wireHover && state.node === 'absent';
        return [{ id: key(e.source, e.target), boost: hovered ? HOVER_EDGE_BOOST : 1, d: wirePaths(a, b, Position.Right, hovered ? HOVER_EDGE_BOOST : 1) }];
      })
    : [];
  const rows = results(state.typed);
  const finalRows = results(INSERT_QUERY.length);
  const focusedType = state.focus === 'round' ? insertedDef.type : state.focus === 'first' ? rows[0]?.type : null;

  return (
    <IntroStage stage={stage} keyCap={state.key ? 'Delete' : null}>
      <svg className="fs-intro__wires">
        {wires.map((w) => (
          <IntroWire key={w.id} ink={ink} boost={w.boost} d={w.d} />
        ))}
      </svg>
      <CardSocketLabels.Provider value={true}>
        <div ref={noiseRef} className="react-flow__node fs-intro__node" style={{ left: NOISE_AT.x, top: NOISE_AT.y }}>
          <NoiseCardContent {...noiseChrome} />
        </div>
        <div ref={outputRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}>
          <OutputCardContent
            {...outputChrome}
            wired={intoColor ? { color: wiredValue(SCENE_NODES, edges, intoColor).val } : undefined}
          />
        </div>
        <div
          ref={roundRef}
          className={`react-flow__node fs-intro__node${state.node === 'selected' ? ' selected' : ''}`}
          style={{ left: layout?.click.x ?? 0, top: layout?.click.y ?? 0, visibility: showRound ? 'visible' : 'hidden' }}
        >
          <ShaderCardContent
            {...roundChrome}
            portStates={intoRound ? { [intoRound.targetHandle]: wiredValue(SCENE_NODES, wiring.spliced, intoRound) } : undefined}
          />
        </div>
      </CardSocketLabels.Provider>

      {/* The edge menu (EdgeContextMenu's rows). */}
      <div
        ref={edgeMenuRef}
        className="context-menu fs-intro__menu"
        style={{ left: layout?.edgeMenu.x ?? 0, top: layout?.edgeMenu.y ?? 0, visibility: state.menu === 'edge' ? 'visible' : 'hidden' }}
      >
        <div className="context-menu__list">
          <button tabIndex={-1} data-intro-row="insert" className={`context-menu__item${state.focus === 'insert' ? ' context-menu__item--focused' : ''}`}>
            {t('Insert node', language)}
          </button>
          <button tabIndex={-1} className="context-menu__item">{t('Add routing point', language)}</button>
          <button tabIndex={-1} className="context-menu__item context-menu__item--danger">{t('Delete Connection', language)}</button>
        </div>
      </div>

      {/* The node search it opens (AddNodeMenu's input and rows), as typed so far. */}
      <div
        className="context-menu context-menu--add-node fs-intro__menu"
        style={{ left: layout?.addMenu.x ?? 0, top: layout?.addMenu.y ?? 0, visibility: state.menu === 'add' ? 'visible' : 'hidden' }}
      >
        <input
          className="context-menu__search"
          tabIndex={-1}
          readOnly
          value={INSERT_QUERY.slice(0, state.typed)}
          placeholder={t('Search nodes...', language)}
        />
        <div className="context-menu__list">
          {rows.map((def) => (
            <MenuRow key={def.type} def={def} focused={def.type === focusedType} language={language} costLow={costLow} costHigh={costHigh} />
          ))}
        </div>
      </div>
      {/* The same search fully typed, never shown: where the Round row WILL be. */}
      <div ref={probeRef} className="context-menu context-menu--add-node fs-intro__menu" style={{ visibility: 'hidden' }}>
        <input className="context-menu__search" tabIndex={-1} readOnly value={INSERT_QUERY} />
        <div className="context-menu__list">
          {finalRows.map((def) => (
            <MenuRow key={def.type} def={def} focused={false} language={language} costLow={costLow} costHigh={costHigh} probe />
          ))}
        </div>
      </div>
    </IntroStage>
  );
}
