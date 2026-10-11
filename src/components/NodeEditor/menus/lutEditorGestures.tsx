import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import { t, type Language } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { beginDragChrome } from '@/utils/dragChrome';
import { isTypingTarget } from '@/utils/isTypingTarget';
import { createLazyGate, createLazyIdleWrite, type LazyGate } from '@/utils/lazyHistoryGate';
import { TEXTURE_BUDGET_MARK, SAMPLED_TEXTURE_STAGE_LIMIT } from '@/engine/textureBudget';
import { formatFieldNumber, parseFieldNumber } from '@/utils/numberField';
import { arrowDirection } from '../keyboardNav';
import { rowStyle, labelStyle, fieldStyle, hintStyle } from './menuShared';

/**
 * The ONE shell the Color Ramp and RGB Curves editors share: their history
 * gates and write rule, the root's key policy, and the parts both draw (the
 * stepper, the tool button, the number field, the texture-budget notice).
 *
 * Every edit is ONE undo entry, opened LAZILY on the first write that changes
 * the node's canonical string (utils/lazyHistoryGate.ts says why), and the
 * stored string is ABSENT while it equals the default, so a fresh node, Reset
 * and the byte-stability snapshots all read the same. Every write — a
 * gesture's or a discrete act's, on whichever key — also runs the editor's
 * CLEAN, so "any edit replaces it" holds for every stored value a notice
 * talks about, not only for the key the edit wrote.
 *
 * `canonicalOf` must be total over adversarial `values` (it is the reader's
 * `format(parse(v[key]))`): it runs on every proposed write.
 */

/** A node's `values`, as the editors read and write them. */
export type LutValues = Record<string, string | number>;
/** The reader's canonical string for one key. */
export type CanonicalOf = (values: LutValues) => string;
/** Runs on every write's fresh copy, after the written key is set: drops every stored value the editor's reader
 *  REJECTED, on any key (and re-stores one it re-spelled), so no notice about a stored value outlives an edit.
 *  Dropping a rejected value changes nothing on screen — it already reads as its default. Mutates the copy. */
export type CleanValues = (values: LutValues) => void;

/** The node's values as the store holds them NOW, or undefined for a node deleted under an open editor — handlers
 *  never trust a render's closure. */
export function currentValues(nodeId: string): LutValues | undefined {
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  return node ? getNodeValues(node) : undefined;
}

/** THE write rule: `key` holds `next`, or is ABSENT while `next` is the default. Mutates `values`. */
export function setCanonical(values: LutValues, key: string, next: string, defaultCanonical: string): void {
  if (next === defaultCanonical) delete values[key];
  else values[key] = next;
}

/** The store side of one (node, key) pair — the read and write the gates and the picker's idle write share.
 *  Hook-free so the node tests can drive it on the real store. */
export function createLutIo(nodeId: string, key: string, canonicalOf: CanonicalOf, defaultCanonical: string, clean?: CleanValues) {
  return {
    read(): string {
      const v = currentValues(nodeId);
      return v ? canonicalOf(v) : defaultCanonical;
    },
    write(next: string): void {
      const v = currentValues(nodeId);
      // A node deleted under an open editor: nothing to write, and no history to push.
      if (!v) return;
      const values: LutValues = { ...v };
      setCanonical(values, key, next, defaultCanonical);
      clean?.(values);
      useAppStore.getState().updateNodeData(nodeId, { values });
    },
  };
}

/**
 * `canonicalOf` and `clean` are part of the io's IDENTITY, so callers pass module-scope functions — one reader per
 * RGB channel. Each key's io then keeps ITS reader: a drag's gate made for C kept comparing through one shared ref
 * against whichever curve a channel switch had selected, so a move that made C equal R's curve was dropped. (An
 * inline lambda would rebuild the gate, and end its bracket, on every render.)
 */
function useLutIo(nodeId: string, key: string, canonicalOf: CanonicalOf, defaultCanonical: string, clean?: CleanValues) {
  return useMemo(() => createLutIo(nodeId, key, canonicalOf, defaultCanonical, clean), [nodeId, key, canonicalOf, defaultCanonical, clean]);
}

