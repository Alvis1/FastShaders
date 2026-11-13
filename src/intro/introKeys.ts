/**
 * The intro window's Keys tab ("Taustiņi"): every keyboard shortcut the editor
 * answers, and the mouse gestures that take a key, as DATA. Pure — no DOM, no
 * store — so `introKeys.test.ts` can hold it to the handlers it describes.
 *
 * Each row names its keys as TOKENS, read per platform at display time
 * (`keyLabel`): `mod` is ⌘ on Apple and Ctrl elsewhere — every handler
 * this table describes takes either (`e.metaKey || e.ctrlKey`) — and `alt` is
 * ⌥ / Alt. A token whose label is null on this platform drops its combo:
 * Backspace is the Mac's "delete" key, so there the table lists Delete alone.
 * Mouse gestures are tokens too, printed as translated words (`MOUSE_TOKENS`).
 *
 * Every string is an English `t()` key with its Latvian in lv.json `ui`.
 * Sources: NodeEditor.tsx's accelerators and bare canvas keys, useKeyboardNav,
 * useSyncEngine (undo), CodeEditor (Apply), DragNumberInput + numberField,
 * AddNodeMenu, and the preview document's fly-through (tslToPreviewHTML).
 */

/** One key or gesture: `mod`/`alt`/`shift`, a mouse token, or a key's own name. */
export type KeyToken = string;

/** One combination, pressed together: `['mod', 'Z']` is Ctrl+Z / ⌘Z. */
export type KeyCombo = readonly KeyToken[];

export interface KeyRow {
  /** Alternatives, any one of which does it: Delete, Backspace or X. */
  readonly combos: readonly KeyCombo[];
  /** What it does — an English `t()` key. */
  readonly does: string;
}

/** Gestures, not keys: drawn as words, not key caps. */
export const MOUSE_TOKENS: ReadonlySet<string> = new Set([
  'Click',
  'Double-click',
  'Right-click',
  'Drag',
  'Right-drag',
  'Middle-drag',
  'Wheel',
]);

/** The tokens printed through `t()`: the gestures, and Space (the intro's key
 *  cap already reads "Atstarpe"). Every other key keeps the name printed on
 *  the key — never `t('Delete')`, which is the menu verb "Dzēst". */
export const TRANSLATED_TOKENS: ReadonlySet<string> = new Set([...MOUSE_TOKENS, 'Space']);

/**
 * One flat list, no headings (owner, 2026-11-13: compact): so each row says
 * on its own what it acts on — "a node", "a number", "in the search".
 * Ordered canvas → nodes → keyboard → numbers → code → 3D view.
 */
export const KEY_ROWS: readonly KeyRow[] = [
  { combos: [['Space'], ['shift', 'A'], ['Right-click']], does: 'Open the node search' },
  { combos: [['↑'], ['↓'], ['Enter']], does: 'In the search: pick a result and add it' },
  { combos: [['A']], does: 'Select every node' },
  { combos: [['shift', 'Click']], does: 'Add a node to the selection' },
  { combos: [['Drag']], does: 'Select with a box (start on an empty spot)' },
  { combos: [['F']], does: 'Fit the selection in view (every node if none is selected)' },
  { combos: [['Wheel']], does: 'Zoom in and out' },
  { combos: [['Middle-drag'], ['Right-drag']], does: 'Move the view' },
  { combos: [['Esc']], does: 'Leave Draw, hide socket names, stop a preview' },
  { combos: [['Delete'], ['backspace'], ['X']], does: 'Delete the selection; the wire joins up again' },
  { combos: [['mod', 'C'], ['mod', 'V']], does: 'Copy, paste' },
  { combos: [['mod', 'D']], does: 'Duplicate' },
  { combos: [['mod', 'G'], ['mod', 'shift', 'G']], does: 'Group, ungroup' },
  { combos: [['mod', 'Z'], ['mod', 'shift', 'Z']], does: 'Undo, redo' },
  { combos: [['M']], does: 'Mute: the node is skipped and its input passes through' },
  { combos: [['alt', 'Drag']], does: 'Pull a node out of its chain; the wire joins up again' },
  { combos: [['Double-click']], does: 'Show a node’s socket names' },
  { combos: [['alt', 'Click']], does: 'Show a node in the 3D view' },
  { combos: [['mod', 'Click']], does: 'Attach a node to an Output' },
  { combos: [['Tab'], ['shift', 'Tab']], does: 'Next, previous node' },
  { combos: [['←↑→↓']], does: 'Move the node (with Shift, further)' },
  { combos: [['mod', '←↑→↓']], does: 'Follow the wires: → toward the Output, ← back' },
  { combos: [['alt', '←'], ['alt', '→']], does: 'Jump between the toolbar, canvas, palette, 3D view and code' },
  { combos: [['Drag']], does: 'On a number: change it step by step (the step shows as you drag)' },
  { combos: [['shift', 'Drag']], does: 'On a number: steps ten times bigger' },
  { combos: [['↑'], ['↓']], does: 'In a number box: one step up, down (with Shift, ten)' },
  { combos: [['Tab'], ['shift', 'Tab']], does: 'Next, previous box on the node' },
  { combos: [['Enter'], ['Esc']], does: 'Keep, cancel the typed value' },
  { combos: [['mod', 'S']], does: 'Apply the code: the graph is built from it' },
  { combos: [['W A S D'], ['←↑→↓']], does: 'Fly while Fly through is on (click the 3D view first)' },
  { combos: [['Q'], ['E']], does: 'Fly down, up' },
  { combos: [['shift']], does: 'Fly faster' },
];

/** Whether this is an Apple platform, where the modifier keys are ⌘ and ⌥. */
export function isApplePlatform(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false;
  return /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent || '');
}

/**
 * What a token prints as on this platform, or null when the platform has no
 * such key. Mouse tokens come back as their English `t()` key.
 */
export function keyLabel(token: KeyToken, mac: boolean): string | null {
  switch (token) {
    case 'mod':
      return mac ? '⌘' : 'Ctrl';
    case 'alt':
      return mac ? '⌥' : 'Alt';
    case 'shift':
      return 'Shift';
    // The Mac's Backspace key is the one printed "delete": listed as Delete.
    case 'backspace':
      return mac ? null : 'Backspace';
    default:
      return token;
  }
}

export interface PrintedKey {
  label: string;
  /** A gesture: drawn as a word rather than a key cap. */
  mouse: boolean;
  /** Printed through `t()` (TRANSLATED_TOKENS). */
  translate: boolean;
}

/** The combos this platform can press, each as its printed tokens. */
export function rowCombos(row: KeyRow, mac: boolean): PrintedKey[][] {
  const out: PrintedKey[][] = [];
  for (const combo of row.combos) {
    const keys: PrintedKey[] = [];
    for (const tok of combo) {
      const label = keyLabel(tok, mac);
      if (label === null) break;
      keys.push({ label, mouse: MOUSE_TOKENS.has(tok), translate: TRANSLATED_TOKENS.has(tok) });
    }
    if (keys.length === combo.length) out.push(keys);
  }
  return out;
}
