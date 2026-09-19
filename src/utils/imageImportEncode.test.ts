/**
 * Runs the REAL `encodeImageFile` under node against a fake canvas.
 *
 * `imageImport.ts` is DOM-only, so everything else about it is pinned from
 * source. This harness supplies the four DOM pieces it touches —
 * `document.createElement('canvas')`, `createImageBitmap`, `FileReader`, and a
 * canvas whose `toBlob` produces a deterministic byte count per format — so the
 * decisions (device cap, budget halving, codec fall-through, the power-of-two
 * snap and its original) run exactly as written. Blob SIZES are a model, not a
 * codec: what is pinned is the control flow over them.
 *
 * Every global is stubbed in beforeEach and undone in afterEach, and the
 * module-scope caps probe is reset on both sides (`isolate: false`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeImageFile,
  __resetEncodeCapsForTests,
  type EncodeImageOptions,
  type EncodeImageResult,
} from './imageImport';

interface Pixels {
  alpha: boolean;
  /** Real pixel data — only the caps probe carries it. */
  data?: Uint8ClampedArray;
}

const state = {
  /** toBlob honours image/webp (false = WebKit, which answers PNG). */
  webp: true,
  /** The probe's q=1 WebP round-trips exactly (Chromium). */
  webpLossless: true,
  /** createImageBitmap refuses resize options (an old WebKit). */
  noResize: false,
  decodeCalls: [] as { name: string; opts: unknown }[],
  /** Every toBlob request, in order: which candidates were tried. */
  encodes: [] as { mime: string; quality: number | undefined; w: number; h: number }[],
  closed: 0,
};

const sources = new WeakMap<Blob, { width: number; height: number; alpha: boolean }>();
const blobPixels = new WeakMap<Blob, Pixels>();

class FakeBitmap implements Pixels {
  alpha: boolean;
  data?: Uint8ClampedArray;
  constructor(public width: number, public height: number, px: Pixels) {
    this.alpha = px.alpha;
    this.data = px.data;
  }
  close(): void {
    state.closed++;
  }
}

/** Bits per pixel of the fake encoder, by what was asked for. */
function fakeBytes(w: number, h: number, mime: string, quality: number | undefined, alpha: boolean): number {
  const px = w * h;
  if (mime === 'image/png') return 64 + Math.ceil(px * (alpha ? 4 : 3));
  if (mime === 'image/webp') return 64 + Math.ceil(px * (quality === 1 ? 1.3 : 0.35 * (quality ?? 0.8)));
  return 64 + Math.ceil(px * 0.5 * (quality ?? 0.92));
}

class FakeCanvas implements Pixels {
  width = 0;
  height = 0;
  alpha = false;
  data?: Uint8ClampedArray;
  getContext(): unknown {
    const c = this;
    return {
      clearRect() {
        c.alpha = false;
        c.data = undefined;
      },
      drawImage(src: Pixels) {
        if (src.alpha) c.alpha = true;
        if (src.data) c.data = src.data;
      },
      getImageData() {
        return { data: c.data ?? Uint8ClampedArray.of(0, 0, 0, c.alpha ? 128 : 255) };
      },
      createImageData(w: number, h: number) {
        return { data: new Uint8ClampedArray(w * h * 4) };
      },
      putImageData(img: { data: Uint8ClampedArray }) {
        c.data = new Uint8ClampedArray(img.data);
      },
    };
  }
  toBlob(cb: (b: Blob | null) => void, mime: string, quality?: number): void {
    state.encodes.push({ mime, quality, w: this.width, h: this.height });
    const type = mime === 'image/webp' && !state.webp ? 'image/png' : mime;
    const blob = new Blob([new Uint8Array(fakeBytes(this.width, this.height, type, quality, this.alpha))], { type });
    // Only a q=1 WebP from a Chromium-like encoder round-trips the probe's
    // gradient; everything else comes back perturbed.
    const exact = type === 'image/webp' && quality === 1 && state.webpLossless;
    blobPixels.set(blob, {
      alpha: this.alpha,
      data: this.data ? (exact ? this.data : this.data.map((v) => v ^ 1)) : undefined,
    });
    queueMicrotask(() => cb(blob));
  }
}

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(
      (buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      },
      () => this.onerror?.(),
    );
  }
}

