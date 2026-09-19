import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  collectImageAssets,
  imageAssetCounters,
  imageAssetFor,
  resetImageAssetCounters,
} from './imageAssets';
import { graphToCode } from './graphToCode';
import { fnv1a32Hex } from '@/utils/payloadDigest';
import { makeNode, makeEdge } from '../test-utils';

/**
 * GLB Phase 6, S2: `imageAssetFor` stops re-running the FNV round per node per
 * pass. The counters are test hooks inside imageAssets.ts; the reset empties
 * both memos, so each count below starts cold even though `isolate: false`
 * shares this module with every other file in the worker.
 */

const B64 = btoa('memo test payload'); // not used by any other suite
const RAW = `data:image/png;base64,${B64}`;
const valid = { imageB64: RAW, width: 4, height: 4, fileName: 'm.png', colorSpace: 'color' };

beforeEach(() => resetImageAssetCounters());
afterAll(() => resetImageAssetCounters());

describe('imageAssets digest memo', () => {
  it('imageAssetFor twice on the same values: one hash, one decode', () => {
    const a = imageAssetFor('img1', valid);
    const b = imageAssetFor('img1', valid);
    expect(a).toEqual(b);
    expect(imageAssetCounters()).toEqual({ digests: 1, decodes: 1 });
  });

  it('collectImageAssets over 3 nodes sharing one payload string: one hash, one decode', () => {
    // Phase 2 shares ONE payload string between nodes; the three values
    // objects here carry the same string, as a duplicated node's do.
    const nodes = [
      makeNode('imgA', 'imageNode', { ...valid }),
      makeNode('imgB', 'imageNode', { ...valid }),
      makeNode('imgC', 'imageNode', { ...valid }),
    ];
    const assets = collectImageAssets(nodes);
    expect(assets.size).toBe(3); // one entry per node key
    expect(imageAssetCounters()).toEqual({ digests: 1, decodes: 1 });
  });

  it('placeholders are byte-identical to fnv1a32Hex(raw), on a miss and on a hit', () => {
    const expected = `img1-${fnv1a32Hex(RAW)}`;
    const miss = imageAssetFor('img1', valid);
    const hit = imageAssetFor('img1', valid);
    expect(miss!.key).toBe(expected);
    expect(hit!.key).toBe(expected);
    expect(hit!.placeholder).toBe(`fs-asset:${expected}`);
  });

  it('a second graph→code pass over an unchanged graph re-hashes nothing', () => {
    const nodes = [makeNode('img1', 'imageNode', valid), makeNode('out1', 'output')];
    const edges = [makeEdge('img1', 'out', 'out1', 'color')];
    const first = graphToCode(nodes, edges).code;
    const afterFirst = imageAssetCounters();
    expect(afterFirst.decodes).toBe(1);
    expect(afterFirst.digests).toBe(1);
    const second = graphToCode(nodes, edges).code;
    expect(second).toBe(first);
    expect(imageAssetCounters()).toEqual(afterFirst);
  });

  it('a changed payload is hashed and decoded afresh', () => {
    imageAssetFor('img1', valid);
    const other = `data:image/png;base64,${btoa('another memo payload')}`;
    const b = imageAssetFor('img1', { ...valid, imageB64: other });
    expect(b!.key).toBe(`img1-${fnv1a32Hex(other)}`);
    expect(imageAssetCounters()).toEqual({ digests: 2, decodes: 2 });
  });

  it('an invalid payload is hashed once and its null decode is memoized too', () => {
    const bad = { ...valid, width: 0 };
    expect(imageAssetFor('img1', bad)).toBeNull();
    expect(imageAssetFor('img1', bad)).toBeNull();
    expect(imageAssetCounters()).toEqual({ digests: 1, decodes: 1 });
  });
});
