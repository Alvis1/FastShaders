/**
 * Intro scene 1 — open the node search with Space or a right-click on empty
 * canvas, type "noise", click a result: the node lands where the menu opened.
 *
 * Same rules as InsertScene: the tiles' card replicas at canvas size, nothing
 * written to the store's graph, a requestAnimationFrame loop that moves only
 * the pointer. The menu is AddNodeMenu's own markup (InsertScene's `MenuRow`);
 * its rows are the real `searchNodes`, filtered by the user's own optional
 * categories, and the two rows picked come from that list (searchTour.ts).
 * Space opens the menu at the canvas CENTRE, as the canvas does; a right-click
 * opens it at the pointer.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { searchNodes } from '@/registry/nodeRegistry';
import { hiddenOptionalCategories } from '@/registry/optionalCategories';
import { t } from '@/i18n';
import { CardSocketLabels, NoiseCardContent, useCardChrome } from '@/components/NodeEditor/NodePreviewCard';
import type { NodeDefinition } from '@/types';
import {
  SEARCH_QUERY,
  SEARCH_ROWS,
  buildSearchTour,
  searchFrame,
  searchPicks,
  type SearchState,
  type SearchTour,
} from './searchTour';
import { IntroStage, STAGE_H, STAGE_W, centre, paintCursor, placeMenu, stageMeasurer, useIntroStage } from './IntroStage';
import { MenuRow } from './InsertScene';
import type { Point } from './timeline';

/** Where Space opens the search: the middle of the canvas, a little high so
 *  the node that lands there stays on the stage. */
const CENTRE: Point = { x: Math.round(STAGE_W / 2), y: Math.round(STAGE_H / 2) - 40 };
/** The right-click on empty canvas, left of the first node. */
const CLICK: Point = { x: 70, y: 40 };

const IDLE: SearchState = { menu: 'none', typed: 0, focus: null, placed: 0, rightClick: false, pressed: false, key: false };

interface Layout {
  spaceMenu: Point;
  rightMenu: Point;
}

/** A placed node: the noise card, as the canvas draws it. */
function PlacedNode({ def, at, show }: { def: NodeDefinition; at: Point; show: boolean }) {
  const chrome = useCardChrome(def);
  return (
    <div className="react-flow__node fs-intro__node" style={{ left: at.x, top: at.y, visibility: show ? 'visible' : 'hidden' }}>
      <NoiseCardContent {...chrome} />
    </div>
  );
}

export function SearchScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const optional = useAppStore((s) => s.optionalCategories);
  const costLow = useAppStore((s) => s.costColorLow);
  const costHigh = useAppStore((s) => s.costColorHigh);
  const hidden = useMemo(() => hiddenOptionalCategories(optional), [optional]);
  const results = (typed: number) => {
    const q = SEARCH_QUERY.slice(0, typed);
    return q ? searchNodes(q, hidden).filter((d) => d.type !== 'output').slice(0, SEARCH_ROWS) : [];
  };
  const finalRows = useMemo(
    () => searchNodes(SEARCH_QUERY, hidden).filter((d) => d.type !== 'output').slice(0, SEARCH_ROWS),
    [hidden],
  );
  const picks = useMemo(() => searchPicks(finalRows), [finalRows]);

  const probeRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [tour, setTour] = useState<SearchTour | null>(null);
  const [state, setState] = useState<SearchState>(IDLE);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const probe = probeRef.current;
    if (!stageEl || !probe || !picks) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const pR = probe.getBoundingClientRect();
      const size = box(probe, pR, { x: 0, y: 0 });
      if (!size) return;
      const spaceMenu = placeMenu(CENTRE, size);
      const rightMenu = placeMenu(CLICK, size);
      const row = (type: string, menuAt: Point) => box(probe.querySelector(`[data-intro-row="${type}"]`), pR, menuAt);
      const first = row(picks[0].type, spaceMenu);
      const second = row(picks[1].type, rightMenu);
      if (!first || !second) return;
      setLayout({ spaceMenu, rightMenu });
      // The pointer lands on a row a little left of its centre, on the label.
      setTour(buildSearchTour({
        centre: CENTRE,
        click: CLICK,
        firstRow: { x: first.x + Math.min(60, first.w / 3), y: centre(first).y },
        secondRow: { x: second.x + Math.min(60, second.w / 3), y: centre(second).y },
      }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(probe);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef, picks]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!tour || !scene || !cursor) return;
    // Each step carries ONE state object, so identity says "the step changed".
    let shown: SearchState | null = null;
    const paint = (time: number) => {
      const f = searchFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed, rightClick: f.state.rightClick });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.both);
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

  const rows = results(state.typed);
  const pick = picks ? picks[state.menu === 'right' ? 1 : 0] : null;
  const focusedType = state.focus === 'pick' ? pick?.type : state.focus === 'first' ? rows[0]?.type : null;
  const menuAt = state.menu === 'right' ? layout?.rightMenu : layout?.spaceMenu;

  return (
    <IntroStage stage={stage} keyCap={state.key ? t('Space', language) : null}>
      {picks && (
        <CardSocketLabels.Provider value={true}>
          <PlacedNode def={picks[0]} at={CENTRE} show={state.placed >= 1} />
          <PlacedNode def={picks[1]} at={CLICK} show={state.placed >= 2} />
        </CardSocketLabels.Provider>
      )}

      {/* The node search (AddNodeMenu's input and rows), as typed so far. */}
      <div
        className="context-menu context-menu--add-node fs-intro__menu"
        style={{ left: menuAt?.x ?? 0, top: menuAt?.y ?? 0, visibility: state.menu !== 'none' ? 'visible' : 'hidden' }}
      >
        <input
          className="context-menu__search"
          tabIndex={-1}
          readOnly
          value={SEARCH_QUERY.slice(0, state.typed)}
          placeholder={t('Search nodes...', language)}
        />
        <div className="context-menu__list">
          {rows.map((def) => (
            <MenuRow key={def.type} def={def} focused={def.type === focusedType} language={language} costLow={costLow} costHigh={costHigh} />
          ))}
        </div>
      </div>
      {/* The same search fully typed, never shown: where the picked rows WILL be. */}
      <div ref={probeRef} className="context-menu context-menu--add-node fs-intro__menu" style={{ visibility: 'hidden' }}>
        <input className="context-menu__search" tabIndex={-1} readOnly value={SEARCH_QUERY} />
        <div className="context-menu__list">
          {finalRows.map((def) => (
            <MenuRow key={def.type} def={def} focused={false} language={language} costLow={costLow} costHigh={costHigh} probe />
          ))}
        </div>
      </div>
    </IntroStage>
  );
}