/** A lazy gate on the store's nesting-counted begin/endInteraction; finished on unmount (and when its io changes).
 *  `beforeBegin` runs right before the gate OPENS its bracket — the Color Ramp passes its colour pick's idle close,
 *  so a drag, nudge or typed number started inside the pick's idle window never folds into the pick's undo entry. */
function useLazyGate(
  nodeId: string,
  key: string,
  canonicalOf: CanonicalOf,
  defaultCanonical: string,
  clean?: CleanValues,
  beforeBegin?: () => void,
): LazyGate {
  const io = useLutIo(nodeId, key, canonicalOf, defaultCanonical, clean);
  const beforeRef = useRef(beforeBegin);
  beforeRef.current = beforeBegin;
  const gate = useMemo(
    () =>
      createLazyGate({
        read: io.read,
        write: io.write,
        begin: () => {
          beforeRef.current?.();
          useAppStore.getState().beginInteraction();
        },
        end: () => useAppStore.getState().endInteraction(),
      }),
    [io],
  );
  useEffect(() => () => gate.finish(), [gate]);
  return gate;
}

/** One discrete act = ONE plain updateNodeData (it pushes history itself), guarded OUTSIDE against a no-op: `edit`
 *  changes the fresh copy and returns false when the act would change nothing. The copy is cleaned like every
 *  gesture write, and every bracket a gesture may still hold is closed first (`endGestures`), so the act is its own
 *  entry. Hook-free so the node tests can drive it on the real store. True when something was written. */
export function discreteWrite(nodeId: string, edit: (values: LutValues) => boolean, clean: CleanValues, endGestures: () => void): boolean {
  const v = currentValues(nodeId);
  if (!v) return false;
  const out: LutValues = { ...v };
  if (!edit(out)) return false;
  clean(out);
  endGestures();
  useAppStore.getState().updateNodeData(nodeId, { values: out });
  return true;
}

/**
 * The live pointer drag on each drag gate — `useBracketedDrag` registers its end while a drag is live — so a
 * discrete act ENDS that drag, not only its bracket. The drag holds the INDEX of a stop or point the act may have
 * removed or moved: a Delete pressed mid-drag removed the dragged point, and the next move pulled whatever slid into
 * its slot (the curve's END point, off x = 1), as a second undo entry. Keyed by the gate, so nothing outlives it.
 */
const liveDrags = new WeakMap<LazyGate, () => void>();

export interface LutEditorWrites {
  /** A pointer drag on the bar or plot: the drag itself ends it (`useBracketedDrag`), or a discrete act, which ends
   *  the drag too — never a blur, a key release or a field. */
  readonly dragGate: LazyGate;
  /** Keyboard nudges: the release of an ARROW key ends it, or the blur of the marker or plot that holds focus. */
  readonly keyGate: LazyGate;
  /** The number fields: Enter, blur and their unmount end it. */
  readonly fieldGate: LazyGate;
  /** The discrete acts (add, remove, flip, interpolation, extend, reset): `discreteWrite`, bound — it first ends a
   *  live drag, and closes all three gates and `closeFirst`. */
  writeDiscrete(edit: (values: LutValues) => boolean): void;
}

/**
 * Every write an editor makes on its (node, key) pair: one lazy gate per gesture SOURCE — so no source can end
 * another's undo entry — and the discrete write. The store's brackets nest, so two gates open at once are still one
 * entry. Why three:
 *   - the fields are keyed on the selection, so a stop dragged across a neighbour REMOUNTS them, and their unmount
 *     finish ended the drag's bracket mid-gesture (one drag measured as two entries in Chrome);
 *   - a blur or a key release ends a keyboard gesture, never a drag: focus leaving the plot mid-drag split it.
 * A discrete act is its own entry and ends the live drag outright (`liveDrags`). `closeFirst` (the Color Ramp's
 * colour pick, whose idle bracket outlives the pick) is closed before any gate opens and before every discrete
 * write, so nothing folds into the pick's entry.
 */