async function fakeCreateImageBitmap(src: Blob, opts?: Record<string, unknown>): Promise<FakeBitmap> {
  const name = src instanceof File ? src.name : '(blob)';
  state.decodeCalls.push({ name, opts });
  const s = sources.get(src);
  if (s) {
    const rw = opts?.resizeWidth;
    const rh = opts?.resizeHeight;
    if (rw !== undefined || rh !== undefined) {
      if (state.noResize) throw new TypeError('resize options unsupported');
      return new FakeBitmap(rw as number, rh as number, { alpha: s.alpha });
    }
    return new FakeBitmap(s.width, s.height, { alpha: s.alpha });
  }
  const px = blobPixels.get(src);
  if (px) return new FakeBitmap(8, 8, px);
  throw new Error('undecodable');
}

/** A dropped file the fake decoder knows the size of. `head` lands in the
 *  file's first bytes (a WebP container flag). */
function source(name: string, width: number, height: number, alpha = false, head: number[] = []): File {
  const type = name.endsWith('.png')
    ? 'image/png'
    : name.endsWith('.webp')
      ? 'image/webp'
      : name.endsWith('.svg')
        ? 'image/svg+xml'
        : 'image/jpeg';
  const file = new File([new Uint8Array([...head, ...new Array(64).fill(0)])], name, { type });
  sources.set(file, { width, height, alpha });
  return file;
}

const ascii = (s: string) => s.split('').map((c) => c.charCodeAt(0));
const webpHead = (fourcc: string) => [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(fourcc)];

/** The comparable part of a result: the payload by its LENGTH (the bytes
 *  are zeros), everything else verbatim. */
function summarize(r: EncodeImageResult): Record<string, unknown> {
  if (!r.ok) return { ...r };
  const { dataUrl, original, ...rest } = r;
  return {
    ...rest,
    chars: dataUrl.length,
    original: original
      ? { mime: original.mime, width: original.width, height: original.height, lossless: original.lossless, chars: original.dataUrl.length }
      : undefined,
  };
}

beforeEach(() => {
  __resetEncodeCapsForTests();
  Object.assign(state, { webp: true, webpLossless: true, noResize: false, decodeCalls: [], encodes: [], closed: 0 });
  vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
  vi.stubGlobal('createImageBitmap', fakeCreateImageBitmap);
  vi.stubGlobal('FileReader', FakeFileReader);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetEncodeCapsForTests();
});

type Scenario = {
  label: string;
  file: () => File;
  ignoreLimits: boolean;
  device: number;
  mode: 'convert' | 'keep';
};

/** Drops every shipped caller makes today: four arguments, no options. */
const SCENARIOS: Scenario[] = [
  { label: 'photo 1920x1080 jpeg, device 1024', file: () => source('photo.jpg', 1920, 1080), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'normal 512 png', file: () => source('normal.png', 512, 512), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'normal 1024 png', file: () => source('normal1k.png', 1024, 1024), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'cutout 300 png alpha', file: () => source('cutout.png', 300, 300, true), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'tiny 200x100 png', file: () => source('tiny.png', 200, 100), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'big 4096 png, device 2048', file: () => source('big.png', 4096, 4096), ignoreLimits: false, device: 2048, mode: 'convert' },
  { label: 'huge 9000 png', file: () => source('huge.png', 9000, 9000), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'huge 9000 png, ignore limits', file: () => source('huge2.png', 9000, 9000), ignoreLimits: true, device: 1024, mode: 'convert' },
  { label: 'photo keep', file: () => source('photo2.jpg', 1920, 1080), ignoreLimits: false, device: 1024, mode: 'keep' },
  { label: 'lossy webp 256', file: () => source('lossy.webp', 256, 256, false, webpHead('VP8 ')), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'lossless webp 256', file: () => source('lossless.webp', 256, 256, false, webpHead('VP8L')), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'undecodable', file: () => new File([new Uint8Array(8)], 'x.png', { type: 'image/png' }), ignoreLimits: false, device: 1024, mode: 'convert' },
  { label: 'svg', file: () => source('x.svg', 10, 10), ignoreLimits: false, device: 1024, mode: 'convert' },
];

