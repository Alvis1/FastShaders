import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  act,
  createElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { createLazyGate } from '@/utils/lazyHistoryGate';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import {
  preventSelectAll,
  keepsKeyInEditor,
  lutEditorKey,
  LutEditorRoot,
  LutStepper,
  ToolButton,
  createLutIo,
  discreteWrite,
  setCanonical,
  currentValues,
  useLutEditorWrites,
  useBracketedDrag,
  type CanonicalOf,
  type CleanValues,
  type LutEditorWrites,
  type LutValues,
} from './lutEditorGestures';
import { TEXTURE_BUDGET_MARK, SAMPLED_TEXTURE_STAGE_LIMIT } from '@/engine/textureBudget';

/**
 * The LUT editors' ONE shared shell (menus/lutEditorGestures.tsx), the parts a
 * reviewer found wrong in the browser:
 *   - the number fields showed the OS locale's decimal COMMA (`<input
 *     type="number">`) beside every other value's dot;
 *   - Cmd/Ctrl+A on a marker or the plot ran the browser's select-all;
 *   - the sampled-texture budget had no notice, then scanned the whole module
 *     on every store notify, and printed a hard-coded 16;
 *   - releasing ANY key on a marker or the plot ended a held arrow's undo
 *     entry, so a Shift released mid-hold split one gesture into two;
 *   - the editors' root, own keys, stepper, tool button and discrete write
 *     were copied per editor and had drifted on which brackets a discrete act
 *     closes;
 *   - one canonical-reader ref was shared by every key's gate, so after an RGB
 *     channel switch a live drag's gate compared against the wrong curve;
 *   - a discrete act mid-drag (Delete) closed the drag's bracket but not the
 *     drag, whose next move pulled whatever slid into the deleted slot;
 *   - a write cleaned only the sibling of the key it wrote, so junk on another
 *     key (and its notice) survived the edit.
 */

const src = readFileSync(join(__dirname, 'lutEditorGestures.tsx'), 'utf8');
const state = () => useAppStore.getState();
const stored = (id = 'n') => getNodeValues(state().nodes.find((n) => n.id === id)!);
/** A stand-in reader: the stored string, or the default when absent or not a string. */
const DEFAULT = 'D';
const canon = (key: string) => (v: LutValues) => (typeof v[key] === 'string' ? (v[key] as string) : DEFAULT);
const storeGate = (io: { read(): string; write(next: string): void }) =>
  createLazyGate({ ...io, begin: () => state().beginInteraction(), end: () => state().endInteraction() });

beforeEach(() => {
  useAppStore.setState({ nodes: [makeNode('n', 'float')], edges: [], past: [], future: [], ...HISTORY_IDLE });
});
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
});

describe('LazyNumberField — one decimal separator', () => {
  it('is a text input with a decimal keypad, never type="number"', () => {
    const field = src.slice(src.indexOf('export function LazyNumberField'));
    expect(field).toContain('type="text"');
    expect(field).toContain('inputMode="decimal"');
    expect(field).not.toContain('type="number"');
    expect(field).toContain('value={editText ?? formatFieldNumber(value)}');
  });

  it('reads and shows a number through the ONE app-wide text rule (utils/numberField.ts, pinned there)', () => {
    expect(src).toMatch(/import \{ formatFieldNumber, parseFieldNumber \} from '@\/utils\/numberField';/);
    expect(src).not.toMatch(/export \{[^}]*(parseFieldNumber|formatFieldNumber)/);
  });
});

