import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  buildPickerSections,
  createColorCommitStager,
  pickPortalHost,
  placePopover,
  swatchTitle,
  COMMIT_IDLE_MS,
  POPOVER_GAP,
  POPOVER_MARGIN,
} from './colorPickerModel';
import { BUILTIN_PALETTES } from '@/registry/builtinPalettes';
import { MAX_COLORS_PER_PALETTE } from '@/utils/palettes';
import { MAX_RECENT_COLORS, SWATCHES_PER_ROW, RECENT_COLOR_ROWS } from '@/utils/recentColors';

/**
 * The colour picker's model, plus source guards on the parts of the component
 * the `node` vitest env cannot render (same split as
 * inputs/dragNumberBracket.test.ts: real behaviour where it can be executed, a
 * text assertion where it cannot).
 */

const COMPONENT = path.join(__dirname, 'PaletteColorPicker.tsx');
const STYLES = path.join(__dirname, 'PaletteColorPicker.css');

/* ============================================================
 * Sections
 * ============================================================ */

describe('buildPickerSections', () => {
  const shader = [
    { id: 'p1', name: 'Mine', colors: ['#ff0000', '#00ff00'] },
    { id: 'p2', name: 'Ramp', colors: ['#111111'] },
  ];

  it('puts the shader palettes above the built-ins', () => {
    const secs = buildPickerSections(shader, BUILTIN_PALETTES);
    expect(secs.map((s) => s.name)).toEqual([
      'Mine',
      'Ramp',
      ...BUILTIN_PALETTES.map((p) => p.name),
    ]);
    expect(secs.filter((s) => s.builtin)).toHaveLength(BUILTIN_PALETTES.length);
  });

  it('keeps keys unique when a shader palette adopts a built-in id', () => {
    // Reachable: sanitizePalettes honours any id unique within ITS batch, so a
    // crafted project block can carry `builtin-ocean` as a shader palette.
    // NB `builtin-ocean` is a HISTORICAL id — the shipped set has since been
    // replaced — so the case below re-runs this against the ids that ship today.
    const secs = buildPickerSections(
      [{ id: 'builtin-ocean', name: 'Impostor', colors: ['#123456'] }],
      BUILTIN_PALETTES,
    );
    const keys = secs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps keys unique when a shader palette adopts a LIVE built-in id', () => {
    // The fixture above names a palette that no longer ships, so on its own it
    // has quietly stopped colliding with anything. Deriving the impostor ids
    // from the live list keeps the collision real however the shipped palettes
    // are renamed or replaced.
    const impostors = BUILTIN_PALETTES.map((p) => ({ ...p, name: `Impostor ${p.id}` }));
    const secs = buildPickerSections(impostors, BUILTIN_PALETTES);
    const keys = secs.map((s) => s.key);
    expect(keys).toHaveLength(BUILTIN_PALETTES.length * 2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps keys unique when one batch repeats an id', () => {
    const secs = buildPickerSections(
      [
        { id: 'dupe', name: 'A', colors: ['#000000'] },
        { id: 'dupe', name: 'B', colors: ['#ffffff'] },
      ],
      [],
    );
    expect(new Set(secs.map((s) => s.key)).size).toBe(2);
  });

  it('drops colourless palettes instead of drawing an empty row', () => {
    const secs = buildPickerSections([{ id: 'e', name: 'Empty', colors: [] }], []);
    expect(secs).toEqual([]);
  });

  it('re-whitelists colours — every swatch goes into style.background', () => {
    const secs = buildPickerSections(
      [
        {
          id: 'x',
          name: 'Mixed',
          colors: ['#FF0000', 'red', '#f00', '#ff0000aa', '#00ff00;background:url(//evil)', '#00ff00'],
        },
      ],
      [],
    );
    expect(secs[0].colors).toEqual(['#ff0000', '#00ff00']);
  });

  it('drops a palette whose colours are all junk', () => {
    expect(buildPickerSections([{ id: 'x', name: 'Junk', colors: ['red', 'blue'] }], [])).toEqual([]);
  });

  it('re-caps an over-long colour list', () => {
    const many = Array.from({ length: MAX_COLORS_PER_PALETTE + 20 }, () => '#abcdef');
    const secs = buildPickerSections([{ id: 'x', name: 'Long', colors: many }], []);
    expect(secs[0].colors).toHaveLength(MAX_COLORS_PER_PALETTE);
  });

  it('tolerates missing lists (a shader with no palettes of its own)', () => {
    expect(buildPickerSections(undefined, BUILTIN_PALETTES)).toHaveLength(BUILTIN_PALETTES.length);
    expect(buildPickerSections(null, null)).toEqual([]);
  });
});

/* ============================================================
 * Per-colour names — the alignment `names[i]` labels `colors[i]`
 * ============================================================ */

describe('buildPickerSections names', () => {
  it('carries the labels through, aligned with their colours', () => {
    const secs = buildPickerSections(
      [{ id: 'p', name: 'Metals', colors: ['#ffe39d', '#fcfaf5'], names: ['Gold', 'Silver'] }],
      [],
    );
    expect(secs[0].colors).toEqual(['#ffe39d', '#fcfaf5']);
    expect(secs[0].names).toEqual(['Gold', 'Silver']);
  });

  it('materializes an all-empty array for an unlabelled palette', () => {
    // The renderer indexes `sec.names[i]` with no guard, so "absent" has to
    // arrive as '' at the right length rather than as undefined.
    const secs = buildPickerSections(
      [{ id: 'p', name: 'Bare', colors: ['#ff0000', '#00ff00', '#0000ff'] }],
      [],
    );
    expect(secs[0].names).toEqual(['', '', '']);
  });

  it('every section has exactly as many names as colours', () => {
    const secs = buildPickerSections(
      [
        { id: 'p1', name: 'Mine', colors: ['#ff0000', '#00ff00'] },
        { id: 'p2', name: 'Named', colors: ['#111111'], names: ['Ink'] },
      ],
      BUILTIN_PALETTES,
    );
    expect(secs).toHaveLength(BUILTIN_PALETTES.length + 2);
    for (const s of secs) expect(s.names, s.name).toHaveLength(s.colors.length);
  });

  it('keeps the labels aligned when colours are DROPPED', () => {
    // THE regression this pair exists to prevent: reading names in a second
    // pass over the source array would keep '#ff0000' and label it "Sky" —
    // wrong, and indistinguishable from working software on screen.
    const secs = buildPickerSections(
      [
        {
          id: 'x',
          name: 'Mixed',
          colors: ['not-a-hex', '#ff0000', '#f00', '#00ff00'],
          names: ['Sky', 'Gold', 'Shorthand', 'Leaf'],
        },
      ],
      [],
    );
    expect(secs[0].colors).toEqual(['#ff0000', '#00ff00']);
    expect(secs[0].names).toEqual(['Gold', 'Leaf']);
  });

  it('keeps the labels aligned when the list is TRUNCATED at the cap', () => {
    const colors = Array.from({ length: MAX_COLORS_PER_PALETTE + 20 }, (_, i) =>
      `#${i.toString(16).padStart(6, '0')}`);
    const names = colors.map((_, i) => `c${i}`);
    const secs = buildPickerSections([{ id: 'x', name: 'Long', colors, names }], []);
    expect(secs[0].names).toHaveLength(MAX_COLORS_PER_PALETTE);
    expect(secs[0].names[0]).toBe('c0');
    expect(secs[0].names[MAX_COLORS_PER_PALETTE - 1]).toBe(`c${MAX_COLORS_PER_PALETTE - 1}`);
  });

  it('keeps the labels aligned when colours are dropped AND the cap is hit', () => {
    // Both filters at once, so every surviving colour sits at a DIFFERENT index
    // than it did in the source — a second pass over `names` cannot fake this.
    const colors: string[] = [];
    const names: string[] = [];
    for (let i = 0; i < MAX_COLORS_PER_PALETTE + 10; i += 1) {
      colors.push('rgb(1,2,3)', `#${i.toString(16).padStart(6, '0')}`);
      names.push('DROPPED', `c${i}`);
    }
    const secs = buildPickerSections([{ id: 'x', name: 'Hostile', colors, names }], []);
    expect(secs[0].colors).toHaveLength(MAX_COLORS_PER_PALETTE);
    expect(secs[0].names).toHaveLength(MAX_COLORS_PER_PALETTE);
    expect(secs[0].names).not.toContain('DROPPED');
    // Each label is checked against the colour it ended up on, not against a
    // position — the hex encodes its own source index.
    secs[0].colors.forEach((hex, i) => {
      expect(secs[0].names[i]).toBe(`c${parseInt(hex.slice(1), 16)}`);
    });
  });

  it('a ragged or mistyped names array degrades to an empty label, never undefined', () => {
    const secs = buildPickerSections(
      [
        {
          id: 'x',
          name: 'Ragged',
          colors: ['#ff0000', '#00ff00', '#0000ff'],
          names: ['Red', 7, null] as unknown as string[],
        },
        { id: 'y', name: 'Short', colors: ['#ff0000', '#00ff00'], names: ['Red'] },
        {
          id: 'z',
          name: 'NotAnArray',
          colors: ['#ff0000'],
          names: 'Gold' as unknown as string[],
        },
      ],
      [],
    );
    expect(secs[0].names).toEqual(['Red', '', '']);
    expect(secs[1].names).toEqual(['Red', '']);
    expect(secs[2].names).toEqual(['']);
  });

  it('drops names that outrun their colours', () => {
    const secs = buildPickerSections(
      [{ id: 'x', name: 'Over', colors: ['#ff0000'], names: ['Red', 'Green', 'Blue'] }],
      [],
    );
    expect(secs[0].names).toEqual(['Red']);
  });

  it('every shipped colour carries a label', () => {
    // A built-in that gained a colour without a name would show a bare hex
    // tooltip beside eleven named ones — the whole reason these palettes exist
    // is that `#ffe39d` means nothing and "Gold" means everything.
    for (const s of buildPickerSections(null, BUILTIN_PALETTES)) {
      expect(s.names, s.name).not.toContain('');
    }
  });
});

/* ============================================================
 * Swatch tooltips
 * ============================================================ */

/** The separator `swatchTitle` uses. Written as an escape so the character is
 *  unambiguous here — an en dash or a hyphen would look identical in review. */
const EM_DASH = '\u2014';

describe('swatchTitle', () => {
  it('reads "Name <em dash> #hex" when the colour is labelled', () => {
    expect(swatchTitle('#ffe39d', 'Gold')).toBe(`Gold ${EM_DASH} #ffe39d`);
  });

  it('keeps the hex even when a name is present', () => {
    // The name is what makes a swatch meaningful, but the hex is what gets
    // copied out — dropping it would make the labelled palettes strictly less
    // useful than the unlabelled ones they replaced.
    expect(swatchTitle('#ffe39d', 'Gold')).toContain('#ffe39d');
  });

  it('separates with an EM DASH, so a hyphen INSIDE a name stays readable', () => {
    // The shipped labels really do contain hyphens ("Skin I - Porcelain"), so a
    // hyphen separator would read as part of the name.
    const title = swatchTitle('#f3d9c6', 'Skin I - Porcelain');
    expect(title).toBe(`Skin I - Porcelain ${EM_DASH} #f3d9c6`);
    expect(title.split(EM_DASH)).toHaveLength(2);
  });

  it('falls back to the bare hex when there is no usable name', () => {
    expect(swatchTitle('#ff0000')).toBe('#ff0000');
    expect(swatchTitle('#ff0000', '')).toBe('#ff0000');
    // Whitespace-only is the shape a rename-to-nothing leaves behind, and a
    // title of "  <em dash> #ff0000" would read as a broken label.
    expect(swatchTitle('#ff0000', '   ')).toBe('#ff0000');
    expect(swatchTitle('#ff0000', '\t \n')).toBe('#ff0000');
  });

  it('falls back to the bare hex when the name is not a string at all', () => {
    // buildPickerSections coerces, but PalettesModal passes `p.names?.[i]`
    // straight off a palette — one helper covers both call sites, so the type
    // check has to live in the helper.
    const bad = [null, undefined, 0, 1, NaN, {}, []] as unknown as string[];
    for (const n of bad) expect(swatchTitle('#123456', n)).toBe('#123456');
  });

  it('trims the label rather than padding the separator', () => {
    expect(swatchTitle('#123456', '  Gold  ')).toBe(`Gold ${EM_DASH} #123456`);
  });

  it('titles a shipped swatch from the section the picker actually renders', () => {
    const [first] = buildPickerSections(null, BUILTIN_PALETTES);
    expect(swatchTitle(first.colors[0], first.names[0])).toBe(
      `${first.names[0]} ${EM_DASH} ${first.colors[0]}`,
    );
  });
});

/* ============================================================
 * Placement (B9 — measured, not hardcoded)
 * ============================================================ */

describe('placePopover', () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = (top: number) => ({ left: 100, top, bottom: top + 12 });

  it('sits below the anchor when there is room', () => {
    const { left, top } = placePopover(anchor(100), { width: 146, height: 300 }, viewport);
    expect(left).toBe(100);
    expect(top).toBe(112 + POPOVER_GAP);
  });

  it('flips above when the bottom would clip', () => {
    const size = { width: 146, height: 300 };
    const { top } = placePopover(anchor(700), size, viewport);
    expect(top).toBe(700 - POPOVER_GAP - 300);
  });

  it('a taller popover flips at a height the old 130/134 literals would not have', () => {
    // The retired code asked "below + 130 > innerHeight" — a 300px popover 500px
    // down passes that test and then hangs 100px off the bottom edge.
    const size = { width: 146, height: 300 };
    const { top } = placePopover(anchor(500), size, viewport);
    expect(top + size.height).toBeLessThanOrEqual(viewport.height - POPOVER_MARGIN);
  });

  it('clamps into the viewport when neither side fits', () => {
    const size = { width: 146, height: 790 };
    const { top } = placePopover(anchor(400), size, viewport);
    expect(top).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    expect(top + size.height).toBeLessThanOrEqual(viewport.height - POPOVER_MARGIN);
  });

  it('pins to the top margin when the popover is taller than the viewport', () => {
    const { top } = placePopover(anchor(400), { width: 146, height: 2000 }, viewport);
    expect(top).toBe(POPOVER_MARGIN);
  });

  it('clamps horizontally at the right edge and never goes negative', () => {
    const near = { left: 990, top: 10, bottom: 22 };
    expect(placePopover(near, { width: 146, height: 100 }, viewport).left).toBe(
      1000 - 146 - POPOVER_MARGIN,
    );
    const off = { left: -50, top: 10, bottom: 22 };
    expect(placePopover(off, { width: 146, height: 100 }, viewport).left).toBe(POPOVER_MARGIN);
    expect(
      placePopover(near, { width: 2000, height: 100 }, viewport).left,
    ).toBe(POPOVER_MARGIN);
  });
});

