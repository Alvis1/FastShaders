import { describe, it, expect } from 'vitest';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  projectTextureSources,
  mergeTextureSources,
  textureSourcesKey,
  pickTextureValues,
  withImagePayload,
  MAX_LISTED_TEXTURE_SOURCES,
  textureSourceKey,
  type ProjectTextureSource,
} from './textureSources';
import type { ModelTextureSource } from './modelTextureSources';

const A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const B = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
const C = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHSQ=';
const ORIGIN = 'a1b2c3d4e5f60718';

const img = (id: string, values: Record<string, string | number>) =>
  makeNode(id, 'imageNode', { width: 64, height: 32, fileName: `${id}.png`, colorSpace: 'color', ...values });

describe('projectTextureSources', () => {
  it('lists each DISTINCT payload once, in document order, with every holder', () => {
    const nodes = [img('n1', { imageB64: A }), makeNode('m', 'mul'), img('n2', { imageB64: A }), img('n3', { imageB64: B })];
    const s = projectTextureSources(nodes);
    expect(s.map((x) => x.dataUrl)).toEqual([A, B]);
    expect(s.map((x) => x.holderIds)).toEqual([['n1', 'n2'], ['n3']]);
    expect(s.every((x) => x.kind === 'project')).toBe(true);
  });

  it('skips a holder whose payload or dimensions would not decode', () => {
    const nodes = [
      img('bad-url', { imageB64: 'data:text/html;base64,PHNjcmlwdD4=' }),
      img('empty', { imageB64: '' }),
      img('w0', { imageB64: A, width: 0 }),
      img('wstr', { imageB64: A, width: '2' }),
      img('w9000', { imageB64: A, width: 9000 }),
      img('hfrac', { imageB64: A, height: 1.5 }),
      img('ok', { imageB64: B }),
    ];
    const s = projectTextureSources(nodes);
    expect(s.map((x) => x.holderIds)).toEqual([['ok']]);
  });

  it('never throws on a primitive `values` (a tampered .fastshader)', () => {
    const tampered = { ...makeNode('t', 'imageNode'), data: { registryType: 'imageNode', label: 't', cost: 0, values: 5 } } as unknown as AppNode;
    expect(() => projectTextureSources([tampered, img('ok', { imageB64: A })])).not.toThrow();
    expect(projectTextureSources([tampered, img('ok', { imageB64: A })]).map((x) => x.holderIds)).toEqual([['ok']]);
  });

  it('takes the whole record from the first holder with a valid originId', () => {
    const nodes = [
      img('n1', { imageB64: A, width: 64, fileName: 'first.png' }),
      img('n2', { imageB64: A, width: 128, fileName: 'second.png', originId: ORIGIN, srcWidth: 256, srcHeight: 100 }),
    ];
    const [s] = projectTextureSources(nodes);
    // Dimensions, name and provenance all from n2 — never n1's width beside
    // n2's id, which would describe an original nobody has.
    expect(s).toMatchObject({ width: 128, fileName: 'second.png', originId: ORIGIN, srcWidth: 256, srcHeight: 100 });
    expect(s.holderIds).toEqual(['n1', 'n2']);
  });

  it('falls back to the first holder with a valid source pair, then to the first holder', () => {
    const pair = projectTextureSources([
      img('n1', { imageB64: A, originId: 'NOT-HEX' }),
      img('n2', { imageB64: A, fileName: 'pair.png', srcWidth: 512, srcHeight: 256 }),
    ])[0];
    expect(pair).toMatchObject({ fileName: 'pair.png', srcWidth: 512, srcHeight: 256 });
    expect(pair.originId).toBeUndefined();

    const plain = projectTextureSources([
      img('n1', { imageB64: A, fileName: 'plain.png', srcWidth: 512 }), // half a pair is no pair
      img('n2', { imageB64: A, fileName: 'other.png' }),
    ])[0];
    expect(plain.fileName).toBe('plain.png');
    expect(plain.srcWidth).toBeUndefined();
    expect(plain.srcHeight).toBeUndefined();
  });

  it('caps the grid at 64', () => {
    expect(MAX_LISTED_TEXTURE_SOURCES).toBe(64);
  });
});

