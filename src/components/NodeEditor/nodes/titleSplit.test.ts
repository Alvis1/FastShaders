import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { splitTitle } from './titleSplit';

describe('splitTitle — one break opportunity, at the most balanced seam', () => {
  it('seams a camelCase var name, keeping the digit on the fragment before it', () => {
    expect(splitTitle('cameraPosition1')).toEqual({ head: 'camera', tail: 'Position1', space: false });
    expect(splitTitle('toHsl1')).toEqual({ head: 'to', tail: 'Hsl1', space: false });
  });

  it('picks the most balanced of several seams', () => {
    // position|WorldDirection1 is 8/15, positionWorld|Direction1 is 13/10.
    expect(splitTitle('positionWorldDirection1')).toEqual({ head: 'positionWorld', tail: 'Direction1', space: false });
  });

  it('splits a spaced label at a space, and a three-word label at the most balanced one', () => {
    expect(splitTitle('Camera Position')).toEqual({ head: 'Camera', tail: 'Position', space: true });
    // "Position World" | "Direction" (14/9) beats "Position" | "World Direction" (8/15).
    expect(splitTitle('Position World Direction')).toEqual({ head: 'Position World', tail: 'Direction', space: true });
  });

  it('breaks after an underscore or hyphen', () => {
    expect(splitTitle('my_prop')).toEqual({ head: 'my_', tail: 'prop', space: false });
    expect(splitTitle('edge-glow')).toEqual({ head: 'edge-', tail: 'glow', space: false });
  });

  it('is Unicode-aware (Latvian labels and camelCase)', () => {
    expect(splitTitle('Kameras pozīcija')).toEqual({ head: 'Kameras', tail: 'pozīcija', space: true });
    expect(splitTitle('vektoriālaisReizinājums')).toEqual({ head: 'vektoriālais', tail: 'Reizinājums', space: false });
  });

  it('returns null for a name with no seam — the node then widens as before', () => {
    expect(splitTitle('mul1')).toBeNull();
    expect(splitTitle('vec31')).toBeNull();
    expect(splitTitle('')).toBeNull();
    expect(splitTitle(' x')).toBeNull();
  });
});

describe('NodeTitle is the ONE renderer of .node-base__title (source pin)', () => {
  /**
   * Files allowed to render the span by hand, each with the reason. The sweep
   * asserts an exemption is still USED (the glyphCoverage.test.ts idiom), so a
   * file that stops needing one fails here instead of silently outliving it.
   */
  const EXEMPT: Record<string, string> = {
    // The asset cards' shared frame. Its header is a bare span, so those five
    // tiles (math preview, preview, clock, mic, audio) get neither splitTitle's
    // single balanced break nor NodeTitle's `title` hover — today invisible,
    // because every one of those labels is one or two space-separated words in
    // both languages, and visible the moment a three-word label or a longer
    // Latvian translation lands. Route CardShell through <NodeTitle> and delete
    // this entry.
    'NodePreviewCard.tsx': 'CardShell renders its own header span',
  };

  it('no component that draws a node renders the title span by hand', () => {
    // The sweep used to read `__dirname` NON-recursively, i.e. nodes/ alone —
    // so NodePreviewCard.tsx, one directory up, was never opened and the guard's
    // headline claim went unchecked exactly where it is broken. Walk the whole
    // NodeEditor tree instead.
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.tsx') || e.name === 'NodeTitle.tsx') continue;
        scanned++;
        const src = readFileSync(p, 'utf8');
        if (!/className="node-base__title"/.test(src)) continue;
        const rel = path.relative(root, p);   // keyed by PATH, so one exemption frees one file
        if (EXEMPT[rel]) continue;
        offenders.push(rel);
      }
    };
    walk(root);
    // Positive control: a wrong root must fail rather than pass vacuously.
    expect(scanned, 'the source walk found almost no components').toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it('every exemption is still used', () => {
    for (const [file, why] of Object.entries(EXEMPT)) {
      const src = readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(/className="node-base__title"/.test(src), `${file} no longer renders the title by hand (${why}) — drop the exemption`).toBe(true);
    }
  });

  it('the title CSS still refuses mid-word breaks and clamps at two lines', () => {
    const css = readFileSync(path.join(__dirname, 'NodeBase.css'), 'utf8');
    const rule = css.slice(css.indexOf('.node-base__title {'), css.indexOf('/* ===== Body'));
    expect(rule).toContain('overflow-wrap: normal;');
    expect(rule).toContain('-webkit-line-clamp: 2;');
  });
});
