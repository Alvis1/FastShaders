import { useMemo, type RefObject } from 'react';
import {
  WAVE_SIZE,
  WAVE_GRID_YS,
  waveScreenY,
  buildWavePath,
  waveTranslateX,
  waveLabel,
  waveLabelWidth,
} from '@/utils/waveform';

/**
 * The sin/cos waveform plot as an SVG — the ONE renderer behind the live
 * MathPreviewNode and its asset-card twin (which used to repaint a private
 * canvas copy of the same picture; shared geometry beats a copied replica).
 *
 * Vector output stays sharp under the React Flow viewport zoom, where the old
 * fixed-72px canvas bitmap blurred, and it removes a canvas from the viewport
 * entirely — the `willReadFrequently` CPU-backing convention exists only to
 * dodge WebKit's overlap-compositing blur, and an SVG never enters that
 * minefield.
 *
 * Animation contract: the initial render is fully declarative from `phase`.
 * A live node overwrites ONLY via `applyWaveFrame` + the `dynamicRefs` it
 * passed — the imperative writer lives in this file and computes every value
 * through the same pure helpers as the JSX, so the two paths cannot drift.
 * (Per-frame React state is deliberately avoided — the established rAF-ref
 * pattern of PreviewNode/MathPreviewNode.)
 */

const ACCENT = '#6C63FF';
const LABEL_BASELINE_Y = WAVE_SIZE - 3;
const PILL_H = 10;
const DOT_CX = WAVE_SIZE / 2;

export interface WaveformDynamicRefs {
  curve: RefObject<SVGPathElement>;
  drop: RefObject<SVGLineElement>;
  dot: RefObject<SVGCircleElement>;
  pill: RefObject<SVGRectElement>;
  text: RefObject<SVGTextElement>;
}

/**
 * Overwrite the dynamic attributes for a new phase. Same semantics as the
 * declarative render: non-finite input/value hides the dot and drop line and
 * degrades the readout to "…". The label (and its pill width) is only
 * touched when the string actually changes — pass `lastLabel` storage.
 */
export function applyWaveFrame(
  refs: WaveformDynamicRefs,
  func: (x: number) => number,
  funcLabel: string,
  phase: number,
  lastLabel: { current: string | null },
): void {
  const { curve, drop, dot, pill, text } = refs;
  const val = func(phase);
  const finite = Number.isFinite(phase) && Number.isFinite(val);

  curve.current?.setAttribute('transform', `translate(${waveTranslateX(phase)} 0)`);

  if (dot.current && drop.current) {
    if (finite) {
      const sy = waveScreenY(val);
      dot.current.setAttribute('cy', String(sy));
      drop.current.setAttribute('y2', String(sy));
      dot.current.setAttribute('visibility', 'visible');
      drop.current.setAttribute('visibility', 'visible');
    } else {
      dot.current.setAttribute('visibility', 'hidden');
      drop.current.setAttribute('visibility', 'hidden');
    }
  }

  const label = waveLabel(funcLabel, phase, val);
  if (label !== lastLabel.current && pill.current && text.current) {
    lastLabel.current = label;
    text.current.textContent = label;
    const pw = waveLabelWidth(label);
    pill.current.setAttribute('x', String(DOT_CX - pw / 2));
    pill.current.setAttribute('width', String(pw));
  }
}

export function WaveformSvg({
  func,
  funcLabel,
  phase,
  showReadout,
  dynamicRefs,
}: {
  func: (x: number) => number;
  funcLabel: string;
  /** Input value at the plot center (the dot rides the curve there). */
  phase: number;
  /** False = curve only (a connected, time-less input shows no dot/readout). */
  showReadout: boolean;
  /** Live nodes pass refs so their rAF loop can call applyWaveFrame. */
  dynamicRefs?: WaveformDynamicRefs;
}) {
  const pathD = useMemo(() => buildWavePath(func), [func]);
  const axisY = waveScreenY(0);
  const val = func(phase);
  const finite = Number.isFinite(phase) && Number.isFinite(val);
  const dotY = finite ? waveScreenY(val) : axisY;
  const label = waveLabel(funcLabel, phase, val);
  const pillW = waveLabelWidth(label);

  return (
    <svg
      className="math-preview-node__canvas"
      viewBox={`0 0 ${WAVE_SIZE} ${WAVE_SIZE}`}
      width={WAVE_SIZE}
      height={WAVE_SIZE}
      aria-hidden="true"
    >
      <rect width={WAVE_SIZE} height={WAVE_SIZE} fill="rgba(0, 0, 0, 0.04)" />
      <g stroke="rgba(0, 0, 0, 0.08)" strokeWidth={0.5} strokeDasharray="2 2">
        {WAVE_GRID_YS.map((y) => (
          <line key={y} x1={0} y1={waveScreenY(y)} x2={WAVE_SIZE} y2={waveScreenY(y)} />
        ))}
      </g>
      <line x1={0} y1={axisY} x2={WAVE_SIZE} y2={axisY} stroke="rgba(0, 0, 0, 0.18)" strokeWidth={1} />
      <path
        ref={dynamicRefs?.curve}
        d={pathD}
        transform={`translate(${waveTranslateX(phase)} 0)`}
        fill="none"
        stroke={ACCENT}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {showReadout && (
        <>
          <line
            ref={dynamicRefs?.drop}
            x1={DOT_CX}
            y1={axisY}
            x2={DOT_CX}
            y2={dotY}
            visibility={finite ? 'visible' : 'hidden'}
            stroke="rgba(0, 0, 0, 0.15)"
            strokeWidth={0.5}
            strokeDasharray="2 2"
          />
          <circle
            ref={dynamicRefs?.dot}
            cx={DOT_CX}
            cy={dotY}
            r={3}
            visibility={finite ? 'visible' : 'hidden'}
            fill={ACCENT}
            stroke="rgba(255, 255, 255, 0.8)"
            strokeWidth={1}
          />
          <rect
            ref={dynamicRefs?.pill}
            x={DOT_CX - pillW / 2}
            y={LABEL_BASELINE_Y - PILL_H + 2}
            width={pillW}
            height={PILL_H}
            rx={2}
            fill="rgba(255, 255, 255, 0.75)"
          />
          <text
            ref={dynamicRefs?.text}
            x={DOT_CX}
            y={LABEL_BASELINE_Y}
            textAnchor="middle"
            fill="rgba(0, 0, 0, 0.65)"
            style={{ font: '8px "JetBrains Mono", monospace' }}
          >
            {label}
          </text>
        </>
      )}
    </svg>
  );
}
