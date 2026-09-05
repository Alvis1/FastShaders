import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPTIONAL_CATEGORIES,
  OPTIONAL_CATEGORY_KEYS,
  DEFAULT_OPTIONAL_CATEGORIES,
  isOptionalCategory,
  loadOptionalCategories,
  hiddenOptionalCategories,
  visibleTabs,
  effectiveTab,
} from './optionalCategories';
import { getAllDefinitions, getEditorDefinitions, searchNodes } from './nodeRegistry';
import { CATEGORIES } from './nodeCategories';
import { formatCategoryLabel, t } from '@/i18n';
import { useAppStore } from '@/store/useAppStore';
import type { NodeCategory } from '@/types';

/**
 * The palette's optional categories — Textures and Distance fields, OFF by
 * default, switched on from the toolbar's right-click list.
 *
 * Nothing here fails loudly. A surface that forgets to pass the hidden set
 * still renders a perfectly good palette (with a family the user switched off
 * back in it); an engine module that reads the flag still compiles every
 * shader (to different bytes per browser); a redirector left behind still
 * answers with a working editor. Each pin below names the way it would rot.
 */

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name) && !name.includes('.test.')) out.push(full);
  }
  return out;
}

const hide = (...ids: NodeCategory[]) => new Set<NodeCategory>(ids);

describe('the flags', () => {
  it('are OFF by default, for every optional category', () => {
    for (const id of OPTIONAL_CATEGORIES) expect(DEFAULT_OPTIONAL_CATEGORIES[id], id).toBe(false);
    expect(loadOptionalCategories(() => null)).toEqual(DEFAULT_OPTIONAL_CATEGORIES);
  });

  it('name real categories that have a tab label in both languages', () => {
    // The right-click row is labelled with the category's own tab name, so the
    // switch and the tab it summons read as one thing — in Latvian too.
    for (const id of OPTIONAL_CATEGORIES) {
      const cat = CATEGORIES.find((c) => c.id === id);
      expect(cat, id).toBeDefined();
      expect(formatCategoryLabel(cat!.label, id, 'lv')).not.toBe(cat!.label);
      expect(isOptionalCategory(id)).toBe(true);
    }
    expect(isOptionalCategory('math')).toBe(false);
    expect(isOptionalCategory('')).toBe(false);
  });

  it('read only the exact string "1" as on — validated, never coerced', () => {
    // localStorage is writable by anything at this origin.
    for (const junk of ['0', 'true', 'yes', '', ' 1', '01', '2']) {
      const flags = loadOptionalCategories(() => junk);
      for (const id of OPTIONAL_CATEGORIES) expect(flags[id], `${id} ← ${JSON.stringify(junk)}`).toBe(false);
    }
    const on = loadOptionalCategories((k) => (k === OPTIONAL_CATEGORY_KEYS.sdf ? '1' : null));
    expect(on).toEqual({ ...DEFAULT_OPTIONAL_CATEGORIES, sdf: true });
  });

  it('survive a reader that throws', () => {
    expect(loadOptionalCategories(() => { throw new Error('blocked'); })).toEqual(DEFAULT_OPTIONAL_CATEGORIES);
  });

  it('turn into the set of categories to WITHHOLD', () => {
    expect([...hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES)].sort()).toEqual([...OPTIONAL_CATEGORIES].sort());
    expect(hiddenOptionalCategories({ texture: true, sdf: true }).size).toBe(0);
    expect([...hiddenOptionalCategories({ texture: true, sdf: false })]).toEqual(['sdf']);
  });

  it('decide the tab strip by value: an optional tab is drawn only while on', () => {
    const tabs = [{ id: 'presets' }, { id: 'texture' }, { id: 'noise' }, { id: 'sdf' }, { id: 'output' }];
    expect(visibleTabs(tabs, DEFAULT_OPTIONAL_CATEGORIES).map((t) => t.id)).toEqual(['presets', 'noise', 'output']);
    expect(visibleTabs(tabs, { texture: true, sdf: false }).map((t) => t.id)).toEqual(['presets', 'texture', 'noise', 'output']);
    expect(visibleTabs(tabs, { texture: true, sdf: true })).toEqual(tabs);
    // Order and the non-optional tabs are untouched — it is a filter, never a sort.
    expect(visibleTabs(tabs, { texture: false, sdf: true }).map((t) => t.id)).toEqual(['presets', 'noise', 'sdf', 'output']);
  });

  it('derive the shown tab: a stored optional tab falls back to All only while off', () => {
    expect(effectiveTab('sdf', DEFAULT_OPTIONAL_CATEGORIES)).toBe('all');
    expect(effectiveTab('texture', DEFAULT_OPTIONAL_CATEGORIES)).toBe('all');
    expect(effectiveTab('sdf', { texture: false, sdf: true })).toBe('sdf');
    expect(effectiveTab('texture', { texture: true, sdf: false })).toBe('texture');
    // Every other tab is passed through whatever the switches say.
    for (const tab of ['all', 'saved', 'presets', 'noise', 'math', 'output']) {
      expect(effectiveTab(tab, DEFAULT_OPTIONAL_CATEGORIES), tab).toBe(tab);
    }
  });

  it('use one storage key per category, all under the fs: prefix', () => {
    const keys = Object.values(OPTIONAL_CATEGORY_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^fs:/);
  });
});