export function useLutEditorWrites(
  nodeId: string,
  key: string,
  canonicalOf: CanonicalOf,
  defaultCanonical: string,
  clean: CleanValues,
  closeFirst?: () => void,
): LutEditorWrites {
  const dragGate = useLazyGate(nodeId, key, canonicalOf, defaultCanonical, clean, closeFirst);
  const keyGate = useLazyGate(nodeId, key, canonicalOf, defaultCanonical, clean, closeFirst);
  const fieldGate = useLazyGate(nodeId, key, canonicalOf, defaultCanonical, clean, closeFirst);
  const closeRef = useRef(closeFirst);
  closeRef.current = closeFirst;
  return useMemo(() => {
    const endGestures = () => {
      liveDrags.get(dragGate)?.();
      dragGate.finish();
      keyGate.finish();
      fieldGate.finish();
      closeRef.current?.();
    };
    return {
      dragGate,
      keyGate,
      fieldGate,
      writeDiscrete: (edit: (values: LutValues) => boolean) => {
        discreteWrite(nodeId, edit, clean, endGestures);
      },
    };
  }, [nodeId, clean, dragGate, keyGate, fieldGate]);
}

/**
 * The colour picker's write path, on the one-copy IDLE bracket (the picker has
 * no "done" event). A write equal to the current canonical string costs
 * nothing — no bracket, no entry, redo kept. Pointer gestures keep the gates'
 * explicit begin/end: an idle close would split a drag paused for longer than
 * the idle window into two entries.
 *
 * The idle bracket stays open for the idle window after the LAST pick, so
 * `close` must run before every other act of the editor (it is the
 * `closeFirst` of `useLutEditorWrites`: the gates run it before they open, the
 * discrete write before it writes) and when the selection changes — or a "+",
 * a flip or a marker drag inside that window folds into the pick's undo entry
 * (one Cmd+Z then reverts both).
 */
export function useLazyIdleWrite(
  nodeId: string,
  key: string,
  canonicalOf: CanonicalOf,
  defaultCanonical: string,
  clean?: CleanValues,
): { write: (next: string) => void; close: () => void } {
  const io = useLutIo(nodeId, key, canonicalOf, defaultCanonical, clean);
  const { bracket, closeBracket } = useHistoryBracket();
  return useMemo(() => {
    const w = createLazyIdleWrite({ read: io.read, write: io.write, bracket });
    return {
      write: (next: string) => {
        w(next);
      },
      close: closeBracket,
    };
  }, [io, bracket, closeBracket]);
}

/**
 * The editor root's key policy: true for a key that must NOT reach the canvas
 * (the root then `stopPropagation`s it) — every key but Escape and Tab, which
 * belong to the menu and the focus order, and Cmd/Ctrl+S, the app's Apply
 * (CodeEditor's window listener), which a swallowed press handed to the
 * browser's own "Save Page As…" instead. Delete/X (delete the NODE), A, F,
 * Space, Cmd+D… stay inside (Cmd+Z included — accepted).
 */
export function keepsKeyInEditor(e: Pick<ReactKeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  if (e.key === 'Escape' || e.key === 'Tab') return false;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) return false;
  return true;
}

/**
 * The editor root's one BROWSER default to cancel: Cmd/Ctrl+A on a marker or
 * the plot. The root stops every key reaching the canvas (stopPropagation),
 * but that does not stop the browser's own select-all, which highlighted the
 * fields' text and the select. A typing target keeps its own select-all.
 */
export function preventSelectAll(e: ReactKeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'a' || e.key === 'A') && !isTypingTarget(e.target)) e.preventDefault();
}

/** What an editor's OWN key asks for: a nudge (x right, y up) or deleting the selection. */
export type LutKey = { readonly kind: 'nudge'; readonly dx: number; readonly dy: number } | { readonly kind: 'delete' };

/**
 * An editor's own key, or null: an arrow (a nudge — 0.1 with Shift, else 0.01)
 * or Delete/Backspace/X, pressed on a target carrying `data-fs-lut-key` (a ramp
 * marker, the curve plot) that is not a typing target, with no Cmd/Ctrl/Alt.
 * React bubbles keys through portals, so Backspace in the colour picker's hex
 * field, or in a number field, reaches the root too and must never delete the
 * selection. The target is read structurally (no `instanceof Element`), so the
 * node tests can drive it.
 */
