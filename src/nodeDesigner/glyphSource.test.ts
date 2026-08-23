import { describe, it, expect } from 'vitest';
import {
  DRAWABLE_TAGS,
  scanGlyphSource,
  tagsAlign,
  drawableIndexAtOffset,
  mergeRanges,
  formatGlyphSource,
} from './glyphSource';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';

/**
 * The glyph modal joins its two halves — the DOM in the preview and the TEXT in
 * the textarea — purely by DOCUMENT ORDER, so everything here is about the
 * scanner agreeing with a browser about what the markup contains and in what
 * order. The shipped glyphs are the corpus: they are the art this actually has to
 * work on, and a scanner that mis-reads one of them mis-highlights it forever.
 */

const shipped = Object.entries(CUSTOM_GLYPHS)
  .map(([type, d]) => [type, (d as { svg?: string }).svg || ''] as const)
  .filter(([, svg]) => !!svg);

describe('scanGlyphSource', () => {
  it('finds each drawable element and slices back to its exact markup', () => {
    const src = '<g transform="translate(28 28)"><line x1="0" y1="0" x2="4" y2="4"/><circle cx="1" cy="2" r="3"></circle></g>';
    const scan = scanGlyphSource(src);
    expect(scan.error).toBeNull();
    expect(scan.drawables.map((d) => d.tag)).toEqual(['line', 'circle']);
    expect(src.slice(scan.drawables[0].start, scan.drawables[0].end)).toBe('<line x1="0" y1="0" x2="4" y2="4"/>');
    // a PAIRED element's range spans through its end tag, so highlighting it
    // highlights the whole element and not just the opening tag
    expect(src.slice(scan.drawables[1].start, scan.drawables[1].end)).toBe('<circle cx="1" cy="2" r="3"></circle>');
  });

  it('records the <g> wrapper too, with depth', () => {
    const scan = scanGlyphSource('<g><g><line x1="0" y1="0" x2="1" y2="1"/></g></g>');
    expect(scan.elements.map((e) => [e.tag, e.depth])).toEqual([['g', 0], ['g', 1], ['line', 2]]);
    expect(scan.drawables).toHaveLength(1);
  });

  it('skips comments, CDATA and processing instructions', () => {
    const src = '<!-- <line x1="9"/> --><line x1="0" y1="0" x2="1" y2="1"/>';
    const scan = scanGlyphSource(src);
    expect(scan.error).toBeNull();
    // the commented-out line must NOT become an element, or every index after it shifts
    expect(scan.drawables).toHaveLength(1);
    expect(src.slice(scan.drawables[0].start)).toBe('<line x1="0" y1="0" x2="1" y2="1"/>');
  });

  it('does not end a tag on a > inside a quoted attribute value', () => {
    const src = '<rect x="0" y="0" width="4" height="4" data-note="a > b"/><line x1="0" y1="0" x2="1" y2="1"/>';
    const scan = scanGlyphSource(src);
    expect(scan.error).toBeNull();
    expect(scan.drawables.map((d) => d.tag)).toEqual(['rect', 'line']);
    expect(src.slice(scan.drawables[0].start, scan.drawables[0].end)).toContain('a > b');
  });

  it('reports — never guesses — on malformed markup', () => {
    expect(scanGlyphSource('<line x1="0"').error).toBeTruthy();
    expect(scanGlyphSource('<!-- unterminated').error).toBeTruthy();
    expect(scanGlyphSource('<g><line x1="0" y1="0" x2="1" y2="1"/>').error).toBeTruthy();
    expect(scanGlyphSource('</g>').error).toBeTruthy();
  });

  it('reads every shipped glyph cleanly', () => {
    const bad = shipped.filter(([, svg]) => scanGlyphSource(svg).error !== null).map(([t]) => t);
    expect(bad).toEqual([]);
    shipped.forEach(([type, svg]) => {
      const scan = scanGlyphSource(svg);
      scan.drawables.forEach((d) => {
        expect(svg.slice(d.start, d.start + 1 + d.tag.length), type).toBe('<' + d.tag);
        expect(svg.slice(d.end - 1, d.end), type).toBe('>');
      });
    });
  });
});

