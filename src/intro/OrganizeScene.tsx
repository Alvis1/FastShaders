/**
 * Intro scene — Organize: nine nodes in a heap, wires crossing every which
 * way; a marquee selects them, a right-click on the selection opens the canvas
 * menu, and Selection → Organize lays them out.
 *
 * Same rules as the other scenes: the tiles' card replicas at canvas size
 * (the graph zoomed out from a wrapper, as the canvas zooms), nothing written
 * to the store's graph. Where the nodes go is the canvas's own Organize
 * (`organizeLayout`, organizeTour.ts) over each card's measured box; the
 * marquee selects the way the canvas's does (Partial — a node it touches),
 * and draws, like the box that stays round a selection, through the canvas's
 * own classes. The menu is AddNodeMenu's markup with its Selection rows.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { formatCategoryLabel, formatNodeLabel, t } from '@/i18n';
import { getLiveUpstreamSet } from '@/engine/cpuEvaluator';
import { estimateNodeSize } from '@/engine/layoutEngine';
import { CardSocketLabels } from '@/components/NodeEditor/NodePreviewCard';
import {
  CHAOS,
  buildOrganizeTour,
  marqueeHits,
  nodeAt,
  organizeFrame,
  organizeGraph,
  organizedPositions,
  type OrganizeState,
  type OrganizeTour,
  type Size,
} from './organizeTour';
import { IntroStage, STAGE_H, STAGE_W, centre, type Box, paintCursor, placeMenu, stageMeasurer, useIntroStage } from './IntroStage';
import { GraphCard, IntroWire, edgePortState, wirePaths, useWireInk } from './sceneGraph';
import type { Point } from './timeline';

/** Stage px kept clear round the fitted graph, and the cost badges' room
 *  above a card (flow px). */
const PAD = 18;
const BADGE = 26;
/** How far outside the heap the marquee starts and ends (stage px). */
const MARQUEE_OUT = 10;

const IDLE: OrganizeState = { marquee: false, selected: false, menu: false, organized: false, rightClick: false, pressed: false };

/** Two measurements agree to half a pixel, key by key. */
function sameNumbers<T extends object>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) {
    const u = a.get(k) as Record<string, number> | undefined;
    if (!u) return false;
    for (const [f, n] of Object.entries(v as Record<string, number>)) if (Math.abs(u[f] - n) >= 0.5) return false;
  }
  return true;
}

const sockKey = (node: string, handle: string, io: 'in' | 'out') => `${node}\0${handle}\0${io}`;

