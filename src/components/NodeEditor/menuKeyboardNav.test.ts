/**
 * Tab inside a settings menu belongs to the MENU (review 5b, GLB Phase 4).
 *
 * The menu shell is rendered inside `.node-editor__canvas`, and useKeyboardNav
 * takes Tab for any focus inside the canvas to cycle NODES. Before the fix a
 * Tab on the Image node's texture-grid cell (or any menu control that is not a
 * form field — a button, a swatch) moved focus onto a canvas node, so a menu
 * could not be walked by keyboard. `isTyping` is the hook's one stand-down
 * predicate; it is run here against plain objects (the vitest env is `node`),
 * and the canvas's own Tab stops are checked to still reach the Tab branch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isTyping } from './useKeyboardNav';

const HOOK = readFileSync(new URL('./useKeyboardNav.ts', import.meta.url), 'utf8');
const CONTEXT_MENU = readFileSync(new URL('./menus/ContextMenu.tsx', import.meta.url), 'utf8');

interface FakeEl {
  tagName: string;
  type?: string;
  parentElement: FakeEl | null;
  classes: string[];
  role?: string;
  closest: (selector: string) => FakeEl | null;
}

/** The two selector shapes isTyping asks for: `.class` and `[role="x"]`. */
function matches(el: FakeEl, part: string): boolean {
  const p = part.trim();
  if (p.startsWith('.')) return el.classes.includes(p.slice(1));
  const role = /^\[role="([^"]+)"\]$/.exec(p);
  if (role) return el.role === role[1];
  throw new Error(`fake closest() does not understand ${p}`);
}

function el(tagName: string, opts: { classes?: string[]; role?: string; parent?: FakeEl | null; type?: string } = {}): FakeEl {
  const self: FakeEl = {
    tagName,
    type: opts.type,
    parentElement: opts.parent ?? null,
    classes: opts.classes ?? [],
    role: opts.role,
    closest(selector: string) {
      for (let cur: FakeEl | null = self; cur; cur = cur.parentElement) {
        if (selector.split(',').some((part) => matches(cur!, part))) return cur;
      }
      return null;
    },
  };
  return self;
}

const asTarget = (e: FakeEl) => e as unknown as EventTarget;

describe('Tab inside a settings menu', () => {
  const canvas = el('DIV', { classes: ['node-editor__canvas'] });
  const menu = el('DIV', { classes: ['context-menu', 'nowheel'], parent: canvas });
  const grid = el('DIV', { classes: ['context-menu__texture-grid'], role: 'listbox', parent: menu });

  it('stands the canvas Tab handler down for a texture-grid cell', () => {
    const cell = el('BUTTON', { classes: ['context-menu__texture-cell'], role: 'option', parent: grid });
    expect(isTyping(asTarget(cell))).toBe(true);
  });

  it('stands down for any non-field control in the menu (a plain menu button)', () => {
    const item = el('BUTTON', { classes: ['context-menu__item'], parent: menu });
    expect(isTyping(asTarget(item))).toBe(true);
  });

  it('keeps the canvas Tab order: a node wrapper and a canvas-bar button still reach the Tab branch', () => {
    const nodes = el('DIV', { classes: ['react-flow__nodes'], parent: canvas });
    const nodeWrapper = el('DIV', { classes: ['react-flow__node'], parent: nodes });
    expect(isTyping(asTarget(nodeWrapper))).toBe(false);
    const barButton = el('BUTTON', { classes: ['fs-canvas-bar__btn'], parent: canvas });
    expect(isTyping(asTarget(barButton))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('still stands down inside a modal and on a form field', () => {
    const dialog = el('DIV', { role: 'dialog' });
    expect(isTyping(asTarget(el('BUTTON', { parent: dialog })))).toBe(true);
    expect(isTyping(asTarget(el('INPUT', { type: 'checkbox', parent: canvas })))).toBe(true);
  });

  it('asks isTyping before the Tab branch, and the class is the real menu shell', () => {
    const guard = HOOK.indexOf('if (isTyping(e.target)) return;');
    const tab = HOOK.indexOf("e.key === 'Tab' && inCanvas");
    expect(guard).toBeGreaterThan(-1);
    expect(tab).toBeGreaterThan(guard);
    expect(HOOK).toContain(".closest?.('.context-menu')");
    // The ONE shell every menu type renders carries the class the exemption names.
    expect(CONTEXT_MENU).toMatch(/className=\{`context-menu /);
  });
});
