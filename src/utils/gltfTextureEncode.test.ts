/**
 * The GLB import's texture encoder loop (Phase 5 Step 8), driven against the
 * fake encoder: what it asks the encoder for per slot, the order, the project
 * budget's halving retry and skip, the abort, the outcomes and N10.
 */
import { describe, it, expect } from 'vitest';
import { encodeGltfImages, BUDGET_RETRIES } from './gltfTextureEncode';
import { encodeRequests } from './gltfImportPlan';
import { aiGlb, blenderGlb, fakeEncoder, fakeStash, hugeTextureGlb, readOk, scanGlb, type FakeEncodeCall } from '@/engine/gltfImportFixtures';

function run(bytes: Uint8Array, over: Partial<Parameters<typeof encodeGltfImages>[2]> = {}, materials?: number[]) {
  const m = readOk(bytes);
  const calls: FakeEncodeCall[] = [];
  const { requests } = encodeRequests(m, materials ?? m.materials.map((x) => x.index));
  const p = encodeGltfImages(m, requests, {
    modelName: 'model.glb',
    maxDim: null,
    deviceMaxDim: 2048,
    ignoreLimits: false,
    budgetChars: Infinity,
    encode: fakeEncoder(calls),
    stash: fakeStash(),
    ...over,
  });
  return { m, calls, result: p };
}

describe('what the encoder is asked', () => {
  it('one call per request, in order, with the slot class and the header size', async () => {
    const { calls, result } = run(blenderGlb());
    const r = await result;
    expect(calls.map((c) => c.name)).toEqual(['BaseColor.png', 'ORM.png', 'Normal.png']);
    expect(calls[0]).toMatchObject({ maxDim: 1024, preferLossless: false, losslessOnly: false, allowHugeSource: true, sourceDims: { width: 4, height: 4 } });
    expect(calls[1]).toMatchObject({ maxDim: 512, preferLossless: true, losslessOnly: true, sourceDims: { width: 4, height: 2 } });
    expect(calls[2]).toMatchObject({ maxDim: 512, preferLossless: true, losslessOnly: true });
    expect(calls.every((c) => c.ignoreLimits === false && c.deviceMaxDim === 2048)).toBe(true);
    expect(r.aborted).toBe(false);
    expect([...r.encoded.keys()]).toEqual([0, 1, 2]);
    expect(r.outcomes.map((o) => o.status)).toEqual(['kept', 'kept', 'kept']);
    expect(r.usedChars).toBe([...r.encoded.values()].reduce((n, e) => n + e.payload.dataUrl.length, 0));
  });

  it('a JPEG data source is asked lossy; the import size caps below the slot', async () => {
    const { calls: c2, result } = run(scanGlb(), { maxDim: 256 });
    await result;
    expect(c2).toHaveLength(5);
    const normal = c2.find((c) => c.name === 'Body_normal.png')!;
    expect(normal).toMatchObject({ maxDim: 256, preferLossless: true, losslessOnly: true });
    const diffuse = c2.find((c) => c.name === 'Body_diffuse.jpg')!;
    expect(diffuse).toMatchObject({ maxDim: 256, preferLossless: false, losslessOnly: false, sourceDims: { width: 1920, height: 1080 } });
  });

  it('losslessOnly data maps are never reported lossy: every lossless request is lossless-ONLY', async () => {
    // There is no "lossy" outcome: the slot table asks preferLossless only
    // together with losslessOnly, so the encoder can never drop losslessness.
    for (const bytes of [blenderGlb(), scanGlb(), aiGlb()]) {
      const { calls, result } = run(bytes);
      const r = await result;
      expect(calls.every((c) => c.preferLossless === c.losslessOnly)).toBe(true);
      expect(r.outcomes.every((o) => o.status === 'kept' || o.status === 'downscaled' || o.status === 'skipped')).toBe(true);
    }
  });
});

describe('downscales and their reasons', () => {
  it('the slot, the import size and the device each explain a shrink', async () => {
    const slot = await run(scanGlb()).result;
    const body = slot.outcomes.find((o) => o.name === 'Body_diffuse.jpg')!;
    expect(body).toMatchObject({ status: 'downscaled', width: 1024, height: 576, reason: 'slot' });

    const res = await run(scanGlb(), { maxDim: 512 }).result;
    expect(res.outcomes.find((o) => o.name === 'Body_diffuse.jpg')).toMatchObject({ status: 'downscaled', width: 512, reason: 'import-res' });

    const dev = await run(scanGlb(), { deviceMaxDim: 256 }).result;
    expect(dev.outcomes.find((o) => o.name === 'Body_diffuse.jpg')).toMatchObject({ status: 'downscaled', width: 256, reason: 'device' });
  });

  it('a source past the 64 MP guard is decoded downscaled and counted for N10', async () => {
    const r = await run(hugeTextureGlb()).result;
    expect(r.decodeDownscaled).toEqual({ count: 1, maxSide: 1024 });
    expect(r.outcomes[0]).toMatchObject({ status: 'downscaled', width: 1024, height: 1024, reason: 'slot' });
  });
});

