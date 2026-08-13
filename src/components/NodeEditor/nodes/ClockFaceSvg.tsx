import type { RefObject } from 'react';
import { CLOCK_SIZE, CLOCK_R, clockTicks, clockHandAngle } from '@/utils/clockFace';

/**
 * The Time node's clock face as an SVG — the ONE renderer behind the live
 * ClockNode and the asset-card tile (utils/clockFace owns the geometry).
 * Vector, so it stays crisp under the viewport zoom where the old fixed-56px
 * canvas bitmap blurred, and it removes another canvas from the React Flow
 * viewport (the WebKit overlap-compositing minefield).
 *
 * Animation contract (the WaveformSvg pattern): the initial render is
 * declarative from `phase`; the live node passes `handRef` and its rAF loop
 * overwrites ONLY the hand's rotation via `applyClockFrame` — both paths
 * compute the angle through the same `clockHandAngle`, so they cannot drift.
 */

const C = CLOCK_SIZE / 2;
const HAND_LEN = CLOCK_R - 6;
const TICKS = clockTicks();

/** Per-frame hand update — one rotate-transform write. */
export function applyClockFrame(handRef: RefObject<SVGGElement>, phase: number): void {
  handRef.current?.setAttribute('transform', `rotate(${clockHandAngle(phase)} ${C} ${C})`);
}

export function ClockFaceSvg({
  phase,
  handRef,
}: {
  /** Hand position in seconds (one sweep per 60; 0 = 12 o'clock). */
  phase: number;
  /** The live node's rAF loop rotates the hand through this. */
  handRef?: RefObject<SVGGElement>;
}) {
  return (
    <svg
      className="clock-node__canvas"
      viewBox={`0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}`}
      width={CLOCK_SIZE}
      height={CLOCK_SIZE}
      aria-hidden="true"
    >
      <circle cx={C} cy={C} r={CLOCK_R} fill="#fff" stroke="#ccc" strokeWidth={1.5} />
      <g stroke="#999" strokeWidth={1.5}>
        {TICKS.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
        ))}
      </g>
      <g ref={handRef} transform={`rotate(${clockHandAngle(phase)} ${C} ${C})`}>
        <line
          x1={C}
          y1={C}
          x2={C}
          y2={C - HAND_LEN}
          stroke="#e74c3c"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      </g>
      <circle cx={C} cy={C} r={2} fill="#e74c3c" />
    </svg>
  );
}