/* ============================================================
 * Portal host (B6)
 * ============================================================ */

describe('pickPortalHost', () => {
  const body = { contains: () => true } as const;
  const anchor = {} as unknown as Node;

  it('uses the body when nothing is fullscreen', () => {
    expect(pickPortalHost(null, anchor, body)).toBe(body);
    expect(pickPortalHost(undefined, anchor, body)).toBe(body);
  });

  it('uses the fullscreen element when it contains the anchor', () => {
    const fs = { contains: (n: Node | null) => n === anchor };
    expect(pickPortalHost(fs, anchor, body as unknown as typeof fs)).toBe(fs);
  });

  it('stays on the body when the fullscreen element does NOT contain the anchor', () => {
    const fs = { contains: () => false };
    expect(pickPortalHost(fs, anchor, body as unknown as typeof fs)).toBe(body);
  });

  it('stays on the body with no anchor to test', () => {
    const fs = { contains: () => true };
    expect(pickPortalHost(fs, null, body as unknown as typeof fs)).toBe(body);
  });

  it('never returns the body twice over (fullscreen === body)', () => {
    expect(pickPortalHost(body, anchor, body)).toBe(body);
  });
});

/* ============================================================
 * Live-apply vs commit (B2)
 * ============================================================ */

describe('createColorCommitStager', () => {
  it('records NOTHING while values are staged', () => {
    const seen: string[] = [];
    const s = createColorCommitStager((h) => seen.push(h));
    s.stage('#ff0000');
    s.stage('#fe0000');
    s.stage('#fd0000');
    expect(seen).toEqual([]);
    expect(s.peek()).toBe('#fd0000');
  });

  it('a 2-second wheel drag records exactly ONE recent colour', () => {
    // 60 events/second for two seconds: the exact stream that would otherwise
    // push 120 shades through a 10-slot MRU and evict everything in it.
    const seen: string[] = [];
    const s = createColorCommitStager((h) => seen.push(h));
    for (let i = 0; i < 120; i++) s.stage(`#${i.toString(16).padStart(6, '0')}`);
    s.flush(); // the idle / blur / close flush
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('#000077');
    expect(120).toBeGreaterThan(MAX_RECENT_COLORS); // the flood this prevents
  });

  it('a second flush with nothing staged records nothing', () => {
    const seen: string[] = [];
    const s = createColorCommitStager((h) => seen.push(h));
    s.stage('#123456');
    s.flush();
    s.flush();
    s.flush();
    expect(seen).toEqual(['#123456']);
  });

  it('discard drops the staged value so a later flush cannot resurrect it', () => {
    // "Clear recent colours" while a value is staged: without discard, closing
    // the popover would immediately re-add the colour just forgotten.
    const seen: string[] = [];
    const s = createColorCommitStager((h) => seen.push(h));
    s.stage('#abcdef');
    s.discard();
    s.flush();
    expect(seen).toEqual([]);
    expect(s.peek()).toBeNull();
  });

  it('two separate gestures record two colours', () => {
    const seen: string[] = [];
    const s = createColorCommitStager((h) => seen.push(h));
    s.stage('#111111');
    s.flush();
    s.stage('#222222');
    s.flush();
    expect(seen).toEqual(['#111111', '#222222']);
  });
});