describe('pickTextureValues', () => {
  const src = (over: Partial<ProjectTextureSource> = {}): ProjectTextureSource => ({
    kind: 'project', dataUrl: B, width: 16, height: 8, fileName: 'b.webp', holderIds: ['n9'], ...over,
  });

  it('is null when the node already holds that payload (no write, no undo entry)', () => {
    expect(pickTextureValues({ imageB64: B }, src())).toBeNull();
  });

  it('swaps the picture and keeps every sampling setting', () => {
    const current = {
      imageB64: A, width: 64, height: 32, fileName: 'a.png',
      colorSpace: 'data', filter: 'nearest', flipX: 1, flipY: 1, repeat: 0, tileX: 3, offsetY: 0.25,
      uvSet: 2, xfRotation: 0.5,
    };
    const next = pickTextureValues(current, src())!;
    expect(next).toEqual({
      ...current, imageB64: B, width: 16, height: 8, fileName: 'b.webp',
    });
  });

  it('moves the row ORDER with the bytes — a model pick never flips the next photo', () => {
    // A model texture is uploaded top-row-first; a file drop is not. Keeping
    // the previous picture's `orientation` renders the new one upside down.
    const fromModel = { imageB64: A, orientation: 'gltf' };
    expect(pickTextureValues(fromModel, src())!).not.toHaveProperty('orientation');
    expect(withImagePayload(fromModel, { dataUrl: B, width: 1, height: 1, fileName: 'x' })).not.toHaveProperty('orientation');
    // …and a source that IS top-row-first carries it onto the node.
    expect(pickTextureValues({ imageB64: A }, src({ orientation: 'gltf' }))!).toMatchObject({ orientation: 'gltf' });
  });

  it('deletes stale provenance when the source carries none', () => {
    const next = pickTextureValues({ imageB64: A, originId: ORIGIN, srcWidth: 2048, srcHeight: 1024 }, src())!;
    expect(next).not.toHaveProperty('originId');
    expect(next).not.toHaveProperty('srcWidth');
    expect(next).not.toHaveProperty('srcHeight');
  });

  it('copies the source’s own provenance (a pick stays revertible — the cache is content-keyed)', () => {
    const next = pickTextureValues(
      { imageB64: A, originId: 'ffffffffffffffff' },
      src({ originId: ORIGIN, srcWidth: 300, srcHeight: 200 }),
    )!;
    expect(next).toMatchObject({ originId: ORIGIN, srcWidth: 300, srcHeight: 200 });
  });

  it('never mutates the values it was given', () => {
    const current = { imageB64: A, originId: ORIGIN };
    const frozen = JSON.stringify(current);
    withImagePayload(current, { dataUrl: B, width: 1, height: 1, fileName: 'x' });
    expect(JSON.stringify(current)).toBe(frozen);
  });
});

describe('mergeTextureSources', () => {
  it('de-duplicates by payload: the first list wins the record, holders are appended', () => {
    const first: ProjectTextureSource[] = [{ kind: 'project', dataUrl: A, width: 1, height: 1, fileName: 'one', holderIds: ['a'] }];
    const second: ProjectTextureSource[] = [
      { kind: 'project', dataUrl: A, width: 2, height: 2, fileName: 'two', holderIds: ['b', 'a'] },
      { kind: 'project', dataUrl: C, width: 3, height: 3, fileName: 'three', holderIds: ['c'] },
    ];
    const merged = mergeTextureSources(first, second);
    expect(merged.map((s) => s.fileName)).toEqual(['one', 'three']);
    expect(merged[0].kind === 'project' && merged[0].holderIds).toEqual(['a', 'b']);
    // The input lists are not mutated.
    expect(first[0].holderIds).toEqual(['a']);
  });
});

describe('textureSourcesKey', () => {
  const base = [img('n1', { imageB64: A }), img('n2', { imageB64: B })];

  it('ignores a position-only edit (every drag frame)', () => {
    const moved = base.map((n) => ({ ...n, position: { x: 400, y: -30 } })) as AppNode[];
    expect(textureSourcesKey(moved)).toBe(textureSourcesKey(base));
  });

  it('moves when a payload, a dimension or a file name changes', () => {
    const k = textureSourcesKey(base);
    expect(textureSourcesKey([img('n1', { imageB64: C }), base[1]])).not.toBe(k);
    expect(textureSourcesKey([img('n1', { imageB64: A, width: 65 }), base[1]])).not.toBe(k);
    expect(textureSourcesKey([img('n1', { imageB64: A, fileName: 'longer-name.png' }), base[1]])).not.toBe(k);
    expect(textureSourcesKey([base[0]])).not.toBe(k);
  });
});

/**
 * The union carries two kinds since 2026-09-19 and they are identified by
 * DIFFERENT things: a project source IS its payload string, a model source is
 * an image index inside the loaded model. Neither can stand in for the other,
 * and a Map holding both must not let them collide.
 */
describe('textureSourceKey — two kinds, two namespaces', () => {
  const model = (image: number): ModelTextureSource => ({
    kind: 'model', image, fileName: `t${image}.png`, width: 4, height: 4, byteLength: 99, slot: 'baseColor',
  });
  const project = (dataUrl: string): ProjectTextureSource => ({
    kind: 'project', dataUrl, width: 1, height: 1, fileName: 'p.png', holderIds: ['n1'],
  });

  it('identifies a project source by its payload and a model one by its index', () => {
    expect(textureSourceKey(project(A))).toBe(`p:${A}`);
    expect(textureSourceKey(model(3))).toBe('m:3');
  });

  it('cannot collide across kinds — the prefix is why', () => {
    expect(textureSourceKey(project('7'))).not.toBe(textureSourceKey(model(7)));
  });

  it('merges a mixed list, project first, keeping every entry', () => {
    const merged = mergeTextureSources([project(A), project(B)], [model(0), model(1)]);
    expect(merged.map((s) => s.kind)).toEqual(['project', 'project', 'model', 'model']);
    expect(merged).toHaveLength(4);
  });

  it('a repeated model index is ONE entry, and the first record wins', () => {
    const merged = mergeTextureSources([model(2)], [{ ...model(2), fileName: 'other.png' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].fileName).toBe('t2.png');
  });

  it('never invents holderIds for a model source', () => {
    const [m] = mergeTextureSources([model(0)]);
    expect(m.kind).toBe('model');
    expect((m as unknown as Record<string, unknown>).holderIds).toBeUndefined();
  });
});
