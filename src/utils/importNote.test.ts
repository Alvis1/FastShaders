/**
 * The canvas import note as STORE state (utils/importNote.ts + the store's
 * `importNote` / `showImportNote` / `dismissImportNote`).
 *
 * It moved out of NodeEditor's local `useState` so that a surface other than
 * the canvas drop (a zip import, the preview) can post to it. What must not
 * change on the way: a later note REPLACES an earlier one, the 12 s timer armed
 * for an older note cannot clear a newer one, and the note never becomes part
 * of what is saved.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useAppStore } from '@/store/useAppStore';
import { importNoteLineText, importNoteHasConvertLine, type ImportNote } from './importNote';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('the import note in the store', () => {
  // `isolate: false` shares this store with later files in the same worker.
  beforeEach(() => useAppStore.setState({ importNote: null }));
  afterAll(() => useAppStore.setState({ importNote: null }));

  it('starts empty', () => {
    expect(useAppStore.getState().importNote).toBeNull();
  });

  it('shows a note under a fresh id', () => {
    useAppStore.getState().showImportNote([{ kind: 'no-webp', storedAs: 'JPEG' }]);
    const note = useAppStore.getState().importNote;
    expect(note).not.toBeNull();
    expect(note!.id).toMatch(/\S/);
    expect(note!.lines).toEqual([{ kind: 'no-webp', storedAs: 'JPEG' }]);
  });

  it('posts nothing for an empty list (and does not clear the current note)', () => {
    useAppStore.getState().showImportNote([]);
    expect(useAppStore.getState().importNote).toBeNull();
    useAppStore.getState().showImportNote([{ kind: 'preference', storedAs: 'PNG' }]);
    const before = useAppStore.getState().importNote;
    useAppStore.getState().showImportNote([]);
    expect(useAppStore.getState().importNote).toBe(before);
  });

  it('copies the lines, so a caller mutating its array cannot edit the note', () => {
    const lines: { kind: 'no-webp'; storedAs: string }[] = [{ kind: 'no-webp', storedAs: 'JPEG' }];
    useAppStore.getState().showImportNote(lines);
    lines.push({ kind: 'no-webp', storedAs: 'PNG' });
    expect(useAppStore.getState().importNote!.lines).toHaveLength(1);
  });

  it('a later note REPLACES the earlier one, under a new id', () => {
    const s = useAppStore.getState();
    s.showImportNote([{ kind: 'no-webp', storedAs: 'JPEG' }]);
    const first = useAppStore.getState().importNote!;
    s.showImportNote([{ kind: 'preference', storedAs: 'PNG' }]);
    const second = useAppStore.getState().importNote!;
    expect(second.id).not.toBe(first.id);
    expect(second.lines).toEqual([{ kind: 'preference', storedAs: 'PNG' }]);
  });

  it('dismiss with no id clears any note', () => {
    useAppStore.getState().showImportNote([{ kind: 'no-webp', storedAs: 'JPEG' }]);
    useAppStore.getState().dismissImportNote();
    expect(useAppStore.getState().importNote).toBeNull();
  });

  it('dismiss with an id clears only the note carrying it (the timer guard)', () => {
    const s = useAppStore.getState();
    s.showImportNote([{ kind: 'no-webp', storedAs: 'JPEG' }]);
    const staleId = useAppStore.getState().importNote!.id;
    s.showImportNote([{ kind: 'preference', storedAs: 'PNG' }]);
    const fresh = useAppStore.getState().importNote!;
    // The first note's 12 s timer firing after the second note arrived.
    s.dismissImportNote(staleId);
    expect(useAppStore.getState().importNote).toBe(fresh);
    s.dismissImportNote(fresh.id);
    expect(useAppStore.getState().importNote).toBeNull();
  });

  it('dismissing when nothing is shown is a no-op', () => {
    const before = useAppStore.getState();
    useAppStore.getState().dismissImportNote('nope');
    useAppStore.getState().dismissImportNote();
    expect(useAppStore.getState().importNote).toBeNull();
    expect(useAppStore.getState().nodes).toBe(before.nodes);
  });

  it('never becomes part of what is saved: no history, no autosave, no localStorage', () => {
    const store = read('store/useAppStore.ts');
    const history = store.slice(store.indexOf('interface HistoryEntry {'), store.indexOf('const MAX_HISTORY'));
    expect(history).not.toMatch(/importNote/);
    const autosave = store.slice(store.lastIndexOf('useAppStore.subscribe('));
    expect(autosave).not.toMatch(/importNote/);
    expect(store).not.toMatch(/fs:importNote/);
  });
});

describe('importNoteLineText', () => {
  it('renders the two drop-conversion lines verbatim, in both languages', () => {
    expect(importNoteLineText({ kind: 'no-webp', storedAs: 'JPEG' }, 'en')).toBe('Not optimized — stored as JPEG');
    expect(importNoteLineText({ kind: 'preference', storedAs: 'PNG' }, 'en')).toBe(
      'Not optimized (set to “Never”) — stored as PNG',
    );
    for (const kind of ['no-webp', 'preference'] as const) {
      const lv = importNoteLineText({ kind, storedAs: 'WebP' }, 'lv');
      expect(lv).not.toBe(importNoteLineText({ kind, storedAs: 'WebP' }, 'en'));
      expect(lv).toContain('WebP');
      expect(lv).not.toContain('{');
    }
  });

  it('fills the placeholder with a replacer, so a `$&` in the value stays literal', () => {
    expect(importNoteLineText({ kind: 'no-webp', storedAs: '$&' }, 'en')).toBe('Not optimized — stored as $&');
  });
});

describe('importNoteHasConvertLine', () => {
  it('is true exactly when a line is about drop-time conversion', () => {
    const note = (lines: ImportNote['lines']): ImportNote => ({ id: 'x', lines });
    expect(importNoteHasConvertLine(note([{ kind: 'no-webp', storedAs: 'JPEG' }]))).toBe(true);
    expect(importNoteHasConvertLine(note([{ kind: 'preference', storedAs: 'PNG' }]))).toBe(true);
    expect(importNoteHasConvertLine(note([]))).toBe(false);
  });
});

describe('NodeEditor reads the note from the store', () => {
  const src = read('components/NodeEditor/NodeEditor.tsx');

  it('no longer declares it with useState', () => {
    expect(src).not.toMatch(/\[\s*importNote\s*,\s*setImportNote\s*\]\s*=\s*useState/);
    expect(src).not.toMatch(/setImportNote/);
    expect(src).toMatch(/useAppStore\(\(s\) => s\.importNote\)/);
  });

  it('posts a drop through showImageDropReports and clears through dismissImportNote(id)', () => {
    // A drop posts ONE note after its loop, composed by the store from the
    // drop's reports (utils/imageImportNote.ts) and keyed by the drop, so an
    // "Add anyway" on one of its images merges in; placeImageFile decides
    // each image's WebP reason.
    expect(src).toContain('showImageDropReports(dropId, reports)');
    expect(src).toMatch(/mode === 'convert' && !res\.webpAvailable\s*\?\s*'no-webp'/);
    expect(src).toMatch(/mode === 'keep' && store\.imageConvertMode === 'never'\s*\?\s*'preference'/);
    expect(src).toContain('dismissImportNote(id)');
    expect(src).toContain('dismissImportNote(importNote.id)');
  });

  it('renders one span per line, and the "?" only for a conversion line', () => {
    expect(src).toContain('className="node-editor__import-note-lines"');
    expect(src).toContain('importNoteLineText(line, language)');
    expect(src).toContain('importNoteHasConvertLine(importNote) && (');
    expect(read('components/NodeEditor/NodeEditor.css')).toMatch(
      /\.node-editor__import-note-lines\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/,
    );
  });
});

/**
 * N1's desktop variant line (GLB Phase 6): posted by announceExportDelivered
 * only AFTER an export was delivered, so it can never claim a save that did
 * not happen. The line itself, then the "after delivery" wiring on every
 * surface that delivers a bundle.
 */
