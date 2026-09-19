/**
 * The ONE editor-side copy of the model-signature helpers
 * (`sanitizeModelSignature`, `modelSignatureMatches`). Every restore path of
 * index-section Output data, the glTF reader, the builder, emission and the
 * parse call these, so their rules are pinned here once. The loader's own
 * restatement of the bounds is pinned by shaderloaderMaterialParts.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_MATERIALS_MAX,
  SIGNATURE_NAME_MAX,
  SIGNATURE_TOTAL_CHARS_MAX,
  modelSignatureMatches,
  sanitizeModelSignature,
} from './materialPartsContract';
import { safeJsonReviver } from '@/utils/safeJson';

describe('sanitizeModelSignature', () => {
  it('returns the SAME object when it is exactly { materials } and clean', () => {
    const sig = { materials: ['Body', '', 'Glass'] };
    expect(sanitizeModelSignature(sig)).toBe(sig);
  });

  it('returns a fresh { materials } copy when the object carries any other key', () => {
    const raw = { materials: ['Body'], extra: 1 };
    const out = sanitizeModelSignature(raw);
    expect(out).toEqual({ materials: ['Body'] });
    expect(out).not.toBe(raw);
    expect(out?.materials).not.toBe(raw.materials);
  });

  it('does not treat an INHERITED materials beside one other own key as clean', () => {
    const raw = Object.assign(Object.create({ materials: ['Body'] }) as object, { other: 1 });
    const out = sanitizeModelSignature(raw);
    expect(out).toEqual({ materials: ['Body'] });
    expect(out).not.toBe(raw);
  });

  it('never trims, truncates or normalises a name', () => {
    const names = ['Body ', ' Glass', 'Ķermenis', 'é', 'é', '__proto__', 'constructor', '"}:,'];
    expect(sanitizeModelSignature({ materials: names })?.materials).toEqual(names);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a number', 5],
    ['a string', 'Body'],
    ['true', true],
    ['an array', [['Body']]],
    ['no materials', {}],
    ['materials a string', { materials: 'Body' }],
    ['materials an object', { materials: { 0: 'Body', length: 1 } }],
    ['an empty list', { materials: [] }],
    ['a non-string entry', { materials: ['Body', 3] }],
    ['a null entry', { materials: ['Body', null] }],
    ['a hole', { materials: [, 'Body'] }], // eslint-disable-line no-sparse-arrays
    ['a name one character over', { materials: ['x'.repeat(SIGNATURE_NAME_MAX + 1)] }],
    ['one entry too many', { materials: new Array(SIGNATURE_MATERIALS_MAX + 1).fill('a') }],
    ['a huge sparse list (rejected before the walk)', { materials: new Array(2 ** 31) }],
    // 65 full-length names: each passes on its own, the sum does not.
    ['a total one name over', { materials: new Array(65).fill('x'.repeat(SIGNATURE_NAME_MAX)) }],
  ])('refuses %s', (_why, raw) => {
    expect(sanitizeModelSignature(raw)).toBeNull();
  });

  it('accepts exactly the bounds', () => {
    expect(sanitizeModelSignature({ materials: ['x'.repeat(SIGNATURE_NAME_MAX)] })).not.toBeNull();
    expect(sanitizeModelSignature({ materials: new Array(SIGNATURE_MATERIALS_MAX).fill('') })).not.toBeNull();
    // 64 × 1024 is exactly the total cap.
    const atCap = new Array(SIGNATURE_TOTAL_CHARS_MAX / SIGNATURE_NAME_MAX).fill('x'.repeat(SIGNATURE_NAME_MAX));
    expect(sanitizeModelSignature({ materials: atCap })).not.toBeNull();
    const over = [...atCap.slice(1), 'x'.repeat(SIGNATURE_NAME_MAX), 'y'];
    expect(sanitizeModelSignature({ materials: over })).toBeNull();
  });

  it('the total cap is reachable: 1024 materials of 64 characters fit it exactly', () => {
    expect(SIGNATURE_TOTAL_CHARS_MAX).toBe(65536);
    const names = new Array(SIGNATURE_MATERIALS_MAX).fill('m'.repeat(64));
    expect(sanitizeModelSignature({ materials: names })).not.toBeNull();
  });

  it('a JSON-borne __proto__ key cannot smuggle a signature past the reviver', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"materials":["Body"]}}', safeJsonReviver);
    expect(sanitizeModelSignature(parsed)).toBeNull();
  });

  it('never throws on any junk shape', () => {
    for (const raw of [0, -0, NaN, 1n, Symbol('s'), () => 1, new Map(), new Date(), { materials: [Symbol('s')] }]) {
      expect(() => sanitizeModelSignature(raw)).not.toThrow();
    }
  });
});

describe('modelSignatureMatches (loader 0.8 sameSignature)', () => {
  it('matches the same count and names in order', () => {
    expect(modelSignatureMatches({ materials: ['A', '', 'B'] }, { materials: ['A', '', 'B'] })).toBe(true);
  });

  it.each<[string, string[], string[]]>([
    ['a different count', ['A', 'B'], ['A', 'B', '']],
    ['a different order', ['A', 'B'], ['B', 'A']],
    ['a trailing space', ['Body'], ['Body ']],
    ['a different Unicode normal form', ['é'], ['é']],
    ['a case difference', ['body'], ['Body']],
    ['an absent name vs a real one', [''], ['Material']],
  ])('does not match %s', (_why, a, b) => {
    expect(modelSignatureMatches({ materials: a }, { materials: b })).toBe(false);
    expect(modelSignatureMatches({ materials: b }, { materials: a })).toBe(false);
  });
});
