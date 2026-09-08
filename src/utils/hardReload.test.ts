/**
 * The toolbar reload button's right-click menu.
 *
 * Two of these pins exist because the wrong version COMPILES and ships a
 * control that quietly does nothing (`location.reload(true)`), and one because
 * the wrong version destroys a study participant's session
 * (`sessionStorage.clear()`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HARD_RELOAD_PARAM,
  HARD_RELOAD_CLEARED_KEYS,
  hardReloadUrl,
  strippedHardReloadUrl,
  clearHardReloadState,
} from './hardReload';

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('hardReloadUrl', () => {
  it('adds the marker, preserving path, other params and hash', () => {
    const out = hardReloadUrl('https://fs.sferas.lv/?fsdbg=noanim#frag', 1234);
    const u = new URL(out);
    expect(u.pathname).toBe('/');
    expect(u.searchParams.get('fsdbg')).toBe('noanim');
    expect(u.searchParams.get(HARD_RELOAD_PARAM)).toBe('1234');
    expect(u.hash).toBe('#frag');
  });

  it('works under a deploy sub-path', () => {
    const u = new URL(hardReloadUrl('https://alvis1.github.io/FastShaders/', 7));
    expect(u.pathname).toBe('/FastShaders/');
    expect(u.searchParams.get(HARD_RELOAD_PARAM)).toBe('7');
  });

  it('replaces an existing marker rather than stacking one', () => {
    const out = hardReloadUrl('https://x.test/?fsreload=1', 2);
    expect(out.match(/fsreload/g)).toHaveLength(1);
    expect(new URL(out).searchParams.get(HARD_RELOAD_PARAM)).toBe('2');
  });

  it('never reproduces the URL it was given', () => {
    // A navigation to the byte-identical URL is just a reload — i.e. exactly
    // the thing this is trying not to be. Two hard reloads inside the same
    // millisecond are the case.
    const href = 'https://x.test/?fsreload=99';
    expect(hardReloadUrl(href, 99)).not.toBe(href);
  });
});

describe('strippedHardReloadUrl', () => {
  it('returns null on an ordinary load', () => {
    // Null rather than the unchanged string, so the boot path can skip the
    // history.replaceState on every normal page view.
    expect(strippedHardReloadUrl('https://x.test/app/')).toBeNull();
    expect(strippedHardReloadUrl('https://x.test/?fsdbg=noanim')).toBeNull();
  });

  it('removes only the marker', () => {
    expect(strippedHardReloadUrl('https://x.test/a?fsreload=5&fsdbg=noanim'))
      .toBe('https://x.test/a?fsdbg=noanim');
  });

  it('leaves no dangling question mark', () => {
    // It would be copied into every bookmark and shared link made from here.
    expect(strippedHardReloadUrl('https://x.test/a?fsreload=5')).toBe('https://x.test/a');
    expect(strippedHardReloadUrl('https://x.test/a?fsreload=5#f')).toBe('https://x.test/a#f');
  });
});

/**
 * NB the declared list is EMPTY today (hardReload.ts documents why the loop is
 * kept), so any assertion written as a loop OVER it asserts nothing. The pins
 * below are therefore written to hold in BOTH states: they compare the calls
 * the function makes against the list, and grep the source for the two shapes
 * that would destroy a study session.
 */
describe('what a hard reload clears', () => {
  /** Every key `clearHardReloadState` asks the storage to remove, in order. */
  const removedKeys = (removeItem?: (k: string) => void): string[] => {
    const calls: string[] = [];
    clearHardReloadState({
      removeItem(k: string) { calls.push(k); removeItem?.(k); },
    });
    return calls;
  };

  it('is a declared list that names no eval key', () => {
    // The four sessionStorage keys in the codebase are eval's. A blanket
    // clear would drop a participant's telemetry journal and return them to
    // the consent screen mid-study, and the package's SUS-integrity checks
    // would then flag a session that was actually intact.
    // The loop is dormant while the list is empty; the export-shape assertion
    // beside it is what keeps the list a LIST, so re-adding a key re-arms the
    // loop rather than quietly bypassing it.
    expect(Array.isArray(HARD_RELOAD_CLEARED_KEYS)).toBe(true);
    for (const key of HARD_RELOAD_CLEARED_KEYS) {
      expect(key.startsWith('fs:eval'), key).toBe(false);
    }
    const src = codeOnly(read('src/utils/hardReload.ts'));
    expect(src).not.toMatch(/sessionStorage\s*\.\s*clear\s*\(/);
    expect(src).not.toMatch(/localStorage\s*\./);
  });

  it('survives a storage that throws', () => {
    // With no declared keys the throwing storage is never reached, so the
    // source pin is what carries this today: the removal must sit INSIDE a
    // try/catch, or the first key added back takes the whole reload handler
    // down in private mode.
    expect(() => removedKeys(() => { throw new Error('blocked'); })).not.toThrow();
    const src = read('src/utils/hardReload.ts');
    expect(src).toMatch(/storage\.removeItem\(key\);\s*\}\s*catch/);
  });

  it('removes exactly the declared keys — no more, no fewer', () => {
    // Equality, not `map.size === 0`: with an empty list that older form held
    // whatever the function did, while this one still says something real —
    // that a hard reload touches NOTHING it has not declared.
    expect(removedKeys()).toEqual([...HARD_RELOAD_CLEARED_KEYS]);
  });
});

describe('the toolbar control', () => {
  const tb = codeOnly(read('src/components/Layout/Toolbar.tsx'));

  it('never spells the reload argument that does nothing', () => {
    // The Location IDL takes no arguments and WebIDL discards extras, so
    // `reload(true)` ships a right-click identical to the left-click — and TS
    // declares `reload(): void`, so the compile error tends to get cast away
    // rather than read as the correction it is.
    // Comments stripped: hardReload.ts's own doc block names the mistake in
    // order to warn about it. The CALLS must not.
    expect(tb).not.toMatch(/reload\s*\(\s*true\s*\)/);
    expect(codeOnly(read('src/utils/hardReload.ts'))).not.toMatch(/reload\s*\(\s*true\s*\)/);
  });

  it('keeps its right-click off the toolbar prefs popup', () => {
    // openPrefs is bound on the BAR ROOT, so a control that opens its own
    // popover must be excluded or both open at the same coordinates while the
    // bar is expanded — and only the new one once collapsed, because
    // `.toolbar__overflow` is already guarded. State-dependent, so it survives
    // testing at one window size.
    expect(tb).toMatch(/closest\('\.toolbar__export-wrap[^']*\.toolbar__reload-wrap'\)/);
    expect(tb).toMatch(/className="toolbar__local toolbar__reload-wrap"/);
  });

  it('binds the touch gesture to the ELEMENT, not a ref', () => {
    // React unmounts this button from the bar and remounts it inside the ☰
    // menu; useLongPress keys on the target's identity and a ref object's
    // identity never changes, so a ref here goes stale on the first collapse
    // and the gesture dies silently for the rest of the session.
    expect(tb).toMatch(/useLongPress\(reloadBtn,/);
    expect(tb).toMatch(/ref=\{setReloadBtn\}/);
  });

  it('closes the menu when the bar collapses', () => {
    // Otherwise a popover opened on the bar and then collapsed away renders
    // itself already-open inside the ☰ with no gesture — worse here than for
    // the other popovers, because one of these rows takes the page down.
    expect(tb).toMatch(/setReloadOpen\(false\);\s*\}, \[overflow\.collapsed\]\)/);
  });
});
