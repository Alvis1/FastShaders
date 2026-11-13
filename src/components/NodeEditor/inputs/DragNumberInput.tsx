import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { NumberField } from '@/components/inputs/NumberField';
import { fullscreenElement } from '@/components/inputs/colorPickerModel';
import { formatFieldNumber, parseFieldNumber } from '@/utils/numberField';
import { dragOffset, dragStep, dragStepNow, formatDragStep } from './dragNumberStep';
import './DragNumberInput.css';

interface DragNumberInputProps {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  compact?: boolean;
  className?: string;
  /** Display precision (default 2). Values that live below 0.01 — an SDF
   *  Output's epsilon — render as "0" at the default, so a site that needs
   *  finer numbers asks for them (with a finer `step`, which is what a drag
   *  moves by). */
  decimals?: number;
}

const DRAG_THRESHOLD = 3; // px before drag starts

/** Sent to a field's root to open its edit box — Tab's hand-off (below). */
const OPEN_EDIT_EVENT = 'fs-drag-num-edit';

/**
 * The fields Tab walks, in document order: every visible one on the same
 * node card (or in the same menu). None outside both — the intro's and the
 * asset cards' display-only copies have nowhere to go.
 */
function tabFields(root: HTMLElement | null): HTMLElement[] {
  const scope = root?.closest('.react-flow__node, .context-menu');
  if (!scope) return [];
  return Array.from(scope.querySelectorAll<HTMLElement>('.drag-num')).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * The readout above a dragged number: the step it moves by now and, on a
 * plain drag, what Shift would make it. Language read once per text, never
 * subscribed — a canvas holds many of these fields.
 */
function stepChipText(now: number, step: number | undefined, coarse: boolean): string {
  const lang = useAppStore.getState().language;
  const n = formatDragStep(now);
  if (coarse) return fillTemplate(t('Step {n}', lang), { n });
  return fillTemplate(t('Step {n} · Shift: {shift}', lang), { n, shift: formatDragStep(dragStep(step) * 10) });
}

interface StepChip {
  /** Viewport px: the field's top centre (the chip sits above it). */
  x: number;
  y: number;
  text: string;
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function DragNumberInput({
  value,
  onChange,
  step = 0.1,
  decimals = 2,
  compact = false,
  className = '',
}: DragNumberInputProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [dragging, setDragging] = useState(false);
  // The step readout, shown only while a drag is moving the value.
  const [stepChip, setStepChip] = useState<StepChip | null>(null);
  // Compact edit mode locks itself to the display span's footprint — see
  // startEdit.
  const [editWidth, setEditWidth] = useState<number | null>(null);

  // `bracketed` is this widget's OWN record that it called `beginInteraction`
  // and has not balanced it yet — the same ownership token useHistoryBracket
  // keeps in `openedRef`. The store's bracket is a global nesting counter with
  // no notion of who owns a depth, so an unpaired end closes whatever bracket
  // another gesture is riding.
  //
  // `startX`/`startValue` are where the current RATE began (the press, or the
  // last Shift press/release — dragNumberStep.ts), `pressX` where the press
  // was (the click-vs-drag threshold), `lastValue` the last value sent.
  const dragRef = useRef({
    startX: 0, startValue: 0, moved: false, isDown: false, bracketed: false,
    pressX: 0, coarse: false, lastValue: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  // The text the open edit box started with, or null when no edit is open: a
  // commit of untouched text changes nothing (and pushes no undo entry — Tab
  // walks through fields), and a second commit of one edit (Enter, then the
  // box's blur) is a no-op.
  const openTextRef = useRef<string | null>(null);

  // Enter edit mode
  const startEdit = useCallback(() => {
    // The compact variant is width:auto (sizes to its value text), and an
    // <input>'s INTRINSIC width is far wider than that text — so
    // swapping the span for the input grew the whole widget and, with it,
    // the node frame (the Time node visibly expanded the moment its speed
    // box was clicked). Lock the input to the span's measured footprint:
    // offsetWidth, not getBoundingClientRect — layout px, immune to the
    // viewport zoom transform. The frame stays put while typing; overlong
    // text scrolls inside the input.
    setEditWidth(valueRef.current?.offsetWidth ?? null);
    // A dot whatever the locale, 4 places (ParamRow's EDIT_DECIMALS guard
    // knows this rounding); a junk value opens EMPTY rather than as "NaN".
    openTextRef.current = formatFieldNumber(value, 4);
    setEditText(formatFieldNumber(value, 4));
    setEditing(true);
  }, [value]);

  // Commit edit — `.` or `,` typed (utils/numberField.ts). Once per edit, and
  // only when the text changed.
  const commitEdit = useCallback(() => {
    const opened = openTextRef.current;
    openTextRef.current = null;
    setEditing(false);
    if (opened === null || editText === opened) return;
    const num = parseFieldNumber(editText);
    if (num !== null) onChange(num);
  }, [editText, onChange]);

  // Cancel edit
  const cancelEdit = useCallback(() => {
    openTextRef.current = null;
    setEditing(false);
  }, []);

  // TAB commits this field and opens the NEXT one on the same card (Shift+Tab
  // the previous; the last wraps to the first) — a node's numbers typed in one
  // pass. With no other field it just commits. The next field is told by an
  // event on its root (OPEN_EDIT_EVENT), so no field needs to know another.
  const onTab = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const root = rootRef.current;
      const fields = tabFields(root);
      commitEdit();
      const i = root ? fields.indexOf(root) : -1;
      if (i < 0 || fields.length < 2) return;
      fields[(i + (e.shiftKey ? fields.length - 1 : 1)) % fields.length].dispatchEvent(new CustomEvent(OPEN_EDIT_EVENT));
    },
    [commitEdit],
  );
  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const open = () => startEditRef.current();
    el.addEventListener(OPEN_EDIT_EVENT, open);
    return () => el.removeEventListener(OPEN_EDIT_EVENT, open);
  }, []);

  // Balance exactly the one `beginInteraction` this widget opened, once. An
  // unpaired end would close another gesture's bracket (a settings-menu
  // rename's idle bracket, a second finger's scrub) — and useHistoryBracket
  // never re-opens after that, so the rest of that gesture pushes a full-graph
  // structuredClone per frame and evicts undo. Must stay the ONLY place in
  // this file that ends an interaction (pinned by dragNumberBracket.test.ts).
  const endBracket = useCallback(() => {
    if (!dragRef.current.bracketed) return;
    dragRef.current.bracketed = false;
    useAppStore.getState().endInteraction();
  }, []);

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Drag handlers
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startValue: value,
        moved: false,
        isDown: true,
        bracketed: false,
        pressX: e.clientX,
        coarse: e.shiftKey,
        lastValue: value,
      };
    },
    [value, editing],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (editing || !d.isDown) return;
      if (!d.moved && Math.abs(e.clientX - d.pressX) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        setDragging(true);
      }
      // Whole STEPS, at a constant rate; Shift ×10, then ×100 further out
      // (dragNumberStep.ts). Shift pressed or released mid-drag starts the new
      // rate from HERE, so the value never jumps.
      if (e.shiftKey !== d.coarse) {
        d.coarse = e.shiftKey;
        d.startX = e.clientX;
        d.startValue = d.lastValue;
      }
      // The readout: placed over the field once per drag (it does not move
      // while dragged; viewport px, so the canvas zoom never scales the
      // text), its text set only when the step changes.
      const text = stepChipText(dragStepNow(e.clientX - d.startX, step, d.coarse), step, d.coarse);
      setStepChip((prev) => {
        if (prev?.text === text) return prev;
        if (prev) return { ...prev, text };
        const r = rootRef.current?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top, text } : null;
      });
      const off = dragOffset(e.clientX - d.startX, step, d.coarse);
      const next = off === 0 ? d.startValue : roundTo(d.startValue + off, Math.max(4, decimals));
      if (Object.is(next, d.lastValue)) return;
      if (!d.bracketed) {
        // Snapshot the pre-drag state ONCE, before the first onChange, so the
        // whole scrub collapses to a single undo step and the graph isn't
        // deep-cloned on every frame. Deliberately not done on pointerdown (a
        // press that turns out to be a click-to-edit would push a no-op
        // entry), nor before the drag reaches its first step: opening the
        // bracket empties the redo stack.
        useAppStore.getState().beginInteraction();
        dragRef.current.bracketed = true;
      }
      d.lastValue = next;
      onChange(next);
    },
    [onChange, editing, decimals, step],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current.isDown = false;
      setDragging(false);
      setStepChip(null);
      endBracket();

      // If no significant movement, treat as click → edit mode
      if (!dragRef.current.moved) {
        startEdit();
      }
    },
    [startEdit, endBracket],
  );

  // A cancelled gesture (pointer stolen, touch interrupted) never fires
  // pointerup, so close the history bracket here too — leaving it open would
  // silently stop recording undo for the rest of the session.
  const onPointerCancel = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragRef.current.isDown = false;
    dragRef.current.moved = false;
    setDragging(false);
    setStepChip(null);
    endBracket();
  }, [endBracket]);

  // Same guarantee if this unmounts mid-drag (e.g. the node is deleted).
  useEffect(() => endBracket, [endBracket]);

  // Arrow button handlers
  const increment = useCallback(() => {
    onChange(roundTo(value + step, 4));
  }, [value, step, onChange]);

  const decrement = useCallback(() => {
    onChange(roundTo(value - step, 4));
  }, [value, step, onChange]);

  const displayValue = roundTo(value, decimals);

  return (
    <span ref={rootRef} className={`drag-num nodrag ${compact ? 'drag-num--compact' : ''} ${className}`}>
      {/* Left arrow (decrease) */}
      <button className="drag-num__arrow" onPointerDown={decrement} type="button">
        ◂
      </button>

      {editing ? (
        // The app's number field (components/inputs/NumberField.tsx): a dot
        // whatever the locale, arrows step the draft by `step`, and a focused
        // field steps on the wheel only where nothing else takes it — on a node
        // the wheel still zooms the canvas. Enter and blur commit; Escape
        // cancels (the unmount commits nothing).
        <NumberField
          ref={inputRef}
          className="drag-num__edit"
          // Compact only: the chrome variant's 90px frame already fixes the
          // footprint (its input flexes inside it).
          style={compact && editWidth != null ? { width: editWidth } : undefined}
          text={editText}
          onText={setEditText}
          value={value}
          step={step}
          onEnter={commitEdit}
          onEscape={cancelEdit}
          onTab={onTab}
          onBlur={commitEdit}
        />
      ) : (
        <span
          ref={valueRef}
          className={`drag-num__value ${dragging ? 'drag-num__value--dragging' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {displayValue}
        </span>
      )}

      {/* Right arrow (increase) */}
      <button className="drag-num__arrow" onPointerDown={increment} type="button">
        ▸
      </button>

      {stepChip &&
        createPortal(
          <div className="drag-num__step" style={{ left: stepChip.x, top: stepChip.y }} aria-hidden="true">
            {stepChip.text}
          </div>,
          fullscreenElement() ?? document.body,
        )}
    </span>
  );
}
