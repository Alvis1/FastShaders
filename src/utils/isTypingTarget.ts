/**
 * "Does this event target take text?" — the ONE predicate behind every
 * `is the user typing?` guard in the app.
 *
 * It exists because there were four of them and three different tag sets, and
 * the app's PRIMARY accelerator handler (NodeEditor's Escape / Delete /
 * Cmd+C,V,G,D) had the narrowest: it knew only INPUT and TEXTAREA, while the
 * F/A handler beside it also skipped SELECT and contentEditable and the
 * toolbar's own guard walked ancestors. So a key that must be swallowed while
 * the user types could fire from inside some editable surfaces — with the
 * Sound node's source `<select>` focused (it sat on a real canvas node),
 * Backspace deleted the selected nodes and Cmd+D duplicated them, while F and
 * A correctly did nothing.
 *
 * What counts, and why each one:
 *   · INPUT — but only the types that actually take a character (see below).
 *   · TEXTAREA — Monaco's input is a textarea, so this covers the code panel.
 *   · SELECT — a `<select>` swallows plain letters as type-to-search and
 *     Backspace/Delete as a native no-op. The settings menus' mode pickers and
 *     the Sound node's source picker are ordinary focusable controls, so this
 *     is not a theoretical case.
 *   · contentEditable — a text field wearing another tag.
 *
 * ANCESTORS ARE WALKED, so a press that lands on a `<span>` (or an SVG child)
 * inside a contenteditable host still counts. `isContentEditable` is inherited
 * and usually answers on its own, but it is an HTMLElement property: an SVG
 * element inside an editable host does not have it.
 *
 * The walk is hand-rolled rather than one `closest()` call for two reasons:
 * the matched INPUT's `type` has to be inspected afterwards, which a single
 * selector cannot express; and this module is unit-tested under vitest's
 * `node` environment, where there is no DOM at all — the walk takes plain
 * `{ tagName, type, parentElement }` objects.
 */

/**
 * The minimal shape the walk reads. Every real `HTMLElement` is structurally
 * assignable to it, and so is a plain object in a node-env test.
 */
export interface TypingTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  parentElement?: TypingTargetLike | null;
}

/**
 * `<input type=…>` values that consume no character, so a key aimed at them is
 * free for the app. This is a DENY list on purpose: an input whose `type`
 * attribute is absent or unrecognised reports `text` from the DOM, and any
 * type added to the platform later is far more likely to take text than not —
 * so the unknown case must fall on the "the user is typing" side, where the
 * cost of being wrong is a shortcut that does nothing rather than a Delete
 * that eats the selection mid-edit.
 */
const TEXTLESS_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

export interface IsTypingTargetOptions {
  /**
   * Treat EVERY `<input>` as typing, whatever its `type`.
   *
   * The callers that need it are not asking "is text being ENTERED?" but "does
   * this control already own the press?", and they are the ones whose keys a
   * plain form control consumes natively:
   *
   *   · useKeyboardNav — it owns the bare ARROWS and Tab, which is exactly
   *     what a range, a radio group or a select uses. The Slider node IS an
   *     `<input type="range">` on a canvas node, so at the default set the
   *     arrow branch would move the NODE instead of the slider.
   *   · Toolbar's right-click / long-press preferences guard — the popover it
   *     opens is rendered inside the bar and is a list of checkboxes, so a
   *     right-click on one of its own rows would re-open the menu on itself.
   *   · The Node Designer's page-level `/`-focuses-search guard, where it is a
   *     pure refactor of the INPUT|TEXTAREA|SELECT regex it replaced.
   *
   * The mirror-image sites take the DEFAULT for the mirror-image reason:
   * NodeEditor's accelerator handler owns Delete and Cmd+D and ContextMenu's
   * owns Escape — keys a checkbox, a range or a colour swatch ignores, so
   * there the press belongs to the app.
   */
  anyInputType?: boolean;
}

/**
 * True when `target` — or an ancestor of it — is a control that takes text.
 * See the module header for the set and for why ancestors are walked.
 */
export function isTypingTarget(
  target: EventTarget | TypingTargetLike | null | undefined,
  opts: IsTypingTargetOptions = {},
): boolean {
  for (
    let el = target as TypingTargetLike | null | undefined;
    el != null;
    el = el.parentElement
  ) {
    // Not an element (window, document, a bare EventTarget): nothing to read,
    // and nothing above it either.
    if (typeof el.tagName !== 'string') return false;
    switch (el.tagName.toUpperCase()) {
      case 'TEXTAREA':
      case 'SELECT':
        return true;
      case 'INPUT':
        if (opts.anyInputType) return true;
        if (!TEXTLESS_INPUT_TYPES.has(String(el.type ?? 'text').toLowerCase())) return true;
        // A textless input answers "no" for ITSELF and the walk continues: the
        // question is whether the press lands anywhere text is being entered,
        // so an editable ancestor still wins. Stopping here would be a second,
        // narrower answer for a case nothing gains from.
        break;
      default:
        // `isContentEditable` is inherited, so the FIRST ancestor that has it
        // answers for the whole subtree — but an element that does not carry
        // the property at all (SVG) must not end the walk, hence `=== true`
        // rather than a truthiness test that would also stop on `undefined`.
        if (el.isContentEditable === true) return true;
    }
  }
  return false;
}
