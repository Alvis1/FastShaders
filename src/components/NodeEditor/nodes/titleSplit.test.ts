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
  it('no node component renders the title span by hand', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.tsx') || f === 'NodeTitle.tsx') continue;
      const src = readFileSync(path.join(dir, f), 'utf8');
      if (/className="node-base__title"/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the title CSS still refuses mid-word breaks and clamps at two lines', () => {
    const css = readFileSync(path.join(__dirname, 'NodeBase.css'), 'utf8');
    const rule = css.slice(css.indexOf('.node-base__title {'), css.indexOf('/* ===== Body'));
    expect(rule).toContain('overflow-wrap: normal;');
    expect(rule).toContain('-webkit-line-clamp: 2;');
  });
});