describe("the 'export-desktop-only' line", () => {
  const MiB = 1024 * 1024;
  const line = { kind: 'export-desktop-only' as const, sizeBytes: 100 * MiB + 1, webLimitBytes: 96 * MiB };

  it('renders both sizes in EN, rounded up to the next tenth', () => {
    expect(importNoteLineText(line, 'en')).toBe(
      'Saved (100.1 MB). Only the desktop editor can open it again — Podest and the web editor open up to 96 MB.',
    );
  });

  it('renders in LV with a decimal comma and no placeholder left', () => {
    const lv = importNoteLineText(line, 'lv');
    expect(lv).not.toBe(importNoteLineText(line, 'en'));
    expect(lv).toContain('100,1');
    expect(lv).toContain('96');
    expect(lv).not.toContain('{');
  });

  it('is not a conversion line, so it never shows the "?"', () => {
    expect(importNoteHasConvertLine({ id: 'x', lines: [line] })).toBe(false);
  });
});

describe('announceExportDelivered runs only after delivery', () => {
  /** The body of the first `const NAME = useCallback(` / `function NAME(` up to `until`. */
  const slice = (src: string, from: string, until: string): string => {
    const a = src.indexOf(from);
    expect(a, `${from} not found`).toBeGreaterThan(-1);
    const b = src.indexOf(until, a + from.length);
    expect(b, `${until} not found after ${from}`).toBeGreaterThan(a);
    return src.slice(a, b);
  };

  it('downloadShader announces AFTER the anchor click, for whatever it delivered', () => {
    const src = read('engine/exportShader.ts');
    const body = slice(src, 'export function downloadShader(', '\n}\n');
    const click = body.indexOf('a.click()');
    const announce = body.indexOf('announceExportDelivered(bundle)');
    expect(click).toBeGreaterThan(-1);
    expect(announce).toBeGreaterThan(click);
  });

  it('the announcement is gated on the study before it plans or posts anything', () => {
    const src = read('engine/exportShader.ts');
    const body = slice(src, 'export function announceExportDelivered(', '\n}\n');
    const evalGate = body.indexOf('if (isEvalMode()) return;');
    expect(evalGate).toBeGreaterThan(-1);
    expect(body.indexOf('planDesktopOnlyExport(')).toBeGreaterThan(evalGate);
    expect(body.indexOf('showImportNote(')).toBeGreaterThan(evalGate);
    // ONE note: showImportNote REPLACES, so a .glb's report and the
    // desktop-only line must be posted together or the first is lost.
    expect(body.match(/showImportNote\(/g) ?? []).toHaveLength(1);
  });

  it('Toolbar EXPORT and NEW\'s save-first deliver through downloadShader and do not announce twice', () => {
    const toolbar = read('components/Layout/Toolbar.tsx');
    expect(toolbar).toContain('if (bundle) downloadShader(bundle);');
    expect(toolbar).not.toContain('announceExportDelivered(');
    const editor = read('components/NodeEditor/NodeEditor.tsx');
    const newShader = slice(editor, 'const startNewShader', 'newGraph()');
    expect(newShader).toContain('downloadShader(bundle);');
    expect(editor).not.toContain('announceExportDelivered(');
  });

  it('the Work-folder Save announces after its write resolved and before the saved flash', () => {
    const src = read('components/Layout/WorkFolder.tsx');
    const save = slice(src, 'const save = useCallback(', 'const toggleList');
    const write = save.indexOf('await invokeDesktop<void>(');
    const announce = save.indexOf('announceExportDelivered(bundle)');
    const flash = save.indexOf('setSavedFlash(true)');
    expect(write).toBeGreaterThan(-1);
    expect(announce).toBeGreaterThan(write);
    expect(flash).toBeGreaterThan(announce);
  });
});
