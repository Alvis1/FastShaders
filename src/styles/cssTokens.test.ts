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