describe('the editor root key policy', () => {
  const ev = (key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {}, target: unknown = { tagName: 'svg' }) => {
    let prevented = false;
    const e = {
      key,
      metaKey: !!mods.meta,
      ctrlKey: !!mods.ctrl,
      altKey: !!mods.alt,
      target,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as ReactKeyboardEvent;
    preventSelectAll(e);
    return prevented;
  };

  it('Cmd/Ctrl+A on a marker or the plot cancels the browser select-all; nothing else does', () => {
    expect(ev('a', { meta: true })).toBe(true);
    expect(ev('A', { ctrl: true })).toBe(true);
    expect(ev('a')).toBe(false);
    expect(ev('a', { meta: true, alt: true })).toBe(false);
    expect(ev('c', { meta: true })).toBe(false);
  });

  it('a typing target keeps its own select-all', () => {
    expect(ev('a', { meta: true }, { tagName: 'INPUT', type: 'text' })).toBe(false);
  });

  it('keeps every key from the canvas but Escape, Tab and Cmd/Ctrl+S — Apply reaches CodeEditor\'s window listener', () => {
    // A swallowed Cmd+S was neither applied nor preventDefault-ed: the browser opened "Save Page As…".
    const k = (key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {}) =>
      keepsKeyInEditor({ key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt });
    expect(k('Escape')).toBe(false);
    expect(k('Tab')).toBe(false);
    expect(k('s', { meta: true })).toBe(false);
    expect(k('s', { ctrl: true })).toBe(false);
    expect(k('S', { meta: true })).toBe(false);
    for (const key of ['Delete', 'Backspace', 'x', 'X', 'a', 'f', ' ', 'ArrowLeft', 's', 'Enter']) expect(k(key), key).toBe(true);
    expect(k('z', { meta: true })).toBe(true);
    expect(k('d', { ctrl: true })).toBe(true);
    expect(k('s', { meta: true, alt: true })).toBe(true);
  });
});

describe('LazyNumberField — Escape, IME and its role', () => {
  const field = src.slice(src.indexOf('export function LazyNumberField'));

  it('Escape drops a draft not yet written and LEAVES the field, so the menu\'s next Escape closes it', () => {
    // ContextMenu's Escape skips a typing target on the premise that Escape cancels the edit there; without this
    // the abandoned Position draft stayed and the next blur in the menu (a marker press) committed it.
    expect(field).toMatch(/else if \(e\.key === 'Escape'\) \{\s*setDraft\(null\);\s*e\.currentTarget\.blur\(\);\s*\}/);
    // commit reads the REF: the blur's commit runs before a re-render could clear the state.
    expect(field).toMatch(/const commit = \(\) => \{\s*const draft = draftRef\.current;/);
    expect(field).toContain('if (e.nativeEvent.isComposing) return;');
  });

  it('steps on a bare or Shift arrow only — Alt/Ctrl/Cmd+Arrow keep the caret, as in every other number field', () => {
    // On macOS Cmd/Option+Up/Down move the caret to the field's start or end (with Shift, select to there); this
    // field stepped the value and wrote an undo entry instead. The condition is the app-wide rule's own spelling
    // (utils/numberField.ts fieldKeyAction, pinned in numberField.test.ts), so the two cannot drift apart unseen.
    const rule = "(e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey";
    expect(field).toContain(`} else if (${rule}) {`);
    expect(readFileSync(join(__dirname, '../../../utils/numberField.ts'), 'utf8')).toContain(`if (${rule}) {`);
  });

  it('is announced as the spinbutton its arrow keys make it, with its value and range', () => {
    expect(field).toContain('role="spinbutton"');
    expect(field).toContain('aria-valuenow={Number.isFinite(value) ? value : undefined}');
    expect(field).toContain('aria-valuemin={min}');
    expect(field).toContain('aria-valuemax={max}');
    expect(field).toContain('data-fs-lut-field={fieldId}');
  });
});

describe('the texture-budget notice', () => {
  const notice = src.slice(src.indexOf('export function TextureBudgetNotice'), src.indexOf('/** Below this travel'));

  it('reads the RUNNING module for graphToCode\'s own comment, so the two cannot disagree', () => {
    expect(notice).toContain('code.includes(TEXTURE_BUDGET_MARK)');
    expect(TEXTURE_BUDGET_MARK.startsWith('//')).toBe(true);
  });

  it('scans the module once per CODE change, never in a store selector (every notify ran it — 125 µs on a Data-heavy module)', () => {
    expect(notice).toContain('const code = useAppStore((s) => s.previewCode);');
    expect(notice).toContain('useMemo(() => code.includes(TEXTURE_BUDGET_MARK), [code])');
    expect(src).not.toMatch(/useAppStore\(\(s\) => s\.previewCode\.includes/);
  });

  it('prints the stage limit from the constant, in both languages', () => {
    const KEY = 'This shader uses more than {max} textures, so it may fail to compile. Give several nodes the same ramp or curves, or use fewer.';
    expect(notice).toContain(`t('${KEY}', language)`);
    expect(notice).toContain('{ max: SAMPLED_TEXTURE_STAGE_LIMIT }');
    expect(src).not.toMatch(/more than 16 textures/);
    expect(t(KEY, 'lv')).not.toBe(KEY);
    for (const lang of ['en', 'lv'] as const) {
      const text = fillTemplate(t(KEY, lang), { max: SAMPLED_TEXTURE_STAGE_LIMIT });
      expect(text).toContain(String(SAMPLED_TEXTURE_STAGE_LIMIT));
      expect(text).not.toContain('{');
    }
  });
});

describe('the write rule: absent while default, and every write cleaned', () => {
  it('setCanonical deletes the key for the default and stores anything else', () => {
    const v: LutValues = { stops: 'x', other: 1 };
    setCanonical(v, 'stops', DEFAULT, DEFAULT);
    expect('stops' in v).toBe(false);
    setCanonical(v, 'stops', 'y', DEFAULT);
    expect(v).toEqual({ other: 1, stops: 'y' });
  });

  it('a gate write runs the clean on the copy AFTER its own key is set, so junk on ANOTHER key goes with it', () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { a: 'old', b: 'junk' })] });
    const seen: LutValues[] = [];
    const io = createLutIo('n', 'a', canon('a'), DEFAULT, (v) => {
      seen.push({ ...v });
      if (v.b === 'junk') delete v.b;
    });
    expect(io.read()).toBe('old');
    io.write('new');
    expect(seen).toEqual([{ a: 'new', b: 'junk' }]);
    expect(stored()).toEqual({ a: 'new' });
    io.write(DEFAULT);
    expect(stored()).toEqual({});
  });

  it('a node deleted under an open editor reads as the default and takes no write (no history)', () => {
    const io = createLutIo('gone', 'a', canon('a'), DEFAULT);
    expect(io.read()).toBe(DEFAULT);
    io.write('x');
    expect(state().past).toHaveLength(0);
    expect(currentValues('gone')).toBeUndefined();
  });

  it('a discrete act is ONE entry: guarded OUTSIDE against a no-op, cleaned, and every gesture bracket closed BEFORE it writes', () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { a: 'old', b: 'junk' })] });
    const clean = (v: LutValues) => {
      if (v.b === 'junk') delete v.b;
    };
    const calls: string[] = [];
    const endGestures = () => calls.push(`end:${String(stored().a)}`);
    // A no-op touches nothing — no bracket closed, no entry, the junk left for a REAL edit to replace.
    expect(discreteWrite('n', () => false, clean, endGestures)).toBe(false);
    expect(calls).toEqual([]);
    expect(state().past).toHaveLength(0);
    expect(stored()).toEqual({ a: 'old', b: 'junk' });
    // A change: brackets closed while the store still holds the old value, then one write.
    expect(
      discreteWrite(
        'n',
        (v) => {
          v.a = 'new';
          return true;
        },
        clean,
        endGestures,
      ),
    ).toBe(true);
    expect(calls).toEqual(['end:old']);
    expect(stored()).toEqual({ a: 'new' });
    expect(state().past).toHaveLength(1);
    expect(discreteWrite('gone', () => true, clean, endGestures)).toBe(false);
  });

  it('every write path cleans: the gates\' io and the discrete write take the editor\'s clean, three gates per editor', () => {
    const io = src.slice(src.indexOf('export function createLutIo'), src.indexOf('function useLutIo'));
    expect(io).toMatch(/setCanonical\(values, key, next, defaultCanonical\);\s*clean\?\.\(values\);/);
    const discrete = src.slice(src.indexOf('export function discreteWrite'), src.indexOf('export interface LutEditorWrites'));
    expect(discrete).toMatch(/if \(!edit\(out\)\) return false;\s*clean\(out\);\s*endGestures\(\);\s*useAppStore\.getState\(\)\.updateNodeData/);
    const writes = src.slice(src.indexOf('export function useLutEditorWrites'), src.indexOf('export function useLazyIdleWrite'));
    for (const g of ['dragGate', 'keyGate', 'fieldGate']) {
      expect(writes).toContain(`const ${g} = useLazyGate(nodeId, key, canonicalOf, defaultCanonical, clean, closeFirst);`);
    }
    // The ONE bracket closing of the discrete acts — both editors bind it here.
    expect(writes).toMatch(/dragGate\.finish\(\);\s*keyGate\.finish\(\);\s*fieldGate\.finish\(\);\s*closeRef\.current\?\.\(\);/);
  });
});