/* ============================================================
 * Source guards — what the node env cannot render
 * ============================================================ */

describe('PaletteColorPicker source guards', () => {
  const src = readFileSync(COMPONENT, 'utf8');

  it('B1: `history` is required, with no default value', () => {
    expect(src).toMatch(/history: ColorPickHistory;/);
    // A default would silently re-arm the trap for every future call site.
    expect(src).not.toMatch(/history\s*=\s*['"]/);
    expect(src).toMatch(/const brackets = history === 'bracket';/);
  });

  it('B1/B4: every bracket() call is gated on that prop', () => {
    // Comments talk ABOUT bracket(); only real calls count.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const calls = code.match(/(?<![A-Za-z])bracket\(\);/g) ?? [];
    const gated = code.match(/if \(brackets\) bracket\(\);/g) ?? [];
    expect(calls.length).toBe(gated.length);
    // applyLive (every live value), pickSwatch (a palette / recent click) and
    // the onClear path, which used to call bracket() directly and unguarded —
    // the one bracketing path a `history` prop applied to the picks alone would
    // have missed.
    expect(gated.length).toBe(3);
  });

  it('B2: the live path never records, and the commit path is the flush', () => {
    expect(src, 'onChange must go through applyLive, never a commit').toMatch(
      /onChange=\{\(e\) => applyLive\(e\.target\.value\)\}/,
    );
    expect(src, 'blur is a flush point').toMatch(/onBlur=\{flushCommit\}/);
    expect(src, 'noteColorUsed may only be reached from the stager commit').toMatch(
      /createColorCommitStager\(\(hex\) => \{\s*const next = noteColorUsed\(hex\);/,
    );
    expect((src.match(/noteColorUsed\(/g) ?? []).length).toBe(1);
    expect(src, 'the idle timer is armed by the live path').toContain('COMMIT_IDLE_MS');
  });

  it('B3: every effect that touches the popover is keyed on `open`', () => {
    // The popover (and its custom input) only exists while open, so an effect
    // without `open` in its deps would attach to nothing, forever.
    const effects = src.match(/use(Layout)?Effect\(([\s\S]*?)\n  \}, \[[^\]]*\]\);/g) ?? [];
    expect(effects.length).toBeGreaterThanOrEqual(6);
    const popoverEffects = effects.filter((e) => /popRef|addEventListener|setHost/.test(e));
    expect(popoverEffects.length).toBeGreaterThanOrEqual(4);
    for (const e of popoverEffects) {
      const deps = /\n  \}, \[([^\]]*)\]\);$/.exec(e)?.[1] ?? '';
      expect(deps.split(',').map((d) => d.trim())).toContain('open');
    }
  });

  it('B5: the Escape handler stops propagation before closing', () => {
    // ContextMenu.tsx closes the WHOLE settings menu on a bubbled Escape and
    // skips only INPUT/TEXTAREA/SELECT/contentEditable — the swatches are
    // <button>, so a leaked Escape would take the menu with the popover.
    expect(src).toMatch(/if \(e\.key !== 'Escape'\) return;[\s\S]{0,900}?e\.stopPropagation\(\);\s*closeSelf\(\);/);
  });

  it('B6: the portal host is resolved, and fullscreen changes close the popover', () => {
    expect(src).toMatch(/setHost\(pickPortalHost\(fsEl, anchor, document\.body\)\)/);
    expect(src).toMatch(/webkitFullscreenElement/);
    expect(src).toContain("document.addEventListener('fullscreenchange', onFsChange)");
    expect(src).toContain("document.addEventListener('webkitfullscreenchange', onFsChange)");
    expect(src, 'the portal must mount into the resolved host, not document.body').toMatch(
      /\n {4}host,\n {2}\);/,
    );
  });

  it('B7: a trigger-less popover is exported alongside the trigger form', () => {
    expect(src).toMatch(/export function ColorPickerPopover\(/);
    expect(src).toMatch(/export function PaletteColorPicker\(/);
    // The trigger form is the popover plus a button — not a second copy of it.
    expect((src.match(/createPortal\(/g) ?? []).length).toBe(1);
    expect(src).toMatch(/<ColorPickerPopover/);
  });

  it('every swatch tooltip goes through swatchTitle at the ALIGNED index', () => {
    // The component indexes `sec.names[i]` with no `?.` and no fallback, which
    // is safe ONLY because buildPickerSections materializes names to the
    // colours' length. Reading the label from anywhere else (the raw palette,
    // say) would reintroduce the misalignment that pairing them prevents.
    expect(src).toMatch(/title=\{swatchTitle\(hex, sec\.names\[i\]\)\}/);
    expect((src.match(/swatchTitle\(/g) ?? []).length).toBe(1);
  });

  it('B9: no hardcoded popover height survives', () => {
    expect(src).not.toMatch(/\b13[04]\b/);
    expect(src).not.toMatch(/POPOVER_W/);
    expect(src, 'placement comes from the measured rect').toMatch(
      /const r = el\.getBoundingClientRect\(\);\s*const next = placePopover\(/,
    );
    expect(src).toMatch(/width: r\.width, height: r\.height/);
  });

  it('a swatch click records NO recent — only a MIXED colour does', () => {
    // "Recent" is for colours the user mixed. A palette colour is permanently
    // one click away in the rows above, so recording it spends an MRU slot to
    // duplicate something already on screen and evicts a mixed colour that
    // exists nowhere else; re-recording a RECENT reorders the row under the
    // pointer mid-click. So both swatch rows go through pickSwatch, which
    // applies without staging — staging is what the flush later records.
    expect((src.match(/onClick=\{\(\) => pickSwatch\(hex\)\}/g) ?? []).length).toBe(2);
    const body = /const pickSwatch = useCallback\(([\s\S]*?)\n  \);/.exec(src)?.[1] ?? '';
    expect(body, 'pickSwatch must exist').toBeTruthy();
    expect(body, 'staging here is exactly what would record it').not.toMatch(/\.stage\(/);
    // It still FLUSHES first, or a custom colour the user had just dragged to
    // would be dropped by the swatch click that follows it.
    expect(body).toMatch(/flushCommit\(\)/);
    // …and nothing else may stage: only the live (custom-input) path does.
    expect((src.match(/\.stage\(/g) ?? []).length).toBe(1);
  });

  it('a click inside an IFRAME closes the popover', () => {
    // The 3D preview is an iframe filling most of the right column, and a
    // pointerdown inside it never reaches this document — so the outside-click
    // listener could not see it and the popover stayed open over the viewport.
    // Focus is the only signal that crosses: the browser focuses the <iframe>
    // and blurs this window.
    expect(src).toContain("window.addEventListener('blur', onWinBlur)");
    expect(src).toContain("window.removeEventListener('blur', onWinBlur)");
    // Gated on an IFRAME really taking focus. A bare close-on-blur would also
    // fire when the OS colour dialog opens from the "Custom" row (macOS), which
    // would tear the picker down mid-pick.
    expect(src).toMatch(
      /document\.activeElement instanceof HTMLIFrameElement\) closeSelf\(\);/,
    );
  });

  it('the shader palettes are read through a reference-stable selector', () => {
    expect(src).toMatch(/useAppStore\(\(s\) => s\.shaderPalettes\)/);
    // A merged/derived array in the selector would allocate per notify per
    // mounted picker and defeat Object.is.
    expect(src).not.toMatch(/useAppStore\(\(s\) => \[/);
  });
});

describe('PaletteColorPicker style guards', () => {
  const css = readFileSync(STYLES, 'utf8');

  it('B8: swatch rows wrap at a fixed column count', () => {
    const row = /\.palette-pop__row \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    expect(row).toMatch(/display: grid;/);
    expect(row).toMatch(new RegExp(`repeat\\(${SWATCHES_PER_ROW}, 20px\\)`));
    expect(row, 'a bare flex row is what let a 6-colour palette spill out').not.toMatch(
      /display: flex;/,
    );
  });

  it('B8: the reserved width really fits a full row of swatches plus a scrollbar', () => {
    const pop = /\.palette-pop \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const rowCss = /\.palette-pop__row \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    // Every term is READ from the CSS rather than remembered. This assertion
    // used to carry `expect(row).toBe(116)` — the width of a five-swatch row —
    // and that literal stayed put while the row grew to six, which is the exact
    // failure mode the B9 placement test exists to prevent one floor up.
    const cols = /repeat\((\d+), (\d+)px\)/.exec(rowCss);
    const swatch = Number(cols?.[2]);
    const gap = Number(/gap: (\d+)px;/.exec(rowCss)?.[1]);
    expect(Number(cols?.[1]), 'the grid must draw the row the model counts').toBe(SWATCHES_PER_ROW);
    expect(swatch).toBeGreaterThan(0);
    expect(gap).toBeGreaterThanOrEqual(0);
    const row = SWATCHES_PER_ROW * swatch + (SWATCHES_PER_ROW - 1) * gap;
    const width = Number(/width: (\d+)px;/.exec(pop)?.[1]);
    const padding = Number(/padding: (\d+)px;/.exec(pop)?.[1]);
    const content = width - 2 * padding - 2; // minus the 1px border per side
    expect(content - row).toBeGreaterThanOrEqual(15); // classic scrollbar gutter
    expect(pop).toMatch(/overflow-y: auto;/);
    expect(pop, 'an unbounded popover cannot be scrolled back into view').toMatch(/max-height:/);
  });

  it('two rows of recents need no extra width', () => {
    expect(RECENT_COLOR_ROWS * SWATCHES_PER_ROW).toBe(MAX_RECENT_COLORS);
  });
});

describe('model constants', () => {
  it('the commit idle window matches the history bracket idle window', () => {
    const hook = readFileSync(
      path.join(__dirname, '..', '..', 'hooks', 'useHistoryBracket.ts'),
      'utf8',
    );
    expect(Number(/const IDLE_MS = (\d+);/.exec(hook)?.[1])).toBe(COMMIT_IDLE_MS);
  });
});
