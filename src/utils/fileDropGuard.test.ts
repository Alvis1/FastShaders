/**
 * A MISSED FILE DROP IS A NO-OP.
 *
 * The bug this pins (owner, 2026-09-19): "why does the drag drop work only in
 * safari — in chrome it opens a separate tab". The app guarded four regions
 * and left the toolbar, the asset browser, the pane seams and every gap to the
 * browser — where Chromium opens the file and throws the unsaved graph away,
 * while WebKit ignores it. Same aim, different browser answer.
 *
 * The two `it`s that matter are the two halves of the trap: guard too little
 * and Chrome navigates; guard too much and every palette tile can be dropped
 * anywhere on the window, because a prevented `dragover` IS what makes an
 * element a drop target.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installFileDropGuard, isFileDrag } from './fileDropGuard';

/** A DragEvent stand-in — the node env has neither DragEvent nor DataTransfer. */
function dragEvent(types: string[] | null): { preventDefault: () => void; prevented: boolean } & Record<string, unknown> {
  const e = {
    prevented: false,
    dataTransfer: types === null ? null : { types },
    preventDefault() { (e as { prevented: boolean }).prevented = true; },
  };
  return e as ReturnType<typeof dragEvent>;
}

/** A window stand-in that records listeners and can fire them. */
function fakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string, e: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('isFileDrag', () => {
  it('is true only for a FILE payload', () => {
    expect(isFileDrag(dragEvent(['Files']) as unknown as DragEvent)).toBe(true);
    expect(isFileDrag(dragEvent(['Files', 'text/plain']) as unknown as DragEvent)).toBe(true);
  });

  it('is false for an internal tile drag, a text drag, and no dataTransfer at all', () => {
    // Palette tiles / saved groups / presets carry their own types. Preventing
    // their dragover would make the WHOLE WINDOW a valid drop target for them.
    expect(isFileDrag(dragEvent(['application/x-fs-tile']) as unknown as DragEvent)).toBe(false);
    expect(isFileDrag(dragEvent(['text/plain']) as unknown as DragEvent)).toBe(false);
    expect(isFileDrag(dragEvent([]) as unknown as DragEvent)).toBe(false);
    expect(isFileDrag(dragEvent(null) as unknown as DragEvent)).toBe(false);
  });

  it('reads a DOMStringList as happily as an array', () => {
    // `types` is a DOMStringList in some engines: it has `length` and indices
    // but no `.includes`, which is why the check goes through Array.prototype.
    const domStringList = Object.assign(Object.create(null), {
      0: 'Files', length: 1, item: (i: number) => (i === 0 ? 'Files' : null),
    });
    expect(isFileDrag({ dataTransfer: { types: domStringList } } as unknown as DragEvent)).toBe(true);
  });
});

describe('installFileDropGuard', () => {
  it('swallows BOTH events for a file drag — dragover and drop', () => {
    // dragover alone is not enough: without it the browser never offers the
    // drop; without drop it performs its own default on the one that lands.
    const w = fakeWindow();
    installFileDropGuard(w as unknown as Window);
    for (const type of ['dragover', 'drop']) {
      const e = dragEvent(['Files']);
      w.fire(type, e);
      expect(e.prevented, type).toBe(true);
    }
  });

  it('leaves an internal drag entirely alone', () => {
    const w = fakeWindow();
    installFileDropGuard(w as unknown as Window);
    for (const type of ['dragover', 'drop']) {
      const e = dragEvent(['application/x-fs-tile']);
      w.fire(type, e);
      expect(e.prevented, type).toBe(false);
    }
  });

  it('detaches both listeners', () => {
    const w = fakeWindow();
    const off = installFileDropGuard(w as unknown as Window);
    expect(w.count('dragover') + w.count('drop')).toBe(2);
    off();
    expect(w.count('dragover') + w.count('drop')).toBe(0);
  });
});

describe('the app installs it', () => {
  it('App mounts the guard for the life of the session', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    expect(src).toContain('installFileDropGuard');
    // Empty deps: it must outlive every drop zone, not follow one of them.
    expect(src).toMatch(/useEffect\(\(\) => installFileDropGuard\(\), \[\]\)/);
  });
});
