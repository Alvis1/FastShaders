import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useAppStore } from './useAppStore';

/**
 * The canvas wheel mode is a SETTING, not a device sniff, and these guard the
 * two halves of that: the flag behaves, and the wheel handler actually asks it.
 *
 * Why it is a setting at all: a trackpad's two-finger swipe and a mouse's wheel
 * notch arrive as the SAME DOM event. A heuristic was built (pixel-vs-line
 * delta mode, then the legacy `wheelDelta` detent of 120), shipped, and
 * reverted after it read a real macOS mouse as a trackpad and removed that
 * user's zoom — most likely because macOS accelerates mouse wheels too, so
 * `wheelDelta` is rarely a clean multiple of 120. The class is unsafe to guess
 * at because the failure is asymmetric (misreading a trackpad costs a pan you
 * repeat; misreading a mouse removes a primary control) AND untestable from
 * here: CDP's wheel injection hardcodes `wheelDeltaY` to ±120 whatever delta is
 * requested, and a constructed WheelEvent leaves it at 0.
 */

describe('trackpadScroll — the canvas wheel-mode setting', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });

  it('defaults to the MOUSE model', () => {
    // A wrong default must cost a trackpad user a pan they can still get
    // another way (two-finger horizontal, double-tap-drag) rather than costing
    // a mouse user their zoom, which has no substitute. It is also the
    // historical behaviour, so nobody's canvas changes under them on upgrade.
    expect(useAppStore.getState().trackpadScroll).toBe(false);
  });

  it('persists both ways under fs:trackpadScroll', () => {
    useAppStore.getState().setTrackpadScroll(true);
    expect(useAppStore.getState().trackpadScroll).toBe(true);
    expect(localStorage.getItem('fs:trackpadScroll')).toBe('1');

    useAppStore.getState().setTrackpadScroll(false);
    expect(useAppStore.getState().trackpadScroll).toBe(false);
    expect(localStorage.getItem('fs:trackpadScroll')).toBe('0');
  });

  it('survives storage being unavailable', () => {
    // Private mode / blocked site data: the setting degrades to session-only
    // rather than throwing out of a checkbox handler.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(() => useAppStore.getState().setTrackpadScroll(true)).not.toThrow();
    expect(useAppStore.getState().trackpadScroll).toBe(true);
    useAppStore.getState().setTrackpadScroll(false);
  });
});

describe('trackpadScroll — the consumers that must keep asking', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('reads the flag at EVENT time, never closed over at mount', () => {
    // The wheel listener is bound once (its deps are the stable viewport
    // helpers), so a captured value would freeze whatever the setting was when
    // the canvas mounted and the toggle would appear to do nothing until a
    // reload — which is exactly how a setting reads as broken.
    const ne = read('components/NodeEditor/NodeEditor.tsx');
    expect(ne).toContain('useAppStore.getState().trackpadScroll');
    expect(ne, 'a selector subscription here would rebind the listener per change')
      .not.toMatch(/useAppStore\(\(s\w*\) => s\w*\.trackpadScroll\)/);
  });

  it('keeps zoom reachable in BOTH modes', () => {
    // Pinch and Ctrl/Cmd+wheel pass through to React Flow. Without this the
    // trackpad mode would have no zoom at all.
    const ne = read('components/NodeEditor/NodeEditor.tsx');
    expect(ne).toMatch(/if \(e\.ctrlKey \|\| e\.metaKey\) return;/);
  });

  it('does not reintroduce a device sniff', () => {
    // The reverted heuristic keyed on these. If one comes back, the reasoning
    // above has to be re-read first — measured on real hardware, not guessed.
    const ne = read('components/NodeEditor/NodeEditor.tsx');
    const code = ne.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const banned of ['wheelDeltaY', 'wheelDeltaX', 'deltaMode']) {
      expect(code, `${banned} is device-sniffing — see this file's wheel handler`).not.toContain(banned);
    }
  });

  it('offers the toggle from the toolbar without stealing a right-click', () => {
    const tb = read('components/Layout/Toolbar.tsx');
    expect(tb).toContain('onContextMenu={openPrefs}');
    // A text input's context menu is the one place users genuinely rely on the
    // OS one, and EXPORT owns right-click for its own popover — its handler
    // preventDefaults but does NOT stopPropagation, so without this guard both
    // would open at once.
    expect(tb).toMatch(/closest\('input, textarea, select, \[contenteditable="true"\]'\)/);
    expect(tb).toMatch(/closest\('\.toolbar__export-wrap/);
  });
});
