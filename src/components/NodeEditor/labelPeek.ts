/**
 * "What are this node's ports?" — a double-click, or a double-tap, on a node
 * shows EVERY one of its socket labels at once and leaves them up.
 *
 * A socket's name is otherwise a one-at-a-time thing: you hover a dot and read
 * one bubble. That is the wrong shape for the question people actually ask of
 * an unfamiliar node, which is about the whole port list — and it is unanswerable
 * on touch, where there is no hover at all. The labels themselves are unchanged:
 * this is a fourth TRIGGER for the label the socket already has, in the one
 * placement every trigger shares (TypedHandle.css).
 *
 * Two decisions live here because both are easy to get wrong and neither can be
 * tested through the DOM in this suite's `node` environment.
 *
 * **It is built on CLICK, not on `dblclick`.** A `dblclick` is not reliably
 * synthesized from a double tap — which is precisely why the Color node carries
 * a long-press beside its own `onDoubleClick` — so counting two clicks inside a
 * window is what makes one implementation serve both pointers.
 *
 * **Anything that already owns a double-click keeps it.** A number box opens for
 * editing, a textarea places a caret, and the whole Color node IS its swatch
 * (double-click opens the picker), so a peek there would fight a control the
 * user is aiming at.
 */

/**
 * How long after a click a second one still counts as a pair. 400 ms is the
 * usual platform double-click window; a shorter one starts failing for the
 * people most likely to want this, and a longer one turns two deliberate
 * separate clicks into a gesture.
 */
export const DOUBLE_ACTIVATE_MS = 400;

export type Activation = { id: string; t: number } | null;

/**
 * Is this click the second half of a pair on the SAME node?
 *
 * Same id, and inside the window. Clicks on two different nodes are never a
 * pair however fast they arrive — that is a user moving between nodes.
 */
export function isDoubleActivation(
  prev: Activation,
  id: string,
  t: number,
  windowMs: number = DOUBLE_ACTIVATE_MS,
): boolean {
  if (!prev || prev.id !== id) return false;
  const dt = t - prev.t;
  // A non-monotonic clock (a system time change mid-gesture) must not make an
  // arbitrarily old click count as the pair's first half.
  return dt >= 0 && dt <= windowMs;
}

/** Double-clicking the peeked node again puts its labels away. */
export function togglePeek(current: string | null, id: string): string | null {
  return current === id ? null : id;
}

/**
 * Controls that own a double-click of their own. `closest()` is asked against
 * the click's target, so a peek never lands on top of one.
 *
 * `.drag-num` is the node's number box (double-click = click-to-edit) and
 * `.palette-swatch` is a colour cell inside the picker.
 */
export const PEEK_EXEMPT_SELECTOR =
  'input, textarea, select, button, [role="button"], a[href], .drag-num, .palette-swatch';

/**
 * Flow node types whose whole body owns the gesture. The Color node IS the
 * swatch — its double-click opens the picker — and it has exactly one socket,
 * so a peek there would trade a real control for almost nothing.
 */
export const PEEK_EXEMPT_NODE_TYPES: ReadonlySet<string> = new Set(['color']);
