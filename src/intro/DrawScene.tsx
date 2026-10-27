/**
 * Intro scene — annotating the canvas: Draw on, a flower drawn freehand, Draw
 * off, then a sticky note from the right-click menu that names it.
 *
 * The ink is the board's own: the user's pen colour and opacity at width 7
 * (owner, 2026-10-18), drawn as DrawingLayer draws a stroke (`splinePath`, one `<g opacity>` at the
 * quantized opacity) behind the cards. The bar is the canvas bar's markup with
 * the real draw cluster (`DrawToolbarView`), the menu the Add menu's top rows,
 * the note a fresh note's face (`NoteFace`) at the size `addNote` gives it.
 * The canvas here is at 80% — the bar and the menu stay at chrome size, as
 * they do when the canvas is zoomed out. Nothing is written to the store.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { formatCategoryLabel, formatNodeLabel, t } from '@/i18n';
import { quantizeOpacity } from '@/utils/drawings';
import { NOTE_HEIGHT, NOTE_WIDTH } from '@/utils/noteDefaults';
import {
  CardSocketLabels,
  NoiseCardContent,
  OutputCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { NoteFace } from '@/components/NodeEditor/NoteTileCard';
import { DrawToolbarView } from '@/components/NodeEditor/DrawToolbar';
import { splinePath } from '@/components/NodeEditor/edges/bezierGeometry';
import { buildDrawTour, drawFrame, flowerStrokes, strokePrefix, type DrawState, type DrawTour } from './drawTour';
import { IntroStage, centre, paintCursor, placeMenu, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, wirePaths, wiredValue, useWireInk, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

/** The canvas zoom of this slide. */
const ZOOM = 0.8;
/** Flow positions. */
const NOISE_AT: Point = { x: 40, y: 44 };
const OUTPUT_AT: Point = { x: 480, y: 30 };
/** Where the note is asked for, in stage px — its top-left lands there. */
const NOTE_CLICK: Point = { x: 188, y: 106 };
/** What the note says — display text, so it follows the UI language. */
export const NOTE_TEXT = 'Flower';
/** The flower: its head's centre and outer radius, in stage px — the empty
 *  corner right of the note, clear of the bar and its pen settings. */
const FLOWER = flowerStrokes({ x: 468, y: 184 }, 30);

const noiseDef = NODE_REGISTRY.get('perlin')!;
const outputDef = NODE_REGISTRY.get('output')!;
const WIRE: SceneEdge = { source: 'intro-noise', sourceHandle: 'out', target: 'intro-output', targetHandle: 'color' };
const noop = () => {};
/** The demo pen's width, shown on the bar's width slider too. */
const PEN_WIDTH = 7;

const IDLE: DrawState = { draw: false, stroke: -1, menu: false, note: false, typed: 0, rightClick: false, pressed: false };

const flow = (p: Point): Point => ({ x: p.x / ZOOM, y: p.y / ZOOM });
const inkPath = (points: readonly Point[]) => (points.length > 1 ? splinePath(points.map((p) => [p.x, p.y] as [number, number])) : '');

