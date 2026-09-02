import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { useAppStore } from '@/store/useAppStore';
import './DragNumberInput.css';

interface DragNumberInputProps {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  compact?: boolean;
  className?: string;
  /** Display precision (default 2). Values that live below 0.01 — an SDF
   *  Output's epsilon — render as "0" at the default, so a site that needs
   *  finer numbers asks for them; the drag speed scales down with it so a
   *  pixel of scrub stays a sensible fraction of the value. */
  decimals?: number;
}

const DRAG_THRESHOLD = 3; // px before drag starts
const BASE_SPEED = 0.005; // value change per pixel
const ACCEL_FACTOR = 0.002; // acceleration per pixel of distance

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
  // Compact edit mode locks itself to the display span's footprint — see
  // startEdit.
  const [editWidth, setEditWidth] = useState<number | null>(null);

  // `bracketed` is this widget's OWN record that it called `beginInteraction`
  // and has not balanced it yet — the same ownership token useHistoryBracket
  // keeps in `openedRef`. The store's bracket is a global nesting counter with
  // no notion of who owns a depth, so an unpaired end closes whatever bracket
  // another gesture is riding.
  const dragRef = useRef({ startX: 0, startValue: 0, moved: false, isDown: false, bracketed: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);

  // Enter edit mode
  const startEdit = useCallback(() => {
    // The compact variant is width:auto (sizes to its value text), and a
    // number <input>'s INTRINSIC width is far wider than that text — so
    // swapping the span for the input grew the whole widget and, with it,
    // the node frame (the Time node visibly expanded the moment its speed
    // box was clicked). Lock the input to the span's measured footprint:
    // offsetWidth, not getBoundingClientRect — layout px, immune to the
    // viewport zoom transform. The frame stays put while typing; overlong
    // text scrolls inside the input.
    setEditWidth(valueRef.current?.offsetWidth ?? null);
    setEditText(String(roundTo(value, 4)));
    setEditing(true);
  }, [value]);

  // Commit edit
  const commitEdit = useCallback(() => {
    setEditing(false);
    const num = parseFloat(editText);
    if (!isNaN(num)) onChange(num);
  }, [editText, onChange]);

  // Cancel edit
  const cancelEdit = useCallback(() => {
    setEditing(false);
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

  const handleEditKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') commitEdit();
      if (e.key === 'Escape') cancelEdit();
    },
    [commitEdit, cancelEdit],
  );

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
      };
    },
    [value, editing],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (editing || !dragRef.current.isDown) return;
      const dx = e.clientX - dragRef.current.startX;

      if (!dragRef.current.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      if (!dragRef.current.moved) {
        // Snapshot the pre-drag state ONCE, before the first onChange, so the
        // whole scrub collapses to a single undo step and the graph isn't
        // deep-cloned on every frame. Deliberately not done on pointerdown: a
        // press that turns out to be a click-to-edit would push a no-op entry.
        useAppStore.getState().beginInteraction();
        dragRef.current.bracketed = true;
      }
      dragRef.current.moved = true;
      setDragging(true);

      // Accelerating speed: faster the further you drag
      const speed = (BASE_SPEED + Math.abs(dx) * ACCEL_FACTOR) * 10 ** (2 - decimals);
      const newValue = dragRef.current.startValue + dx * speed;
      onChange(roundTo(newValue, Math.max(4, decimals)));
    },
    [onChange, editing, decimals],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current.isDown = false;
      setDragging(false);
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
    <span className={`drag-num nodrag ${compact ? 'drag-num--compact' : ''} ${className}`}>
      {/* Left arrow (decrease) */}
      <button className="drag-num__arrow" onPointerDown={decrement} type="button">
        ◂
      </button>

      {editing ? (
        <input
          ref={inputRef}
          className="drag-num__edit"
          type="number"
          // Compact only: the chrome variant's 90px frame already fixes the
          // footprint (its input flexes inside it).
          style={compact && editWidth != null ? { width: editWidth } : undefined}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleEditKey}
          onBlur={commitEdit}
          step={step}
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
    </span>
  );
}
