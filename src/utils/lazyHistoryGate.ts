/**
 * LAZY history brackets for the Color Ramp / RGB Curves editors: the bracket
 * opens on the first write that actually CHANGES the canonical string, never on
 * the press. `beginInteraction` clears `future`, so a bracket opened by a click
 * that moved nothing (a tap on a stop, a nudge against the clamp, a pick of the
 * colour the stop already has) would cost an empty undo entry AND wipe redo —
 * the rule "never bracket a write that might change nothing" (CLAUDE.md,
 * History), applied per gesture rather than per call site.
 *
 * Canonical to canonical: `read()` returns `format(parse(stored))` (absent =
 * the default's canonical form), so a valid-but-non-canonical stored string
 * (uppercase hex, "0.50") compares equal to its own re-format and costs nothing.
 *
 * LEAF — the store is reached only through the injected `io`, so this is
 * node-testable and the React wrappers (`menus/lutEditorGestures.tsx`) stay thin.
 */

export interface LazyGate {
  /** Write `next` when it differs from the current canonical string; the first
   *  such write of the gesture opens the bracket. True when something was written. */
  propose(next: string): boolean;
  /** End the gesture: closes the bracket only if this gate opened it. Idempotent. */
  finish(): void;
  /** Whether this gate currently holds a bracket open. */
  readonly open: boolean;
}

/** read() returns the CURRENT canonical string (format(parse(stored)), absent = default) — compare canonical to
 *  canonical, so a valid-but-non-canonical stored string (uppercase hex, "0.50") never costs an empty entry.
 *  propose: equal → false, nothing happens; else begin() once (first change), then write(next). finish: end()
 *  only if this gate began. */
export function createLazyGate(io: {
  read(): string;
  write(next: string): void;
  begin(): void;
  end(): void;
}): LazyGate {
  let began = false;
  return {
    propose(next) {
      if (next === io.read()) return false;
      if (!began) {
        began = true;
        io.begin();
      }
      io.write(next);
      return true;
    },
    finish() {
      if (!began) return;
      began = false;
      io.end();
    },
    get open() {
      return began;
    },
  };
}

/**
 * The colour picker's path: it has no "done" event, so it rides the one-copy
 * IDLE bracket (`useHistoryBracket`). `bracket()` is called before EVERY
 * changing write — that is what re-arms the idle close — and never for a write
 * equal to the current canonical string, so picking the colour a stop already
 * has (or the same swatch twice) opens nothing and leaves redo intact. That is
 * also why the picker itself runs with `history="none"`: PaletteColorPicker
 * brackets BEFORE `onPick` on every path, before anyone knows whether the pick
 * changes anything. Returns true when something was written.
 */
export function createLazyIdleWrite(io: {
  read(): string;
  write(next: string): void;
  bracket(): void;
}): (next: string) => boolean {
  return (next) => {
    if (next === io.read()) return false;
    io.bracket();
    io.write(next);
    return true;
  };
}