function run(sc: Scenario, opts?: EncodeImageOptions): Promise<EncodeImageResult> {
  return opts === undefined
    ? encodeImageFile(sc.file(), sc.ignoreLimits, sc.device, sc.mode)
    : encodeImageFile(sc.file(), sc.ignoreLimits, sc.device, sc.mode, opts);
}

/**
 * What these drops produced on the encoder BEFORE the options argument
 * existed (captured on the unmodified code, 2026-09-12). `chromium` is a
 * WebP-and-lossless-WebP encoder, `webkit` one that answers PNG to a WebP
 * request. A change here is a change to what every image drop stores.
 */
const GOLDEN: Record<string, Record<string, unknown>> = {
  "chromium: photo 1920x1080 jpeg, device 1024": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 1024, "height": 512, "sourceWidth": 1920, "sourceHeight": 1080, "potApplied": true, "preferLossless": false, "lossless": false, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 208079, "original": {"mime": "image/webp", "width": 1024, "height": 576, "lossless": false, "chars": 234075}},
  "chromium: normal 512 png": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 512, "height": 512, "sourceWidth": 512, "sourceHeight": 512, "potApplied": false, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 454495},
  "chromium: normal 1024 png": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 1024, "height": 1024, "sourceWidth": 1024, "sourceHeight": 1024, "potApplied": false, "preferLossless": true, "lossless": false, "budgetScaled": false, "losslessDropped": true, "budgetChars": 600000, "chars": 416047},
  "chromium: cutout 300 png alpha": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 256, "height": 256, "sourceWidth": 300, "sourceHeight": 300, "potApplied": true, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 113707, "original": {"mime": "image/webp", "width": 300, "height": 300, "lossless": true, "chars": 156111}},
  "chromium: tiny 200x100 png": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 128, "height": 64, "sourceWidth": 200, "sourceHeight": 100, "potApplied": true, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 14311, "original": {"mime": "image/webp", "width": 200, "height": 100, "lossless": true, "chars": 34775}},
  "chromium: big 4096 png, device 2048": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 1024, "height": 1024, "sourceWidth": 4096, "sourceHeight": 4096, "potApplied": false, "preferLossless": true, "lossless": false, "budgetScaled": true, "losslessDropped": true, "budgetChars": 600000, "chars": 416047},
  "chromium: huge 9000 png": {"ok": false, "reason": "pixels", "width": 9000, "height": 9000},
  "chromium: huge 9000 png, ignore limits": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 2048, "height": 2048, "sourceWidth": 9000, "sourceHeight": 9000, "potApplied": false, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 8000000, "chars": 7270239},
  "chromium: photo keep": {"ok": true, "mime": "image/jpeg", "webpAvailable": true, "width": 1024, "height": 576, "sourceWidth": 1920, "sourceHeight": 1080, "potApplied": false, "preferLossless": false, "lossless": false, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 334343},
  "chromium: lossy webp 256": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 256, "height": 256, "sourceWidth": 256, "sourceHeight": 256, "potApplied": false, "preferLossless": false, "lossless": false, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 26107},
  "chromium: lossless webp 256": {"ok": true, "mime": "image/webp", "webpAvailable": true, "width": 256, "height": 256, "sourceWidth": 256, "sourceHeight": 256, "potApplied": false, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 113707},
  "chromium: undecodable": {"ok": false, "reason": "load"},
  "chromium: svg": {"ok": false, "reason": "svg"},
  "webkit: photo 1920x1080 jpeg, device 1024": {"ok": true, "mime": "image/jpeg", "webpAvailable": false, "width": 1024, "height": 512, "sourceWidth": 1920, "sourceHeight": 1080, "potApplied": true, "preferLossless": false, "lossless": false, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 297207, "original": {"mime": "image/jpeg", "width": 1024, "height": 576, "lossless": false, "chars": 334343}},
  "webkit: normal 512 png": {"ok": true, "mime": "image/jpeg", "webpAvailable": false, "width": 512, "height": 512, "sourceWidth": 512, "sourceHeight": 512, "potApplied": false, "preferLossless": true, "lossless": false, "budgetScaled": false, "losslessDropped": true, "budgetChars": 600000, "chars": 148659},
  "webkit: normal 1024 png": {"ok": true, "mime": "image/jpeg", "webpAvailable": false, "width": 1024, "height": 1024, "sourceWidth": 1024, "sourceHeight": 1024, "potApplied": false, "preferLossless": true, "lossless": false, "budgetScaled": false, "losslessDropped": true, "budgetChars": 600000, "chars": 594303},
  "webkit: cutout 300 png alpha": {"ok": true, "mime": "image/png", "webpAvailable": false, "width": 256, "height": 256, "sourceWidth": 300, "sourceHeight": 300, "potApplied": true, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 349634, "original": {"mime": "image/png", "width": 300, "height": 300, "lossless": true, "chars": 480110}},
  "webkit: tiny 200x100 png": {"ok": true, "mime": "image/png", "webpAvailable": false, "width": 128, "height": 64, "sourceWidth": 200, "sourceHeight": 100, "potApplied": true, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 32878, "original": {"mime": "image/png", "width": 200, "height": 100, "lossless": true, "chars": 80110}},
  "webkit: big 4096 png, device 2048": {"ok": true, "mime": "image/jpeg", "webpAvailable": false, "width": 1024, "height": 1024, "sourceWidth": 4096, "sourceHeight": 4096, "potApplied": false, "preferLossless": true, "lossless": false, "budgetScaled": true, "losslessDropped": true, "budgetChars": 600000, "chars": 594303},
  "webkit: huge 9000 png": {"ok": false, "reason": "pixels", "width": 9000, "height": 9000},
  "webkit: huge 9000 png, ignore limits": {"ok": true, "mime": "image/jpeg", "webpAvailable": false, "width": 2048, "height": 2048, "sourceWidth": 9000, "sourceHeight": 9000, "potApplied": false, "preferLossless": true, "lossless": false, "budgetScaled": false, "losslessDropped": true, "budgetChars": 8000000, "chars": 2376883},
  "webkit: photo keep": {"ok": true, "mime": "image/jpeg", "webpAvailable": false, "width": 1024, "height": 576, "sourceWidth": 1920, "sourceHeight": 1080, "potApplied": false, "preferLossless": false, "lossless": false, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 334343},
  "webkit: lossy webp 256": {"ok": true, "mime": "image/jpeg", "webpAvailable": false, "width": 256, "height": 256, "sourceWidth": 256, "sourceHeight": 256, "potApplied": false, "preferLossless": false, "lossless": false, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 37247},
  "webkit: lossless webp 256": {"ok": true, "mime": "image/png", "webpAvailable": false, "width": 256, "height": 256, "sourceWidth": 256, "sourceHeight": 256, "potApplied": false, "preferLossless": true, "lossless": true, "budgetScaled": false, "losslessDropped": false, "budgetChars": 600000, "chars": 262254},
  "webkit: undecodable": {"ok": false, "reason": "load"},
  "webkit: svg": {"ok": false, "reason": "svg"},
};

