import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * The app-wide colour picker's `history` prop, pinned per call site.
 *
 * `PaletteColorPicker` / `ColorPickerPopover` take `history: 'bracket' | 'none'`
 * as a REQUIRED prop with no default, so TypeScript already catches a site that
 * forgets it. What the compiler cannot catch is the WRONG value, and getting it
 * wrong is a real defect rather than a style nit:
 *
 *   `bracket()` opens `beginInteraction`, which snapshots the whole graph AND
 *   sets `future: []`. On a site whose value is NOT graph state — the canvas
 *   background, the draw ink, the cost-gradient poles, the preview background,
 *   a live uniform, a note's colour — that pushes an undo entry restoring
 *   nothing and WIPES THE USER'S REDO STACK on every single colour pick.
 *
 * The vitest env is `node` with no jsdom, so no picker can be rendered. This
 * suite pins the SOURCE instead (the historyBracketing / designerEntry /
 * vendorSync pattern): the table below is the reviewed answer for every site,
 * with the writer that justifies it, and any new or edited call site has to
 * come back through here.
 */

const SRC = __dirname;

/**
 * Per file: the `history` value every picker in it must carry, and WHY — i.e.
 * the writer the pick reaches and whether that writer pushes history.
 *
 * A file appears once because no file today mixes the two kinds. If one ever
 * needs to, split the assertion rather than loosening it.
 */
const SITES: { file: string; history: 'bracket' | 'none'; count: number; why: string }[] = [
  {
    file: 'components/NodeEditor/nodes/OutputNode.tsx',
    history: 'bracket',
    count: 1,
    why: 'stored channel colour -> setChannelValue -> updateNodeData (pushHistory); it emits color(0x…)',
  },
  {
    file: 'components/NodeEditor/nodes/SdfOutputNode.tsx',
    history: 'bracket',
    count: 1,
    why: 'the SDF Output colour swatch is a stored channel value that emits color(0x…) — graph content, undoable',
  },
  {
    file: 'components/NodeEditor/nodes/ColorNode.tsx',
    history: 'bracket',
    count: 1,
    why: 'values.hex -> updateNodeData (pushHistory)',
  },
  {
    file: 'components/NodeEditor/nodes/ShaderNode.tsx',
    history: 'bracket',
    count: 1,
    why: 'stripes/dataviz lowColor/highColor -> handleChange -> updateNodeData (pushHistory)',
  },
  {
    file: 'components/NodeEditor/menus/GroupSettingsMenu.tsx',
    history: 'bracket',
    count: 1,
    why: 'group frame colour -> updateGroupData (pushHistory)',
  },
  {
    file: 'components/NodeEditor/menus/NodeSettingsMenu.tsx',
    history: 'bracket',
    count: 1,
    why: 'hex defaultValues row -> handleValueChange -> updateNodeData (pushHistory)',
  },
  {
    file: 'components/NodeEditor/menus/NoteSettingsMenu.tsx',
    history: 'none',
    count: 2,
    why: 'updateNoteData is DELIBERATELY history-free (inline typing would flood the 50-entry buffer)',
  },
  {
    file: 'components/NodeEditor/nodes/NodeVisual.tsx',
    history: 'none',
    count: 1,
    why: "the static replica's only interactive consumer is the Node Designer, whose onValueChange writes its own session-only preview model",
  },
  {
    file: 'components/NodeEditor/NodeEditor.tsx',
    history: 'none',
    count: 1,
    why: 'canvas background -> setNodeEditorBgColor: localStorage + set(), no pushHistory',
  },
  {
    file: 'components/NodeEditor/DrawToolbar.tsx',
    history: 'none',
    count: 1,
    why: 'ink colour -> setDrawColor: localStorage + set(), no pushHistory (strokes ride history; the pen colour does not)',
  },
  {
    file: 'components/Layout/CostBar.tsx',
    history: 'none',
    count: 2,
    why: 'cost gradient poles -> setCostColorLow/High: localStorage + set(), no pushHistory',
  },
  {
    file: 'components/Preview/ShaderPreview.tsx',
    history: 'none',
    count: 2,
    why: 'preview bg is usePersistedState; the uniform row posts fs:uniform and persists by name ("Set as default" is the separate write-back)',
  },
];