describe('each key keeps its own reader, and a drag belongs to the gate it latched', () => {
  it('the io is keyed on its reader and clean — no shared ref a channel switch could repoint', () => {
    // One `canonRef` per hook slot was read by the old AND the new key's io, so a C drag's gate compared against
    // R's curve after a tap on R: a move making C equal R's curve was dropped, an unchanged one opened a bracket.
    expect(src).toContain('[nodeId, key, canonicalOf, defaultCanonical, clean]');
    expect(src).not.toContain('canonRef');
  });

  it('a new gate (an RGB channel switch) ends the live drag latched on the old one — only that one', () => {
    const drag = src.slice(src.indexOf('export function useBracketedDrag'), src.indexOf('export interface LazyNumberFieldProps'));
    expect(drag).toContain('const liveRef = useRef<{ gate: LazyGate; end: () => void } | null>(null);');
    expect(drag).toMatch(/const live = liveRef\.current;\s*if \(live && live\.gate === current\) live\.end\(\);\s*\},\s*\[current\],/);
    expect(drag).toContain('liveRef.current = { gate, end };');
  });
});

describe('the editor root: own keys, and a held arrow is ONE entry', () => {
  type FakeEvent = Partial<ReactKeyboardEvent> & { prevented: boolean; stopped: boolean };
  const keyEvent = (key: string, opts: { shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean; target?: unknown } = {}): FakeEvent => {
    const e: FakeEvent = {
      key,
      shiftKey: !!opts.shift,
      metaKey: !!opts.meta,
      ctrlKey: !!opts.ctrl,
      altKey: !!opts.alt,
      target: (opts.target ?? MARKER) as EventTarget,
      prevented: false,
      stopped: false,
    };
    e.preventDefault = () => {
      e.prevented = true;
    };
    e.stopPropagation = () => {
      e.stopped = true;
    };
    return e;
  };
  /** A marker or the plot, structurally: `data-fs-lut-key`, not a typing target. */
  const MARKER = { tagName: 'g', hasAttribute: (n: string) => n === 'data-fs-lut-key' };

  it('decodes an own key only on a marker/plot that is not a typing target, without Cmd/Ctrl/Alt', () => {
    expect(lutEditorKey(keyEvent('ArrowRight') as ReactKeyboardEvent)).toEqual({ kind: 'nudge', dx: 0.01, dy: 0 });
    expect(lutEditorKey(keyEvent('ArrowLeft', { shift: true }) as ReactKeyboardEvent)).toEqual({ kind: 'nudge', dx: -0.1, dy: 0 });
    expect(lutEditorKey(keyEvent('ArrowUp') as ReactKeyboardEvent)).toEqual({ kind: 'nudge', dx: 0, dy: 0.01 });
    expect(lutEditorKey(keyEvent('ArrowDown', { shift: true }) as ReactKeyboardEvent)).toEqual({ kind: 'nudge', dx: 0, dy: -0.1 });
    for (const k of ['Delete', 'Backspace', 'x', 'X']) expect(lutEditorKey(keyEvent(k) as ReactKeyboardEvent), k).toEqual({ kind: 'delete' });
    for (const k of ['a', 'Enter', ' ', 'Shift', 'Escape']) expect(lutEditorKey(keyEvent(k) as ReactKeyboardEvent), k).toBeNull();
    expect(lutEditorKey(keyEvent('Delete', { meta: true }) as ReactKeyboardEvent)).toBeNull();
    expect(lutEditorKey(keyEvent('ArrowLeft', { alt: true }) as ReactKeyboardEvent)).toBeNull();
    // Backspace in the portalled colour picker's hex field, or in a number field, must never delete the stop.
    const field = { tagName: 'INPUT', type: 'text', hasAttribute: () => false };
    expect(lutEditorKey(keyEvent('Backspace', { target: field }) as ReactKeyboardEvent)).toBeNull();
    expect(lutEditorKey(keyEvent('Backspace', { target: { ...field, hasAttribute: () => true } }) as ReactKeyboardEvent)).toBeNull();
    expect(lutEditorKey(keyEvent('Delete', { target: { tagName: 'BUTTON', hasAttribute: () => false } }) as ReactKeyboardEvent)).toBeNull();
    expect(lutEditorKey(keyEvent('Delete', { target: {} }) as ReactKeyboardEvent)).toBeNull();
  });

  const root = (keyGate = storeGate(createLutIo('n', 'a', canon('a'), DEFAULT)), onKey = (_k: unknown) => {}) =>
    LutEditorRoot({ keyGate, onKey, children: null }) as ReactElement<{ onKeyDown(e: unknown): void; onKeyUp(e: unknown): void }>;

  it('keydown: own key first, then every key but Escape, Tab and Cmd/Ctrl+S stops at the root, and Cmd+A is cancelled', () => {
    const got: unknown[] = [];
    const r = root(undefined, (k) => got.push(k));
    const del = keyEvent('Delete');
    r.props.onKeyDown(del);
    expect(got).toEqual([{ kind: 'delete' }]);
    expect(del.stopped).toBe(true);
    for (const e of [keyEvent('Escape'), keyEvent('Tab'), keyEvent('s', { meta: true })]) {
      r.props.onKeyDown(e);
      expect(e.stopped, e.key).toBe(false);
    }
    const all = keyEvent('a', { meta: true });
    r.props.onKeyDown(all);
    expect(all.prevented).toBe(true);
    expect(got).toHaveLength(1);
  });

  it('keyup ends the keyboard gesture only for an ARROW key — a Shift released mid-hold keeps ONE entry', () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { a: 'p0' })] });
    const keyGate = storeGate(createLutIo('n', 'a', canon('a'), DEFAULT));
    const r = root(keyGate);
    keyGate.propose('p1'); // Shift+ArrowRight held: the first step opens the bracket
    r.props.onKeyUp(keyEvent('Shift'));
    expect(keyGate.open).toBe(true);
    r.props.onKeyUp(keyEvent('a'));
    expect(keyGate.open).toBe(true);
    keyGate.propose('p2'); // ArrowRight still held, now without Shift
    r.props.onKeyUp(keyEvent('ArrowRight'));
    expect(keyGate.open).toBe(false);
    expect(state().coalescingHistory).toBe(false);
    expect(state().past).toHaveLength(1);
    state().undo();
    expect(stored().a).toBe('p0');
  });

  it('the root is the ONE copy both editors render', () => {
    const rootSrc = src.slice(src.indexOf('export function LutEditorRoot'), src.indexOf('export function LutStepper'));
    expect(rootSrc).toMatch(/const key = lutEditorKey\(e\);\s*if \(key\) onKey\(key, e\);\s*if \(keepsKeyInEditor\(e\)\) e\.stopPropagation\(\);\s*preventSelectAll\(e\);/);
    expect(rootSrc).toMatch(/onKeyUp=\{\(e\) => \{\s*if \(arrowDirection\(e\.key\)\) keyGate\.finish\(\);\s*if \(keepsKeyInEditor\(e\)\) e\.stopPropagation\(\);/);
    for (const file of ['ColorRampSettings.tsx', 'RgbCurvesSettings.tsx']) {
      const editor = readFileSync(join(__dirname, file), 'utf8');
      expect(editor, file).toContain('<LutEditorRoot ');
      expect(editor, file).toContain('<LutStepper');
      expect(editor, file).not.toMatch(/onKeyDown=|onKeyUp=|className="fs-lut-editor"|fs-lut-editor__stepper|function \w+Button\(|isTypingTarget/);
    }
  });
});

describe('the stepper and the tool button', () => {
  it('the stepper clamps to the list and names both buttons', () => {
    const picked: number[] = [];
    const el = (index: number) =>
      LutStepper({ index, total: 3, label: 'Stop 1 of 3', prevLabel: 'Previous stop', nextLabel: 'Next stop', onSelect: (i) => picked.push(i) }) as ReactElement<{
        children: ReactElement<{ onClick(): void }>[];
      }>;
    el(0).props.children[0].props.onClick();
    el(0).props.children[2].props.onClick();
    el(2).props.children[2].props.onClick();
    el(2).props.children[0].props.onClick();
    expect(picked).toEqual([0, 1, 2, 1]);
    const html = renderToStaticMarkup(createElement(LutStepper, { index: 0, total: 3, label: 'Stop 1 of 3', prevLabel: 'Previous stop', nextLabel: 'Next stop', onSelect: () => {} }));
    expect(html).toContain('aria-label="Previous stop"');
    expect(html).toContain('title="Next stop"');
    expect(html).toContain('Stop 1 of 3');
  });

  it('an inactive tool button keeps its tooltip and stays focusable (aria-disabled, never disabled) and does nothing', () => {
    let clicks = 0;
    const inactive = ToolButton({ label: '+', title: 'cap', ariaLabel: 'Add stop', inactive: true, onClick: () => clicks++ }) as ReactElement<{
      onClick(): void;
    }>;
    inactive.props.onClick();
    expect(clicks).toBe(0);
    (ToolButton({ label: 'Reset curve', title: 'Reset curve', onClick: () => clicks++ }) as ReactElement<{ onClick(): void }>).props.onClick();
    expect(clicks).toBe(1);
    const html = renderToStaticMarkup(createElement(ToolButton, { label: '+', title: 'cap', ariaLabel: 'Add stop', inactive: true, onClick: () => {} }));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('title="cap"');
    expect(html).not.toMatch(/\sdisabled=/);
  });
});

/**
 * A pointer drag belongs to what it latched, and ENDS with it — MOUNTED with
 * react-dom/client (the settledPreview.test.ts technique: a stand-in container,
 * components rendering null, every render inside React's act), because what
 * makes it right is when React runs an effect's cleanup, and a source pin only
 * says the text is there. `window` (useBracketedDrag's listeners — React DOM's
 * commit also reads `HTMLIFrameElement`), `document` (beginDragChrome's <html>
 * class) and `IS_REACT_ACT_ENVIRONMENT` are stubbed for this block and restored.
 */
describe('a live drag ends with the gate and the stop it latched (mounted)', () => {
  type Key = 'a' | 'b';
  /** One reader per key at module scope, as RgbCurvesSettings' CANONICAL_OF: a reader is part of its gates' identity. */
  const READ: Record<Key, CanonicalOf> = { a: canon('a'), b: canon('b') };
  const noClean: CleanValues = () => {};
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const htmlClasses = new Set<string>();
  const fire = (type: string, ev: object) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  const pointerListeners = () => ['pointermove', 'pointerup', 'pointercancel'].reduce((n, t) => n + (listeners.get(t)?.size ?? 0), 0);
  /** Every root a test mounted, unmounted by afterEach whatever the test did. */
  const mounted: (() => Promise<void>)[] = [];
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listeners.clear();
    htmlClasses.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', {
      HTMLIFrameElement: class {},
      addEventListener(type: string, fn: (e: unknown) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: (e: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    });
    vi.stubGlobal('document', {
      documentElement: { classList: { add: (c: string) => htmlClasses.add(c), remove: (c: string) => htmlClasses.delete(c) } },
      body: { style: {} },
    });
    consoleError = vi.spyOn(console, 'error');
  });
  afterEach(async () => {
    // Clean up FIRST and assert last: a failing expect skips what follows it, and under `isolate: false` the stubs —
    // and a drag a failed test left live, whose chrome refcount is module state in utils/dragChrome.ts — would leak
    // into whatever runs next. Unmounting ends a drag on the current gate; the cancel ends one any other way.
    for (const unmount of mounted.splice(0)) await unmount();
    fire('pointercancel', { pointerId: 1 });
    const errors = consoleError.mock.calls.slice();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    expect(errors).toEqual([]);
  });

  /** An editor on key `k`: its writes and a drag whose every move proposes `v<clientX>` on the drag gate. */
  function mountEditor() {
    const out: { writes?: LutEditorWrites; onPointerDown?: (e: ReactPointerEvent<SVGSVGElement>) => void } = {};
    function Editor({ k }: { k: Key }) {
      const writes = useLutEditorWrites('n', k, READ[k], DEFAULT, noClean);
      const drag = useBracketedDrag<{ k: Key }>({ gate: writes.dragGate, start: () => ({ k }), move: (_s, ev) => `v${ev.clientX}` });
      out.writes = writes;
      out.onPointerDown = drag.onPointerDown;
      return null;
    }
    const container = {
      nodeType: 1,
      tagName: 'DIV',
      namespaceURI: null,
      addEventListener() {},
      removeEventListener() {},
      ownerDocument: { addEventListener() {}, removeEventListener() {} },
    } as unknown as Element;
    const root = createRoot(container);
    let live = true;
    const unmount = async () => {
      if (!live) return;
      live = false;
      await act(async () => root.unmount());
    };
    mounted.push(unmount);
    const svg = { setPointerCapture() {}, releasePointerCapture() {} };
    return {
      writes: () => out.writes!,
      render: (k: Key) => act(async () => root.render(createElement(Editor, { k }))),
      unmount,
      press: () =>
        out.onPointerDown!({ pointerType: 'mouse', button: 0, pointerId: 1, clientX: 0, clientY: 0, currentTarget: svg, preventDefault() {} } as unknown as ReactPointerEvent<SVGSVGElement>),
      moveTo: (clientX: number) => fire('pointermove', { pointerId: 1, clientX, clientY: 0 }),
      release: (clientX: number) => fire('pointerup', { pointerId: 1, clientX, clientY: 0 }),
    };
  }

  it('a re-render with the SAME gate keeps the drag: one gesture, one entry', async () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { a: 'a0' })] });
    const m = mountEditor();
    await m.render('a');
    m.press();
    m.moveTo(10);
    await m.render('a');
    expect(pointerListeners()).toBe(3);
    m.moveTo(20);
    m.release(20);
    expect(stored()).toEqual({ a: 'v20' });
    expect(state().past).toHaveLength(1);
    expect(state().interactionDepth).toBe(0);
    expect(pointerListeners()).toBe(0);
    expect(htmlClasses.has('fs-dragging')).toBe(false);
    await m.unmount();
  });

  it('a channel switch (the gates re-key) ENDS the drag latched on the old gate, and that gate keeps ITS key\'s reader', async () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { a: 'a0', b: 'b0' })] });
    const m = mountEditor();
    await m.render('a');
    m.press();
    m.moveTo(10); // past the threshold: the first change opens the drag's bracket
    expect(state().interactionDepth).toBe(1);
    const oldDrag = m.writes().dragGate;
    // A channel tab clicked mid-drag — a second input device, or Shift+Tab and Space while the mouse still drags.
    await m.render('b');
    expect(pointerListeners()).toBe(0);
    expect(htmlClasses.has('fs-dragging')).toBe(false);
    expect(state().interactionDepth).toBe(0);
    m.moveTo(20);
    m.release(30);
    expect(stored()).toEqual({ a: 'v10', b: 'b0' });
    expect(state().past).toHaveLength(1);
    // One shared reader ref made the old gate compare against b's curve: a value equal to b0 read as "no change".
    expect(oldDrag.propose('b0')).toBe(true);
    oldDrag.finish();
    expect(stored()).toEqual({ a: 'b0', b: 'b0' });
    await m.unmount();
  });

  it('a discrete act ENDS a live drag, not only its bracket — the stop or point it held may be gone', async () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { a: 'a0' })] });
    const m = mountEditor();
    await m.render('a');
    const act1 = (to: string) =>
      m.writes().writeDiscrete((v) => {
        v.a = to;
        return true;
      });
    // Delete pressed while the mouse still drags: the next move used to pull whatever slid into the deleted slot.
    m.press();
    m.moveTo(10);
    act1('deleted');
    expect(pointerListeners()).toBe(0);
    expect(htmlClasses.has('fs-dragging')).toBe(false);
    m.moveTo(40);
    m.release(40);
    expect(stored()).toEqual({ a: 'deleted' });
    expect(state().past).toHaveLength(2); // the drag's entry, then the act's
    expect(state().interactionDepth).toBe(0);
    // The same before the drag's first write: the act ends the press.
    m.press();
    act1('flipped');
    m.moveTo(50);
    m.release(50);
    expect(stored()).toEqual({ a: 'flipped' });
    expect(state().past).toHaveLength(3);
    // A no-op act (nothing to remove) interrupts nothing.
    m.press();
    m.writes().writeDiscrete(() => false);
    m.moveTo(60);
    m.release(60);
    expect(stored()).toEqual({ a: 'v60' });
    expect(state().past).toHaveLength(4);
    await m.unmount();
  });

  it('unmount mid-drag ends it: listeners, chrome and bracket', async () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { a: 'a0' })] });
    const m = mountEditor();
    await m.render('a');
    m.press();
    m.moveTo(10);
    await m.unmount();
    expect(pointerListeners()).toBe(0);
    expect(htmlClasses.has('fs-dragging')).toBe(false);
    expect(state().interactionDepth).toBe(0);
    expect(state().past).toHaveLength(1);
  });
});