describe('the project budget', () => {
  it('halves the slot size until the encode fits, and reports the shrink as budget', async () => {
    const m = readOk(scanGlb());
    const { requests } = encodeRequests(m, [0]);
    const calls: FakeEncodeCall[] = [];
    // Lossy at 4 bytes per pixel: 1024×576 → ~3.1M chars, over a 1M budget;
    // 512×288 → ~0.79M fits.
    const r = await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: 1_000_000,
      encode: fakeEncoder(calls, { lossyBytesPerPixel: 4, losslessBytesPerPixel: 0.001 }),
      stash: fakeStash(),
    });
    const diffuseCalls = calls.filter((c) => c.name === 'Body_diffuse.jpg').map((c) => c.maxDim);
    expect(diffuseCalls).toEqual([1024, 512]);
    expect(r.outcomes[0]).toMatchObject({ status: 'downscaled', width: 512, height: 288, reason: 'budget' });
    expect(r.usedChars).toBeLessThanOrEqual(1_000_000);
  });

  it('skips as budget when the smallest retry still does not fit, and the next image still runs', async () => {
    const m = readOk(scanGlb());
    const { requests } = encodeRequests(m, [0]);
    const calls: FakeEncodeCall[] = [];
    const r = await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: 10,
      encode: fakeEncoder(calls),
      stash: fakeStash(),
    });
    const diffuseCalls = calls.filter((c) => c.name === 'Body_diffuse.jpg').map((c) => c.maxDim);
    expect(diffuseCalls).toEqual([1024, 512, 256, 128]);
    expect(diffuseCalls.length).toBeLessThanOrEqual(BUDGET_RETRIES + 1);
    expect(r.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r.outcomes.every((o) => o.status === 'skipped' && o.reason === 'budget')).toBe(true);
    expect(r.encoded.size).toBe(0);
    expect(r.usedChars).toBe(0);
  });

  it("the encoder's own per-image halving is the per-image cap, never the project budget", async () => {
    // Nowhere near the project budget (Infinity): only the encoder halved,
    // for its own per-image cap.
    const m = readOk(blenderGlb());
    const { requests } = encodeRequests(m, [0]);
    const base = fakeEncoder([]);
    const r = await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      encode: async (...a) => {
        const e = await base(...a);
        return e.ok ? { ...e, width: Math.max(1, e.width >> 1), height: Math.max(1, e.height >> 1), budgetScaled: true } : e;
      },
      stash: fakeStash(),
    });
    expect(r.outcomes[0]).toMatchObject({ name: 'BaseColor.png', status: 'downscaled', width: 2, height: 2, reason: 'image-cap' });
    expect(r.outcomes.some((o) => o.status === 'downscaled' && o.reason === 'budget')).toBe(false);
  });

  it('ignore-limits lifts the budget and passes ignoreLimits to the encoder', async () => {
    const calls: FakeEncodeCall[] = [];
    const m = readOk(scanGlb());
    const { requests } = encodeRequests(m, [0]);
    const r = await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: true,
      budgetChars: 10,
      encode: fakeEncoder(calls),
      stash: fakeStash(),
    });
    expect(calls.every((c) => c.ignoreLimits)).toBe(true);
    expect(r.encoded.size).toBe(3);
  });
});

describe('failures and the abort', () => {
  it('an encoder refusal is a skipped outcome: too-large reads as the per-image cap, the rest as decode', async () => {
    const m = readOk(scanGlb());
    const { requests } = encodeRequests(m, [0]);
    const r = await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      encode: fakeEncoder([], { refuse: { 'Body_diffuse.jpg': 'too-large', 'Body_normal.png': 'load' } }),
      stash: fakeStash(),
    });
    // Requests follow the reader's slot order: base colour, metallicRoughness, normal.
    expect(r.outcomes).toEqual([
      { image: 0, name: 'Body_diffuse.jpg', status: 'skipped', reason: 'image-cap' },
      { image: 2, name: 'Body_orm.png', status: 'kept' },
      { image: 1, name: 'Body_normal.png', status: 'skipped', reason: 'decode' },
    ]);
  });

  it('an encoder that throws is a decode skip, never an exception', async () => {
    const m = readOk(aiGlb());
    const { requests } = encodeRequests(m, [0]);
    const r = await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      encode: async () => { throw new Error('boom'); },
      stash: fakeStash(),
    });
    expect(r.outcomes.every((o) => o.status === 'skipped' && o.reason === 'decode')).toBe(true);
  });

  it('an abort between images stops the loop and says so', async () => {
    const m = readOk(scanGlb());
    const { requests } = encodeRequests(m, [0, 1, 2]);
    const ac = new AbortController();
    let n = 0;
    const r = await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      signal: ac.signal,
      // The (0, total) report before the loop is not an image: abort after
      // the SECOND image's report.
      onProgress: (done) => { n++; if (done === 2) ac.abort(); },
      encode: fakeEncoder([]),
      stash: fakeStash(),
    });
    expect(r.aborted).toBe(true);
    expect(r.outcomes).toHaveLength(2);
    expect(n).toBe(3);
  });

  it('reports (0, total) before the first encode, then once per request', async () => {
    const m = readOk(scanGlb());
    const { requests } = encodeRequests(m, [0, 1, 2]);
    const seen: [number, number][] = [];
    await encodeGltfImages(m, requests, {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      onProgress: (d, t) => seen.push([d, t]),
      encode: fakeEncoder([]),
      stash: fakeStash(),
    });
    // The first report carries the total, so the dialog never reads "0 of 0".
    expect(seen[0]).toEqual([0, 5]);
    expect(seen).toEqual([[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  });

  it('a request naming an image the reader did not hand out is a decode skip', async () => {
    const m = readOk(scanGlb());
    const r = await encodeGltfImages(m, [{ image: 99, slot: 'baseColor' }, { image: -1, slot: 'normal' }], {
      modelName: 'm.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      encode: fakeEncoder([]),
      stash: fakeStash(),
    });
    expect(r.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped']);
  });
});
