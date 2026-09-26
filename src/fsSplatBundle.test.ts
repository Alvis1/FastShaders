/**
 * The Gaussian-splat runtime, `public/js/fs-splat-0.1.js`, as it SHIPS.
 *
 * The runtime is three r186's GaussianSplat addon and its four loaders, bundled
 * by the submodule's build/build-splat.mjs against the PAGE'S three (r184 here,
 * plus an `unpackUnorm4x8` polyfill). The addon sources cannot be imported into
 * vitest directly — r184 exports no `unpackUnorm4x8`, so the ESM import fails —
 * which is why everything below goes through the BUILT IIFE, evaluated in `vm`
 * with THREE = the real three/webgpu namespace (the shaderloader harness
 * pattern). The file is read inside each test, never at module top level: a
 * copy that stops being vendored then skips instead of throwing at import.
 *
 * Covered: the private addon names loader 0.8's splat wrapper reads (a three
 * re-copy that renames one must fail here, not as an unedited splat in a
 * browser); the stubs that keep fflate's gunzip and zstddec's data: fetch out of
 * the shipped text; the ONE parse chokepoint `parseBytes` and every refusal it
 * makes before allocating; its `.ply` gate held to the trusted sniff's verdict
 * over the shared corpus (SPLAT_SNIFF_CASES in src/test-utils.ts, read inside
 * the tests); the SH drop; `normalize`; the `splat-model`
 * component's load / events / stale-generation / dispose paths.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three/webgpu';
import { SPLAT_RUNTIME_FILE } from '@/engine/tslToShaderModule';
import * as SPLAT_LIMITS from '@/utils/splatLimits';
import { sniffSplat } from '@/utils/splatSniff';
import { SPLAT_SNIFF_CASES, splatPly } from '@/test-utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'public/js', SPLAT_RUNTIME_FILE);
const available = existsSync(RUNTIME);
const runtimeText = () => readFileSync(RUNTIME, 'utf8');

// The page's typed arrays. In a browser the runtime and three share ONE realm;
// handing the sandbox the test realm's constructors keeps it that way, so the
// addon's `instanceof Uint32Array` checks see the arrays a test builds.
const TYPED = {
  ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
  Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
};

interface RuntimeOptions {
  /** The page's THREE; null = none on the page. Default: three/webgpu. */
  three?: unknown;
  AFRAME?: unknown;
  /** false = the sandbox keeps its OWN typed arrays (a second realm). */
  shareTypedArrays?: boolean;
  warn?: (...a: unknown[]) => void;
}

function evalRuntime(opts: RuntimeOptions = {}) {
  const sandbox: Record<string, unknown> = {
    console: { log() {}, error() {}, warn: opts.warn ?? (() => {}) },
    Blob,
    DecompressionStream,
    TextDecoder,
    ...(opts.shareTypedArrays === false ? {} : TYPED),
  };
  if (opts.three !== null) sandbox.THREE = opts.three ?? THREE;
  if (opts.AFRAME) sandbox.AFRAME = opts.AFRAME;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(runtimeText(), sandbox, { filename: RUNTIME });
  return { sandbox, FS: sandbox.FastShadersSplat as Any };
}

/** The sentence a promise rejects with (from any realm). */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { message?: unknown }).message);
  }
  throw new Error('expected a rejection');
}

function exactBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

// --- fixtures ---------------------------------------------------------------

/** `n` rows of a `.splat`: a line along x, scale 0.1, opaque grey, identity rotation. */
function splatRows(n: number): ArrayBuffer {
  const buf = new ArrayBuffer(n * 32);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    dv.setFloat32(o, i, true);
    dv.setFloat32(o + 4, 1, true);
    dv.setFloat32(o + 8, -2, true);
    dv.setFloat32(o + 12, 0.1, true);
    dv.setFloat32(o + 16, 0.1, true);
    dv.setFloat32(o + 20, 0.1, true);
    u8.set([200, 200, 200, 255, 255, 128, 128, 128], o + 24);
  }
  return buf;
}

const PLY_SPLAT_PROPS = [
  'x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
];

/** A binary little-endian PLY: one float per property per vertex, `extra` header lines verbatim. */
function plyFile(props: string[], count: number, extra: string[] = [], rows?: number[][]): ArrayBuffer {
  const header = [
    'ply', 'format binary_little_endian 1.0', `element vertex ${count}`,
    ...props.map((p) => `property float ${p}`), ...extra, 'end_header', '',
  ].join('\n');
  const head = new TextEncoder().encode(header);
  const body = rows ? new Float32Array(rows.flat()) : new Float32Array(count * props.length);
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(body.buffer), head.length);
  return out.buffer;
}

