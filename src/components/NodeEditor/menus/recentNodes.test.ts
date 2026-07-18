import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getRecentNodeTypes, noteNodeUsed, RECENT_MAX } from './recentNodes';

/**
 * MRU list behind the add-node menu's "Recent" section: newest-first, deduped,
 * capped, and tolerant of adversarial/absent storage. Node env has no
 * localStorage, so stub it (same pattern as graphPersistence.test.ts).
 */
describe('recentNodes MRU', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      __store: store,
    });
  });

  it('starts empty and records newest-first', () => {
    expect(getRecentNodeTypes()).toEqual([]);
    noteNodeUsed('mul');
    noteNodeUsed('sin');
    expect(getRecentNodeTypes()).toEqual(['sin', 'mul']);
  });

  it('re-using a type moves it to the front without duplicating', () => {
    noteNodeUsed('mul');
    noteNodeUsed('sin');
    noteNodeUsed('mul');
    expect(getRecentNodeTypes()).toEqual(['mul', 'sin']);
  });

  it('caps at RECENT_MAX, dropping the oldest', () => {
    for (let i = 0; i < RECENT_MAX + 3; i++) noteNodeUsed(`t${i}`);
    const recent = getRecentNodeTypes();
    expect(recent).toHaveLength(RECENT_MAX);
    // Newest first; the earliest few fell off the end.
    expect(recent[0]).toBe(`t${RECENT_MAX + 2}`);
    expect(recent).not.toContain('t0');
  });

  it('ignores malformed / non-string storage instead of throwing', () => {
    localStorage.setItem('fs:recentNodes', '{"not":"an array"}');
    expect(getRecentNodeTypes()).toEqual([]);
    localStorage.setItem('fs:recentNodes', '["ok", 42, null, "ok"]');
    expect(getRecentNodeTypes()).toEqual(['ok']); // strings only, deduped
    localStorage.setItem('fs:recentNodes', 'not json at all');
    expect(getRecentNodeTypes()).toEqual([]);
  });

  it('degrades silently when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => noteNodeUsed('mul')).not.toThrow();
    expect(getRecentNodeTypes()).toEqual([]);
  });
});
