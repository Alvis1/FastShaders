import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The window-level key handlers that edit the GRAPH stand down while an
 * aria-modal dialog is open — the guard useKeyboardNav already had
 * (evalDialogs.test.ts pins that one).
 *
 * LimitModal, CsvImportModal, CostProfileModal and FeedbackModal handle only
 * Escape and focus a plain panel div, so every other key reached the canvas.
 * Measured 2026-10-11 in real Chrome: with the Feedback dialog open, Cmd+D
 * duplicated and Backspace deleted the selection behind it, and Cmd+Z typed in
 * its textarea brought back a deleted node. At idle the query matches nothing,
 * so the guard never mutes the canvas in normal use.
 */
const GUARD = `if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;`;
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('graph keys stand down behind an open dialog (source pins)', () => {
  it('NodeEditor\'s accelerator handler (Delete, X, Cmd/Ctrl+C/V/G/D), right after its typing guard', () => {
    const src = read('NodeEditor.tsx');
    const start = src.indexOf('const handler = (e: KeyboardEvent) => {');
    const handler = src.slice(start, src.indexOf('window.addEventListener', start));
    const typing = handler.indexOf('if (isTypingTarget(e.target)) return;');
    const guard = handler.indexOf(GUARD);
    expect(typing).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(typing);
    // Ahead of every accelerator it protects.
    for (const branch of ["if (mod && key === 'c')", "if (mod && key === 'v')", "if (mod && key === 'd')", '// Delete / Backspace / X']) {
      expect(guard, branch).toBeLessThan(handler.indexOf(branch));
    }
  });

  it('NodeEditor\'s bare canvas keys (A, F, Space, Shift+A), after the allow-list and before every key', () => {
    // The allow-list admits a press on `body`, and `body` is where focus falls
    // when a focused element inside an open dialog goes away. Measured
    // 2026-10-11 in real Chrome with the Feedback dialog open and focus on
    // body: A selected all 6 nodes behind it and Space opened the Add-node
    // menu, whose search then took the dialog's focus (Enter would add a node).
    const src = read('NodeEditor.tsx');
    const start = src.indexOf('const onKey = (e: KeyboardEvent) => {\n      if (isTypingTarget(e.target)) return;');
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("window.addEventListener('keydown', onKey);", start));
    const allow = handler.indexOf('if (!onCanvas && !unfocused) return;');
    const guard = handler.indexOf(GUARD);
    expect(allow).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(allow);
    for (const branch of ["if (key === 'a' && !e.shiftKey)", "if (key === 'f' && !e.shiftKey)", "if (key === ' ' && !e.shiftKey)"]) {
      expect(handler.indexOf(branch), branch).toBeGreaterThan(guard);
    }
  });

  it('useSyncEngine\'s Cmd/Ctrl+Z handler — and a text field keeps its own native undo', () => {
    const src = read('../../hooks/useSyncEngine.ts');
    const start = src.indexOf('const handleKeyDown = (e: KeyboardEvent) => {');
    const handler = src.slice(start, src.indexOf("window.addEventListener('keydown', handleKeyDown)", start));
    const undo = handler.indexOf('useAppStore.getState().undo();');
    expect(handler.indexOf(GUARD)).toBeGreaterThan(-1);
    expect(handler.indexOf(GUARD)).toBeLessThan(undo);
    // Cmd+Z in the toolbar's Name field undid the last GRAPH edit and the
    // field's own undo never ran. keepsNativeUndo (utils/isTypingTarget, unit
    // tested there) leaves number fields and selects on graph undo.
    expect(handler.indexOf('if (keepsNativeUndo(e.target)) return;')).toBeGreaterThan(-1);
    expect(handler.indexOf('if (keepsNativeUndo(e.target)) return;')).toBeLessThan(handler.indexOf('e.preventDefault();'));
    expect(src).toContain("import { keepsNativeUndo } from '@/utils/isTypingTarget';");
  });
});
