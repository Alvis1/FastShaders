/**
 * A CONNECTION drag arms the app-wide selection chrome (`.fs-dragging`).
 *
 * Reported by the owner as "when edges are dragged out the strange browser
 * selections (partial) highlight appears". MEASURED 2026-09-18 against this
 * build, one wire dragged off a socket across the canvas and the chrome:
 *
 *   WebKit 26.5   before: 38 selection rectangles painted, fs-dragging=false
 *                 after:   0 rectangles,                    fs-dragging=true
 *   Chrome 152    before and after: 0 — Chrome seeds no selection from an
 *                 anchor under `.react-flow__node`'s `user-select: none`
 *   a GRIP drag (the control, which already armed it): 0 in both engines
 *
 * So the engines disagree about whether the pressed element's `user-select`
 * protects the gesture, and the app's own suppression — which every seam grip
 * has used since it was written — was simply never armed for the canvas. The
 * assertions below are source pins: the vitest env is `node`, so NodeEditor
 * cannot be rendered, and the behaviour half runs against `dragChrome` itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { beginDragChrome } from '@/utils/dragChrome';

const NODE_EDITOR = readFileSync(new URL('./NodeEditor.tsx', import.meta.url).pathname, 'utf8');

/** A document just real enough for dragChrome: a class list and a body style. */
function fakeDocument() {
  const classes = new Set<string>();
  return {
    classes,
    body: { style: { cursor: '' } },
    documentElement: {
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c),
      },
    },
  };
}

describe('beginDragChrome takes a cursor-less gesture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a null cursor sets the class and leaves the document cursor alone', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    const end = beginDragChrome(null);
    expect(doc.classes.has('fs-dragging')).toBe(true);
    // React Flow owns the pointer's look during a connect; pinning `move` over
    // it would fight the connection line.
    expect(doc.body.style.cursor).toBe('');
    end();
    expect(doc.classes.has('fs-dragging')).toBe(false);
  });

  it('the end call is idempotent, so pointerup + pointercancel + unmount is safe', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    const end = beginDragChrome(null);
    end();
    end();
    end();
    expect(doc.classes.has('fs-dragging')).toBe(false);
    // The refcount is not left negative: a fresh gesture still arms and clears.
    const again = beginDragChrome(null);
    expect(doc.classes.has('fs-dragging')).toBe(true);
    again();
    expect(doc.classes.has('fs-dragging')).toBe(false);
  });

  it('a cursor-less gesture cannot strip an overlapping grip drag of its cursor', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    const grip = beginDragChrome('col-resize');
    const connect = beginDragChrome(null);
    expect(doc.body.style.cursor).toBe('col-resize');
    connect();
    // The grip still holds a token, so nothing is cleared under it.
    expect(doc.body.style.cursor).toBe('col-resize');
    expect(doc.classes.has('fs-dragging')).toBe(true);
    grip();
    expect(doc.body.style.cursor).toBe('');
    expect(doc.classes.has('fs-dragging')).toBe(false);
  });
});

describe('NodeEditor arms it for the whole connection gesture', () => {
  it('the helper exists and is cursor-less', () => {
    expect(NODE_EDITOR).toContain("import { beginDragChrome } from '@/utils/dragChrome';");
    expect(NODE_EDITOR).toContain('function setConnectChrome(on: boolean): void {');
    expect(NODE_EDITOR).toContain('endConnectChrome = beginDragChrome(null);');
  });

  it('onConnectStart arms it', () => {
    const start = NODE_EDITOR.indexOf('const onConnectStart = useCallback(');
    expect(start).toBeGreaterThan(0);
    const body = NODE_EDITOR.slice(start, NODE_EDITOR.indexOf('const onConnectEnd = useCallback('));
    expect(body).toContain('setConnectChrome(true);');
  });

  it('onConnectEnd releases it ABOVE every early return', () => {
    const at = NODE_EDITOR.indexOf('const onConnectEnd = useCallback(');
    expect(at).toBeGreaterThan(0);
    const body = NODE_EDITOR.slice(at, at + 2600);
    const release = body.indexOf('setConnectChrome(false);');
    const firstReturn = body.indexOf('return;');
    expect(release).toBeGreaterThan(0);
    expect(firstReturn).toBeGreaterThan(0);
    // A missed release leaves `.fs-dragging` on <html> and the whole app
    // unselectable — worse than the defect it fixes.
    expect(release).toBeLessThan(firstReturn);
  });

  it('unmount releases it', () => {
    const at = NODE_EDITOR.indexOf("document.documentElement.classList.remove('fs-canvas-busy');\n    // Same guarantee");
    expect(at).toBeGreaterThan(0);
    expect(NODE_EDITOR.slice(at, at + 400)).toContain('setConnectChrome(false);');
  });

  it('the pointer reaper releases it above its own canvasBusy early return', () => {
    const at = NODE_EDITOR.indexOf('function trackPointerUp(');
    expect(at).toBeGreaterThan(0);
    const body = NODE_EDITOR.slice(at, at + 1200);
    const release = body.indexOf('setConnectChrome(false);');
    const busyReturn = body.indexOf('if (canvasBusy === 0) return;');
    expect(release).toBeGreaterThan(0);
    expect(busyReturn).toBeGreaterThan(release);
  });
});
