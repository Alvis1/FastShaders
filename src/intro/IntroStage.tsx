/**
 * The small canvas every intro scene plays on: the user's canvas colour and
 * grid at zoom 1, scaled to the window from a wrapper, plus a pointer and a
 * key cap the scene moves imperatively.
 *
 * It wears `node-editor` and `react-flow` only as SCOPES — the canvas's
 * drag-connect rules and in-canvas node rules are written under them
 * (IntroWindow.css undoes `.node-editor`'s pane layout).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { canvasGridColor, canvasInkColor, canvasInkShadow } from '@/utils/colorUtils';
import type { Point } from './timeline';

/** The stage in canvas px (zoom 1). */
export const STAGE_W = 560;
export const STAGE_H = 300;
const MAX_SCALE = 1.25;

export function useIntroStage() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(MAX_SCALE, el.clientWidth / STAGE_W) || 1);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { viewportRef, stageRef, sceneRef, cursorRef, scale };
}

export type IntroStageHandle = ReturnType<typeof useIntroStage>;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A measuring function in stage px: an element's box relative to `base` (its
 * wrapper), placed at `at` (the wrapper's stage position). Relative to the
 * wrapper, so a translate on the wrapper (a drag in progress) cancels out.
 */
export function stageMeasurer(stage: HTMLElement) {
  const s = stage.getBoundingClientRect().width / STAGE_W;
  if (!(s > 0)) return null;
  return (el: Element | null, base: DOMRect, at: Point): Box | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: at.x + (r.left - base.left) / s, y: at.y + (r.top - base.top) / s, w: r.width / s, h: r.height / s };
  };
}

export const centre = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** A menu placed at the click point, kept inside the stage (ContextMenu clamps
 *  to the viewport the same way). */
export function placeMenu(at: Point, size: Box): Point {
  return {
    x: Math.max(4, Math.min(at.x, STAGE_W - size.w - 4)),
    y: Math.max(4, Math.min(at.y, STAGE_H - size.h - 4)),
  };
}

/** Move the pointer; the arrow's tip is at (x, y). */
export function paintCursor(
  cursor: SVGSVGElement,
  p: Point,
  state: { pressed?: boolean; rightClick?: boolean },
): void {
  // The viewBox starts at -1, so the tip sits 1px into the svg.
  cursor.style.transform = `translate(${p.x - 1}px, ${p.y - 1}px)`;
  cursor.classList.toggle('fs-intro__cursor--pressed', !!state.pressed);
  cursor.classList.toggle('fs-intro__cursor--right', !!state.rightClick);
}

export function IntroStage({
  stage,
  keyCap,
  children,
}: {
  stage: IntroStageHandle;
  /** A key being pressed, shown as a key cap under the scene. */
  keyCap?: string | null;
  children: ReactNode;
}) {
  const bg = useAppStore((s) => s.nodeEditorBgColor);
  const ink = canvasInkColor(bg);
  return (
    <div ref={stage.viewportRef} className="fs-intro__viewport" style={{ height: STAGE_H * stage.scale }}>
      <div
        ref={stage.stageRef}
        className="node-editor react-flow fs-intro__stage"
        style={{
          width: STAGE_W,
          height: STAGE_H,
          transform: `scale(${stage.scale})`,
          background: bg,
          ...({ '--node-cost-text': ink, '--node-cost-text-shadow': canvasInkShadow(ink) } as React.CSSProperties),
        }}
        aria-hidden="true"
      >
        {/* React Flow's Cross background at the canvas's gap 20 / size 1. */}
        <svg className="fs-intro__grid" width={STAGE_W} height={STAGE_H}>
          <pattern id="fs-intro-grid" width={20} height={20} patternUnits="userSpaceOnUse">
            <path d="M0.5 0 V1 M0 0.5 H1" stroke={canvasGridColor(ink)} strokeWidth={1} />
          </pattern>
          <rect width="100%" height="100%" fill="url(#fs-intro-grid)" />
        </svg>
        <div ref={stage.sceneRef} className="fs-intro__scene" style={{ opacity: 0 }}>
          {children}
          <svg ref={stage.cursorRef} className="fs-intro__cursor" width={22} height={26} viewBox="-1 -1 22 26">
            <circle className="fs-intro__cursor-ring" cx={0} cy={0} r={8} />
            <path d="M0 0 L0 17 L4.5 12.5 L7.5 19.5 L10 18.5 L7 11.5 L13 11.5 Z" fill="#111" stroke="#fff" strokeWidth={1.2} strokeLinejoin="round" />
            {/* A mouse with its RIGHT button lit, beside the arrow, while the
                scene right-clicks. */}
            <g className="fs-intro__mouse" transform="translate(15 15)">
              <rect x={0} y={0} width={14} height={20} rx={7} fill="#fff" stroke="#111" strokeWidth={1.2} />
              <path d="M7 0 V8 M0 8 H14" stroke="#111" strokeWidth={1} fill="none" />
              <path className="fs-intro__mouse-right" d="M7.6 0.7 A6.4 6.4 0 0 1 13.4 7.4 L7.6 7.4 Z" />
            </g>
          </svg>
          {keyCap && <kbd className="fs-intro__key">{keyCap}</kbd>}
        </div>
      </div>
    </div>
  );
}
