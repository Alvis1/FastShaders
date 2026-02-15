import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import './DragNumberInput.css';

interface DragNumberInputProps {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  compact?: boolean;
  className?: string;
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
  compact = false,
  className = '',
}: DragNumberInputProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [dragging, setDragging] = useState(false);

  const dragRef = useRef({ startX: 0, startValue: 0, moved: false, isDown: false });
  const inputRef = useRef<HTMLInputElement>(null);

  // Enter edit mode
  const startEdit = useCallback(() => {
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
      dragRef.current = { startX: e.clientX, startValue: value, moved: false, isDown: true };
    },
    [value, editing],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (editing || !dragRef.current.isDown) return;
      const dx = e.clientX - dragRef.current.startX;

      if (!dragRef.current.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      dragRef.current.moved = true;
      setDragging(true);

      // Accelerating speed: faster the further you drag
      const speed = BASE_SPEED + Math.abs(dx) * ACCEL_FACTOR;
      const newValue = dragRef.current.startValue + dx * speed;
      onChange(roundTo(newValue, 4));
    },
    [onChange, editing],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current.isDown = false;
      setDragging(false);

      // If no significant movement, treat as click → edit mode
      if (!dragRef.current.moved) {
        startEdit();
      }
    },
    [startEdit],
  );

  // Arrow button handlers
  const increment = useCallback(() => {
    onChange(roundTo(value + step, 4));
  }, [value, step, onChange]);

  const decrement = useCallback(() => {
    onChange(roundTo(value - step, 4));
  }, [value, step, onChange]);

  const displayValue = roundTo(value, 2);

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
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleEditKey}
          onBlur={commitEdit}
          step={step}
        />
      ) : (
        <span
          className={`drag-num__value ${dragging ? 'drag-num__value--dragging' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
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
