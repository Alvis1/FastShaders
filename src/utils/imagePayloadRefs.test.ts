/**
 * The storage de-duplication of image payloads (imagePayloadRefs.ts): the
 * writer that stores a duplicated payload once per document, and the reader
 * every restore path runs before sanitizeImageNodes. Pure; no globals.
 *
 * The one property everything rests on is "the reader never strips what the
 * writer wrote", with identity decided by CONTENT: the collision fixtures are a
 * real FNV-1a pair (payloadDigest.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  IMAGE_REF_RE,
  MAX_REF_RESOLVED_IMAGE_CHARS,
  imageRefFor,
  imagePayloadsForStorage,
  libraryPayloadsForStorage,
  harvestImagePayloads,
  newRefBudget,
  resolveImageRefs,
} from './imagePayloadRefs';
import { HARD_MAX_IMAGE_ENCODED_CHARS, IMAGE_REF_KEY, WRITE_IMAGE_REFS } from './imageNode';
import { safeJsonReviver } from './safeJson';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

const P = 'data:image/png;base64,AAAA';
const Q = 'data:image/png;base64,BBBB';
// A real FNV-1a collision: equal length (30), both valid, both hash 61a5fde1.
const CP = 'data:image/png;base64,L8zt5mTG';
const CQ = 'data:image/png;base64,E6b4siKM';
// Same length as P (26) but fails the whitelist.
const BAD = 'data:text/html;base64,AAAA';

const img = (id: string, imageB64: string): AppNode =>
  makeNode(id, 'imageNode', { imageB64, width: 1, height: 1 });
const vals = (n: unknown) => (n as { data: { values: Record<string, unknown> } }).data.values;
const b64 = (n: unknown) => vals(n).imageB64;
const hasRef = (n: unknown) => Object.prototype.hasOwnProperty.call(vals(n), IMAGE_REF_KEY);
/** What localStorage hands back: the written document, re-parsed. */
const stored = <T>(x: T): T => JSON.parse(JSON.stringify(x), safeJsonReviver) as T;
/** A hand-written stored node carrying a ref. */
const refNode = (id: string, ref: unknown, imageB64 = ''): AppNode =>
  ({
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'imageNode', label: id, cost: 0, values: { imageB64, width: 1, height: 1, imageRef: ref } },
  }) as unknown as AppNode;

describe('the ref format', () => {
  it('is img1-<fnv hex>-<length base36>', () => {
    expect(imageRefFor(P)).toBe('img1-0ce4918c-q');
    expect(P.length).toBe(26);
    expect(IMAGE_REF_RE.test(imageRefFor(P))).toBe(true);
    expect(imageRefFor(CP)).toBe('img1-61a5fde1-u');
    expect(imageRefFor(CQ)).toBe('img1-61a5fde1-u');
    expect(IMAGE_REF_RE.test('img2-0ce4918c-q')).toBe(false);
    expect(IMAGE_REF_RE.test('img1-0CE4918C-q')).toBe(false);
    expect(IMAGE_REF_RE.test('img1-0ce4918-q')).toBe(false);
  });

  it('guards 16M characters per document, and the writer is switched on', () => {
    expect(MAX_REF_RESOLVED_IMAGE_CHARS).toBe(16_000_000);
    expect(MAX_REF_RESOLVED_IMAGE_CHARS).toBe(2 * HARD_MAX_IMAGE_ENCODED_CHARS);
    // The rollback lever (integration §5 Q3); every writer test below assumes it.
    expect(WRITE_IMAGE_REFS).toBe(true);
  });
});

