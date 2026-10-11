import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { fieldInputMode, fieldKeyAction, fieldWheelText } from '@/utils/numberField';

type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'onKeyDown' | 'min' | 'max' | 'step' | 'inputMode' | 'role'
>;

export interface NumberFieldProps extends InputProps {
  /** What the field shows: the caller's draft while one is open, else `formatFieldNumber(value)`. */
  text: string;
  /** Every change of that text — typed, pasted, or a step (an arrow key, or the wheel while focused). */
  onText: (text: string) => void;
  /** The number the field stands for: its spinbutton value, and what a step starts from while `text` does not parse. */
  value: number;
  /** One arrow press or wheel notch; ×10 with Shift. */
  step: number;
  min?: number;
  max?: number;
  /** Whole numbers only: with a `min` of 0 or more, the keypad drops its decimal key too. */
  integer?: boolean;
  onEnter?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onEscape?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The app's number field: a TEXT input whose text goes through
 * utils/numberField.ts, so it shows a dot whatever the locale and takes a dot
 * or a comma (that module says why). What `<input type="number">` did, it keeps:
 *   - ArrowUp/ArrowDown step by `step` within `min`/`max` (×10 with Shift, the
 *     LUT editors' rule);
 *   - the wheel steps a FOCUSED field under the pointer, as Chrome's number
 *     input did — and, like it, only a wheel nothing else took: over a node the
 *     canvas still zooms (React Flow cancels that wheel), so the step is made by
 *     a window listener, armed while the field has focus, that sees only a wheel
 *     nobody prevented (×10 with Shift, which a mouse reports sideways —
 *     `fieldWheelText`);
 *   - it is announced as a spinbutton with its value and range;
 * and it asks for the keypad its range allows (`fieldInputMode`).
 *
 * The TEXT belongs to the caller: each site keeps its own draft and commit rule
 * (live per keystroke, or on Enter/blur), so `onText` gets every change of the
 * text and nothing else (a step that leaves it as it is, at a bound, reports
 * nothing, as the number input fired nothing there). Enter/Escape are reported
 * here, never decided.
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { text, onText, value, step, min, max, integer = false, onEnter, onEscape, onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState<HTMLInputElement | null>(null);
  // What a wheel notch steps from. The window listener is bound once per focus, and a wheel's update is not rendered
  // synchronously, so each notch advances `text` here itself — a second notch before the re-render would otherwise
  // step from the stale text and count once.
  const latest = useRef({ text, value, onText, range: { step, min, max } });
  latest.current = { text, value, onText, range: { step, min, max } };

  useEffect(() => {
    if (!focused) return;
    const onWheel = (e: WheelEvent) => {
      if (e.target !== focused || document.activeElement !== focused) return;
      const l = latest.current;
      const next = fieldWheelText(e, l.text, l.value, l.range);
      if (next === null) return;
      e.preventDefault();
      if (next === l.text) return; // at a bound: the wheel is taken, but there is no change to report (onKeyDown says why)
      l.text = next;
      l.onText(next);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [focused]);

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode={fieldInputMode(min, integer)}
      // A text field invites what the number input never had on a touch
      // keyboard: autocomplete, autocorrect and auto-capitalisation.
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      role="spinbutton"
      aria-valuenow={Number.isFinite(value) ? value : undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      value={text}
      onChange={(e) => onText(e.target.value)}
      onKeyDown={(e) => {
        const action = fieldKeyAction(
          { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing },
          text,
          value,
          { step, min, max },
        );
        if (action?.kind === 'step') {
          // Swallowed either way (the arrow must not jump the caret), but
          // reported only when it changes the text: at a bound the number input
          // fired no change, and a report there made NumberRow bracket a commit
          // that changed nothing — an undo entry that restored nothing, and the
          // redo stack gone (an arrow or a wheel notch at midpoint's 0.99,
          // measured).
          e.preventDefault();
          if (action.text !== text) onText(action.text);
        } else if (action?.kind === 'enter') onEnter?.(e);
        else if (action?.kind === 'escape') onEscape?.(e);
      }}
      onFocus={(e) => {
        setFocused(e.currentTarget);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(null);
        onBlur?.(e);
      }}
    />
  );
});