describe('tagsAlign', () => {
  const src = '<g><line x1="0" y1="0" x2="1" y2="1"/><circle cx="0" cy="0" r="1"/></g>';
  it('accepts a DOM tag list in the same order', () => {
    expect(tagsAlign(scanGlyphSource(src), ['line', 'circle'])).toBe(true);
  });
  it('rejects a different length or order — the index join would be off by one', () => {
    expect(tagsAlign(scanGlyphSource(src), ['line'])).toBe(false);
    expect(tagsAlign(scanGlyphSource(src), ['circle', 'line'])).toBe(false);
  });
  it('rejects outright when the scan itself failed', () => {
    expect(tagsAlign(scanGlyphSource('<line x1="0"'), [])).toBe(false);
  });
  it('covers exactly the tags collectGlyphPoints handles', () => {
    expect(DRAWABLE_TAGS.slice().sort()).toEqual(
      ['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'text'],
    );
  });
});

describe('drawableIndexAtOffset', () => {
  const src = '<line x1="0" y1="0" x2="1" y2="1"/>\n<circle cx="0" cy="0" r="1"/>';
  const scan = scanGlyphSource(src);
  it('maps a caret inside an element to that element', () => {
    expect(drawableIndexAtOffset(scan, 5)).toBe(0);
    expect(drawableIndexAtOffset(scan, src.indexOf('cx'))).toBe(1);
  });
  it('returns -1 between elements', () => {
    expect(drawableIndexAtOffset(scan, src.indexOf('\n') + 1 - 1)).toBe(0); // the boundary belongs to the element that ends there
    expect(drawableIndexAtOffset(scan, src.length)).toBe(1);
  });
});

describe('mergeRanges', () => {
  it('sorts, merges overlaps and drops empties', () => {
    expect(mergeRanges([{ start: 10, end: 20 }, { start: 0, end: 5 }, { start: 4, end: 12 }, { start: 7, end: 7 }]))
      .toEqual([{ start: 0, end: 20 }]);
    expect(mergeRanges([{ start: 0, end: 2 }, { start: 5, end: 7 }]))
      .toEqual([{ start: 0, end: 2 }, { start: 5, end: 7 }]);
  });
});

describe('formatGlyphSource', () => {
  it('puts each element on its own line and indents groups', () => {
    const src = '<g transform="translate(28 28)"><line x1="0" y1="0" x2="1" y2="1"/><circle cx="0" cy="0" r="1"/></g>';
    expect(formatGlyphSource(src)).toBe(
      '<g transform="translate(28 28)">\n'
      + '  <line x1="0" y1="0" x2="1" y2="1"/>\n'
      + '  <circle cx="0" cy="0" r="1"/>\n'
      + '</g>',
    );
  });

  it('keeps a childless element on ONE line, paired form included', () => {
    // the modal's own commit path (root.innerHTML) writes every shape paired,
    // so this is the common case, not an edge one
    expect(formatGlyphSource('<g><rect x="0" y="0" width="4" height="4"></rect><line x1="0" y1="0" x2="1" y2="1"/></g>'))
      .toBe('<g>\n  <rect x="0" y="0" width="4" height="4"></rect>\n  <line x1="0" y1="0" x2="1" y2="1"/>\n</g>');
  });

  it('still breaks a group that really has element children', () => {
    expect(formatGlyphSource('<g><g><line x1="0" y1="0" x2="1" y2="1"/></g></g>'))
      .toBe('<g>\n  <g>\n    <line x1="0" y1="0" x2="1" y2="1"/>\n  </g>\n</g>');
  });

  it('is idempotent', () => {
    const src = '<g><line x1="0" y1="0" x2="1" y2="1"/></g>';
    const once = formatGlyphSource(src);
    expect(formatGlyphSource(once)).toBe(once);
  });

  it('keeps a <text> element and its tspans on ONE line — its whitespace renders', () => {
    const src = '<g><text x="0" y="0">a<tspan dy="2">b</tspan></text></g>';
    expect(formatGlyphSource(src)).toBe('<g>\n  <text x="0" y="0">a<tspan dy="2">b</tspan></text>\n</g>');
  });

  it('refuses to touch markup it could not read', () => {
    const broken = '<g><line x1="0"';
    expect(formatGlyphSource(broken)).toBe(broken);
  });

  it('preserves every tag byte-for-byte across the whole shipped corpus', () => {
    shipped.forEach(([type, svg]) => {
      const out = formatGlyphSource(svg);
      const tagsOf = (s: string) => {
        const scan = scanGlyphSource(s);
        return scan.elements.map((e) => s.slice(e.start, e.end).replace(/\s+/g, ' '));
      };
      // same elements, same order — only whitespace BETWEEN tags moved
      expect(scanGlyphSource(out).error, type).toBeNull();
      expect(scanGlyphSource(out).elements.map((e) => e.tag), type)
        .toEqual(scanGlyphSource(svg).elements.map((e) => e.tag));
      // and every element's own markup is untouched (nested ranges normalise the
      // newlines the formatter inserted BETWEEN their children)
      expect(tagsOf(out).map((t) => t.replace(/> </g, '><')), type)
        .toEqual(tagsOf(svg).map((t) => t.replace(/> </g, '><')));
      expect(formatGlyphSource(out), type).toBe(out);
    });
  });
});
