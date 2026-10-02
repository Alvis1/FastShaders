import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('X key deletes the selection, same path as Delete/Backspace (source pin)', () => {
  it('the Delete/Backspace branch also matches a bare X (no Cmd/Ctrl/Alt) and flows into bridgeEdgesAcrossDeletedNodes', () => {
    const src = readFileSync(path.resolve(__dirname, 'NodeEditor.tsx'), 'utf8');
    const start = src.indexOf('// Delete / Backspace / X');
    const end = src.indexOf('window.addEventListener', start);
    const handler = src.slice(start, end);

    // Same condition the Delete/Backspace key uses — X is an alternative
    // trigger into the identical branch, not a second deletion path.
    expect(handler).toMatch(
      /e\.key === 'Delete' \|\|\s*e\.key === 'Backspace' \|\|\s*\(key === 'x' && !mod && !e\.altKey\)/,
    );
    // Guarded like every other bare canvas shortcut: not while typing, and
    // Cmd/Ctrl+X (browser cut) must not trigger it.
    expect(handler).toContain('!mod && !e.altKey');
    expect(handler).toContain('bridgeEdgesAcrossDeletedNodes(');
    expect(handler).toContain('asOneHistoryEntry(');
  });
});