describe('the registry narrows by the hidden set', () => {
  it('drops exactly the hidden categories and keeps registry order', () => {
    const all = getEditorDefinitions();
    const narrowed = getEditorDefinitions(hide('sdf'));
    expect(narrowed.some((d) => d.category === 'sdf')).toBe(false);
    expect(narrowed).toEqual(all.filter((d) => d.category !== 'sdf'));
    // The family is real and would otherwise be there — an empty family would
    // make every assertion here vacuous.
    expect(all.filter((d) => d.category === 'sdf').length).toBeGreaterThan(10);
  });

  it('returns ONE array identity per hidden set, however the Set was built', () => {
    // Consumers memoize on the returned identity and build a fresh Set per
    // render, so a per-call filter would silently defeat every one of them.
    expect(getEditorDefinitions(hide('sdf'))).toBe(getEditorDefinitions(new Set(['sdf'])));
    expect(getEditorDefinitions(hide('sdf', 'texture'))).toBe(getEditorDefinitions(hide('texture', 'sdf')));
    expect(getEditorDefinitions(hide())).toBe(getEditorDefinitions());
    expect(getEditorDefinitions(undefined)).toBe(getEditorDefinitions());
  });

  it('never touches getAllDefinitions — a loaded graph still resolves the nodes', () => {
    getEditorDefinitions(hide('sdf', 'texture'));
    expect(getAllDefinitions().some((d) => d.category === 'sdf')).toBe(true);
    expect(getEditorDefinitions().some((d) => d.category === 'sdf')).toBe(true);
  });

  it('searchNodes cannot type a switched-off family back into existence', () => {
    // An exact-name query is the one search tier that would otherwise rank
    // the node first.
    expect(searchNodes('sdBox', hide('sdf')).map((d) => d.type)).not.toContain('sdBox');
    expect(searchNodes('distance', hide('sdf')).some((d) => d.category === 'sdf')).toBe(false);
    expect(searchNodes('sdBox', hide()).map((d) => d.type)).toContain('sdBox');
    expect(searchNodes('sdBox').map((d) => d.type)).toContain('sdBox');
    // A hidden family must not drag its neighbours out with it.
    expect(searchNodes('mul', hide('sdf', 'texture')).map((d) => d.type)).toContain('mul');
    expect(searchNodes('', hide('sdf'))).toBe(getEditorDefinitions(hide('sdf')));
  });
});