/** The DECODED bytes of an SPZ v2: `count` splats with SH degree `sh` (0..3). */
function spzRaw(count: number, sh: number, version = 2): Uint8Array {
  const vectors = [0, 3, 8, 15, 24][sh];
  const size = 16 + count * (9 + 1 + 3 + 3 + (version === 3 ? 4 : 3) + vectors * 3);
  const u8 = new Uint8Array(size);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, 0x5053474e, true); // 'NGSP'
  dv.setUint32(4, version, true);
  dv.setUint32(8, count, true);
  u8[12] = sh;
  u8[13] = 12; // fractional bits
  let o = 16;
  for (let i = 0; i < count; i++) { u8[o + i * 9] = i * 16; } // x, 24-bit fixed point
  o += count * 9;
  u8.fill(255, o, o + count); // alpha
  o += count;
  u8.fill(128, o, o + count * 3); // colour
  o += count * 3;
  u8.fill(100, o, o + count * 3); // scale → exp(100/16 - 10)
  o += count * 3;
  u8.fill(128, o, o + count * 3); // rotation xyz ~ 0 → identity
  o += count * 3;
  u8.fill(140, o, size); // SH coefficients
  return u8;
}

function gz(u8: Uint8Array): ArrayBuffer {
  return exactBuffer(gzipSync(u8));
}

// ---------------------------------------------------------------------------