const ENGINES = [
  ['chromium', () => {}],
  ['webkit', () => { state.webp = false; }],
] as const;

/** The result minus the one field the options added. */
function comparable(r: EncodeImageResult): Record<string, unknown> {
  const out = summarize(r);
  delete out.decodeDownscaled;
  if (out.original === undefined) delete out.original;
  return out;
}

describe('encodeImageFile: every existing drop is byte-identical', () => {
  for (const [engine, setup] of ENGINES) {
    for (const sc of SCENARIOS) {
      it(`${engine}: ${sc.label} matches the pre-options golden`, async () => {
        setup();
        const r = await run(sc);
        expect(comparable(r)).toEqual(GOLDEN[`${engine}: ${sc.label}`]);
        if (r.ok) expect(r.decodeDownscaled).toBe(false);
      });
    }
  }

  // Junk in every option field reads as "absent", so it must change nothing
  // either — the options are read strictly.
  const JUNK: unknown[] = [
    {},
    { maxDim: undefined, preferLossless: undefined, losslessOnly: undefined, allowHugeSource: undefined },
    { maxDim: NaN },
    { maxDim: Infinity },
    { maxDim: 0 },
    { maxDim: -5 },
    { maxDim: '512' },
    { preferLossless: 'yes' },
    { preferLossless: 1 },
    { losslessOnly: 1 },
    { losslessOnly: 'true' },
    { allowHugeSource: 'true' },
    { allowHugeSource: true },
    { allowHugeSource: true, sourceDims: { width: 1920, height: 1080 } },
    { allowHugeSource: true, sourceDims: { width: NaN, height: 5 } },
  ];
  for (const [engine, setup] of ENGINES) {
    it(`${engine}: absent or junk options change nothing`, async () => {
      setup();
      for (const sc of SCENARIOS) {
        if (sc.label.startsWith('huge')) continue; // a size lie on a huge file is the next suite's business
        for (const opts of JUNK) {
          const r = await run(sc, opts as EncodeImageOptions);
          expect(comparable(r), `${sc.label} ${JSON.stringify(opts)}`).toEqual(GOLDEN[`${engine}: ${sc.label}`]);
        }
      }
    }, 60_000);
  }
});

