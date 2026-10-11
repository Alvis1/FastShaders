import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, SVGProps } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import { fillTemplate } from '@/utils/fillTemplate';
import { CurvesArt } from '../nodes/CurvesArt';
import {
  readRgbCurves,
  formatCurve,
  addPoint,
  movePoint,
  deletePoint,
  isCurveExtend,
  CURVE_KEYS,
  CURVE_CHANNELS,
  CURVE_MAX_POINTS,
  CURVE_MIN_POINTS,
  IDENTITY_CURVE,
  type CurveChannel,
  type CurvePoint,
  type RgbCurves,
} from '@/utils/rgbCurves';
import {
  useLutEditorWrites,
  useBracketedDrag,
  LazyNumberField,
  LutEditorRoot,
  LutStepper,
  ToolButton,
  TextureBudgetNotice,
  currentValues,
  setCanonical,
  type CanonicalOf,
  type CleanValues,
  type LutKey,
} from './lutEditorGestures';
import { hintStyle } from './menuShared';

/**
 * The RGB Curves editor — a section of NodeSettingsMenu, the Color Ramp
 * editor's sibling. Everything it writes is `values.curveC/R/G/B` /
 * `values.extend` in the canonical form utils/rgbCurves.ts formats (absent =
 * the identity line / Extrapolated), so the code panel, the card art and the
 * shader all read one string per curve; every write also drops whatever the
 * reader rejected, on any channel (`cleanCurves`).
 *
 * History (menus/lutEditorGestures.tsx): a drag, a held arrow key or a typed
 * number is ONE undo entry, opened LAZILY on the first write that changes the
 * active curve's canonical string — a tap on a point, or a nudge against a
 * neighbour or the box, costs nothing and keeps redo. Discrete acts (delete,
 * reset, extend) are one plain `updateNodeData` behind a no-op guard
 * (`writeDiscrete`). A channel switch re-keys the gates, and a drag still live
 * on the old channel ends there.
 *
 * Points never cross (x is clamped between the neighbours), so the selected
 * index is stable through drags, nudges and a typed X.
 *
 * Keys (`LutEditorRoot`, the Color Ramp editor's too): the root swallows every
 * key but Escape, Tab and Cmd/Ctrl+S (Apply), so Delete/X (delete the NODE),
 * A, F, Space, Cmd+D… never reach the canvas while focus is in here (Cmd+Z
 * included — accepted). The editor's own keys act only on the plot
 * (`data-fs-lut-key`) when it is not a typing target: React events bubble from
 * the number fields to this root too, and Backspace there must never delete
 * the selected point.
 */

const PLOT_W = 236;
const PLOT_H = 200;
const PAD = 6;
const IN_W = PLOT_W - 2 * PAD;
const IN_H = PLOT_H - 2 * PAD;
const HIT_HALF = 12;

const CHANNEL_TITLES: ReadonlyMap<CurveChannel, string> = new Map([
  ['c', 'Combined'],
  ['r', 'Red'],
  ['g', 'Green'],
  ['b', 'Blue'],
]);

/** One canonical reader per channel, at module scope: a reader is part of its gates' identity, so each channel's
 *  gates keep THEIR curve's reader (lutEditorGestures.tsx `useLutIo`) — a drag's gate made for C never compares
 *  against the curve a channel switch selected. */
const CANONICAL_OF: Readonly<Record<CurveChannel, CanonicalOf>> = Object.freeze({
  c: (v) => readRgbCurves(v).c.canonical,
  r: (v) => readRgbCurves(v).r.canonical,
  g: (v) => readRgbCurves(v).g.canonical,
  b: (v) => readRgbCurves(v).b.canonical,
});

/**
 * Every write's clean, whichever key the write was for: a curve (on ANY channel) or an `extend` the reader REJECTED
 * is dropped — it already reads as the straight line / Extrapolated, so nothing on screen changes — and a curve
 * whose handle tokens the reader dropped is stored in its canonical form (absent when that is the straight line).
 * A junk R curve, its notice and its code comment used to survive a C drag or an Extend pick, and so did "Handle
 * types … reset to Auto". A node with nothing rejected or re-spelled is left exactly as it was.
 */