export function lutEditorKey(e: Pick<ReactKeyboardEvent, 'key' | 'target' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>): LutKey | null {
  const target = e.target as { hasAttribute?: unknown } | null;
  if (typeof target?.hasAttribute !== 'function' || !(target as Element).hasAttribute('data-fs-lut-key') || isTypingTarget(e.target)) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const dir = arrowDirection(e.key);
  if (dir) {
    const step = e.shiftKey ? 0.1 : 0.01;
    return { kind: 'nudge', dx: dir === 'left' ? -step : dir === 'right' ? step : 0, dy: dir === 'up' ? step : dir === 'down' ? -step : 0 };
  }
  if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'x' || e.key === 'X') return { kind: 'delete' };
  return null;
}

/**
 * The editor ROOT, one copy for both editors: its own keys first (`onKey`,
 * given `lutEditorKey`'s answer), then the shared policy — every key but
 * Escape, Tab and Cmd/Ctrl+S stops here (`keepsKeyInEditor`) and the browser's
 * select-all is cancelled (`preventSelectAll`). A held arrow is ONE entry: the
 * release of an ARROW key ends it, as useKeyboardNav's does — ending on any
 * release split one held Shift+Arrow into two entries when Shift came up first.
 */
export function LutEditorRoot({
  rootRef,
  keyGate,
  onKey,
  children,
}: {
  rootRef?: Ref<HTMLDivElement>;
  keyGate: LazyGate;
  onKey: (key: LutKey, e: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      className="fs-lut-editor"
      onKeyDown={(e) => {
        const key = lutEditorKey(e);
        if (key) onKey(key, e);
        if (keepsKeyInEditor(e)) e.stopPropagation();
        preventSelectAll(e);
      }}
      onKeyUp={(e) => {
        if (arrowDirection(e.key)) keyGate.finish();
        if (keepsKeyInEditor(e)) e.stopPropagation();
      }}
    >
      <div className="context-menu__divider" />
      {children}
    </div>
  );
}

/** ◀ n of N ▶ — selects the previous or next marker/point, including ones the others cover. */
export function LutStepper({
  index,
  total,
  label,
  prevLabel,
  nextLabel,
  onSelect,
}: {
  index: number;
  total: number;
  label: string;
  prevLabel: string;
  nextLabel: string;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="fs-lut-editor__stepper">
      <button type="button" className="fs-lut-editor__btn" aria-label={prevLabel} title={prevLabel} onClick={() => onSelect(Math.max(0, index - 1))}>
        ◀
      </button>
      <span className="fs-lut-editor__count">{label}</span>
      <button type="button" className="fs-lut-editor__btn" aria-label={nextLabel} title={nextLabel} onClick={() => onSelect(Math.min(total - 1, index + 1))}>
        ▶
      </button>
    </div>
  );
}

/** A toolbar button that stays focusable and keeps its tooltip when it cannot act (aria-disabled + guarded, never
 *  `disabled`), so the limit it hits can announce itself. `ariaLabel` names a symbol label ("+", "⇄"). */
export function ToolButton({
  label,
  title,
  ariaLabel,
  inactive = false,
  onClick,
}: {
  label: string;
  title: string;
  ariaLabel?: string;
  inactive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="fs-lut-editor__btn"
      title={title}
      aria-label={ariaLabel}
      aria-disabled={inactive || undefined}
      onClick={() => {
        if (!inactive) onClick();
      }}
    >
      {label}
    </button>
  );
}

/**
 * The sampled-texture budget, announced where the user adds tables: shown
 * while the RUNNING module carries graphToCode's over-the-limit comment
 * (engine/textureBudget.ts). Reads the code rather than recounting the graph,
 * so the notice and the comment cannot disagree — scanned once per CODE
 * change, never per store notify: a marker drag notifies 2–3 times per move,
 * and a Data node's columns ride the module as base64 (a 734K-character module
 * measured 125 µs per scan).
 */
export function TextureBudgetNotice({ language }: { language: Language }) {
  const code = useAppStore((s) => s.previewCode);
  const over = useMemo(() => code.includes(TEXTURE_BUDGET_MARK), [code]);
  if (!over) return null;
  return (
    <div className="fs-lut-editor__notice" style={hintStyle}>
      {fillTemplate(
        t('This shader uses more than {max} textures, so it may fail to compile. Give several nodes the same ramp or curves, or use fewer.', language),
        { max: SAMPLED_TEXTURE_STAGE_LIMIT },
      )}
    </div>
  );
}

/** Below this travel (px) a press is a TAP: nothing is written until it is passed. */
const DRAG_THRESHOLD_PX = 3;

export interface BracketedDragOptions<S> {
  gate: LazyGate;
  /** Decide what the press grabs; null ignores it (nothing latched, no chrome).
   *  `preventDefault` on a mouse press also blocks focus — focus a marker here if keys should follow. */
  start(e: ReactPointerEvent<SVGSVGElement>, svg: SVGSVGElement): S | null;
  /** The canonical string for this move, or null for "no change". */
  move(s: S, e: PointerEvent): string | null;
  /** The canonical string for a press released before the threshold (add a stop on TAP, never on press). */
  tap?(s: S, e: PointerEvent): string | null;
}

/**
 * One pointer gesture on an editor's SVG ROOT = one undo entry. Contract:
 *   - the FIRST pointerId is latched; a second finger is a second pointerdown
 *     (not a pointercancel), so it is ignored rather than allowed to steal the drag;
 *   - mouse: primary button only, and `preventDefault()` (no text selection);
 *   - `beginDragChrome(null)` synchronously — it takes the opaque-origin preview
 *     iframe out of hit-testing; pointer capture alone failed when the first
 *     move landed over the iframe (controls.css);
 *   - `setPointerCapture` in try/catch (it throws for a pointer already gone);
 *   - nothing is written below the 3 px threshold; past it every move proposes;
 *     a release below it is a tap;
 *   - pointerup / pointercancel / unmount all end it: gate.finish(), capture
 *     released, chrome ended, listeners removed, latch cleared;
 *   - so does a NEW `gate`: a drag belongs to the gate it latched, and the
 *     editor re-keys its gates on an RGB channel switch (a tap with a second
 *     device, or Shift+Tab and Space, while the mouse still drags). Its next
 *     move would reopen the old gate's bracket — a second undo entry, on a
 *     curve no longer shown;
 *   - and so does a discrete act (`liveDrags`, ended by `useLutEditorWrites`):
 *     the stop or point the drag holds by index may be gone.
 * Branches on the gesture's own `pointerType`, never on a media query.
 */
export function useBracketedDrag<S>(opts: BracketedDragOptions<S>): { onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void } {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // The live drag, with the gate it latched.
  const liveRef = useRef<{ gate: LazyGate; end: () => void } | null>(null);
  const current = opts.gate;
  useEffect(
    () => () => {
      const live = liveRef.current;
      if (live && live.gate === current) live.end();
    },
    [current],
  );

  const onPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (liveRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const svg = e.currentTarget;
    const s = optsRef.current.start(e, svg);
    if (s === null) return;
    if (e.pointerType === 'mouse') e.preventDefault();
    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const gate = optsRef.current.gate;
    let passed = false;
    const endChrome = beginDragChrome(null);
    try {
      svg.setPointerCapture(id);
    } catch {
      /* the pointer is already gone — the window listeners still end the gesture */
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!passed) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return;
        passed = true;
      }
      const next = optsRef.current.move(s, ev);
      if (next !== null) gate.propose(next);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!passed) {
        const next = optsRef.current.tap?.(s, ev) ?? null;
        if (next !== null) gate.propose(next);
      }
      end();
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === id) end();
    };
    const end = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      try {
        svg.releasePointerCapture(id);
      } catch {
        /* already released (the element may have unmounted) */
      }
      endChrome();
      gate.finish();
      liveRef.current = null;
      if (liveDrags.get(gate) === end) liveDrags.delete(gate);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    liveRef.current = { gate, end };
    liveDrags.set(gate, end);
  }, []);

  return { onPointerDown };
}