describe('encodeImageFile: maxDim (the slot size)', () => {
  it('caps the long side on top of the device cap', async () => {
    const r = await encodeImageFile(source('p.jpg', 1920, 1080), false, 1024, 'convert', { maxDim: 512 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(512);
    expect(Math.max(r.original!.width, r.original!.height)).toBeLessThanOrEqual(512);
  });

  it('is not lifted by ignore-limits, which lifts budgets only', async () => {
    const r = await encodeImageFile(source('p.jpg', 4096, 4096), true, 1024, 'convert', { maxDim: 512 });
    expect(r.ok && Math.max(r.width, r.height)).toBe(512);
  });

  it('never raises the device cap', async () => {
    const r = await encodeImageFile(source('p.jpg', 4096, 4096), false, 256, 'convert', { maxDim: 1024 });
    expect(r.ok && Math.max(r.width, r.height)).toBe(256);
  });
});

describe('encodeImageFile: losslessOnly (data maps from a lossless source)', () => {
  for (const [engine, setup] of ENGINES) {
    it(`${engine}: never stores lossy — it halves instead`, async () => {
      setup();
      // A 1024² PNG that fits NO lossless candidate at full size: the drop
      // (golden) stores it lossy; losslessOnly halves it and stays exact.
      const r = await encodeImageFile(source('n.png', 1024, 1024), false, 1024, 'convert', { losslessOnly: true, maxDim: 1024 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.lossless).toBe(true);
      expect(r.losslessDropped).toBe(false);
      expect(r.budgetScaled).toBe(true);
      expect(r.width).toBeLessThan(1024);
      expect(state.encodes.every((e) => e.mime === 'image/png' || (e.mime === 'image/webp' && e.quality === 1))).toBe(true);
    });

    it(`${engine}: implies preferLossless, whatever the file is called`, async () => {
      setup();
      const r = await encodeImageFile(source('orm.jpg', 256, 256), false, 1024, 'convert', { losslessOnly: true, preferLossless: false });
      expect(r.ok && r.lossless).toBe(true);
      expect(r.ok && r.preferLossless).toBe(true);
    });
  }

  it('keeps an alpha source lossless too (never a JPEG)', async () => {
    const r = await encodeImageFile(source('a.png', 700, 700, true), false, 1024, 'convert', { losslessOnly: true });
    expect(r.ok && r.lossless).toBe(true);
    expect(state.encodes.some((e) => e.mime === 'image/jpeg')).toBe(false);
  });
});

describe('encodeImageFile: preferLossless replaces the file-name sniff', () => {
  it('false stores a PNG lossy from the first candidate on (a base colour)', async () => {
    const r = await encodeImageFile(source('base.png', 512, 512), false, 1024, 'convert', { preferLossless: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preferLossless).toBe(false);
    expect(r.lossless).toBe(false);
    expect(r.losslessDropped).toBe(false);
    expect(state.encodes[state.encodes.length - (r.potApplied ? 2 : 1)]).toMatchObject({ mime: 'image/webp', quality: 0.85 });
    expect(state.encodes.some((e) => e.w === 512 && e.mime === 'image/webp' && e.quality === 1)).toBe(false);
  });

  it('true tries lossless first on a JPEG, and still falls through when nothing lossless fits', async () => {
    const r = await encodeImageFile(source('n.jpg', 1024, 1024), false, 1024, 'convert', { preferLossless: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preferLossless).toBe(true);
    const firstAtFull = state.encodes.find((e) => e.w === 1024 && e.mime !== undefined && e.quality !== undefined);
    expect(state.encodes.find((e) => e.w === 1024)).toMatchObject({ mime: 'image/webp', quality: 1 });
    expect(firstAtFull).toBeDefined();
    expect(r.lossless).toBe(false);
    expect(r.losslessDropped).toBe(true);
  });
});

describe('encodeImageFile: allowHugeSource (N10, the decode downscale)', () => {
  const RESIZE = { resizeQuality: 'high', imageOrientation: 'from-image' };

  it('decodes a source past the pixel guard straight to its capped size', async () => {
    const r = await encodeImageFile(source('scan.png', 9000, 9000), false, 1024, 'convert', {
      allowHugeSource: true,
      sourceDims: { width: 9000, height: 9000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decodeDownscaled).toBe(true);
    expect([r.sourceWidth, r.sourceHeight]).toEqual([9000, 9000]);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1024);
    const calls = state.decodeCalls.filter((c) => c.name === 'scan.png');
    expect(calls).toEqual([{ name: 'scan.png', opts: { resizeWidth: 1024, resizeHeight: 1024, ...RESIZE } }]);
    expect(state.closed).toBeGreaterThanOrEqual(1);
  });

  it('keeps the aspect ratio and honours the slot cap', async () => {
    await encodeImageFile(source('wide.png', 12000, 6000), false, 1024, 'convert', {
      allowHugeSource: true,
      sourceDims: { width: 12000, height: 6000 },
      maxDim: 512,
    });
    expect(state.decodeCalls.find((c) => c.name === 'wide.png')?.opts).toEqual({ resizeWidth: 512, resizeHeight: 256, ...RESIZE });
  });

  it('still downscales at decode under ignore-limits (memory, not a budget)', async () => {
    const r = await encodeImageFile(source('big8k.png', 8193, 8193), true, 2048, 'convert', {
      allowHugeSource: true,
      sourceDims: { width: 8193, height: 8193 },
    });
    expect(r.ok && r.decodeDownscaled).toBe(true);
    expect(state.decodeCalls.find((c) => c.name === 'big8k.png')?.opts).toMatchObject({ resizeWidth: 2048, resizeHeight: 2048 });
  });

  it('refuses as `pixels`, with the header size, when the engine has no resize options', async () => {
    state.noResize = true;
    const r = await encodeImageFile(source('old.png', 9000, 9000), false, 1024, 'convert', {
      allowHugeSource: true,
      sourceDims: { width: 9000, height: 9000 },
    });
    expect(r).toEqual({ ok: false, reason: 'pixels', width: 9000, height: 9000 });
    // No fallback to a full-size decode: that is what the path exists to avoid.
    expect(state.decodeCalls.filter((c) => c.name === 'old.png')).toHaveLength(1);
  });

  it('needs the header size: without it, or with junk, the pixel guard still refuses', async () => {
    for (const sourceDims of [undefined, { width: 0, height: 9000 }, { width: -1, height: 9000 }, { width: 1.5, height: 9e7 }, { width: '9000', height: 9000 }, { width: 1e20, height: 1e20 }]) {
      const r = await encodeImageFile(source('h.png', 9000, 9000), false, 1024, 'convert', {
        allowHugeSource: true,
        sourceDims: sourceDims as { width: number; height: number } | undefined,
      });
      expect(r, JSON.stringify(sourceDims)).toEqual({ ok: false, reason: 'pixels', width: 9000, height: 9000 });
    }
  });

  it('a header that UNDER-states a huge file takes the ordinary path, and its guard', async () => {
    const r = await encodeImageFile(source('liar.png', 9000, 9000), false, 1024, 'convert', {
      allowHugeSource: true,
      sourceDims: { width: 1000, height: 1000 },
    });
    expect(r).toEqual({ ok: false, reason: 'pixels', width: 9000, height: 9000 });
  });

  it('is never on without the flag, whatever sourceDims says', async () => {
    const r = await encodeImageFile(source('noflag.png', 9000, 9000), false, 1024, 'convert', {
      sourceDims: { width: 9000, height: 9000 },
    });
    expect(r).toEqual({ ok: false, reason: 'pixels', width: 9000, height: 9000 });
  });
});