describe('writer then reader', () => {
  it('stores a duplicate once, keeps key order, and restores it', () => {
    const doc = [img('a', P), img('b', P), img('c', Q)];
    const before = JSON.stringify(doc);
    const written = imagePayloadsForStorage(doc);
    // The input is never mutated.
    expect(JSON.stringify(doc)).toBe(before);
    expect(b64(written[0])).toBe(P);
    expect(b64(written[2])).toBe(Q);
    expect(written[0]).toBe(doc[0]);
    expect(written[2]).toBe(doc[2]);
    expect(vals(written[1])).toEqual({ imageB64: '', width: 1, height: 1, imageRef: 'img1-0ce4918c-q' });
    expect(Object.keys(vals(written[1]))).toEqual(['imageB64', 'width', 'height', 'imageRef']);

    const read = resolveImageRefs(stored(written));
    expect(read.dangling).toBe(0);
    expect(read.nodes.map(b64)).toEqual([P, P, Q]);
    for (const n of read.nodes) {
      expect(hasRef(n)).toBe(false);
      expect(Object.keys(vals(n))).toEqual(['imageB64', 'width', 'height']);
    }
  });

  it('is idempotent across a write, a read and a write', () => {
    const doc = [img('a', P), img('b', P), img('c', Q), img('d', Q), img('e', P)];
    const once = JSON.stringify(imagePayloadsForStorage(doc));
    const again = JSON.stringify(imagePayloadsForStorage(resolveImageRefs(stored(imagePayloadsForStorage(doc))).nodes));
    expect(again).toBe(once);
  });

  it('a document without duplicates is returned as the SAME array, both ways', () => {
    const doc = [img('a', P), img('b', Q), makeNode('f', 'float', { value: 1 })];
    expect(imagePayloadsForStorage(doc)).toBe(doc);
    const parsed = stored(doc);
    expect(resolveImageRefs(parsed).nodes).toBe(parsed);
  });

  it('an old-format document with three identical inline payloads loads unchanged', () => {
    const parsed = stored([img('a', P), img('b', P), img('c', P)]);
    const read = resolveImageRefs(parsed);
    expect(read.dangling).toBe(0);
    expect(read.nodes).toBe(parsed);
    expect(read.nodes.map(b64)).toEqual([P, P, P]);
  });

  it('drops a stray in-memory imageRef instead of writing it', () => {
    const stray = { ...img('a', P) } as AppNode;
    (stray.data as { values: Record<string, unknown> }).values = { imageB64: P, width: 1, height: 1, imageRef: 'junk' };
    const written = imagePayloadsForStorage([stray]);
    expect(hasRef(written[0])).toBe(false);
    expect(b64(written[0])).toBe(P);
    expect(vals(stray).imageRef).toBe('junk');
  });
});

describe('collisions are decided by content', () => {
  it('[P, P, Q, Q] with a shared key: only the first payload may be referenced', () => {
    const written = imagePayloadsForStorage([img('a', CP), img('b', CP), img('c', CQ), img('d', CQ)]);
    expect(b64(written[0])).toBe(CP);
    expect(vals(written[1]).imageRef).toBe('img1-61a5fde1-u');
    expect(b64(written[2])).toBe(CQ);
    expect(b64(written[3])).toBe(CQ);
    expect(hasRef(written[2]) || hasRef(written[3])).toBe(false);
    const read = resolveImageRefs(stored(written));
    expect(read.dangling).toBe(0);
    expect(read.nodes.map(b64)).toEqual([CP, CP, CQ, CQ]);
  });

  it('[Q, P, P]: a single earlier Q owns the key, so no ref is written at all', () => {
    const doc = [img('q', CQ), img('a', CP), img('b', CP)];
    expect(imagePayloadsForStorage(doc)).toBe(doc);
  });

  it('a hostile ref resolves to the document\'s own first payload with that key', () => {
    const read = resolveImageRefs(stored([img('q', CQ), refNode('x', 'img1-61a5fde1-u')]));
    expect(read.dangling).toBe(0);
    expect(b64(read.nodes[1])).toBe(CQ);
  });

  it('an invalid payload of the same length claims nothing', () => {
    const written = imagePayloadsForStorage([img('bad', BAD), img('a', P), img('b', P)]);
    expect(vals(written[2]).imageRef).toBe(imageRefFor(P));
    expect(resolveImageRefs(stored(written)).nodes.map(b64)).toEqual([BAD, P, P]);
  });
});

