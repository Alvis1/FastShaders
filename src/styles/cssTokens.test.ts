import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `var(--x)` a stylesheet reads must resolve to something.
 *
 * This exists because of a failure mode CSS makes silent and severe: a `var()`
 * naming an undeclared property is "invalid at computed-value time", which
 * throws away the WHOLE declaration rather than just that value. Deleting one
 * token in tokens.css therefore does not produce a slightly-wrong colour
 * somewhere — it deletes a property from whatever rules still referenced it.
 *
 * MEASURED, mid-restyle: `--node-selection-width` was retired from tokens.css
 * while ColorNode.css still read it inside its selected-state `box-shadow`.
 * The result was a selected Color node with NO shadow at all — the declaration
 * was dropped entirely, taking the drop shadow that shared it. Typecheck,
 * build and all 152 test files stayed green.
 *
 * The check is deliberately whole-repo and not scoped to tokens: a property may
 * legitimately be published by a component (ShaderNode publishes
 * `--node-text-scale`, NodeEditor publishes `--node-cost-text`, SplitPane
 * publishes `--fs-grip-offset`), so "declared ANYWHERE we can see" — in a
 * stylesheet, in an inline style, or as a documented fallback — is the honest
 * bar. What it catches is the reference that resolves NOWHERE.
 */

const SRC = join(__dirname, '..');

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (entry.endsWith('.css')) out.push(p);
  }
  return out;
}

