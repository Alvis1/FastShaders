/**
 * fillTemplate — the single-pass placeholder filler every multi-placeholder
 * notice goes through. The failure it closes: a value (a file name) spelling a
 * LATER placeholder captured that placeholder's fill, and the real one printed
 * literally. Successive `.replace()` calls fail every case marked "capture".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillTemplate } from './fillTemplate';

describe('fillTemplate', () => {
  it('fills every placeholder from the map', () => {
    expect(fillTemplate('{name} holds more than {max} files', { name: '“a.zip”', max: 512 }))
      .toBe('“a.zip” holds more than 512 files');
  });

  it('capture: a value spelling a later placeholder stays text', () => {
    expect(fillTemplate('{name} unpacks to more than {limit} MB', { name: '“{limit}.zip”', limit: '96' }))
      .toBe('“{limit}.zip” unpacks to more than 96 MB');
  });

  it('capture: a value spelling EVERY placeholder, including itself, stays text', () => {
    const name = '{name}{limit}{max}{reason}{n}{error}{size}{w}{h}';
    const out = fillTemplate('{name}|{limit}|{max}|{reason}|{n}|{error}|{size}|{w}|{h}', {
      name, limit: 1, max: 2, reason: 'r', n: 3, error: 'e', size: 4, w: 5, h: 6,
    });
    expect(out).toBe(`${name}|1|2|r|3|e|4|5|6`);
  });

  it('inserts values verbatim: no $& / $1 / $` / $\' expansion', () => {
    expect(fillTemplate('[{name}]', { name: '$&' })).toBe('[$&]');
    expect(fillTemplate('[{name}]', { name: '$1$2' })).toBe('[$1$2]');
    expect(fillTemplate('a{name}b', { name: "$`$'$$" })).toBe("a$`$'$$b");
  });

  it('nested braces: only the inner {key} is a placeholder', () => {
    expect(fillTemplate('{{name}}', { name: 'x' })).toBe('{x}');
    expect(fillTemplate('{ name } {} {1} {name', { name: 'x' })).toBe('{ name } {} {1} {name');
  });

  it('fills a key used twice, everywhere', () => {
    expect(fillTemplate('uses {ext}, re-export without {ext}', { ext: 'Draco' }))
      .toBe('uses Draco, re-export without Draco');
  });

  it('leaves an unknown key literal', () => {
    expect(fillTemplate('{name} and {other}', { name: 'x' })).toBe('x and {other}');
  });

  it('never resolves a key through Object.prototype', () => {
    expect(fillTemplate('{constructor} {toString} {__proto__}', {})).toBe('{constructor} {toString} {__proto__}');
  });

  it('prints an empty-string value as nothing, and a number as its digits', () => {
    expect(fillTemplate('a{x}b{y}', { x: '', y: 0 })).toBe('ab0');
  });
});

/**
 * Source pin. No notice may fill placeholders with CHAINED `.replace('{…}', …)`
 * calls again — the exact shape of the defect (a value inserted by the first
 * call is scanned by the second). A lone `.replace('{x}', …)` stays legal: it
 * cannot capture anything.
 */
function chainedPlaceholderReplaces(src: string): string[] {
  const hits: string[] = [];
  const opener = /\.replace\(\s*(?:['"`]\{|\/\\\{)/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src))) {
    // Walk the call's argument list to its closing paren, skipping strings.
    let i = m.index + '.replace('.length;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      } else if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
    }
    const rest = src.slice(i + 1);
    if (/^\s*\.replace\(\s*(?:['"`]\{|\/\\\{)/.test(rest)) {
      hits.push(src.slice(m.index, i + 1 + 60).replace(/\s+/g, ' '));
    }
  }
  return hits;
}

describe('multi-placeholder fills go through fillTemplate', () => {
  it('the detector finds the old chained shape (so the pin is not vacuous)', () => {
    const old = "t('{name} and {limit}', l)\n  .replace('{name}', () => `“${n}”`)\n  .replace('{limit}', () => f(z.limit, lang))";
    expect(chainedPlaceholderReplaces(old)).toHaveLength(1);
    expect(chainedPlaceholderReplaces("x.replace('{name}', () => (a ? `(${b}) ` : '')).replace(/\\{ext\\}/g, f)")).toHaveLength(1);
    expect(chainedPlaceholderReplaces("t('{n}', l).replace('{n}', String(a)) : t('{n}', l).replace('{n}', String(b))")).toEqual([]);
  });

  const FILES = [
    'utils/zipImportNotices.ts',
    'utils/importNote.ts',
    'utils/previewMesh.ts',
    'components/Modals/limitNoticeCopy.ts',
    'components/Modals/ExportPreflightModal.tsx',
    'components/NodeEditor/NodeEditor.tsx',
    'components/NodeEditor/SavedGroupCard.tsx',
    'components/Preview/ShaderPreview.tsx',
    'components/Layout/CostBar.tsx',
    'store/useAppStore.ts',
  ];

  it.each(FILES)('%s has no chained placeholder replace', (rel) => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    expect(chainedPlaceholderReplaces(src), rel).toEqual([]);
  });
});
