import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { getNodeValues } from '@/types';
import { fillTemplate } from '@/utils/fillTemplate';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { ColorRampStrip } from '../nodes/ColorRampArt';
import {
  readColorRamp,
  formatRampStops,
  DEFAULT_RAMP_STOPS,
  RAMP_MAX_STOPS,
  RAMP_INTERPS,
  isRampInterp,
  addStopAt,
  insertStopNear,
  removeStop,
  moveStop,
  flipStops,
  setStopHex,
  setStopAlpha,
  indexAfterMove,
  type ColorRamp,
  type RampInterp,
  type RampStop,
} from '@/utils/colorRamp';
import {
  useLutEditorWrites,
  useLazyIdleWrite,
  useBracketedDrag,
  LazyNumberField,
  LutEditorRoot,
  LutStepper,
  ToolButton,
  TextureBudgetNotice,
  currentValues,
  setCanonical,
  type CleanValues,
  type LutKey,
  type LutValues,
} from './lutEditorGestures';
import { rowStyle, labelStyle, hintStyle } from './menuShared';

/**
 * The Color Ramp editor — a section of NodeSettingsMenu, like the Image and
 * Noise ones. Everything it writes is `values.stops` / `values.interp` in the
 * canonical form utils/colorRamp.ts formats (absent = the default), so the
 * code panel, the card strip and the shader all read one string; every write
 * also drops whichever of the two the reader rejected (`cleanRamp`).
 *
 * History (menus/lutEditorGestures.tsx): a drag, a held arrow key or a typed
 * number is ONE undo entry, opened LAZILY on the first write that changes the
 * canonical string — a tap on a marker, a nudge against the end, or a pick of
 * the colour a stop already has costs nothing and keeps redo. Discrete acts
 * (add, remove, flip, interpolation) are one plain `updateNodeData` behind a
 * no-op guard (`writeDiscrete`).
 *
 * Keys (`LutEditorRoot`, the RGB Curves editor's too): the root swallows every
 * key but Escape, Tab and Cmd/Ctrl+S (Apply), so Delete/X (delete the NODE),
 * A, F, Space, Cmd+D… never reach the canvas while focus is in here (Cmd+Z
 * included — accepted). The editor's own keys act only on a marker
 * (`data-fs-lut-key`) that is not a typing target: React events bubble through
 * portals, so Backspace in the colour picker's hex field reaches this root
 * too, and must never delete the selected stop.
 *
 * Focus follows the stop it is on, and never falls to <body>: the markers are
 * keyed by INDEX and the number fields by the selection, so a keyboard Delete
 * of the last stop, a nudge or a drag carrying a stop past its neighbour, or an
 * Enter in Position that re-sorts the stops unmounts (or re-indexes) the
 * focused element. On <body> the next Delete reached the canvas's window
 * handler and deleted the NODE; left on the neighbour's slot, focus showed one
 * stop while the arrows and Delete acted on another. Those acts name the
 * element to focus once they have rendered (`refocusRef`).
 */

const BAR_W = 236;
const STRIP_H = 24;
const BAR_H = 40;
const MARKER_HALF_W = 5;
const MARKER_TOP = STRIP_H + 2;
const MARKER_SHOULDER = MARKER_TOP + 4;
const MARKER_BOTTOM = MARKER_TOP + 12;
const HIT_HALF_W = 12;
/** A marker grabs only below this line (the lower 24 px: the markers and the strip's lower edge); the strip above
 *  always ADDS — full-height grab boxes covered the whole bar from 11 evenly spaced stops on, so tap-to-add, which
 *  the bar's own title offers, became impossible. */
const GRAB_TOP = STRIP_H - 8;

const INTERP_LABELS: ReadonlyMap<RampInterp, string> = new Map([
  ['linear', 'Linear'],
  ['constant', 'Constant'],
  ['ease', 'Ease'],
  ['bspline', 'B-Spline'],
  ['cardinal', 'Cardinal'],
]);

/** The gates' canonical reader (module scope: it is part of each gate's identity): total over adversarial `values`. */
const canonicalOf = (values: LutValues): string => readColorRamp(values).canonical;

/**
 * Every write's clean, whichever key the write was for: a `stops` or `interp` the reader REJECTED is dropped, so
 * "any edit replaces it" holds — junk stops used to survive an interpolation pick, notice and code comment with
 * them. Each already reads as its default (the black→white ramp, Linear), so nothing on screen changes; a node
 * with nothing rejected is left exactly as it was.
 */