describe('the store', () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    });
    useAppStore.setState({ optionalCategories: DEFAULT_OPTIONAL_CATEGORIES });
  });
  // vite.config.ts runs suites with `isolate: false`: the store instance AND
  // globalThis are shared by every file in the worker, so a throwing
  // localStorage stub or an `sdf: true` left behind here lands in whichever
  // suite runs next. setState rather than the setter — the setter would call
  // the throwing stub before it is removed.
  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ optionalCategories: DEFAULT_OPTIONAL_CATEGORIES });
  });

  it('boots from the persisted keys through the validated reader', () => {
    // The store module is instantiated at import, before any stub exists, so
    // the boot READ cannot be exercised here — it is pinned at the source
    // instead: the field is seeded by the pure reader (tested above) over the
    // store's throw-safe loadString, with the same '0' fallback the other
    // boolean prefs use.
    const store = codeOnly(read('src/store/useAppStore.ts'));
    expect(store).toMatch(/optionalCategories:\s*loadOptionalCategories\(\(key\)\s*=>\s*loadString\(key,\s*'0'\)\)/);
  });

  it('persists each switch under its own key, both ways', () => {
    useAppStore.getState().setOptionalCategory('sdf', true);
    expect(useAppStore.getState().optionalCategories).toEqual({ ...DEFAULT_OPTIONAL_CATEGORIES, sdf: true });
    expect(localStorage.getItem(OPTIONAL_CATEGORY_KEYS.sdf)).toBe('1');
    // Flipping one switch writes ONLY its own key.
    expect(localStorage.getItem(OPTIONAL_CATEGORY_KEYS.texture)).toBeNull();
    useAppStore.getState().setOptionalCategory('sdf', false);
    expect(localStorage.getItem(OPTIONAL_CATEGORY_KEYS.sdf)).toBe('0');
    expect(useAppStore.getState().optionalCategories.sdf).toBe(false);
  });

  it('replaces the record on every flip, so a whole-record selector re-runs', () => {
    const before = useAppStore.getState().optionalCategories;
    useAppStore.getState().setOptionalCategory('texture', true);
    expect(useAppStore.getState().optionalCategories).not.toBe(before);
  });

  it('survives storage being unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(() => useAppStore.getState().setOptionalCategory('sdf', true)).not.toThrow();
    expect(useAppStore.getState().optionalCategories.sdf).toBe(true);
  });
});

