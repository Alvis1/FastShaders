/**
 * The Textures tab's session unlock — behaviour plus the source pins that keep
 * it an ADD-SURFACE filter.
 *
 * None of what this guards fails loudly. A leaked texture strip still renders
 * perfectly; a gate in the wrong layer still compiles; a redirector that never
 * reaches the dev server still returns HTTP 200 with a working editor. Each
 * pin below exists because the failure it describes reads as "the feature was
 * never implemented" rather than as a bug.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TEXTURES_ARM_KEY,
  TEXTURES_ARM_VALUE,
  consumeTexturesArm,
  areTexturesUnlocked,
} from './texturesUnlock';

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
/** Comments stripped, so a pin can never be satisfied by prose about it. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Minimal Storage stand-in — the vitest env is `node`, which has none. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('textures unlock — the read is destructive', () => {
  it('reports an armed key once, and takes it with it', () => {
    const s = fakeStorage({ [TEXTURES_ARM_KEY]: TEXTURES_ARM_VALUE });
    expect(consumeTexturesArm(s)).toBe(true);
    // THE mechanism: any later page load — soft reload, hard reload, restored
    // tab — finds nothing. A page cannot tell Cmd+R from Cmd+Shift+R
    // (PerformanceNavigationTiming says 'reload' for both and sessionStorage
    // survives either), so the app ends the unlock itself instead of asking
    // the browser a question it cannot answer.
    expect(s.map.has(TEXTURES_ARM_KEY)).toBe(false);
    expect(consumeTexturesArm(s)).toBe(false);
  });

  it('treats any other value as not armed, and still clears it', () => {
    for (const junk of ['0', 'true', '', 'yes', '2']) {
      const s = fakeStorage({ [TEXTURES_ARM_KEY]: junk });
      expect(consumeTexturesArm(s), junk).toBe(false);
      // Cleared even when it meant nothing: a stale or hand-edited value must
      // not sit there waiting to be reinterpreted by a later build.
      expect(s.map.has(TEXTURES_ARM_KEY), junk).toBe(false);
    }
  });

  it('degrades to LOCKED when storage throws', () => {
    // Private mode / blocked storage. Locked is the safe direction: the
    // palette merely looks the way it does for everyone who did not use the
    // entry, rather than the hidden library appearing by accident.
    const boom = {
      getItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    expect(consumeTexturesArm(boom)).toBe(false);
  });

  it('is locked by default with nothing to arm it', () => {
    // The node env has no sessionStorage at all, which is also the shape of a
    // browser that blocks it — the module must survive that, not throw
    // through every consumer that imports it.
    expect(areTexturesUnlocked()).toBe(false);
  });
});

describe('the entry that arms it', () => {
  const page = read('public/textures/index.html');

  it('arms via sessionStorage, never localStorage', () => {
    // The same rule (and the same pin) eval mode carries: a localStorage arm
    // would leave this browser unlocked for every later visit, with no way
    // back short of clearing site data.
    expect(page).toContain("sessionStorage.setItem('fs:texturesArm'");
    // The word may appear in the explanatory comment; the CALLS must not.
    expect(page).not.toMatch(/localStorage\s*\./);
  });

  it('spells the key the module reads', () => {
    // The writer and the reader are a drift pair with nothing between them —
    // a typo on either side is a redirector that silently does nothing.
    expect(TEXTURES_ARM_KEY).toBe('fs:texturesArm');
    expect(page).toContain(`'${TEXTURES_ARM_KEY}'`);
    expect(page).toContain(`'${TEXTURES_ARM_VALUE}'`);
  });

  it('keeps every reference relative', () => {
    // Copied VERBATIM into dist — nothing rewrites public/ — so a leading
    // slash resolves against the server root and misses /FastShaders/ and
    // /fastshaders/ while looking perfect on fs.sferas.lv, the one host it
    // targets. (favicons.test.ts pins the icon href; this covers the hop.)
    expect(page).toContain("location.replace('../')");
    expect(page).not.toMatch(/location\.replace\('\//);
  });

  it('is registered with the dev server', () => {
    // Without this, `/textures` in `npm run dev` is answered by the SPA
    // fallback with the APP's own index.html: HTTP 200, a fully working
    // editor, no unlock, no 404 and no console error — so the bug gets hunted
    // in the flag reader instead of the dev server.
    const vite = codeOnly(read('vite.config.ts'));
    expect(vite).toMatch(/PUBLIC_ENTRY_DIRS\s*=\s*\[[^\]]*'textures'/);
  });
});

describe('the gate is an add-surface filter', () => {
  const browser = codeOnly(read('src/components/NodeEditor/ContentBrowser.tsx'));

  it('gates the tab list AND the search results', () => {
    expect(browser).toMatch(/areTexturesUnlocked\(\)/);
    // Two sites, because a live search surfaces texture cards on EVERY tab
    // (they are appended to the generic strip). Gating only the tab list
    // leaves the Textures tab gone and `marble` one keystroke away — the
    // feature reads as half-removed in both directions.
    const uses = browser.match(/texturesUnlocked/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    const memo = browser.slice(browser.indexOf('const filteredTextures'));
    expect(memo.slice(0, 400)).toMatch(/if \(!texturesUnlocked\) return \[\];/);
  });

  it('leaves the texture library itself alone', () => {
    // Hiding must never become a REGISTRY filter: the accessors stay whole, so
    // a saved .fastshader, a saved group or a built-in preset holding a
    // texture still resolves. The placement path (instantiateBuiltinTexture)
    // is deliberately ungated for the same reason.
    for (const f of [
      'src/registry/builtinTextures.ts',
      'src/store/useAppStore.ts',
      'src/components/Graphs/GraphsPage.tsx',
    ]) {
      expect(codeOnly(read(f)), f).not.toMatch(/texturesUnlock|areTexturesUnlocked/);
    }
  });

  it('never reaches the engine', () => {
    // The same statement editorVisibility makes about the hidden set: if
    // codegen, the parser and the evaluator cannot see the flag, a locked
    // session cannot compile to different bytes than an unlocked one.
    const offenders: string[] = [];
    for (const f of [
      'src/engine/graphToCode.ts',
      'src/engine/codeToGraph.ts',
      'src/engine/cpuEvaluator.ts',
      'src/engine/projectImport.ts',
    ]) {
      if (/texturesUnlock|areTexturesUnlocked/.test(codeOnly(read(f)))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the desktop build unlocked', () => {
    // The .dmg/.exe has no address bar and no Reload menu item, so /textures
    // cannot be reached there by any gesture — shipping the lock would remove
    // the texture library from that build permanently, with no way back.
    expect(codeOnly(read('src/utils/texturesUnlock.ts'))).toMatch(
      /return __FS_DESKTOP__ \|\| unlocked;/,
    );
  });
});
