/**
 * `fs-canvas-busy` — the class that takes the 3D preview out of hit-testing
 * for the length of a canvas gesture, and the reaper that stops it sticking.
 *
 * WHY IT EXISTS: the preview is a sandboxed, opaque-origin iframe, so the
 * moment the pointer crosses into it the parent stops receiving mouse events
 * at all — including the `mouseup` d3-zoom listens for. A middle-button pan
 * dragged over the preview therefore never ended. Node drags and connection
 * drags cross the same boundary, so all three bracket it.
 *
 * WHY THE REAPER: the bracket is a refcount over React Flow's paired start/stop
 * callbacks, and every release depends on the stop actually arriving. When one
 * does not — a node deleted out from under a drag, a cancelled connection — the
 * count never returns to 0 and the preview is INERT FOR THE REST OF THE
 * SESSION. Reported from the canvas as "the 3D view is sometimes not
 * interactable; dragging selects the ✕ text instead", which is precisely what a
 * `pointer-events: none` iframe looks like: the drag lands on the chrome
 * behind it. Chasing each missing stop is whack-a-mole; the reaper closes the
 * class instead — the flag protects a POINTER gesture, so once every pointer
 * has lifted there is nothing left to protect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'NodeEditor.tsx'), 'utf8');

describe('the canvas-busy flag', () => {
  it('is a refcount, so overlapping gestures cannot un-arm each other', () => {
    // React Flow fires onMoveStart for the pan UNDER a selection drag, so a
    // boolean would let whichever ended first re-arm the iframe while the other
    // was still running.
    expect(SRC).toContain('canvasBusy = Math.max(0, canvasBusy + (busy ? 1 : -1));');
  });

  it('clears once every pointer has lifted, whatever React Flow reported', () => {
    expect(SRC).toContain('const activePointers = new Set<number>();');
    // By ID, not a boolean: a touch gesture holds several pointers and lifting
    // one finger does not end a two-finger pan.
    expect(SRC).toContain('activePointers.add(e.pointerId);');
    expect(SRC).toContain('activePointers.delete(e.pointerId);');
    expect(SRC).toContain('if (activePointers.size > 0 || busyReapFrame) return;');
  });

  it('reaps in a rAF, so the ordinary stop handlers still go first', () => {
    // React Flow's own stops fire on pointerup too. Running before them would
    // clear a flag they are about to clear anyway — harmless — but running
    // after keeps the normal path byte-for-byte what it was, and leaves this
    // collecting only a residue.
    const reaper = SRC.slice(SRC.indexOf('function trackPointerUp'), SRC.indexOf('function trackPointerUp') + 600);
    expect(reaper).toContain('requestAnimationFrame(');
    expect(reaper).toContain("document.documentElement.classList.remove('fs-canvas-busy')");
  });

  it('listens in the CAPTURE phase and unbinds on unmount', () => {
    // Capture, so a handler that stops propagation cannot hide the release.
    expect(SRC).toContain("window.addEventListener('pointerup', trackPointerUp, true);");
    expect(SRC).toContain("window.addEventListener('pointercancel', trackPointerUp, true);");
    expect(SRC).toContain("window.removeEventListener('pointercancel', trackPointerUp, true);");
  });

  it('still resets the module-scope counter on unmount', () => {
    // `canvasBusy` outlives the component, so a residue would push the next
    // mount's first arm to 2 and no stop could bring it back to 0.
    expect(SRC).toMatch(/useEffect\(\(\) => \(\) => \{\s*canvasBusy = 0;/);
  });
});