export interface LazyNumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** A parsed, finite, min/max-clamped number; the caller formats it and calls `gate.propose`. */
  onPropose: (n: number) => void;
  /** End of the edit (`gate.finish`). */
  onFinish: () => void;
  /** true: every parseable keystroke proposes. false: keystrokes edit only the
   *  local text; Enter/blur propose ONCE, then finish — for a value whose write
   *  REORDERS the list (a ramp stop's Position would jump through 0 while
   *  "0.75" is typed, and remount the picker keyed on the selection). */
  live?: boolean;
  /** Rendered as `data-fs-lut-field` on the input, so an editor can find the field again after a re-keyed remount. */
  fieldId?: string;
}

/**
 * The editors' number input. Used instead of `NumberRow`, which brackets
 * before it knows a change happened: here the caller's gate opens only when
 * the proposed value changes the canonical string, and Enter / blur / unmount
 * end it. Unmount only FINISHES — a pending non-live edit is not written,
 * because the field unmounts when its selection changes or its node is deleted.
 *
 * A TEXT input with `inputMode="decimal"`, not `type="number"`: the number
 * input draws the OS locale's separator (a comma here), unlike every other
 * value in the menu. It reads and shows a number through the ONE rule every
 * number field in the app shares (utils/numberField.ts: `.` or `,` typed, a
 * dot shown). ArrowUp/ArrowDown step by `step` (×10 with Shift), as the
 * number input's own keys did, and the input says so as a `spinbutton`.
 *
 * Escape drops a draft that is not written yet (a non-live field's typed text)
 * and leaves the field — DragNumberInput's convention, which ContextMenu
 * relies on: its Escape skips a typing target because Escape there cancels the
 * edit, so the NEXT Escape closes the menu. A live field's keystrokes are
 * already written; Escape ends its edit as Enter would. Without this, Escape
 * did neither, and the next blur in the menu (a marker press) committed the
 * abandoned value.
 */