export function DrawScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const drawColor = useAppStore((s) => s.drawColor);
  const drawOpacity = useAppStore((s) => s.drawOpacity);
  const bg = useAppStore((s) => s.nodeEditorBgColor);
  const ink = useWireInk();
  const noiseChrome = useCardChrome(noiseDef);
  const outputChrome = useCardChrome(outputDef);
  const wiredText = useMemo(
    () => wiredValue([{ id: WIRE.source, def: noiseDef }, { id: WIRE.target, def: outputDef }], [WIRE], WIRE).val,
    [],
  );
  const noteText = t(NOTE_TEXT, language);

  const noiseRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const strokeRefs = useRef<(SVGPathElement | null)[]>([]);
  const clockRef = useRef<number | null>(null);

  const [wire, setWire] = useState<{ wire: string; arrows: string } | null>(null);
  const [menuAt, setMenuAt] = useState<Point>(NOTE_CLICK);
  const [tour, setTour] = useState<DrawTour | null>(null);
  const [state, setState] = useState<DrawState>(IDLE);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const els = [noiseRef.current, outputRef.current, barRef.current, menuRef.current];
    if (!stageEl || els.some((e) => !e)) return;
    const [noiseW, outW, bar, menu] = els as HTMLDivElement[];
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const base = stageEl.getBoundingClientRect();
      const o = { x: 0, y: 0 };
      const out = box(noiseW.querySelector('.react-flow__handle-right[data-handleid="out"]'), base, o);
      const color = box(outW.querySelector('[data-handleid="color"]'), base, o);
      const drawBtn = box(bar.querySelector('.fs-draw-btn'), base, o);
      const mR = menu.getBoundingClientRect();
      const size = box(menu, mR, o);
      if (!out || !color || !drawBtn || !size) return;
      const at = placeMenu(NOTE_CLICK, size);
      const row = box(menu.querySelector('[data-intro-row="note"]'), mR, at);
      if (!row) return;
      const colorIn = { x: color.x, y: centre(color).y };
      setWire(wirePaths(flow({ x: out.x + out.w, y: centre(out).y }), flow(colorIn), Position.Right));
      setMenuAt(at);
      setTour(
        buildDrawTour(
          {
            drawBtn: centre(drawBtn),
            strokes: FLOWER,
            noteClick: NOTE_CLICK,
            noteRow: { x: row.x + Math.min(50, row.w / 3), y: centre(row).y },
          },
          noteText,
        ),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of els as HTMLDivElement[]) ro.observe(el);
    return () => ro.disconnect();
    // `noteText` follows the language.
  }, [stage.scale, stage.stageRef, noteText]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    const paths = strokeRefs.current;
    if (!tour || !scene || !cursor || tour.geo.strokes.some((_, i) => !paths[i])) return;
    let shown: DrawState | null = null;
    const paint = (time: number) => {
      const f = drawFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed, rightClick: f.state.rightClick });
      tour.geo.strokes.forEach((s, i) => {
        paths[i]!.setAttribute('d', inkPath(strokePrefix(s, f.progress[i])));
      });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
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
  }, [tour, stage.sceneRef, stage.cursorRef]);

  const noteFlow = flow(NOTE_CLICK);

  return (
    <IntroStage stage={stage}>
      {/* The ink, behind the cards (DrawingLayer's z order), in stage px. */}
      <svg className="fs-intro__wires" aria-hidden="true">
        <g opacity={quantizeOpacity(drawOpacity)}>
          {FLOWER.map((_, i) => (
            <path
              key={i}
              ref={(el) => {
                strokeRefs.current[i] = el;
              }}
              stroke={drawColor}
              strokeWidth={PEN_WIDTH * ZOOM}
              strokeOpacity={1}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
      </svg>

      <div className="fs-intro__graph" style={{ transform: `scale(${ZOOM})` }}>
        <svg className="fs-intro__wires">{wire && <IntroWire ink={ink} d={wire} />}</svg>
        <CardSocketLabels.Provider value={true}>
          <div ref={noiseRef} className="react-flow__node fs-intro__node" style={{ left: NOISE_AT.x, top: NOISE_AT.y }}>
            <NoiseCardContent {...noiseChrome} />
          </div>
          <div ref={outputRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}>
            <OutputCardContent {...outputChrome} wired={{ color: wiredText }} />
          </div>
        </CardSocketLabels.Provider>
        {state.note && (
          <div className="react-flow__node fs-intro__node fs-intro__note" style={{ left: noteFlow.x, top: noteFlow.y }}>
            <NoteFace
              width={NOTE_WIDTH}
              height={NOTE_HEIGHT}
              text={noteText.slice(0, state.typed)}
              typing={state.typed < noteText.length ? <span className="fs-intro__note-caret" /> : undefined}
              language={language}
            />
          </div>
        )}
      </div>

      {/* The canvas bar (NodeEditor's bottom-left Panel): history, the real
          draw cluster with the backdrop swatch, zoom, fit and pan — drawn inert. */}
      <div ref={barRef} className="react-flow__panel bottom left fs-canvas-bar">
        <div className="fs-canvas-bar__group fs-canvas-bar__group--history">
          <button type="button" tabIndex={-1} disabled className="fs-canvas-bar__btn fs-canvas-bar__btn--history">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
            </svg>
          </button>
          <button type="button" tabIndex={-1} disabled className="fs-canvas-bar__btn fs-canvas-bar__btn--history">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z" />
            </svg>
          </button>
        </div>
        <div className="fs-canvas-bar__group">
          <DrawToolbarView
            inert
            active={state.draw}
            eraser={false}
            opacity={drawOpacity}
            width={PEN_WIDTH}
            hasInk={state.stroke >= 0 || state.draw}
            language={language}
            swatch={<span className="palette-swatch fs-draw-swatch" style={{ background: drawColor }} />}
            onActive={noop}
            onEraser={noop}
            onOpacity={noop}
            onWidth={noop}
            onClear={noop}
          />
          <button type="button" tabIndex={-1} className="fs-canvas-bar__btn node-editor__bg-color-btn">
            <span className="node-editor__bg-color-swatch" style={{ background: bg }} />
          </button>
        </div>
        <div className="fs-canvas-bar__group">
          <button type="button" tabIndex={-1} className="fs-canvas-bar__btn">−</button>
          <button type="button" tabIndex={-1} className="fs-canvas-bar__btn">+</button>
          <button type="button" tabIndex={-1} className="fs-canvas-bar__btn">⤢</button>
          <button type="button" tabIndex={-1} className="fs-canvas-bar__btn fs-canvas-bar__btn--pan">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 2l3.5 3.5h-2.5v5.5h5.5v-2.5l3.5 3.5-3.5 3.5v-2.5h-5.5v5.5h2.5l-3.5 3.5-3.5-3.5h2.5v-5.5h-5.5v2.5l-3.5-3.5 3.5-3.5v2.5h5.5v-5.5h-2.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* The Add menu (AddNodeMenu), its top rows: the Output, then Annotate. */}
      <div
        ref={menuRef}
        className="context-menu context-menu--add-node fs-intro__menu"
        style={{ left: menuAt.x, top: menuAt.y, visibility: state.menu ? 'visible' : 'hidden' }}
      >
        <input className="context-menu__search" tabIndex={-1} readOnly value="" placeholder={t('Search nodes...', language)} />
        <div className="context-menu__list">
          <div className="context-menu__category">{formatCategoryLabel('Output', 'output', language, true)}</div>
          <button type="button" tabIndex={-1} className="context-menu__item">
            <span>{formatNodeLabel('Output', 'output', language)}</span>
            <span className="context-menu__item-category">output</span>
          </button>
          <div className="context-menu__category">{t('Annotate', language)}</div>
          <button
            type="button"
            tabIndex={-1}
            data-intro-row="note"
            className={`context-menu__item${state.menu && state.pressed ? ' context-menu__item--focused' : ''}`}
          >
            <span>{t('Add Note', language)}</span>
            <span className="context-menu__item-category">note</span>
          </button>
        </div>
      </div>
    </IntroStage>
  );
}
