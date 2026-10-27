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
 * pattern of PreviewNode/MathPreviewNode, now ticked by utils/frameTicker.)
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
 * Write an attribute only when its value moved. Compared against the DOM
 * itself, not a cache of earlier writes: React patches these same attributes
 * declaratively, and remounts the readout elements when `showReadout` flips,
 * so a cache could skip a write the element actually needs. A getAttribute is
 * a plain read — no layout. On the sin card most per-tick writes were
 * identical (the visibility pair always; the dot whenever the value sits
 * still).
 */
function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * Overwrite the dynamic attributes for a new phase. Same semantics as the
 * declarative render: non-finite input/value hides the dot and drop line and
 * degrades the readout to "…". Only attributes whose value changed are
 * written, and the label (and its pill width) is only touched when the string
 * actually changes — pass `lastLabel` storage.
 *
 * The CURVE follows `phase`; the dot, drop line and readout follow `readout`,
 * which is `phase` unless the caller knows better. A live card whose X has no
 * single value — a sampled field, or a chain the CPU cannot evaluate — still
 * scrolls the curve by the clock as decoration, but passes `readout: null`:
 * no dot, and "…" rather than sin(t) printed for a wire that is not t.
 */
export function applyWaveFrame(
  refs: WaveformDynamicRefs,
  func: (x: number) => number,
  funcLabel: string,
  phase: number,
  lastLabel: { current: string | null },
  readout: number | null = phase,
): void {
  const { curve, drop, dot, pill, text } = refs;
  const x = readout ?? NaN;
  const val = func(x);
  const finite = Number.isFinite(x) && Number.isFinite(val);

  if (curve.current) setAttr(curve.current, 'transform', `translate(${waveTranslateX(phase)} 0)`);

  if (dot.current && drop.current) {
    if (finite) {
      const sy = String(waveScreenY(val));
      setAttr(dot.current, 'cy', sy);
      setAttr(drop.current, 'y2', sy);
      setAttr(dot.current, 'visibility', 'visible');
      setAttr(drop.current, 'visibility', 'visible');
    } else {
      setAttr(dot.current, 'visibility', 'hidden');
      setAttr(drop.current, 'visibility', 'hidden');
    }
  }

  const label = waveLabel(funcLabel, x, val);
  if (label !== lastLabel.current && pill.current && text.current) {
    lastLabel.current = label;
    text.current.textContent = label;
    const pw = waveLabelWidth(label);
    setAttr(pill.current, 'x', String(DOT_CX - pw / 2));
    setAttr(pill.current, 'width', String(pw));
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
  /** Live nodes pass refs so their frame loop can call applyWaveFrame. */
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