export const cleanCurves: CleanValues = (v) => {
  const curves = readRgbCurves(v);
  for (const ch of CURVE_CHANNELS) {
    const read = curves[ch];
    if (read.rejected) delete v[CURVE_KEYS[ch]];
    else if (read.droppedHandles) setCanonical(v, CURVE_KEYS[ch], read.canonical, IDENTITY_CURVE);
  }
  if (curves.rejectedExtend) delete v.extend;
};

/** The node's curves as the store holds them NOW — handlers never trust a render's closure. */
const currentCurves = (nodeId: string): RgbCurves => readRgbCurves(currentValues(nodeId));

type DragState = { kind: 'point'; ch: CurveChannel; index: number; rect: DOMRect } | { kind: 'add'; ch: CurveChannel; rect: DOMRect };

/** A pointer position → plot units (the svg may be scaled, so through its rect, not raw pixels). */
function unitAt(ev: { clientX: number; clientY: number }, rect: DOMRect): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const px = ((ev.clientX - rect.left) * PLOT_W) / rect.width;
  const py = ((ev.clientY - rect.top) * PLOT_H) / rect.height;
  return { x: (px - PAD) / IN_W, y: 1 - (py - PAD) / IN_H };
}

const px = (p: CurvePoint) => PAD + p.x * IN_W;
const py = (p: CurvePoint) => PAD + (1 - p.y) * IN_H;

/**
 * The point a press grabs: the NEAREST one whose hit box (HIT_HALF around it) holds the press, or null for empty
 * plot. Decided here rather than by the DOM, where overlapping boxes let the later point take a press aimed at
 * the one beside it; on a tie the later point wins, as the drawing order shows it on top.
 */
function pointAt(ev: { clientX: number; clientY: number }, rect: DOMRect, points: readonly CurvePoint[]): number | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const x = ((ev.clientX - rect.left) * PLOT_W) / rect.width;
  const y = ((ev.clientY - rect.top) * PLOT_H) / rect.height;
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dx = px(points[i]) - x;
    const dy = py(points[i]) - y;
    if (Math.abs(dx) > HIT_HALF || Math.abs(dy) > HIT_HALF) continue;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