export const cleanRamp: CleanValues = (v) => {
  const ramp = readColorRamp(v);
  if (ramp.rejectedStops) delete v.stops;
  if (ramp.rejectedInterp) delete v.interp;
};

/** The node's ramp as the store holds it NOW — handlers never trust a render's closure. */
const currentRamp = (nodeId: string): ColorRamp => readColorRamp(currentValues(nodeId));

const markerPoints = (x: number): string =>
  [
    [x, MARKER_TOP],
    [x + MARKER_HALF_W, MARKER_SHOULDER],
    [x + MARKER_HALF_W, MARKER_BOTTOM],
    [x - MARKER_HALF_W, MARKER_BOTTOM],
    [x - MARKER_HALF_W, MARKER_SHOULDER],
  ]
    .map(([a, b]) => `${a},${b}`)
    .join(' ');

type DragState = { kind: 'stop'; index: number; rect: DOMRect } | { kind: 'add'; rect: DOMRect };

const unitAt = (ev: { clientX: number }, rect: DOMRect): number | null =>
  rect.width > 0 ? (ev.clientX - rect.left) / rect.width : null;

/**
 * The stop a press grabs: the NEAREST one within HIT_HALF_W of it, in the marker band (below GRAB_TOP), or null —
 * the strip above, and the bar beyond every grab box, ADD. Decided by geometry, never by which marker the DOM
 * draws on top: two markers closer than a marker's width overlap, and the later one took a press aimed at the
 * centre of the other. On a tie the later stop wins, as the drawing shows it on top.
 */