/** Strip comments so a token named only in prose does not count as declared. */
const decomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('CSS custom properties', () => {
  const files = cssFiles(SRC);

  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every var() reference resolves to a declared property or has a fallback', () => {
    const declared = new Set<string>();
    const referenced: Array<{ name: string; file: string }> = [];

    // Properties declared in CSS.
    for (const f of files) {
      const css = decomment(readFileSync(f, 'utf8'));
      for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
      // `var(--x)` with no fallback. A `var(--x, something)` is safe by
      // construction — that is what the fallback is for — so only the bare
      // single-argument form has to resolve.
      for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        referenced.push({ name: m[1], file: f.slice(SRC.length + 1) });
      }
    }

    // Properties published imperatively from TS/TSX (inline styles, setProperty).
    const tsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) tsFiles.push(p);
      }
    };
    walk(SRC);
    // Properties published from TS/TSX. Only the three forms that WRITE a
    // property count — `setProperty('--x', …)`, an inline-style object key
    // (`'--x': value`), and a named constant (`= '--x'`, which is then passed
    // to setProperty). A bare literal anywhere else is usually a READ, e.g.
    // ShaderNode's `var(${selected ? '--shadow-node-selected' : …})`; counting
    // those as declarations is what makes this check vacuous, since every
    // dangling reference would then declare itself.
    const families: string[] = [];
    for (const f of tsFiles) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) declared.add(m[1]);
      for (const m of src.matchAll(/=\s*['"`](--[\w-]+)['"`]/g)) declared.add(m[1]);
      // Computed FAMILIES — `--cat-${category}` in colorUtils publishes one per
      // entry of CAT_HEX, so no literal `--cat-output` exists anywhere to grep.
      // The prefix is what is knowable statically, so it licenses the family.
      for (const m of src.matchAll(/`(--[\w-]*-)\$\{/g)) families.push(m[1]);
    }

    const dangling = referenced.filter(
      (r) => !declared.has(r.name) && !families.some((p) => r.name.startsWith(p)),
    );
    expect(
      dangling.map((d) => `${d.file}: var(${d.name})`),
      'var() references naming a property nothing declares — CSS drops the ENTIRE declaration, not just the value',
    ).toEqual([]);
  });
});

/**
 * The elevation RAMP is a set of inequalities, not a list of numbers — and
 * every one of them is invisible to a typecheck, a build and every other test
 * in the suite. What they encode: a hard offset with no blur is the only thing
 * saying how high a surface floats, so the ordering IS the design. Break it and
 * nothing errors; the app just stops reading as layered.
 *
 * The specific defect these were written after: canvas chrome sat BELOW the
 * graph it floats over — the settings menus matched a selected node exactly
 * (both 8px), and the cost pill, NEW and the canvas bar were shallower than it
 * (2–4px), so a selected node appeared to hover above the app's own controls.
 */
describe('shadow elevation ramp', () => {
  const tokens = decomment(readFileSync(join(SRC, 'styles/tokens.css'), 'utf8'));

  /** Offset (px) of a hard shadow token, read from the LIGHT (`:root`) block. */
  const offsetOf = (name: string): number => {
    const m = new RegExp(`${name}:\\s*(-?\\d+)px\\s+(-?\\d+)px\\s+0`).exec(tokens);
    if (!m) throw new Error(`${name} is not declared as a hard "Npx Npx 0" shadow`);
    expect(m[1], `${name} must be square — the light source is fixed top-left`).toBe(m[2]);
    return Number(m[1]);
  };

  it('keeps the chrome ramp strictly ordered: chip < card < popover', () => {
    const sm = offsetOf('--shadow-sm'), md = offsetOf('--shadow-md'), lg = offsetOf('--shadow-lg');
    expect([sm, md, lg]).toEqual([...[sm, md, lg]].sort((a, b) => a - b));
    expect(new Set([sm, md, lg]).size, 'two layers at the same offset are one layer').toBe(3);
  });

  it('gives canvas chrome its own depth, distinct from every chrome layer', () => {
    // --shadow-float is deliberately NOT a member of the sm/md/lg ramp — it
    // describes a different region (over the graph, not over ordinary content)
    // and is authored by eye. What must hold is that it is its own value:
    // collapsing it onto one of the others is how the canvas chrome silently
    // rejoins the layer it was split out of.
    const float = offsetOf('--shadow-float');
    for (const other of ['--shadow-sm', '--shadow-md', '--shadow-lg']) {
      expect(float, `--shadow-float must not collapse onto ${other}`).not.toBe(offsetOf(other));
    }
  });

  it('floats canvas chrome above a node AT REST', () => {
    // The comparison that matters on screen: every node except the one or two
    // selected ones is resting, so this is what the chrome is read against.
    //
    // Deliberately NOT asserted against --shadow-node-selected. The first cut
    // of --shadow-float was 12px precisely to clear it, and that read as too
    // heavy; at the authored 6px a SELECTED node casts a longer shadow than the
    // panel over it. That inversion is a known, accepted trade (see the token's
    // note) — pinning it either way would freeze a judgement call that belongs
    // to whoever is looking at the screen.
    expect(offsetOf('--shadow-float')).toBeGreaterThan(offsetOf('--shadow-node'));
  });

  it('keeps a node RESTING below every chrome layer, and selection above most', () => {
    expect(offsetOf('--shadow-node')).toBeLessThan(offsetOf('--shadow-md'));
    expect(offsetOf('--shadow-node-selected')).toBeGreaterThan(offsetOf('--shadow-md'));
  });

  it('draws the toolbar strip with the same geometry it claims to restate', () => {
    // The one shadow in the app that cannot be a box-shadow (see AppLayout.css):
    // a plain strip, so its height and left inset ARE the offset and nothing but
    // this test keeps them in step with the token.
    const layout = decomment(readFileSync(join(SRC, 'components/Layout/AppLayout.css'), 'utf8'));
    const rule = /\.app-layout__left::before\s*\{([^}]*)\}/.exec(layout);
    expect(rule, 'the toolbar shadow strip is gone').not.toBeNull();
    const body = rule![1];
    const px = (prop: string) => Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(body)?.[1]);
    const off = offsetOf('--shadow-float');
    expect(px('height'), 'strip height must equal the shadow offset').toBe(off);
    expect(px('left'), 'strip left inset must equal the shadow offset').toBe(off);
    // Colour comes from the token, never a literal — that is what makes the
    // strip darken with the theme like every real shadow.
    expect(body).toContain('background: var(--shadow-float-color)');
  });

  it('gives every floating canvas panel the SAME shadow', () => {
    // "Same" is the requirement, so the check is that the set has one member.
    const panels: [string, string][] = [
      ['components/NodeEditor/menus/ContextMenu.css', '.context-menu'],
      ['components/NodeEditor/edges/EdgeInfoCard.css', '.edge-info-card'],
      ['components/NodeEditor/nodes/MeshTargetPicker.css', '.mesh-picker__pop'],
    ];
    const used = new Set<string>();
    for (const [file, sel] of panels) {
      const css = decomment(readFileSync(join(SRC, file), 'utf8'));
      const rule = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
      expect(rule, `${sel} not found in ${file}`).not.toBeNull();
      const m = /box-shadow:\s*var\((--shadow-[a-z]+)\)/.exec(rule![1]);
      expect(m, `${sel} must take its shadow from a token`).not.toBeNull();
      used.add(m![1]);
    }
    // NodeEditor.css holds the rest (NEW, cost pill, canvas bar, draw cluster,
    // the two drop hints) — every hard shadow in it must be the same token.
    const ne = decomment(readFileSync(join(SRC, 'components/NodeEditor/NodeEditor.css'), 'utf8'));
    for (const m of ne.matchAll(/box-shadow:\s*var\((--shadow-[a-z-]+)\)/g)) used.add(m[1]);
    expect([...used]).toEqual(['--shadow-float']);
  });
});