export function RgbCurvesSettings({ nodeId }: { nodeId: string }) {
  const language = useAppStore((s) => s.language);
  // Per-node selector (NodeSettingsMenu's idiom): an unrelated drag does not re-render this.
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  // Blender opens on the Combined curve (cur = 3).
  const [channel, setChannel] = useState<CurveChannel>('c');
  const [selRaw, setSel] = useState(0);
  const key = CURVE_KEYS[channel];
  // One gate per gesture source — drag, keys, the X/Y fields — and the discrete write (lutEditorGestures.tsx), all
  // on the active channel's key and reader.
  const { dragGate, keyGate, fieldGate, writeDiscrete } = useLutEditorWrites(nodeId, key, CANONICAL_OF[channel], IDENTITY_CURVE, cleanCurves);

  const values = node ? getNodeValues(node) : undefined;
  const curves = readRgbCurves(values);
  const points = curves[channel].points;
  // CLAMPED every render: Cmd+Z while the menu is open can shorten the list under the selection.
  const sel = Math.min(Math.max(selRaw, 0), Math.max(points.length - 1, 0));
  const point: CurvePoint | undefined = points[sel];
  const atCap = points.length >= CURVE_MAX_POINTS;
  const atMin = points.length <= CURVE_MIN_POINTS;

  const drag = useBracketedDrag<DragState>({
    gate: dragGate,
    start(e: ReactPointerEvent<SVGSVGElement>, svg) {
      const rect = svg.getBoundingClientRect();
      // A mouse press is preventDefault'ed (no text selection), which also blocks focus: give it to the plot so
      // arrow keys follow the press.
      svg.focus?.({ preventScroll: true });
      const i = pointAt(e, rect, points);
      if (i !== null) {
        setSel(i);
        return { kind: 'point', ch: channel, index: i, rect };
      }
      return { kind: 'add', ch: channel, rect };
    },
    move(s, ev) {
      // A drag that starts on empty plot does nothing: adding is a TAP.
      if (s.kind !== 'point') return null;
      const u = unitAt(ev, s.rect);
      const cur = currentCurves(nodeId)[s.ch].points;
      if (u === null || s.index >= cur.length) return null;
      return formatCurve(movePoint(cur, s.index, u.x, u.y));
    },
    tap(s, ev) {
      if (s.kind !== 'add') return null;
      const u = unitAt(ev, s.rect);
      const r = u === null ? null : addPoint(currentCurves(nodeId)[s.ch].points, u.x, u.y);
      if (!r) return null; // the point cap: the line under the editor says so
      setSel(r.index);
      return formatCurve(r.points);
    },
  });

  const nudge = (dx: number, dy: number) => {
    const cur = currentCurves(nodeId)[channel].points;
    const p = cur[sel];
    if (!p) return;
    keyGate.propose(formatCurve(movePoint(cur, sel, p.x + dx, p.y + dy)));
  };

  const remove = () => {
    const next = deletePoint(currentCurves(nodeId)[channel].points, sel);
    if (!next) return;
    const canon = formatCurve(next);
    writeDiscrete((v) => {
      setCanonical(v, key, canon, IDENTITY_CURVE);
      return true;
    });
    setSel(Math.max(0, Math.min(sel, next.length - 1)));
  };

  const onKey = (k: LutKey, e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (k.kind === 'delete') remove();
    else nudge(k.dx, k.dy);
  };

  if (!node || !point) return null;
  const total = points.length;
  const pointLabel = (n: number) => fillTemplate(t('Point {n} of {total}', language), { n, total });
  const stored = values?.[key];
  const isIdentity = curves[channel].canonical === IDENTITY_CURVE && stored === undefined;
  const dropped = CURVE_CHANNELS.some((ch) => curves[ch].droppedHandles);
  const capText = fillTemplate(t('A curve holds at most {max} points.', language), { max: CURVE_MAX_POINTS });

  return (
    <LutEditorRoot keyGate={keyGate} onKey={onKey}>
      {curves.rejectedChannels.length > 0 && (
        <div className="fs-lut-editor__notice" style={hintStyle}>
          {fillTemplate(t('Stored curves could not be read ({channels}), so they show as straight lines. Any edit replaces them.', language), {
            channels: curves.rejectedChannels.join(', '),
          })}
        </div>
      )}
      {curves.rejectedExtend && (
        <div className="fs-lut-editor__notice" style={hintStyle}>
          {t('The stored extend mode could not be read, so Extrapolated is used. Any edit replaces it.', language)}
        </div>
      )}
      <TextureBudgetNotice language={language} />
      {dropped && (
        <div className="fs-lut-editor__notice" style={hintStyle}>
          {t('Handle types from a newer version were reset to Auto.', language)}
        </div>
      )}

      <div className="fs-lut-editor__toolbar" role="group">
        {CURVE_CHANNELS.map((ch) => (
          <button
            key={ch}
            type="button"
            className="fs-lut-editor__btn fs-lut-editor__tab"
            aria-pressed={ch === channel}
            title={t(CHANNEL_TITLES.get(ch) ?? ch, language)}
            aria-label={t(CHANNEL_TITLES.get(ch) ?? ch, language)}
            onClick={() => {
              if (ch === channel) return;
              setChannel(ch);
              setSel(0);
            }}
          >
            {ch.toUpperCase()}
          </button>
        ))}
        <select
          className="context-menu__select fs-lut-editor__select"
          aria-label={t('Extend', language)}
          title={t('Extend', language)}
          value={curves.extend}
          onChange={(e) => {
            const next = e.target.value;
            if (!isCurveExtend(next)) return;
            writeDiscrete((v) => {
              // Compare the STORED key. A rejected value reads as Extrapolated, so the select cannot fire for it —
              // `cleanCurves` drops it on ANY edit instead.
              if (next === 'horizontal' ? v.extend === 'horizontal' : v.extend === undefined) return false;
              setCanonical(v, 'extend', next, 'extrapolate');
              return true;
            });
          }}
        >
          <option value="extrapolate">{t('Extrapolated', language)}</option>
          <option value="horizontal">{t('Horizontal', language)}</option>
        </select>
      </div>

      <div className="fs-lut-editor__plotbox" title={t('Tap the plot to add a point; drag a point to move it.', language)}>
        <CurvesArt
          curveC={values?.curveC}
          curveR={values?.curveR}
          curveG={values?.curveG}
          curveB={values?.curveB}
          extend={values?.extend}
          width={PLOT_W}
          height={PLOT_H}
          pad={PAD}
          active={channel}
          // `nodrag`: the canvas's double-tap pan and draw mode exempt only `.nodrag` targets (ColorRampSettings).
          className="fs-lut-editor__plot nowheel nodrag"
          style={{ touchAction: 'none' }}
          svgProps={{
            tabIndex: 0,
            'data-fs-lut-key': '',
            role: 'group',
            'aria-label': pointLabel(sel + 1),
            onPointerDown: drag.onPointerDown,
            // A blur ends a held arrow's entry — never a drag's: focus leaving the plot mid-drag split it in two.
            onBlur: () => keyGate.finish(),
          } as SVGProps<SVGSVGElement>}
        >
          {/* The add layer, then each point's box (the cursor's area — the press itself is decided by `pointAt`,
              nearest wins) and its mark. */}
          <rect x={0} y={0} width={PLOT_W} height={PLOT_H} fill="transparent" />
          {points.map((p, i) => {
            const selected = i === sel;
            const half = selected ? 4 : 3;
            return (
              <g key={i} data-point={i} className="fs-lut-editor__point">
                <rect x={px(p) - HIT_HALF} y={py(p) - HIT_HALF} width={HIT_HALF * 2} height={HIT_HALF * 2} fill="transparent" />
                {selected && (
                  <rect x={px(p) - half + 1} y={py(p) - half + 1} width={half * 2} height={half * 2} className="fs-lut-editor__marker-shadow" />
                )}
                <rect
                  x={px(p) - half}
                  y={py(p) - half}
                  width={half * 2}
                  height={half * 2}
                  className="fs-lut-editor__point-body"
                  strokeWidth={selected ? 2 : 1}
                />
              </g>
            );
          })}
        </CurvesArt>
      </div>

      <LutStepper
        index={sel}
        total={total}
        label={pointLabel(sel + 1)}
        prevLabel={t('Previous point', language)}
        nextLabel={t('Next point', language)}
        onSelect={setSel}
      />

      {/* X is clamped between the neighbours, so a typed X can never jump the selection; both stay live. */}
      <LazyNumberField
        key={`x${channel}${sel}`}
        label="X"
        value={point.x}
        min={0}
        max={1}
        onPropose={(n) => {
          const cur = currentCurves(nodeId)[channel].points;
          const p = cur[sel];
          if (p) fieldGate.propose(formatCurve(movePoint(cur, sel, n, p.y)));
        }}
        onFinish={() => fieldGate.finish()}
      />
      <LazyNumberField
        key={`y${channel}${sel}`}
        label="Y"
        value={point.y}
        min={0}
        max={1}
        onPropose={(n) => {
          const cur = currentCurves(nodeId)[channel].points;
          const p = cur[sel];
          if (p) fieldGate.propose(formatCurve(movePoint(cur, sel, p.x, n)));
        }}
        onFinish={() => fieldGate.finish()}
      />

      <div className="fs-lut-editor__toolbar">
        <ToolButton
          label={t('Delete point', language)}
          title={atMin ? fillTemplate(t('A curve needs at least {min} points.', language), { min: CURVE_MIN_POINTS }) : t('Delete point', language)}
          inactive={atMin}
          onClick={remove}
        />
        <ToolButton
          label={t('Reset curve', language)}
          title={t('Reset curve', language)}
          inactive={isIdentity}
          onClick={() => {
            writeDiscrete((v) => {
              if (v[key] === undefined) return false;
              delete v[key];
              return true;
            });
            setSel(0);
          }}
        />
      </div>

      {atCap && (
        <div className="fs-lut-editor__cap" style={hintStyle}>
          {capText}
        </div>
      )}
    </LutEditorRoot>
  );
}