describe('every add surface passes the hidden set', () => {
  const editorDir = root('src/components/NodeEditor');

  it('every getEditorDefinitions/searchNodes call under components/NodeEditor is fed from hiddenOptionalCategories', () => {
    // A POSITIVE rule, not "no empty parens": `getEditorDefinitions(undefined)`,
    // `(new Set())` and `searchNodes(q, undefined)` all offer the switched-off
    // family just as a bare call does. The argument must be the
    // hiddenOptionalCategories(...) call itself, or an identifier bound from
    // one in the same file (via useMemo or directly).
    const offenders: string[] = [];
    for (const f of sourceFiles(editorDir)) {
      const src = codeOnly(readFileSync(f, 'utf8'));
      const bound = new Set(
        [...src.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:useMemo\(\s*\(\)\s*=>\s*)?hiddenOptionalCategories\(/g)].map((m) => m[1]),
      );
      const fed = (arg: string) => /^hiddenOptionalCategories\(/.test(arg.trim()) || bound.has(arg.trim());
      for (const m of src.matchAll(/\bgetEditorDefinitions\(([^)]*)\)/g)) {
        if (!fed(m[1])) offenders.push(`${f}: getEditorDefinitions(${m[1]})`);
      }
      for (const m of src.matchAll(/\bsearchNodes\(([^)]*)\)/g)) {
        const args = m[1].split(',');
        if (args.length < 2 || !fed(args.slice(1).join(','))) offenders.push(`${f}: searchNodes(${m[1]})`);
      }
    }
    expect(offenders.map((o) => o.slice(editorDir.length + 1))).toEqual([]);
    // The rule has teeth only if the surfaces actually call the accessors.
    expect(codeOnly(read('src/components/NodeEditor/menus/AddNodeMenu.tsx'))).toMatch(/\bsearchNodes\(/);
    expect(codeOnly(read('src/components/NodeEditor/ContentBrowser.tsx'))).toMatch(/\bgetEditorDefinitions\(/);
  });

  it('both surfaces SUBSCRIBE to the flags — a one-time read would make the switch inert until a reload', () => {
    // The palette and the menu are long-lived; `getState()` at mount would
    // freeze the switches, which reads as the setting doing nothing (the
    // trackpadScroll test guards the same failure from the other direction).
    for (const f of ['src/components/NodeEditor/ContentBrowser.tsx', 'src/components/NodeEditor/menus/AddNodeMenu.tsx']) {
      const src = codeOnly(read(f));
      expect(src, f).toMatch(/useAppStore\(\(s\) => s\.optionalCategories\)/);
      expect(src, f).not.toMatch(/getState\(\)\.optionalCategories/);
    }
  });

  it('the content browser gates the tab strip, the defs AND the texture search', () => {
    const src = codeOnly(read('src/components/NodeEditor/ContentBrowser.tsx'));
    // Tabs: the module-scope list feeds the validator; the RENDERED list is the
    // filtered one — a stored 'sdf' stays valid while switched off and comes
    // back with the switch.
    expect(src).toMatch(/visibleTabs\(displayCategories, \w+\)/);
    expect(src).toMatch(/visibleCategories\.map\(/);
    expect(src).not.toMatch(/displayCategories\.map\(\(cat\)/);
    expect(src).toMatch(/effectiveTab\(\w+, \w+\)/);
    // The strip's tallest-tile high-water mark is measured only when the
    // strip's CONTENTS can change; a switched-on family lands its tiles in the
    // All strip with no tab change, so the flags must be a dep of that effect.
    const measureDeps = src.match(/\}, \[activeCategory,[^\]]*\]\);/);
    expect(measureDeps, 'the measurement effect deps').not.toBeNull();
    expect(measureDeps![0]).toMatch(/\boptional\b/);
    // A live search appends texture cards to EVERY tab, so the texture memo
    // has its own gate, above the lazy ~84 ms build.
    const memo = src.slice(src.indexOf('const filteredTextures'));
    expect(memo.slice(0, 400)).toMatch(/if \(!optional\.texture\) return \[\];/);
  });

  it('the Add-node menu narrows its browse list, its search AND its recents', () => {
    const src = codeOnly(read('src/components/NodeEditor/menus/AddNodeMenu.tsx'));
    expect(src).toMatch(/searchNodes\(query, hidden\)/);
    expect((src.match(/getEditorDefinitions\(hidden\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the toolbar rows', () => {
  const tb = read('src/components/Layout/Toolbar.tsx');

  it('renders one checkbox per optional category, from the shared list', () => {
    expect(codeOnly(tb)).toMatch(/OPTIONAL_CATEGORIES\.map\(/);
    expect(codeOnly(tb)).toMatch(/setOptionalCategory\(id,\s*\w+\.target\.checked\)/);
  });

  it('is a plain list — no heading inside the popover, and an accessible name that fits every row', () => {
    // Index and slice on the SAME string: an index taken in the raw source and
    // applied to the comment-stripped one lands past its end and slices ''.
    const code = codeOnly(tb);
    const at = code.indexOf('className="toolbar__prefs-popover"');
    expect(at).toBeGreaterThan(-1);
    const popover = code.slice(at);
    expect(popover).toMatch(/toolbar__prefs-row/);          // positive control
    expect(popover).not.toMatch(/toolbar__local-header/);
    expect(popover).not.toMatch(/Input settings/);           // the removed heading, not kept as the aria-label
    expect(popover).toMatch(/aria-label=\{t\('Settings'/);
    expect(t('Settings', 'lv')).not.toBe('Settings');
  });

  it('opens on a touch long-press too — the list is the ONLY way to switch the categories on', () => {
    // Right-click needs a second button; iPadOS dispatches no contextmenu from
    // a sustained touch (hooks/useLongPress.ts exists for exactly this). The
    // press shares the right-click's guard so EXPORT, the reload button and
    // the name field keep their own gestures.
    const code = codeOnly(tb);
    expect(code).toMatch(/useLongPress\(barRef,/);
    const press = code.slice(code.indexOf('useLongPress(barRef,'), code.indexOf('useLongPress(barRef,') + 200);
    expect(press).toMatch(/prefsClaimedElsewhere\(target\)/);
    expect(code).toMatch(/if \(prefsClaimedElsewhere\(e\.target/);
  });

  it('carries a Latvian hint for every row', () => {
    const block = tb.slice(tb.indexOf('const OPTIONAL_CATEGORY_HINTS'), tb.indexOf('};', tb.indexOf('const OPTIONAL_CATEGORY_HINTS')));
    const hints = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(hints.length).toBe(OPTIONAL_CATEGORIES.length);
    for (const h of hints) expect(t(h, 'lv'), h).not.toBe(h);
  });
});

describe('the flag is an add-surface preference and nothing more', () => {
  it('no engine, util or hook module can see it', () => {
    // If codegen, the parser, the evaluator or a restore path could read the
    // switch, the same .fastshader would compile to different bytes per
    // browser. The STORE holds the flag and is the one exception.
    // The module name, its exports AND the raw storage keys — a direct
    // `localStorage.getItem('fs:showDistanceFields')` reads the same switch
    // without ever naming the module.
    const banned = new RegExp(
      ['optionalCategories', 'OPTIONAL_CATEGOR', 'hiddenOptionalCategories', ...Object.values(OPTIONAL_CATEGORY_KEYS)]
        .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    );
    const offenders: string[] = [];
    for (const dir of ['src/engine', 'src/utils', 'src/hooks']) {
      for (const f of sourceFiles(root(dir))) {
        if (banned.test(codeOnly(readFileSync(f, 'utf8')))) offenders.push(f.slice(root('').length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the overview page and the Node Designer keep seeing everything', () => {
    for (const f of ['src/components/Graphs/GraphsPage.tsx', 'src/nodeDesigner/ndData.ts']) {
      expect(codeOnly(read(f)), f).not.toMatch(/optionalCategories/);
    }
  });

  it('the study clean slate drops the previous participant\'s switches', () => {
    // Scoped to the function BODY: matched anywhere in the file, a refactor
    // that split the function and forgot the call would still pass.
    const src = codeOnly(read('src/eval/EvalGate.tsx'));
    const start = src.indexOf('function cleanSlateForStudy');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/OPTIONAL_CATEGORY_KEYS/);
    expect(body).toMatch(/removeItem\(/);
    expect(body).toMatch(/optionalCategories:\s*DEFAULT_OPTIONAL_CATEGORIES/);
  });
});

describe('the /textures one-load unlock is retired', () => {
  it('has no redirector, no dev-server entry and no module left', () => {
    // A leftover entry answers with a working editor and unlocks nothing —
    // the failure that reads as "the URL never worked".
    expect(existsSync(root('public/textures'))).toBe(false);
    expect(codeOnly(read('vite.config.ts'))).not.toMatch(/PUBLIC_ENTRY_DIRS\s*=\s*\[[^\]]*textures/);
    for (const f of sourceFiles(root('src'))) {
      expect(codeOnly(readFileSync(f, 'utf8')), f).not.toMatch(/texturesUnlock|areTexturesUnlocked|fs:texturesArm/);
    }
  });
});
