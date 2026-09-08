import { describe, it, expect } from 'vitest';
import { isTypingTarget, type TypingTargetLike } from './isTypingTarget';

/**
 * vitest runs under `environment: 'node'` — there is no DOM here, which is
 * exactly why the predicate walks `parentElement` by hand instead of calling
 * `closest()`. These stubs are the shape it reads.
 */
const el = (
  tagName: string,
  extra: Partial<TypingTargetLike> = {},
): TypingTargetLike => ({ tagName, ...extra });

/** `child` nested inside `ancestors`, outermost last. Returns the child. */
const nest = (child: TypingTargetLike, ...ancestors: TypingTargetLike[]): TypingTargetLike => {
  let cur = child;
  for (const a of ancestors) {
    cur.parentElement = a;
    cur = a;
  }
  return child;
};

describe('isTypingTarget', () => {
  it('counts the three text-taking tags', () => {
    // TEXTAREA covers Monaco (its input is a textarea) and SELECT is not
    // theoretical: the Audio Input node puts a real one on a canvas node, and
    // a select swallows plain letters as type-to-search.
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV'))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
  });

  it('excludes the input types that consume no character', () => {
    // The canvas legitimately keys over these: the Slider node IS an
    // `<input type="range">`, the settings menus are full of checkboxes, and
    // the colour rows are `<input type="color">`. Delete/Cmd+D there mean
    // "act on the selected node", and Escape on a checkbox has no in-progress
    // edit to cancel (that exemption is for DragNumberInput and the Add-node
    // search box, both of which take text).
    for (const type of ['range', 'checkbox', 'color', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden']) {
      expect(isTypingTarget(el('INPUT', { type })), type).toBe(false);
    }
    for (const type of ['text', 'number', 'search', 'password', 'email', 'url', 'tel', 'date']) {
      expect(isTypingTarget(el('INPUT', { type })), type).toBe(true);
    }
  });

  it('treats an unknown or absent input type as typing (the deny-list default)', () => {
    // An input with no `type` attribute reports `text` from the DOM, and a
    // type added to the platform later is far likelier to take text than not.
    // Being wrong this way costs a shortcut that does nothing; being wrong the
    // other way is a Delete that eats the selection mid-edit.
    expect(isTypingTarget(el('INPUT', { type: undefined }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'some-future-text-type' }))).toBe(true);
    // The DOM normalizes `type` to lower case; a stub (or a hand-set property)
    // need not, so the comparison does it too.
    expect(isTypingTarget(el('INPUT', { type: 'RANGE' }))).toBe(false);
  });

  it('is case-insensitive about the tag, so a stub or an XHTML document agrees', () => {
    expect(isTypingTarget(el('textarea'))).toBe(true);
  });

  it('walks ancestors, so a press inside a contentEditable host counts', () => {
    // A click lands on the SPAN, not on the editable host — and an SVG child
    // does not carry `isContentEditable` at all, which is why the walk cannot
    // stop at the first element that lacks the property.
    const host = el('DIV', { isContentEditable: true });
    expect(isTypingTarget(nest(el('SPAN', { isContentEditable: true }), host))).toBe(true);
    expect(isTypingTarget(nest(el('svg'), el('SPAN'), host))).toBe(true);
    expect(isTypingTarget(nest(el('SPAN'), el('DIV'), el('SECTION')))).toBe(false);
  });

  it('lets an editable ancestor outrank a textless input', () => {
    // The question is whether the press lands anywhere text is being entered,
    // so a checkbox does not end the walk.
    const host = el('DIV', { isContentEditable: true });
    expect(isTypingTarget(nest(el('INPUT', { type: 'checkbox' }), host))).toBe(true);
  });

  it('survives a non-element target', () => {
    // `e.target` is `window` or `document` for some listeners, and null when a
    // handler is invoked with a synthetic event.
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget({} as TypingTargetLike)).toBe(false);
    // An element whose PARENT is not an element ends the walk rather than
    // throwing — a shadow root or a document fragment reads this way.
    expect(isTypingTarget(nest(el('SPAN'), {} as TypingTargetLike))).toBe(false);
  });

  it('anyInputType widens it to every control, for the two "who owns this press" guards', () => {
    // The Toolbar's right-click/long-press guard and the Node Designer's
    // page-level `/`-focuses-search guard ask a looser question, and both
    // predate this module — at `true` they are pure refactors. The toolbar's
    // preferences popover is rendered INSIDE the bar and is a list of
    // checkboxes, so a right-click on one must not re-open the menu on itself.
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }), { anyInputType: true })).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'range' }), { anyInputType: true })).toBe(true);
    // Everything else is unchanged by the option.
    expect(isTypingTarget(el('BUTTON'), { anyInputType: true })).toBe(false);
    expect(isTypingTarget(el('SELECT'), { anyInputType: true })).toBe(true);
  });
});