/** The picker's own module — it forwards `history` as a variable, by design. */
const PICKER_MODULE = 'components/inputs/PaletteColorPicker.tsx';

/** Every `.tsx` / `.ts` under src/, so a NEW call site cannot hide from the table. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path.relative(SRC, full));
    }
  }
  return out;
}

/** The attribute blocks of every `<PaletteColorPicker` / `<ColorPickerPopover`
 *  element in `src`, each sliced from its opening tag to its self-closing `/>`.
 *  Both components are always written self-closing (they take no children). */
function pickerElements(src: string): string[] {
  const out: string[] = [];
  const re = /<(?:PaletteColorPicker|ColorPickerPopover)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf('/>', m.index);
    expect(end, 'picker element must be self-closing').toBeGreaterThan(-1);
    out.push(src.slice(m.index, end));
  }
  return out;
}

const ALL = sourceFiles(SRC);

describe('the colour picker declares the right history kind at every call site', () => {
  for (const site of SITES) {
    it(`${site.file} -> history="${site.history}" (${site.why})`, () => {
      const src = readFileSync(path.join(SRC, site.file), 'utf8');
      const els = pickerElements(src);
      expect(els.length, `${site.file}: expected ${site.count} picker(s)`).toBe(site.count);
      for (const el of els) {
        expect(el, `${site.file}: ${site.why}`).toContain(`history="${site.history}"`);
      }
    });
  }

  it('every picker in src/ is covered by the table above', () => {
    const listed = new Set(SITES.map((s) => s.file));
    const missing: string[] = [];
    for (const f of ALL) {
      if (f === PICKER_MODULE || listed.has(f)) continue;
      if (pickerElements(readFileSync(path.join(SRC, f), 'utf8')).length > 0) missing.push(f);
    }
    expect(
      missing,
      'a new colour-picker call site must declare its history kind in SITES — see the header',
    ).toEqual([]);
  });

  it('a listed site that lost its picker fails instead of silently passing', () => {
    // Guards the table itself: `count` is asserted exactly, so a deleted picker
    // shows up as a count mismatch above rather than as a vacuously-true loop.
    for (const site of SITES) expect(site.count).toBeGreaterThan(0);
  });
});

describe('native colour inputs have been retired from the app', () => {
  /**
   * `<input type="color">` survives in exactly two places, both deliberate:
   *
   *   · PaletteColorPicker itself — the popover's "Custom" escape hatch, the
   *     one control that can reach a colour no palette contains.
   *   · PalettesModal — the palette EDITOR. It authors the very swatches the
   *     picker offers, so opening the picker there would be circular, and its
   *     rows run a bespoke draft-then-commit-on-blur model built around the
   *     native input's blur.
   */
  const ALLOWED = new Set([PICKER_MODULE, 'components/Modals/PalettesModal.tsx']);

  /** RENDERED ones only. `<input` before the attribute keeps prose out (several
   *  modules explain the native input's per-frame event stream in a comment),
   *  and `[^>]*` cannot run past the element because JSX has no `>` until the
   *  tag closes. */
  const RENDERED = /<input[^>]*type="color"/;

  it('no other component renders one', () => {
    const offenders = ALL.filter(
      (f) => f.endsWith('.tsx') && !ALLOWED.has(f) && RENDERED.test(readFileSync(path.join(SRC, f), 'utf8')),
    );
    expect(offenders, 'use PaletteColorPicker / ColorPickerPopover instead').toEqual([]);
  });

  it('the two allowed files really do still contain one (the guard is not vacuous)', () => {
    for (const f of ALLOWED) {
      expect(RENDERED.test(readFileSync(path.join(SRC, f), 'utf8')), `${f}`).toBe(true);
    }
  });
});