export function LazyNumberField({ label, value, min, max, step = 0.01, onPropose, onFinish, live = true, fieldId }: LazyNumberFieldProps) {
  const [editText, setEditText] = useState<string | null>(null);
  // The draft the handlers read: Escape's blur runs onBlur → commit SYNCHRONOUSLY, before a state update could
  // re-render the closure, so the cancelled draft must already be gone from here.
  const draftRef = useRef<string | null>(null);
  const setDraft = (text: string | null) => {
    draftRef.current = text;
    setEditText(text);
  };
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  useEffect(() => () => finishRef.current(), []);

  const clamp = (n: number): number => (min !== undefined && n < min ? min : max !== undefined && n > max ? max : n);
  const parse = (raw: string): number | null => {
    const n = parseFieldNumber(raw);
    return n === null ? null : clamp(n);
  };
  const commit = () => {
    const draft = draftRef.current;
    if (!live && draft !== null) {
      const n = parse(draft);
      if (n !== null) onPropose(n);
    }
    setDraft(null);
    onFinish();
  };
  const edit = (raw: string) => {
    setDraft(raw);
    if (!live) return;
    const n = parse(raw);
    if (n !== null) onPropose(n);
  };

  return (
    <div style={rowStyle}>
      <label style={labelStyle}>{label}</label>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        role="spinbutton"
        aria-label={label}
        aria-valuenow={Number.isFinite(value) ? value : undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        data-fs-lut-field={fieldId}
        value={editText ?? formatFieldNumber(value)}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const from = parse(draftRef.current ?? formatFieldNumber(value)) ?? value;
            const d = (e.shiftKey ? step * 10 : step) * (e.key === 'ArrowUp' ? 1 : -1);
            edit(formatFieldNumber(clamp(from + d)));
          }
        }}
        onBlur={commit}
        style={fieldStyle}
      />
    </div>
  );
}