function stopAt(ev: { clientX: number; clientY: number }, rect: DOMRect, stops: readonly RampStop[]): number | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const x = ((ev.clientX - rect.left) * BAR_W) / rect.width;
  const y = ((ev.clientY - rect.top) * BAR_H) / rect.height;
  if (y < GRAB_TOP) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = Math.abs(stops[i].pos * BAR_W - x);
    if (d <= HIT_HALF_W && d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

export function ColorRampSettings({ nodeId }: { nodeId: string }) {
  const language = useAppStore((s) => s.language);
  // Per-node selector (NodeSettingsMenu's idiom): an unrelated drag does not re-render this.
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  const [selRaw, setSel] = useState(0);
  // The last re-sort the Position field committed ({from, to} stop index) — read by a press that blurred it.
  const fieldMoveRef = useRef<{ from: number; to: number } | null>(null);
  // The stop colour's idle-bracketed write (the picker has no "done" event). Its bracket stays open for the idle
  // window after the last pick, so every other act closes it FIRST — it is the gates' and the discrete writes'
  // `closeFirst` — and so does a selection change (the effect): a "+", flip or marker drag inside that window used
  // to fold into the pick's undo entry, one Cmd+Z reverting both.
  const pick = useLazyIdleWrite(nodeId, 'stops', canonicalOf, DEFAULT_RAMP_STOPS, cleanRamp);
  // One gate per gesture source — drag, keys, the number fields — and the discrete write (lutEditorGestures.tsx).
  const { dragGate, keyGate, fieldGate, writeDiscrete } = useLutEditorWrites(nodeId, 'stops', canonicalOf, DEFAULT_RAMP_STOPS, cleanRamp, pick.close);

  const rootRef = useRef<HTMLDivElement>(null);
  // The element to focus once the act that set it has rendered (a selector inside this editor) — see the header.
  const refocusRef = useRef<string | null>(null);
  // True while focus moves between markers ON PURPOSE, so the old marker's blur does not end a held arrow's entry.
  const refocusingRef = useRef(false);
  useLayoutEffect(() => {
    const selector = refocusRef.current;
    if (selector === null) return;
    refocusRef.current = null;
    const el = rootRef.current?.querySelector<HTMLElement | SVGElement>(selector);
    if (!el || el === document.activeElement) return;
    refocusingRef.current = true;
    try {
      el.focus({ preventScroll: true });
    } finally {
      refocusingRef.current = false;
    }
  });

  const values = node ? getNodeValues(node) : undefined;
  const ramp = readColorRamp(values);
  const stops = ramp.stops;
  // CLAMPED every render: Cmd+Z while the menu is open can shorten the list under the selection.
  const sel = Math.min(Math.max(selRaw, 0), Math.max(stops.length - 1, 0));
  const stop: RampStop | undefined = stops[sel];
  const atCap = stops.length >= RAMP_MAX_STOPS;

  // A pick belongs to the stop it was made on: a selection change (or the editor closing) ends its idle bracket.
  useEffect(() => pick.close, [sel, pick]);

  /** A stop act (add, remove, flip): a no-op when the canonical stops would not change. */
  const writeStops = (next: readonly RampStop[] | null) => {
    if (!next) return;
    const canon = formatRampStops(next);
    writeDiscrete((v) => {
      if (canon === readColorRamp(v).canonical) return false;
      setCanonical(v, 'stops', canon, DEFAULT_RAMP_STOPS);
      return true;
    });
  };

  const writeInterp = (next: string) => {
    if (!isRampInterp(next)) return;
    writeDiscrete((v) => {
      // Compare the STORED key. A rejected value reads as Linear, so the select cannot fire for it — `cleanRamp`
      // drops it on ANY edit instead.
      if (next === 'linear' ? v.interp === undefined : v.interp === next) return false;
      setCanonical(v, 'interp', next, 'linear');
      return true;
    });
  };

  /** Whether one of this bar's markers holds focus — a dragged stop carries it across a neighbour only then. */
  const markerHasFocus = (): boolean => {
    const a = document.activeElement;
    return !!a && a.hasAttribute('data-stop') && !!rootRef.current?.contains(a);
  };

  const drag = useBracketedDrag<DragState>({
    gate: dragGate,
    start(e: ReactPointerEvent<SVGSVGElement>, svg) {
      const rect = svg.getBoundingClientRect();
      const grabbed = stopAt(e, rect, stops);
      const hit = grabbed !== null;
      let i = grabbed ?? sel;
      // A Position or Alpha edit still pending in its field is committed FIRST, whatever the press lands on: a
      // mouse press is preventDefault'ed (no text selection), which also keeps focus where it was, so a bar tap
      // used to add a stop with the edit still pending — Enter then moved the NEW stop, and an Alpha bracket
      // swallowed the add. And `i` is an index of the LAST render: the Position commit can RE-SORT the stops
      // under the press, so the pressed stop is followed to its new index. (Focusing the marker blurred the field
      // only AFTER the index was read: the drag then moved, and the tap selected, whichever stop had slid into
      // the clicked one's slot.)
      fieldMoveRef.current = null;
      const active = document.activeElement;
      if (active instanceof HTMLElement && svg.closest('.fs-lut-editor')?.contains(active)) active.blur();
      const moved = fieldMoveRef.current as { from: number; to: number } | null;
      // A bar press keeps the selected stop, which the commit may have moved.
      if (moved) i = hit ? indexAfterMove(i, moved.from, moved.to) : moved.to;
      // Render the committed order NOW, so the marker the press focuses is the right stop's; the selection is
      // set LAST, after the field's own setSel.
      const at = i;
      flushSync(() => setSel(at));
      // Give focus to the marker so arrow keys follow the press — and so it never stays on <body> after the blur
      // above, where the next Delete would reach the canvas and delete the NODE.
      (svg.querySelector(`[data-stop="${at}"]`) as SVGElement | null)?.focus?.({ preventScroll: true });
      setSel(at);
      if (hit) return { kind: 'stop', index: at, rect };
      return { kind: 'add', rect };
    },
    move(s, ev) {
      // A drag that starts on the bar (not a marker) does nothing: adding is a TAP.
      if (s.kind !== 'stop') return null;
      const u = unitAt(ev, s.rect);
      const cur = currentRamp(nodeId).stops;
      if (u === null || s.index >= cur.length) return null;
      // Stops may cross: the moved stop's new index comes back and the selection follows it — and so does focus,
      // as after a nudge. The markers are keyed by index, so the focused slot went on to draw the neighbour: focus,
      // its aria and the ring showed one stop while the arrows and Delete acted on the dragged one.
      const r = moveStop(cur, s.index, u);
      if (r.index !== s.index && markerHasFocus()) refocusRef.current = `[data-stop="${r.index}"]`;
      s.index = r.index;
      setSel(r.index);
      return formatRampStops(r.stops);
    },
    tap(s, ev) {
      if (s.kind !== 'add') return null;
      const u = unitAt(ev, s.rect);
      const r = u === null ? null : addStopAt(currentRamp(nodeId), u);
      if (!r) return null; // the stop cap: the line under the editor says so
      setSel(r.index);
      refocusRef.current = `[data-stop="${r.index}"]`;
      return formatRampStops(r.stops);
    },
  });

  const nudge = (delta: number) => {
    const cur = currentRamp(nodeId).stops;
    const s = cur[sel];
    if (!s) return;
    const r = moveStop(cur, sel, s.pos + delta);
    if (keyGate.propose(formatRampStops(r.stops))) {
      // Past a neighbour the stop changes index; focus follows it (the markers are keyed by index).
      if (r.index !== sel) refocusRef.current = `[data-stop="${r.index}"]`;
      setSel(r.index);
    }
  };

  /** Remove the selected stop; the index selected after it, or null when nothing was removed. */
  const remove = (): number | null => {
    const next = removeStop(currentRamp(nodeId).stops, sel);
    if (!next) return null;
    writeStops(next);
    const after = Math.max(0, Math.min(sel, next.length - 1));
    setSel(after);
    return after;
  };

  const onKey = (key: LutKey, e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (key.kind === 'delete') {
      e.preventDefault();
      // The deleted LAST stop's marker unmounts under the focus: keep it on the stop selected after it.
      const after = remove();
      if (after !== null) refocusRef.current = `[data-stop="${after}"]`;
    } else if (key.dx !== 0) {
      // Left/Right only: a stop has no y.
      e.preventDefault();
      nudge(key.dx);
    }
  };

  if (!node || !stop) return null;
  const total = stops.length;
  const stopLabel = (n: number) => fillTemplate(t('Stop {n} of {total}', language), { n, total });
  const atOne = total <= 1;
  const capText = fillTemplate(t('A ramp holds at most {max} stops.', language), { max: RAMP_MAX_STOPS });

  return (
    <LutEditorRoot rootRef={rootRef} keyGate={keyGate} onKey={onKey}>
      {ramp.rejectedStops && (
        <div className="fs-lut-editor__notice" style={hintStyle}>
          {t('The stored ramp could not be read, so the default ramp is shown. Any edit replaces it.', language)}
        </div>
      )}
      {ramp.rejectedInterp && (
        <div className="fs-lut-editor__notice" style={hintStyle}>
          {t('The stored interpolation could not be read, so Linear is used. Any edit replaces it.', language)}
        </div>
      )}
      <TextureBudgetNotice language={language} />

      <div className="fs-lut-editor__toolbar">
        <ToolButton
          label="+"
          title={atCap ? capText : t('Add stop', language)}
          ariaLabel={t('Add stop', language)}
          inactive={atCap}
          onClick={() => {
            const r = insertStopNear(currentRamp(nodeId), sel);
            if (!r) return;
            writeStops(r.stops);
            setSel(r.index);
          }}
        />
        <ToolButton
          label="−"
          title={atOne ? t('A ramp needs at least one stop.', language) : t('Remove stop', language)}
          ariaLabel={t('Remove stop', language)}
          inactive={atOne}
          onClick={remove}
        />
        <ToolButton
          label="⇄"
          title={t('Flip', language)}
          ariaLabel={t('Flip', language)}
          onClick={() => {
            writeStops(flipStops(currentRamp(nodeId).stops));
            setSel(total - 1 - sel);
          }}
        />
        <select
          className="context-menu__select fs-lut-editor__select"
          aria-label={t('Interpolation', language)}
          title={t('Interpolation', language)}
          value={ramp.interp}
          onChange={(e) => writeInterp(e.target.value)}
        >
          {RAMP_INTERPS.map((m) => (
            <option key={m} value={m}>
              {t(INTERP_LABELS.get(m) ?? m, language)}
            </option>
          ))}
        </select>
      </div>

      <div className="fs-lut-editor__bar" title={t('Tap the bar to add a stop; drag a marker to move it.', language)}>
        <ColorRampStrip stops={values?.stops} interp={values?.interp} className="fs-lut-editor__strip" />
        {/* `nodrag` (with `nowheel`): the editor sits inside the canvas, whose capture-phase double-tap pan and draw
            mode exempt only `.nodrag` targets — a second press within 300 ms panned the canvas instead of grabbing
            a marker, and in draw mode a marker drag painted ink. */}
        <svg
          className="fs-lut-editor__hit nowheel nodrag"
          width={BAR_W}
          height={BAR_H}
          viewBox={`0 0 ${BAR_W} ${BAR_H}`}
          style={{ touchAction: 'none' }}
          onPointerDown={drag.onPointerDown}
        >
          {/* The add layer, then each stop's grab box and marker. The press itself is decided by `stopAt`
              (nearest wins); the boxes give the cursor the same areas. */}
          <rect x={0} y={0} width={BAR_W} height={BAR_H} fill="transparent" />
          {stops.map((s, i) => {
            const x = s.pos * BAR_W;
            const selected = i === sel;
            // `stopAt`'s areas: a grab box ends halfway to each neighbour (stops are sorted by position), capped at
            // HIT_HALF_W, in the marker band only.
            const left = i > 0 ? Math.max(x - HIT_HALF_W, (stops[i - 1].pos * BAR_W + x) / 2) : x - HIT_HALF_W;
            const right = i < stops.length - 1 ? Math.min(x + HIT_HALF_W, (x + stops[i + 1].pos * BAR_W) / 2) : x + HIT_HALF_W;
            return (
              <g
                key={i}
                data-stop={i}
                data-fs-lut-key=""
                className="fs-lut-editor__marker"
                tabIndex={0}
                role="slider"
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={s.pos}
                aria-label={stopLabel(i + 1)}
                onFocus={() => setSel(i)}
                onBlur={() => {
                  if (!refocusingRef.current) keyGate.finish();
                }}
              >
                <rect x={left} y={GRAB_TOP} width={Math.max(0, right - left)} height={BAR_H - GRAB_TOP} fill="transparent" />
                {selected && <polygon points={markerPoints(x + 1)} transform="translate(0 1)" className="fs-lut-editor__marker-shadow" />}
                <polygon
                  points={markerPoints(x)}
                  fill={s.hex}
                  className="fs-lut-editor__marker-body"
                  strokeWidth={selected ? 2 : 1}
                />
              </g>
            );
          })}
        </svg>
      </div>

      <LutStepper
        index={sel}
        total={total}
        label={stopLabel(sel + 1)}
        prevLabel={t('Previous stop', language)}
        nextLabel={t('Next stop', language)}
        onSelect={setSel}
      />

      {/* Position proposes ONCE (Enter/blur): a live position re-sorts the stops on every keystroke, so typing
          "0.75" would pass through 0, jump the stop and remount the picker keyed on the selection. */}
      <LazyNumberField
        key={`pos${sel}`}
        label={t('Position', language)}
        value={stop.pos}
        min={0}
        max={1}
        live={false}
        fieldId="pos"
        onPropose={(n) => {
          const cur = currentRamp(nodeId).stops;
          if (sel >= cur.length) return;
          const r = moveStop(cur, sel, n);
          if (fieldGate.propose(formatRampStops(r.stops))) {
            fieldMoveRef.current = { from: sel, to: r.index };
            // An ENTER that re-sorts remounts this field (keyed on the selection): focus goes to its successor.
            // A commit by blur is already taking focus elsewhere — the input no longer holds it — so it is left be.
            if (r.index !== sel && document.activeElement?.getAttribute('data-fs-lut-field') === 'pos') {
              refocusRef.current = '[data-fs-lut-field="pos"]';
            }
            setSel(r.index);
          }
        }}
        onFinish={() => fieldGate.finish()}
      />
      <LazyNumberField
        key={`alpha${sel}`}
        label={t('Alpha', language)}
        value={stop.alpha}
        min={0}
        max={1}
        onPropose={(n) => fieldGate.propose(formatRampStops(setStopAlpha(currentRamp(nodeId).stops, sel, n)))}
        onFinish={() => fieldGate.finish()}
      />
      <StopColor
        key={sel}
        hex={stop.hex}
        language={language}
        onPick={(h) => {
          const next = setStopHex(currentRamp(nodeId).stops, sel, h);
          if (next) pick.write(formatRampStops(next));
        }}
      />

      {atCap && (
        <div className="fs-lut-editor__cap" style={hintStyle}>
          {capText}
        </div>
      )}
    </LutEditorRoot>
  );
}

/**
 * The selected stop's colour, KEYED by the selection in the parent (a fresh
 * picker per stop). `history="none"`: the picker brackets BEFORE `onPick` on
 * every path, so `bracket` would cost an empty entry (and clear redo) for a
 * pick of the colour the stop already has; the parent's `pick`
 * (useLazyIdleWrite) brackets only a write that changes the canonical stops,
 * and closes that bracket before any other act and on a selection change.
 */
function StopColor({ hex, language, onPick }: { hex: string; language: Language; onPick: (hex: string) => void }) {
  return (
    <div style={rowStyle}>
      <label style={labelStyle}>{t('Stop color', language)}</label>
      <PaletteColorPicker value={hex} history="none" onPick={onPick} />
    </div>
  );
}