export function OrganizeScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const ink = useWireInk();
  const graph = useMemo(organizeGraph, []);
  const live = useMemo(() => getLiveUpstreamSet(graph.nodes, graph.edges), [graph]);
  const channels = useMemo(
    () =>
      new Map(
        graph.edges.map((e) => [
          e.id,
          edgePortState(graph.nodes, graph.edges, {
            source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, targetHandle: e.targetHandle ?? 'in',
          }).ch,
        ]),
      ),
    [graph],
  );
  const chaos = useMemo(() => new Map(Object.entries(CHAOS)), []);

  const layerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);

  /** Each card's layout box (flow px) — React Flow's `measured`, which
   *  Organize lays out by — and each socket's place on its card. */
  const [sizes, setSizes] = useState<Map<string, Size> | null>(null);
  const [sockets, setSockets] = useState<Map<string, Point> | null>(null);
  /** What each card paints, relative to its position (flow px): an expensive
   *  card is drawn larger than its layout box (getCostScale). */
  const [painted, setPainted] = useState<Map<string, Box> | null>(null);
  const organized = useMemo(() => (sizes ? organizedPositions(sizes) : null), [sizes]);
  /** A card's painted box at `p` (flow px); the layout engine's estimate
   *  until the cards are measured. */
  const paintedBox = (id: string, p: Point): Box => {
    const m = painted?.get(id);
    if (m) return { x: p.x + m.x, y: p.y + m.y, w: m.w, h: m.h };
    const n = graph.nodes.find((q) => q.id === id)!;
    const e = estimateNodeSize(n, graph.edges.filter((x) => x.target === id).length);
    return { x: p.x, y: p.y, w: e.width, h: e.height };
  };

  // The camera: the heap and the organized graph both in view, held still.
  const view = useMemo(() => {
    const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const places of [chaos, organized ?? new Map<string, Point>()]) {
      for (const [id, p] of places) {
        const box = paintedBox(id, p);
        b.x1 = Math.min(b.x1, box.x);
        b.y1 = Math.min(b.y1, box.y - BADGE);
        b.x2 = Math.max(b.x2, box.x + box.w);
        b.y2 = Math.max(b.y2, box.y + box.h);
      }
    }
    const zoom = Math.min(1, (STAGE_W - 2 * PAD) / (b.x2 - b.x1), (STAGE_H - 2 * PAD) / (b.y2 - b.y1));
    return {
      x: (STAGE_W - (b.x2 - b.x1) * zoom) / 2 - b.x1 * zoom,
      y: (STAGE_H - (b.y2 - b.y1) * zoom) / 2 - b.y1 * zoom,
      zoom,
    };
  }, [chaos, organized, painted]);
  const toStage = (p: Point): Point => ({ x: view.x + p.x * view.zoom, y: view.y + p.y * view.zoom });

  const [tour, setTour] = useState<OrganizeTour | null>(null);
  const [menuAt, setMenuAt] = useState<Point>({ x: 0, y: 0 });
  const [state, setState] = useState<OrganizeState>(IDLE);
  const [pos, setPos] = useState<ReadonlyMap<string, Point>>(chaos);
  /** The nodes the marquee holds so far, while it is dragged. */
  const [hits, setHits] = useState<ReadonlySet<string>>(new Set());

  // The cards' boxes and sockets. A layout box ignores every transform (the
  // camera's zoom, a card's cost scale), as React Flow's measurement does;
  // a socket is measured where it is drawn.
  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const layer = layerRef.current;
    if (!stageEl || !layer) return;
    const measure = () => {
      const k = (stageEl.getBoundingClientRect().width / STAGE_W) * view.zoom;
      if (!(k > 0)) return;
      const nextSizes = new Map<string, Size>();
      const nextPainted = new Map<string, Box>();
      const nextSockets = new Map<string, Point>();
      for (const el of layer.querySelectorAll<HTMLElement>('[data-node]')) {
        const id = el.dataset.node!;
        nextSizes.set(id, { width: el.offsetWidth, height: el.offsetHeight });
        const base = el.getBoundingClientRect();
        // What the card PAINTS, cost scale included — what the camera fits.
        const card = (el.firstElementChild ?? el).getBoundingClientRect();
        nextPainted.set(id, {
          x: (card.left - base.left) / k,
          y: (card.top - base.top) / k,
          w: card.width / k,
          h: card.height / k,
        });
        const put = (handle: string, io: 'in' | 'out', h: Element) => {
          const r = h.getBoundingClientRect();
          nextSockets.set(sockKey(id, handle, io), {
            x: ((io === 'out' ? r.right : r.left) - base.left) / k,
            y: (r.top + r.height / 2 - base.top) / k,
          });
        };
        // React Flow handles (the Output, Time, Sin, a noise), then
        // NodeVisual's static sockets (a shader card) — BudgetScene's lookup.
        for (const h of el.querySelectorAll<HTMLElement>('.react-flow__handle[data-handleid]')) {
          put(h.dataset.handleid!, h.classList.contains('react-flow__handle-right') ? 'out' : 'in', h);
        }
        for (const h of el.querySelectorAll<HTMLElement>('[data-port][data-io]')) {
          put(h.dataset.port!, h.dataset.io === 'out' ? 'out' : 'in', h);
        }
      }
      // Only a real change re-renders: the camera fits what is measured, so a
      // sub-pixel remeasure would otherwise move it, and remeasure, forever.
      setSizes((prev) => (prev && sameNumbers(prev, nextSizes) ? prev : nextSizes));
      setPainted((prev) => (prev && sameNumbers(prev, nextPainted) ? prev : nextPainted));
      setSockets((prev) => (prev && sameNumbers(prev, nextSockets) ? prev : nextSockets));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of layer.querySelectorAll('[data-node]')) ro.observe(el);
    return () => ro.disconnect();
  }, [view.zoom, stage.scale, stage.stageRef]);

  // The pointer's places: round the heap, on it, and on the menu's row.
  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const menu = menuRef.current;
    if (!stageEl || !menu || !sizes || !organized) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
      for (const [id, p] of chaos) {
        const q = paintedBox(id, p);
        const a = toStage({ x: q.x, y: q.y - BADGE });
        const z = toStage({ x: q.x + q.w, y: q.y + q.h });
        b.x1 = Math.min(b.x1, a.x);
        b.y1 = Math.min(b.y1, a.y);
        b.x2 = Math.max(b.x2, z.x);
        b.y2 = Math.max(b.y2, z.y);
      }
      const menuClick = { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
      const mR = menu.getBoundingClientRect();
      const size = box(menu, mR, { x: 0, y: 0 });
      if (!size) return;
      const at = placeMenu(menuClick, size);
      const row = box(menu.querySelector('[data-intro-row="organize"]'), mR, at);
      if (!row) return;
      setMenuAt(at);
      setTour(
        buildOrganizeTour({
          marqueeFrom: { x: Math.max(4, b.x1 - MARQUEE_OUT), y: Math.max(4, b.y1 - MARQUEE_OUT) },
          marqueeTo: { x: Math.min(STAGE_W - 4, b.x2 + MARQUEE_OUT), y: Math.min(STAGE_H - 4, b.y2 + MARQUEE_OUT) },
          menuClick,
          organizeRow: { x: row.x + Math.min(50, row.w / 3), y: centre(row).y },
          chaos,
          organized,
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(menu);
    return () => ro.disconnect();
  }, [sizes, painted, organized, view, chaos, stage.scale, stage.stageRef, language]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    const marquee = marqueeRef.current;
    if (!tour || !scene || !cursor || !marquee || !sizes) return;
    let shown: OrganizeState | null = null;
    let placed = '';
    let held = '';
    const paint = (time: number) => {
      const f = organizeFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed, rightClick: f.state.rightClick });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
      const at = new Map([...chaos.keys()].map((id) => [id, nodeAt(f.key, id)]));
      const sig = [...at.values()].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      if (sig !== placed) {
        placed = sig;
        setPos(at);
      }
      // The live band, and the nodes it touches so far.
      const from = tour.geo.marqueeFrom;
      marquee.style.visibility = f.state.marquee ? 'visible' : 'hidden';
      let inside = new Set<string>();
      if (f.state.marquee) {
        marquee.style.left = `${Math.min(from.x, f.cursor.x)}px`;
        marquee.style.top = `${Math.min(from.y, f.cursor.y)}px`;
        marquee.style.width = `${Math.abs(f.cursor.x - from.x)}px`;
        marquee.style.height = `${Math.abs(f.cursor.y - from.y)}px`;
        inside = marqueeHits(
          from,
          f.cursor,
          [...at].map(([id, p]) => {
            const s = sizes.get(id)!;
            return { id, x: view.x + p.x * view.zoom, y: view.y + p.y * view.zoom, w: s.width * view.zoom, h: s.height * view.zoom };
          }),
        );
      }
      const hitSig = [...inside].sort().join(' ');
      if (hitSig !== held) {
        held = hitSig;
        setHits(inside);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.organized);
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
  }, [tour, sizes, view, chaos, stage.sceneRef, stage.cursorRef]);

  const wires = sockets
    ? graph.edges.flatMap((e) => {
        const s = pos.get(e.source);
        const g = pos.get(e.target);
        const a = sockets.get(sockKey(e.source, e.sourceHandle ?? 'out', 'out'));
        const b = sockets.get(sockKey(e.target, e.targetHandle ?? 'in', 'in'));
        if (!s || !g || !a || !b) return [];
        const ch = channels.get(e.id) ?? 1;
        return [{
          id: e.id,
          live: live.has(e.source),
          count: ch,
          d: wirePaths({ x: s.x + a.x, y: s.y + a.y }, { x: g.x + b.x, y: g.y + b.y }, Position.Right, 1, ch),
        }];
      })
    : [];

  // The box that stays round a selection: the selected cards' extent.
  const selection = (() => {
    if (!state.selected || state.marquee || !sizes) return null;
    const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const [id, p] of pos) {
      const s = sizes.get(id);
      if (!s) continue;
      b.x1 = Math.min(b.x1, p.x);
      b.y1 = Math.min(b.y1, p.y);
      b.x2 = Math.max(b.x2, p.x + s.width);
      b.y2 = Math.max(b.y2, p.y + s.height);
    }
    const a = toStage({ x: b.x1, y: b.y1 });
    return { left: a.x, top: a.y, width: (b.x2 - b.x1) * view.zoom, height: (b.y2 - b.y1) * view.zoom };
  })();

  const count = graph.nodes.length;
  const isSelected = (id: string) => (state.marquee ? hits.has(id) : state.selected);

  return (
    <IntroStage stage={stage}>
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
          {graph.nodes.map((n) => {
            const p = pos.get(n.id) ?? CHAOS[n.id];
            return (
              <div
                key={n.id}
                data-node={n.id}
                className={`react-flow__node fs-intro__node${isSelected(n.id) ? ' selected' : ''}`}
                style={{ left: p.x, top: p.y }}
              >
                <GraphCard node={n} graph={graph} />
              </div>
            );
          })}
        </CardSocketLabels.Provider>
      </div>

      {/* The live marquee band, and the box that stays round the selection
          (React Flow's own elements, in the canvas's styling). */}
      <div ref={marqueeRef} className="react-flow__selection fs-intro__marquee" style={{ visibility: 'hidden' }} />
      {selection && <div className="react-flow__nodesselection-rect fs-intro__marquee" style={selection} />}

      {/* The canvas menu on a selection (AddNodeMenu): its Selection rows
          first, Organize focused as the menu opens it. */}
      <div
        ref={menuRef}
        className="context-menu context-menu--add-node fs-intro__menu"
        style={{ left: menuAt.x, top: menuAt.y, visibility: state.menu ? 'visible' : 'hidden' }}
      >
        <input className="context-menu__search" tabIndex={-1} readOnly value="" placeholder={t('Search nodes...', language)} />
        <div className="context-menu__list">
          <div className="context-menu__category">{t('Selection', language)}</div>
          <button tabIndex={-1} data-intro-row="organize" className="context-menu__item context-menu__item--focused">
            <span>{t('Organize', language)}</span>
            <span className="context-menu__item-category">
              {count} {t('nodes', language)}
            </span>
          </button>
          <button tabIndex={-1} className="context-menu__item">
            <span>{t('Group Selection', language)}</span>
            <span className="context-menu__item-category">
              {count} {t('nodes', language)}
            </span>
          </button>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{formatCategoryLabel('Output', 'output', language, true)}</div>
          <button tabIndex={-1} className="context-menu__item">
            <span>{formatNodeLabel('Output', 'output', language)}</span>
            <span className="context-menu__item-category">output</span>
          </button>
          <div className="context-menu__category">{t('Annotate', language)}</div>
          <button tabIndex={-1} className="context-menu__item">
            <span>{t('Add Note', language)}</span>
            <span className="context-menu__item-category">note</span>
          </button>
        </div>
      </div>
    </IntroStage>
  );
}