describe('hostile stored documents', () => {
  it('a ref with no canonical empties the node and counts it', () => {
    const read = resolveImageRefs(stored([refNode('x', imageRefFor(P))]));
    expect(read.dangling).toBe(1);
    expect(b64(read.nodes[0])).toBe('');
    expect(hasRef(read.nodes[0])).toBe(false);
  });

  it('a malformed ref dangles, even with the canonical present', () => {
    for (const bad of ['img2-0ce4918c-q', 'img1-0CE4918C-q', 'img1-0ce4918-q', 'img1-0ce4918c-r', 'img1-0ce4918c-']) {
      const read = resolveImageRefs(stored([img('a', P), refNode('x', bad)]));
      expect(read.dangling, bad).toBe(1);
      expect(b64(read.nodes[1]), bad).toBe('');
    }
  });

  it('a canonical that fails the whitelist resolves nothing', () => {
    const breakout = 'data:image/png;base64,AA</script>';
    for (const canonical of [BAD, breakout]) {
      const read = resolveImageRefs(stored([img('a', canonical), refNode('x', imageRefFor(canonical))]));
      expect(read.dangling, canonical).toBe(1);
      expect(b64(read.nodes[1])).toBe('');
    }
  });

  it('a non-string ref dangles and its key is removed', () => {
    for (const junk of [{}, 42, null, true, []]) {
      const read = resolveImageRefs(stored([img('a', P), refNode('x', junk)]));
      expect(read.dangling).toBe(1);
      expect(b64(read.nodes[1])).toBe('');
      expect(hasRef(read.nodes[1])).toBe(false);
    }
  });

  it('a non-empty inline payload beside a ref wins, uncounted', () => {
    const read = resolveImageRefs(stored([img('a', P), refNode('x', imageRefFor(P), Q)]));
    expect(read.dangling).toBe(0);
    expect(b64(read.nodes[1])).toBe(Q);
    expect(hasRef(read.nodes[1])).toBe(false);
  });

  it('never throws on malformed elements, and leaves them alone', () => {
    const junk = [
      null,
      undefined,
      'node',
      42,
      { data: null },
      { data: { registryType: 'imageNode', values: 5 } },
      { data: { registryType: 'imageNode', values: null } },
      { data: { registryType: 'imageNode', values: ['x'] } },
      { data: { registryType: 'imageNode' } },
    ] as unknown[];
    const read = resolveImageRefs(junk);
    expect(read.dangling).toBe(0);
    expect(read.nodes).toBe(junk);
    expect(() => imagePayloadsForStorage(junk as AppNode[])).not.toThrow();
    expect(() => libraryPayloadsForStorage([{ nodes: junk as AppNode[] }])).not.toThrow();
  });

  it('reads a null-prototype values object by plain property access', () => {
    const values = Object.create(null) as Record<string, unknown>;
    values.imageB64 = '';
    values.imageRef = imageRefFor(P);
    const node = { id: 'x', data: { registryType: 'imageNode', values } };
    const read = resolveImageRefs([img('a', P), node] as unknown[]);
    expect(read.dangling).toBe(0);
    expect(b64(read.nodes[1])).toBe(P);
  });

  it('the module never uses the `in` operator (it throws on a primitive)', () => {
    const src = readFileSync(new URL('./imagePayloadRefs.ts', import.meta.url), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    expect(code).not.toMatch(/\bin\b/);
  });
});

describe('the amplification guard', () => {
  it('the writer writes inline past it, and its own reader strips nothing', () => {
    const doc = [img('a', P), img('b', P), img('c', P), img('d', P), img('e', P)];
    const max = 3 * P.length;
    const written = imagePayloadsForStorage(doc, max);
    expect(written.map(hasRef)).toEqual([false, true, true, true, false]);
    expect(b64(written[4])).toBe(P);
    const read = resolveImageRefs(stored(written), undefined, newRefBudget(max));
    expect(read.dangling).toBe(0);
    expect(read.nodes.map(b64)).toEqual([P, P, P, P, P]);
  });

  it('the reader strips a hostile document past it', () => {
    const r = imageRefFor(P);
    const doc = stored([img('a', P), refNode('b', r), refNode('c', r), refNode('d', r), refNode('e', r)]);
    const read = resolveImageRefs(doc, undefined, newRefBudget(3 * P.length));
    expect(read.dangling).toBe(1);
    expect(read.nodes.map(b64)).toEqual([P, P, P, P, '']);
  });
});

describe('property: the reader never strips what the writer wrote', () => {
  /** mulberry32 — a seeded PRNG, so a failure is reproducible. */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const POOL = [P, Q, CP, CQ, BAD];

  it('over 200 random documents, with and without a tight guard', () => {
    const rand = rng(20260911);
    for (let d = 0; d < 200; d++) {
      const n = Math.floor(rand() * 13);
      const doc: AppNode[] = [];
      for (let i = 0; i < n; i++) {
        doc.push(rand() < 0.15 ? makeNode(`f${i}`, 'float', { value: i }) : img(`n${i}`, POOL[Math.floor(rand() * POOL.length)]));
      }
      const max = d % 2 === 0 ? MAX_REF_RESOLVED_IMAGE_CHARS : 2 * P.length;
      const read = resolveImageRefs(stored(imagePayloadsForStorage(doc, max)), undefined, newRefBudget(max));
      expect(read.dangling, `doc ${d}`).toBe(0);
      expect(read.nodes.map((x) => (x.data.registryType === 'imageNode' ? b64(x) : null))).toEqual(
        doc.map((x) => (x.data.registryType === 'imageNode' ? b64(x) : null)),
      );
      for (const x of read.nodes) if (x.data.registryType === 'imageNode') expect(hasRef(x)).toBe(false);
    }
  });
});

describe('the saved-group library is ONE document', () => {
  const group = (id: string, nodes: AppNode[]) => ({ id, name: id, color: '#6366f1', nodes, edges: [] });

  it('a ref may point into an earlier group', () => {
    const groups = [group('g1', [img('i1', P)]), group('g2', [img('i2', P)])];
    const written = libraryPayloadsForStorage(groups);
    expect(written[0]).toBe(groups[0]);
    expect(vals(written[1].nodes[0]).imageRef).toBe(imageRefFor(P));
    expect(libraryPayloadsForStorage([group('g1', [img('i1', P)]), group('g2', [img('i2', Q)])]).length).toBe(2);
  });

  it('returns the SAME array when nothing is duplicated', () => {
    const groups = [group('g1', [img('i1', P)]), group('g2', [img('i2', Q)])];
    expect(libraryPayloadsForStorage(groups)).toBe(groups);
  });

  it('resolves with a harvest of every group and ONE budget, even if the first is skipped', () => {
    const raw = stored(libraryPayloadsForStorage([group('g1', [img('i1', P)]), group('g2', [img('i2', P)])]));
    const index = harvestImagePayloads(raw.flatMap((g) => g.nodes));
    const budget = newRefBudget();
    // g1 is never resolved (as when its own per-group catch drops it).
    const g2 = resolveImageRefs(raw[1].nodes, index, budget);
    expect(g2.dangling).toBe(0);
    expect(b64(g2.nodes[0])).toBe(P);
    expect(budget.refChars).toBe(P.length);
  });
});

describe('what it saves', () => {
  it('ten nodes sharing a 600K payload write about one copy', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(600_000 - 22);
    const doc = Array.from({ length: 10 }, (_, i) => img(`n${i}`, big));
    expect(JSON.stringify(imagePayloadsForStorage(doc)).length).toBeLessThan(600_000 + 10 * 250);
    expect(JSON.stringify(doc).length).toBeGreaterThan(6_000_000);
  });
});