describe.skipIf(!available)('fs-splat-0.1.js — the shipped text', () => {
  it('keeps every private addon name loader 0.8 reads, and the names pages look for', () => {
    const text = runtimeText();
    for (const name of [
      '_buffers', 'centerRead', '_sort', 'orderRead', 'isGaussianSplat', 'splatGeometry',
      'updateSphericalHarmonics', 'updateSort', 'autoSort', 'vSplatColor', 'parseRawSPZ',
      'fs_unpackUnorm4x8', 'FastShadersSplat', 'splat-model',
    ]) {
      expect(text, name).toContain(name);
    }
  });

  it('ships neither the gzip stub call nor the zstd data: fetch, and imports nothing', () => {
    const text = runtimeText();
    expect(text).not.toContain('fetch("data:');
    expect(text).not.toContain("fetch('data:");
    expect(text).not.toContain('gunzipSync(');
    // An IIFE cannot import: a leaked specifier would be an unresolvable require.
    expect(text).not.toMatch(/\brequire\(["']/);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/from\s*["']three/);
  });

  it('is pure ASCII and says what it bundles, under which licence', () => {
    const text = runtimeText();
    expect(/^[\x00-\x7f]*$/.test(text)).toBe(true);
    expect(text.startsWith('/*! fs-splat 0.1.0')).toBe(true);
    expect(text).toContain('three.js r186');
    expect(text).toContain('MIT License');
  });
});

describe.skipIf(!available)('fs-splat-0.1.js — evaluated against three/webgpu (r184)', () => {
  it('installs the frozen FastShadersSplat global with the contract keys', () => {
    const { FS } = evalRuntime();
    expect(FS).toBeTruthy();
    for (const k of [
      'version', 'addonRevision', 'GaussianSplat', 'CountingSort', 'createGaussianSplatGeometry',
      'getSphericalHarmonicsDegree', 'loaders', 'parseBytes', 'normalize', 'LIMITS',
    ]) {
      expect(k in FS, k).toBe(true);
    }
    expect(FS.version).toBe('0.1.0');
    expect(FS.addonRevision).toBe('186');
    expect(Object.isFrozen(FS)).toBe(true);
    expect(Object.isFrozen(FS.loaders)).toBe(true);
    expect(Object.keys(FS.loaders).sort()).toEqual(['ksplat', 'ply', 'splat', 'spz']);
    expect(typeof FS.GaussianSplat).toBe('function');
    expect(typeof FS.CountingSort).toBe('function');
  });

  it('LIMITS are the literals of src/utils/splatLimits.ts', () => {
    const { FS } = evalRuntime();
    expect({ ...FS.LIMITS }).toEqual({ ...SPLAT_LIMITS });
    expect(Object.isFrozen(FS.LIMITS)).toBe(true);
  });

  it('throws the named error on a page without the A-Frame bundle', () => {
    let message = '';
    try {
      evalRuntime({ three: null });
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toBe('FastShadersSplat: three/webgpu global not found - load the A-Frame bundle first');
  });

  it('polyfills unpackUnorm4x8 only because r184 lacks it', () => {
    // The day the bundle moves to r186 the virtual three/tsl module passes the
    // page's TSL through untouched; this pins today's premise.
    expect('unpackUnorm4x8' in THREE.TSL).toBe(false);
    expect(runtimeText()).toMatch(/unpackUnorm4x8\?/);
  });

  it('a GaussianSplat constructs from createGaussianSplatGeometry, with the fields the wrapper reads', () => {
    const { FS } = evalRuntime();
    const n = 4;
    const centers = new Float32Array(n * 3).map((_, i) => (i % 3) * 0.1);
    const cov = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { cov[i * 6] = 0.01; cov[i * 6 + 3] = 0.01; cov[i * 6 + 5] = 0.01; }
    const colors = new Uint8ClampedArray(n * 4).fill(200);
    const splat = new FS.GaussianSplat(FS.createGaussianSplatGeometry(centers, cov, colors), { autoSort: false });
    expect(splat.isGaussianSplat).toBe(true);
    expect(splat.isMesh).toBe(true);
    expect(splat.geometry.isInstancedBufferGeometry).toBe(true);
    expect(splat.geometry.instanceCount).toBe(n);
    expect(splat._buffers.centerRead.isNode).toBe(true);
    expect(splat._sort.orderRead.isNode).toBe(true);
    expect(splat.material.vertexNode.isNode).toBe(true);
    expect(splat.material.colorNode.isNode).toBe(true);
    // Degree 0: no SH vertex variant, no SH compute pass.
    expect(splat._sphericalHarmonicsVertexNode).toBeNull();
    expect(splat._sphericalHarmonicsComputeNode).toBeNull();
    expect(typeof splat.onBeforeRender).toBe('function');
    expect(typeof splat.updateSort).toBe('function');
    expect(typeof splat.updateSphericalHarmonics).toBe('function');
    expect(splat.autoSort).toBe(false);
    expect(splat.splatGeometry.getAttribute('position').count).toBe(n);
  });
});

describe.skipIf(!available)('FastShadersSplat.parseBytes — .splat', () => {
  it('reads 32-byte rows', async () => {
    const { FS } = evalRuntime();
    const r = await FS.parseBytes('splat', splatRows(3));
    expect(r.count).toBe(3);
    expect(r.shDropped).toBe(0);
    expect(r.geometry.getAttribute('position').count).toBe(3);
    expect(r.geometry.getAttribute('covariance').itemSize).toBe(6);
    expect(r.geometry.getAttribute('color').itemSize).toBe(4);
    // …and the result builds a splat.
    expect(new FS.GaussianSplat(r.geometry).geometry.instanceCount).toBe(3);
  });

  it('refuses a size that is not whole rows, and an empty file', async () => {
    const { FS } = evalRuntime();
    expect(await rejection(FS.parseBytes('splat', new ArrayBuffer(33))))
      .toBe('This .splat file is damaged: its size (33 bytes) is not a whole number of 32-byte splats.');
    expect(await rejection(FS.parseBytes('splat', new ArrayBuffer(0)))).toBe('This .splat file is empty.');
  });

  it('refuses more than SPLAT_MAX_COUNT rows BEFORE parsing', async () => {
    const { FS } = evalRuntime();
    const over = new ArrayBuffer((SPLAT_LIMITS.SPLAT_MAX_COUNT + 1) * 32);
    const msg = await rejection(FS.parseBytes('splat', over));
    expect(msg).toBe(
      'This .splat file holds 1,000,001 splats; the limit is 1,000,000. ' +
        'Reduce the scene in SuperSplat (or splat-transform) and export it again.',
    );
  });

  it('refuses an unknown kind and a non-buffer, as rejections', async () => {
    const { FS } = evalRuntime();
    expect(await rejection(FS.parseBytes('glb', splatRows(1)))).toContain('.splat, .spz, .ply and .ksplat');
    expect(await rejection(FS.parseBytes('splat', 'not bytes'))).toContain('expected the file as an ArrayBuffer');
    // Never a synchronous throw: a host can always .catch().
    expect(() => FS.parseBytes('nope', null).catch(() => {})).not.toThrow();
  });

  it('accepts a view, and a buffer from another realm', async () => {
    const { FS } = evalRuntime({ shareTypedArrays: false });
    const rows = new Uint8Array(splatRows(2));
    const padded = new Uint8Array(rows.length + 8);
    padded.set(rows, 4);
    expect((await FS.parseBytes('splat', padded.subarray(4, 4 + rows.length))).count).toBe(2);
    // PLYLoader tests `data instanceof ArrayBuffer`; a foreign buffer must still parse as binary.
    const ply = plyFile(PLY_SPLAT_PROPS, 1, [], [[0, 0, 0, -4, -4, -4, 1, 0, 0, 0, 0, 0, 0, 0]]);
    expect((await FS.parseBytes('ply', ply)).count).toBe(1);
  });
});

describe.skipIf(!available)('FastShadersSplat.parseBytes — .ply', () => {
  it('reads a Gaussian-splat PLY', async () => {
    const { FS } = evalRuntime();
    const rows = [
      [0, 0, 0, -4, -4, -4, 1, 0, 0, 0, 0.5, 0, 0, 2],
      [1, 0, 0, -4, -4, -4, 1, 0, 0, 0, 0, 0.5, 0, 2],
    ];
    const r = await FS.parseBytes('ply', plyFile(PLY_SPLAT_PROPS, 2, [], rows));
    expect(r.count).toBe(2);
    expect(r.shDropped).toBe(0);
    expect(Array.from(r.geometry.getAttribute('position').array)).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it('refuses a training PLY carrying f_rest_* and names the conversion', async () => {
    const { FS } = evalRuntime();
    const msg = await rejection(FS.parseBytes('ply', plyFile([...PLY_SPLAT_PROPS, 'f_rest_0'], 2)));
    expect(msg).toContain('spherical harmonics');
    expect(msg).toContain('Convert it to .splat or .spz with SuperSplat or splat-transform');
  });

  it('refuses a plain mesh / point cloud PLY', async () => {
    const { FS } = evalRuntime();
    const mesh = plyFile(['x', 'y', 'z', 'nx', 'ny', 'nz'], 3, ['element face 1', 'property list uchar int vertex_indices']);
    expect(await rejection(FS.parseBytes('ply', mesh))).toContain('a mesh or a point cloud, not a Gaussian splat');
  });

  it('refuses a SuperSplat compressed PLY (element chunk)', async () => {
    const { FS } = evalRuntime();
    const compressed = plyFile(PLY_SPLAT_PROPS, 2, ['element chunk 1', 'property float min_x']);
    const msg = await rejection(FS.parseBytes('ply', compressed));
    expect(msg).toContain('compressed splat PLY');
    expect(msg).toContain('SuperSplat or splat-transform');
  });

  it('refuses a file that is not a PLY, or whose header does not end in the scan window', async () => {
    const { FS } = evalRuntime();
    expect(await rejection(FS.parseBytes('ply', splatRows(2)))).toContain('is not a PLY file');
    const noEnd = new TextEncoder().encode('ply\nformat ascii 1.0\n' + 'comment x\n'.repeat(8000));
    expect(await rejection(FS.parseBytes('ply', exactBuffer(noEnd)))).toContain('no end_header in its first 64 KB');
  });

  it('refuses an ASCII PLY before PLYLoader splits its body into strings', async () => {
    const { FS } = evalRuntime();
    const ascii = new TextEncoder().encode(
      ['ply', 'format ascii 1.0', 'element vertex 1', ...PLY_SPLAT_PROPS.map((p) => `property float ${p}`),
        'end_header', PLY_SPLAT_PROPS.map(() => '0').join(' '), ''].join('\n'));
    const msg = await rejection(FS.parseBytes('ply', exactBuffer(ascii)));
    expect(msg).toContain('stored as text (format ascii)');
    expect(msg).toContain('SuperSplat or splat-transform');
  });

  it('refuses a vertex count over the cap from the header alone', async () => {
    const { FS } = evalRuntime();
    const header = new TextEncoder().encode(
      ['ply', 'format binary_little_endian 1.0', 'element vertex 1000001',
        ...PLY_SPLAT_PROPS.map((p) => `property float ${p}`), 'end_header', ''].join('\n'));
    expect(await rejection(FS.parseBytes('ply', exactBuffer(header)))).toContain('holds 1,000,001 splats');
  });

  it('a body shorter than its rows is refused by the header gate, before PLYLoader reads past it', async () => {
    // It used to reach PLYLoader and come back as "could not be read (Offset is
    // outside the bounds of the DataView)"; the gate now measures the body.
    const { FS } = evalRuntime();
    const header = new TextEncoder().encode(
      ['ply', 'format binary_little_endian 1.0', 'element vertex 5',
        ...PLY_SPLAT_PROPS.map((p) => `property float ${p}`), 'end_header', ''].join('\n'));
    const msg = await rejection(FS.parseBytes('ply', exactBuffer(header)));
    expect(msg).toBe('This .ply file is cut short: its header declares 5 splats (280 bytes), but only 0 bytes follow the header.');
  });

  it('refuses a second element before PLYLoader walks it (RT-1: `element junk 99999999999999` was a 1e14-row loop)', async () => {
    const { FS } = evalRuntime();
    const junk = splatPly({ after: ['element junk 99999999999999'] });
    const t0 = performance.now();
    const msg = await rejection(FS.parseBytes('ply', exactBuffer(junk)));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(msg).toContain('not a Gaussian splat');
    // The property-less second vertex element (the heap variant) too.
    const t1 = performance.now();
    expect(await rejection(FS.parseBytes('ply', exactBuffer(splatPly({ after: ['element vertex 99999999999'] })))))
      .toContain('not a Gaussian splat');
    expect(performance.now() - t1).toBeLessThan(50);
  });

  it('reads the header up to the first exact end_header LINE, and refuses an earlier end_header (RT-2)', async () => {
    const { FS } = evalRuntime();
    // A `format ascii` hidden after `comment x-end_header` used to reach PLYLoader
    // unseen, which then split the whole body into strings.
    const hidden = splatPly({ after: ['comment x-end_header', 'format ascii 1.0'], body: 16 * 1024 * 1024 });
    expect(await rejection(FS.parseBytes('ply', exactBuffer(hidden)))).toContain('"end_header" inside another header line');
    expect(() => FS.internals.sniffPlyHeader(splatPly({ before: ['format ascii 1.0'] }))).toThrow('declares its format more than once');
  });
});

/* ── the runtime's PLY gate agrees with the trusted sniff ──────────────── */

describe.skipIf(!available)("the runtime's PLY gate gives the trusted sniff's verdict (test-utils SPLAT_SNIFF_CASES)", () => {
  // The trusted sniff (src/utils/splatSniff.ts), podest's twin and this gate
  // implement ONE rule set; podestSplat.test.ts pins the twin, this pins the
  // runtime, over the same corpus. A verdict that differs is a file the editor
  // persists and the sandbox then refuses in English on every reload — or one
  // the editor refuses that the runtime would have shown.
  const plyCases = () => SPLAT_SNIFF_CASES.filter((c) => c.kind === 'ply');

  it('internals.sniffPlyHeader accepts exactly what sniffSplat accepts, with the same count', () => {
    const { FS } = evalRuntime();
    expect(plyCases().length).toBeGreaterThan(60);
    const differ: string[] = [];
    for (const c of plyCases()) {
      const bytes = c.bytes();
      const trusted = sniffSplat('ply', bytes);
      let gate: string;
      try {
        gate = `count ${FS.internals.sniffPlyHeader(bytes).count}`;
      } catch (e) {
        gate = 'refused';
      }
      const want = 'facts' in trusted ? `count ${trusted.facts.count}` : 'refused';
      if (gate !== want) differ.push(`${c.name}: sniffSplat ${want}, runtime ${gate}`);
    }
    expect(differ).toEqual([]);
  });

  it('parseBytes resolves every accepted case with its count, and rejects every refused one with the gate sentence', async () => {
    const { FS } = evalRuntime();
    for (const c of plyCases()) {
      const bytes = c.bytes();
      const trusted = sniffSplat('ply', bytes);
      if ('facts' in trusted) {
        const parsed = await FS.parseBytes('ply', exactBuffer(bytes));
        expect(parsed.count, c.name).toBe(trusted.facts.count);
        expect(parsed.geometry.getAttribute('position').count, c.name).toBe(trusted.facts.count);
      } else {
        let gate = '';
        try {
          FS.internals.sniffPlyHeader(bytes);
        } catch (e) {
          gate = String((e as Error).message);
        }
        expect(gate, c.name).not.toBe('');
        expect(await rejection(FS.parseBytes('ply', exactBuffer(bytes))), c.name).toBe(gate);
      }
    }
  }, 30000);
});

describe.skipIf(!available)('FastShadersSplat.parseBytes — .spz', () => {
  it('inflates a gzip SPZ v2, and DROPS its spherical harmonics (shDropped = 1)', async () => {
    const { FS } = evalRuntime();
    const r = await FS.parseBytes('spz', gz(spzRaw(3, 1)));
    expect(r.count).toBe(3);
    expect(r.shDropped).toBe(1);
    expect(r.geometry.getAttribute('sphericalHarmonics1')).toBeUndefined();
    expect(FS.getSphericalHarmonicsDegree(r.geometry)).toBe(0);
    const splat = new FS.GaussianSplat(r.geometry);
    expect(splat._sphericalHarmonicsVertexNode).toBeNull();
  });

  it('records the HIGHEST band dropped', async () => {
    const { FS } = evalRuntime();
    expect((await FS.parseBytes('spz', gz(spzRaw(2, 3, 3)))).shDropped).toBe(3);
    expect((await FS.parseBytes('spz', gz(spzRaw(2, 0)))).shDropped).toBe(0);
  });

  it('refuses SPZ v4 (NGSP magic, zstd) with the contract sentence', async () => {
    const { FS } = evalRuntime();
    const v4 = new Uint8Array(32);
    new DataView(v4.buffer).setUint32(0, 0x5053474e, true);
    new DataView(v4.buffer).setUint32(4, 4, true);
    expect(await rejection(FS.parseBytes('spz', v4.buffer)))
      .toBe('SPZ version 4 (zstd) is not supported - export SPZ v2/v3 or .splat');
  });

  it('refuses bytes that are not gzip', async () => {
    const { FS } = evalRuntime();
    expect(await rejection(FS.parseBytes('spz', splatRows(2)))).toContain('not gzip-compressed');
  });

  it('refuses a header count over the cap before buffering the rest', async () => {
    const { FS } = evalRuntime();
    const head = spzRaw(1, 0);
    new DataView(head.buffer).setUint32(8, SPLAT_LIMITS.SPLAT_MAX_COUNT + 1, true);
    expect(await rejection(FS.parseBytes('spz', gz(head)))).toContain('holds 1,000,001 splats');
  });

  it('refuses a stream longer, or shorter, than its header declares', async () => {
    const { FS } = evalRuntime();
    const raw = spzRaw(3, 0);
    const longer = new Uint8Array(raw.length + 10);
    longer.set(raw);
    expect(await rejection(FS.parseBytes('spz', gz(longer)))).toContain('more data than its header declares');
    expect(await rejection(FS.parseBytes('spz', gz(raw.subarray(0, raw.length - 5)))))
      .toContain('less data than its header declares');
  });

  it('refuses a truncated gzip stream', async () => {
    const { FS } = evalRuntime();
    const whole = new Uint8Array(gz(spzRaw(3, 0)));
    const cut = whole.slice(0, whole.length - 12);
    expect(await rejection(FS.parseBytes('spz', cut.buffer))).toContain('gzip data is truncated or corrupt');
  });

  it('the streamed counter rejects AT the cap, whatever the gzip trailer claims', async () => {
    const { FS } = evalRuntime();
    // 256 KiB of zeros against a 64 KiB cap: the counter, not the trailer's
    // ISIZE, decides — and a planless inflate never holds more than the cap.
    const zeros = gzipSync(new Uint8Array(256 * 1024));
    const msg = await rejection(FS.internals.gunzipCapped(new Uint8Array(zeros), 64 * 1024));
    expect(msg).toBe('This .spz file unpacks to more than 65,536 bytes, the limit for one splat file.');
    // Under the cap it inflates.
    const ok = await FS.internals.gunzipCapped(new Uint8Array(gzipSync(new Uint8Array(1000).fill(7))), 64 * 1024);
    expect(ok.length).toBe(1000);
    expect(ok[999]).toBe(7);
  });

  it('the header plan sizes every legal SPZ under SPZ_MAX_DECODED_BYTES', () => {
    const { FS } = evalRuntime();
    // The largest header the count cap allows (degree 4, v3, LOD flag) still
    // fits: the byte cap is a backstop, the declared size is the real bound.
    const h = new Uint8Array(16);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x5053474e, true);
    dv.setUint32(4, 3, true);
    dv.setUint32(8, SPLAT_LIMITS.SPLAT_MAX_COUNT, true);
    h[12] = 4;
    h[14] = 0x80;
    const size = FS.internals.spzPlan(h);
    expect(size).toBe(16 + 1e6 * (9 + 1 + 3 + 3 + 4 + 72 + 6));
    expect(size).toBeLessThanOrEqual(SPLAT_LIMITS.SPZ_MAX_DECODED_BYTES);
  });
});

describe.skipIf(!available)('FastShadersSplat.parseBytes — .ksplat', () => {
  it('refuses a file shorter than its header, and a header count over the cap', async () => {
    const { FS } = evalRuntime();
    expect(await rejection(FS.parseBytes('ksplat', new ArrayBuffer(100)))).toContain('shorter than its 4096-byte header');
    const head = new Uint8Array(4096);
    new DataView(head.buffer).setUint32(16, SPLAT_LIMITS.SPLAT_MAX_COUNT + 1, true);
    expect(await rejection(FS.parseBytes('ksplat', head.buffer))).toContain('holds 1,000,001 splats');
    new DataView(head.buffer).setUint32(16, 0, true);
    expect(await rejection(FS.parseBytes('ksplat', head.buffer))).toBe('This .ksplat file holds no splats.');
  });

  it('a malformed header is a sentence, not a raw loader error', async () => {
    const { FS } = evalRuntime();
    const head = new Uint8Array(4096);
    head[0] = 9; // version 9.0
    new DataView(head.buffer).setUint32(16, 3, true);
    const msg = await rejection(FS.parseBytes('ksplat', head.buffer));
    expect(msg.startsWith('This .ksplat file could not be read (')).toBe(true);
  });
});

describe.skipIf(!available)('FastShadersSplat.normalize', () => {
  it('centres the 2-sigma bounds and scales the longest extent to `size`, covariance by s^2', async () => {
    const { FS } = evalRuntime();
    const { geometry } = await FS.parseBytes('splat', splatRows(3));
    const before = Array.from(geometry.getAttribute('position').array as Float32Array);
    const covBefore = Array.from(geometry.getAttribute('covariance').array as Float32Array);
    // x runs 0..2, each splat has sigma 0.1 → 2-sigma radius 0.2: x extent 2.4,
    // centre (1, 1, -2), so s = 1.6 / 2.4.
    const r = 2 * Math.sqrt(covBefore[0]);
    const extent = 2 + 2 * r;
    const s = 1.6 / extent;
    expect(geometry.boundingBox).not.toBeNull();
    FS.normalize(geometry, 1.6);
    const after = geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < 3; i++) {
      expect(after[i * 3]).toBeCloseTo((before[i * 3] - 1) * s, 5);
      expect(after[i * 3 + 1]).toBeCloseTo(0, 6);
      expect(after[i * 3 + 2]).toBeCloseTo(0, 6);
    }
    const covAfter = geometry.getAttribute('covariance').array as Float32Array;
    covBefore.forEach((v, i) => expect(covAfter[i]).toBeCloseTo(v * s * s, 7));
    expect(geometry.boundingBox).toBeNull();
    expect(geometry.boundingSphere).toBeNull();
    // The splat built from it spans exactly `size` along its longest axis.
    const splat = new FS.GaussianSplat(geometry);
    splat.computeBoundingBox();
    const box = splat.boundingBox;
    expect(box.max.x - box.min.x).toBeCloseTo(1.6, 5);
    expect(box.max.x + box.min.x).toBeCloseTo(0, 5);
  });

  it('size <= 0 keeps the authored units, and nothing measurable changes nothing', async () => {
    const { FS } = evalRuntime();
    const { geometry } = await FS.parseBytes('splat', splatRows(3));
    const before = Array.from(geometry.getAttribute('position').array as Float32Array);
    FS.normalize(geometry, 0);
    FS.normalize(geometry, -1);
    FS.normalize(geometry, Number.NaN);
    expect(Array.from(geometry.getAttribute('position').array as Float32Array)).toEqual(before);
    expect(geometry.boundingBox).not.toBeNull();
    // One splat, zero covariance: the extent is 0, so there is no scale to find.
    const one = FS.createGaussianSplatGeometry(new Float32Array([5, 5, 5]), new Float32Array(6), new Uint8ClampedArray(4));
    FS.normalize(one, 1.6);
    expect(Array.from(one.getAttribute('position').array as Float32Array)).toEqual([5, 5, 5]);
  });
});

describe.skipIf(!available)('the splat-model A-Frame component', () => {
  interface Registered { name: string; def: Any }

  function fakeAframe(taken: string[] = []) {
    const registered: Registered[] = [];
    const components: Record<string, unknown> = {};
    for (const t of taken) components[t] = {};
    return {
      registered,
      AFRAME: { registerComponent: (name: string, def: Any) => registered.push({ name, def }), components },
    };
  }

  /**
   * A FileLoader that serves `files` by URL, asynchronously, like the real one,
   * and a three Cache that records what is dropped from it (a fake, so no test
   * flips the real, shared THREE.Cache).
   */
  function threeWithFiles(files: Map<string, ArrayBuffer>, requested: string[], cacheRemoved: string[] = []) {
    class StubFileLoader {
      manager = { resolveURL: (u: string) => `resolved:${u}` };
      responseType = '';
      setResponseType(t: string) { this.responseType = t; return this; }
      load(url: string, onLoad: (b: ArrayBuffer) => void, _p: unknown, onError: (e: unknown) => void) {
        requested.push(url);
        expect(this.responseType).toBe('arraybuffer');
        queueMicrotask(() => {
          const b = files.get(url);
          if (b) onLoad(b);
          else onError(new Error(`404 ${url}`));
        });
      }
    }
    const Cache = { enabled: true, remove: (k: string) => cacheRemoved.push(k) };
    return { ...THREE, FileLoader: StubFileLoader, Cache };
  }

  function fakeEl() {
    const events: { name: string; detail: Any }[] = [];
    const obj: Record<string, Any> = {};
    return {
      events,
      obj,
      setObject3D(name: string, o: Any) { obj[name] = o; },
      getObject3D(name: string) { return obj[name]; },
      removeObject3D(name: string) { delete obj[name]; },
      emit(name: string, detail: Any) { events.push({ name, detail }); },
    };
  }

  function mount(def: Any, data: Record<string, unknown>) {
    const el = fakeEl();
    const comp = Object.create(def);
    comp.el = el;
    comp.data = { kind: 'splat', size: 1.6, autoSort: true, ...data };
    def.init.call(comp);
    return { comp, el };
  }

  it('registers with the contract schema, and never over another splat-model', () => {
    const a = fakeAframe();
    evalRuntime({ AFRAME: a.AFRAME });
    expect(a.registered.map((r) => r.name)).toEqual(['splat-model']);
    const schema = a.registered[0].def.schema;
    expect(schema.src).toEqual({ type: 'string' });
    expect(schema.kind.default).toBe('splat');
    expect([...schema.kind.oneOf]).toEqual(['splat', 'spz', 'ply', 'ksplat']);
    expect(schema.size).toEqual({ type: 'number', default: 1.6 });
    expect(schema.autoSort).toEqual({ default: true });

    const b = fakeAframe(['splat-model']);
    evalRuntime({ AFRAME: b.AFRAME });
    expect(b.registered).toEqual([]);
  });

  it('loads src through FileLoader, normalises, and emits model-loaded then splat-loaded', async () => {
    const files = new Map([['blob:null/abc', splatRows(3)]]);
    const requested: string[] = [];
    const cacheRemoved: string[] = [];
    const a = fakeAframe();
    evalRuntime({ AFRAME: a.AFRAME, three: threeWithFiles(files, requested, cacheRemoved) });
    const { comp, el } = mount(a.registered[0].def, { src: 'url(blob:null/abc)', autoSort: false });
    comp.update({});
    await vi.waitFor(() => expect(el.events.length).toBe(2));
    expect(requested).toEqual(['blob:null/abc']);
    // FileLoader's own cache key, so the bytes do not outlive the load.
    expect(cacheRemoved).toEqual(['file:resolved:blob:null/abc']);
    expect(el.events.map((e) => e.name)).toEqual(['model-loaded', 'splat-loaded']);
    const splat = el.obj.mesh;
    expect(splat.isGaussianSplat).toBe(true);
    expect(splat.autoSort).toBe(false);
    expect(el.events[0].detail).toEqual({ format: 'splat', model: splat });
    expect(el.events[1].detail).toEqual({ count: 3, shDropped: 0 });
    // Normalised: the longest 2-sigma extent is 1.6, centred on the origin.
    splat.computeBoundingBox();
    expect(splat.boundingBox.max.x - splat.boundingBox.min.x).toBeCloseTo(1.6, 5);
    expect(splat.boundingBox.max.x + splat.boundingBox.min.x).toBeCloseTo(0, 5);
  });

  it('a refused file emits model-error with the sentence, and sets no mesh', async () => {
    const files = new Map([['bad.splat', new ArrayBuffer(33)]]);
    const a = fakeAframe();
    const warns: string[] = [];
    evalRuntime({ AFRAME: a.AFRAME, three: threeWithFiles(files, []), warn: (m) => warns.push(String(m)) });
    const { comp, el } = mount(a.registered[0].def, { src: 'bad.splat' });
    comp.update({});
    await vi.waitFor(() => expect(el.events.length).toBe(1));
    expect(el.events[0]).toEqual({
      name: 'model-error',
      detail: { src: 'bad.splat', message: 'This .splat file is damaged: its size (33 bytes) is not a whole number of 32-byte splats.' },
    });
    expect(el.obj.mesh).toBeUndefined();
    expect(warns.length).toBe(1);

    // A fetch failure takes the same path.
    const { comp: c2, el: e2 } = mount(a.registered[0].def, { src: 'missing.splat' });
    c2.update({});
    await vi.waitFor(() => expect(e2.events.length).toBe(1));
    expect(e2.events[0].name).toBe('model-error');
    expect(e2.events[0].detail.message).toBe('404 missing.splat');
  });

  it('keeps its own material when an A-Frame `material` on the entity assigns another (on set and later)', async () => {
    // Measured in the editor preview: A-Frame's material component answers
    // object3dset by assigning ITS MeshStandardMaterial to the new 'mesh', and
    // a GaussianSplat drawn through that is one flat grey quad per splat.
    const files = new Map([['m.splat', splatRows(4)]]);
    const a = fakeAframe();
    const warns: string[] = [];
    evalRuntime({ AFRAME: a.AFRAME, three: threeWithFiles(files, []), warn: (m) => warns.push(String(m)) });
    const { comp, el } = mount(a.registered[0].def, { src: 'm.splat' });
    const foreign = { isMaterial: true, name: 'a-frame material' };
    const set = el.setObject3D.bind(el);
    el.setObject3D = (name: string, o: Any) => { set(name, o); o.material = foreign; };
    let materialAtLoad: unknown = null;
    const emit = el.emit.bind(el);
    el.emit = (name: string, detail: Any) => {
      if (name === 'model-loaded') materialAtLoad = detail.model.material;
      emit(name, detail);
    };
    comp.update({});
    await vi.waitFor(() => expect(el.events.some((e) => e.name === 'splat-loaded')).toBe(true));
    const splat = el.obj.mesh;
    const own = splat.material;
    expect(own).not.toBe(foreign);
    expect(own.isNodeMaterial).toBe(true);
    // Restored BEFORE model-loaded, so the shader component wraps the real one.
    expect(materialAtLoad).toBe(own);
    // A later replacement is undone on the next tick, with ONE warning in total.
    splat.material = foreign;
    comp.tick();
    expect(splat.material).toBe(own);
    splat.material = foreign;
    comp.tick();
    expect(splat.material).toBe(own);
    expect(warns.filter((w) => w.includes('another material')).length).toBe(1);
    // A tick with no splat, or with the right material, does nothing.
    comp.tick();
    expect(splat.material).toBe(own);
  });

  it('a newer update drops the older load, and remove() disposes and detaches', async () => {
    const files = new Map([['a.splat', splatRows(2)], ['b.splat', splatRows(5)]]);
    const a = fakeAframe();
    evalRuntime({ AFRAME: a.AFRAME, three: threeWithFiles(files, []) });
    const { comp, el } = mount(a.registered[0].def, { src: 'a.splat' });
    comp.update({});
    comp.data = { ...comp.data, src: 'b.splat' };
    comp.update({});
    await vi.waitFor(() => expect(el.events.some((e) => e.name === 'splat-loaded')).toBe(true));
    // Give the stale load every chance to land, then check it never did.
    await new Promise((r) => setTimeout(r, 20));
    expect(el.events.filter((e) => e.name === 'splat-loaded').map((e) => e.detail.count)).toEqual([5]);

    const splat = el.obj.mesh;
    let disposed = 0;
    for (const o of [splat.geometry, splat.splatGeometry, splat.material]) {
      const d = o.dispose.bind(o);
      o.dispose = () => { disposed++; d(); };
    }
    comp.remove();
    expect(el.obj.mesh).toBeUndefined();
    expect(disposed).toBe(3);
    // An empty src loads nothing.
    comp.data = { ...comp.data, src: '' };
    comp.update({});
    await new Promise((r) => setTimeout(r, 5));
    expect(el.obj.mesh).toBeUndefined();
  });
});
