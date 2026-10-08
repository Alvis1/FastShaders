import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { beginDragChrome } from '@/utils/dragChrome';
import { createLazyGate, createLazyIdleWrite, type LazyGate } from '@/utils/lazyHistoryGate';
import { rowStyle, labelStyle, fieldStyle } from './menuShared';

/**
 * The gesture plumbing the Color Ramp and RGB Curves editors share: every
 * edit is ONE undo entry, opened LAZILY on the first write that changes the
 * node's canonical string (utils/lazyHistoryGate.ts says why), and the stored
 * string is ABSENT while it equals the default, so a fresh node, Reset and the
 * byte-stability snapshots all read the same.
 *
 * `canonicalOf` must be total over adversarial `values` (it is the reader's
 * `format(parse(v[key]))`): it runs on every proposed write.
 */

type CanonicalOf = (values: Record<string, string | number>) => string;

/** The store side of one (node, key) pair, shared by the drag gate and the picker's idle write. */
function useLutIo(nodeId: string, key: string, canonicalOf: CanonicalOf, defaultCanonical: string) {
  // Callers pass inline lambdas; a ref keeps the gate (and its open bracket) stable across renders.
  const canonRef = useRef(canonicalOf);
  canonRef.current = canonicalOf;
  return useMemo(() => {
    const find = () => useAppStore.getState().nodes.find((n) => n.id === nodeId);
    return {
      read(): string {
        const node = find();
        return node ? canonRef.current(getNodeValues(node)) : defaultCanonical;
      },
      write(next: string): void {
        const node = find();
        // A node deleted under an open editor: nothing to write, and no history to push.
        if (!node) return;
        const values: Record<string, string | number> = { ...getNodeValues(node) };
        if (next === defaultCanonical) delete values[key];
        else values[key] = next;
        useAppStore.getState().updateNodeData(nodeId, { values });
      },
    };
  }, [nodeId, key, defaultCanonical]);
}

/** A lazy gate on the store's nesting-counted begin/endInteraction; finished on unmount (and when the node/key change). */
export function useLazyGate(nodeId: string, key: string, canonicalOf: CanonicalOf, defaultCanonical: string): LazyGate {
  const io = useLutIo(nodeId, key, canonicalOf, defaultCanonical);
  const gate = useMemo(
    () =>
      createLazyGate({
        read: io.read,
        write: io.write,
        begin: () => useAppStore.getState().beginInteraction(),
        end: () => useAppStore.getState().endInteraction(),
      }),
    [io],
  );
  useEffect(() => () => gate.finish(), [gate]);
  return gate;
}

/**
 * The colour picker's write path, on the one-copy IDLE bracket (the picker has
 * no "done" event). A write equal to the current canonical string costs
 * nothing — no bracket, no entry, redo kept. Pointer gestures keep
 * `useLazyGate`'s explicit begin/end: an idle close would split a drag paused
 * for longer than the idle window into two entries. Mount it in a child KEYED
 * with the picker, so changing the selection unmounts both and closes the
 * bracket before a later marker drag could fold into the pick's entry.
 */
export function useLazyIdleWrite(nodeId: string, key: string, canonicalOf: CanonicalOf, defaultCanonical: string): (next: string) => void {
  const io = useLutIo(nodeId, key, canonicalOf, defaultCanonical);
  const { bracket } = useHistoryBracket();
  return useMemo(() => {
    const w = createLazyIdleWrite({ read: io.read, write: io.write, bracket });
    return (next: string) => {
      w(next);
    };
  }, [io, bracket]);
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
 *     released, chrome ended, listeners removed, latch cleared.
 * Branches on the gesture's own `pointerType`, never on a media query.
 */
export function useBracketedDrag<S>(opts: BracketedDragOptions<S>): { onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void } {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const liveRef = useRef<(() => void) | null>(null);
  useEffect(() => () => liveRef.current?.(), []);

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
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    liveRef.current = end;
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
}

/**
 * The editors' number input. Used instead of `NumberRow`, which brackets
 * before it knows a change happened: here the caller's gate opens only when
 * the proposed value changes the canonical string, and Enter / blur / unmount
 * end it. Unmount only FINISHES — a pending non-live edit is not written,
 * because the field unmounts when its selection changes or its node is deleted.
 */
export function LazyNumberField({ label, value, min, max, step = 0.01, onPropose, onFinish, live = true }: LazyNumberFieldProps) {
  const [editText, setEditText] = useState<string | null>(null);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  useEffect(() => () => finishRef.current(), []);

  const parse = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return min !== undefined && n < min ? min : max !== undefined && n > max ? max : n;
  };
  const commit = () => {
    if (!live && editText !== null) {
      const n = parse(editText);
      if (n !== null) onPropose(n);
    }
    setEditText(null);
    onFinish();
  };

  return (
    <div style={rowStyle}>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        aria-label={label}
        step={step}
        min={min}
        max={max}
        value={editText ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          setEditText(raw);
          if (!live) return;
          const n = parse(raw);
          if (n !== null) onPropose(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        onBlur={commit}
        style={fieldStyle}
      />
    </div>
  );
}
