import { describe, it, expect, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import { readImageTextureSpec, imageTextureSetupLines } from '@/engine/imageTexturePlan';
import { LUT_SIZE } from '@/utils/colormaps';

/**
 * Phase 9's texture atoms in ShaderCarousel/lib/bench-registry.js: the only
 * bench shaders that sample a texture, and the only ones that can ever price
 * `imageNode` and `colormap` from a measurement instead of an estimate.
 *
 * Nothing here runs a GPU. What a node test CAN prove is everything the
 * measurement would silently get wrong: that the groups exist only when a
 * bench passes THREE (the corpus without it is byte-for-byte the old one),
 * that k copies really are k distinct samples (the fit's slope is per COPY),
 * that a failed build throws instead of falling back to a free magenta, and
 * that the textures are configured the way the app configures its own — a
 * bench atom sampling a texture the app would never build prices the wrong
 * thing.
 */

type Entry = {
  id: string;
  group: string;
  category: string;
  copies?: number;
  build: (() => unknown) | null;
};
type TexConfig = { side: number; height: number; kind: 'colour' | 'data' | 'lut' };
interface BenchRegistry {
  buildBenchRegistry(TSL: unknown, THREE?: unknown): Entry[];
  TEX_K_LEVELS: number[];
  TEX_OFFSETS: [number, number][];
  TEX_CONFIGS: Record<string, TexConfig>;
  TEX_OPS: readonly (readonly [string, string, string, number])[];
  TEX_SCREEN_SPAN: number;
  makeBenchTextureData(width: number, height: number, seed?: number): Uint8Array;
  makeBenchTexture(THREE: unknown, key: string): THREE.DataTexture;
}
type AnyNode = {
  id: number;
  isNode?: boolean;
  isTextureNode?: boolean;
  uvNode?: AnyNode | null;
  value?: unknown;
  getChildren(): Iterable<AnyNode>;
};

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
// Non-literal specifier: a plain JS module with no type declarations, which
// tsc must not try to resolve (fitCalibration.test.ts does the same).
const reg = (await import(/* @vite-ignore */ here('../../ShaderCarousel/lib/bench-registry.js'))) as BenchRegistry;
const readSource = (rel: string) => readFileSync(here(rel), 'utf8');
const BENCH_UI = readSource('../../ShaderCarousel/lib/bench-ui.js');

const TSL = THREE.TSL;
// The saved-groups loader reads localStorage in a try, so node sees none; the
// filter keeps these counts honest even if a stray global ever leaks one in.
const corpus = (entries: Entry[]) => entries.filter((e) => e.group !== 'saved');
const TEX_ID = /^(texture_|calib_tex_|combo_tex)/;
const K_RE = /^calib_(.+)_x(\d+)$/;

/** Every node reachable from `root`, once each (shared subtrees included). */
function nodesOf(root: unknown): AnyNode[] {
  const seen = new Map<number, AnyNode>();
  const walk = (n: AnyNode | null | undefined) => {
    if (!n || typeof n !== 'object' || n.isNode !== true || seen.has(n.id)) return;
    seen.set(n.id, n);
    for (const c of n.getChildren()) walk(c);
  };
  walk(root as AnyNode);
  return [...seen.values()];
}
const textureNodesOf = (root: unknown) => nodesOf(root).filter((n) => n.isTextureNode === true);

// One registry WITH textures, built once: every texture/texcalib/combo_tex
// entry except the 4096² ones (85 MB with mips — never allocated in node). The
// build runs under a local console.warn spy, since safeWrap's magenta fallback
// announces itself only there.
let memo: { entries: Entry[]; built: Map<string, unknown>; warns: number } | null = null;
function builtTextureEntries() {
  if (memo) return memo;
  const entries = reg.buildBenchRegistry(TSL, THREE);
  const built = new Map<string, unknown>();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const e of entries) {
      if (!TEX_ID.test(e.id) || e.id.includes('c4096')) continue;
      built.set(e.id, e.build!());
    }
    memo = { entries, built, warns: warn.mock.calls.length };
  } finally {
    warn.mockRestore();
  }
  return memo;
}
afterAll(() => { memo = null; }); // ~37 MB of texel arrays; isolate:false keeps the file alive

describe('bench texture atoms: the corpus', () => {
  it('without THREE the corpus is unchanged: 75 entries, no texture ids', () => {
    const entries = corpus(reg.buildBenchRegistry(TSL));
    expect(entries).toHaveLength(75);
    expect(entries.filter((e) => TEX_ID.test(e.id))).toEqual([]);
    expect(entries.some((e) => e.copies !== undefined)).toBe(false);
  });

  it('with THREE: 105 unique ids, the two profile atoms, the full sweep and the combo', () => {
    const entries = corpus(reg.buildBenchRegistry(TSL, THREE));
    const ids = entries.map((e) => e.id);
    expect(entries).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);

    // copies: 16 on exactly the two per-fetch profile atoms.
    const withCopies = entries.filter((e) => e.copies !== undefined);
    expect(withCopies.map((e) => [e.id, e.copies])).toEqual([
      ['texture_imageNode', 16],
      ['texture_colormap', 16],
    ]);
    expect(withCopies.every((e) => e.group === 'texture' && e.category === 'texture')).toBe(true);

    const expected = ['calib_tex_scaffold_x1', 'calib_tex_scaffold_x4', 'calib_tex_scaffold_x16'];
    for (const op of ['c256', 'c1024', 'c2048', 'c4096', 'd2048', 'c2048q', 'd2048q', 'lut256']) {
      for (const k of [1, 4, 16]) expected.push(`calib_tex_${op}_x${k}`);
    }
    for (const id of expected) expect(ids, id).toContain(id);
    expect(ids).toContain('combo_tex4_perlin4');

    const texCalib = entries.filter((e) => e.id.startsWith('calib_tex_'));
    expect(texCalib).toHaveLength(27);
    for (const e of texCalib) {
      const m = K_RE.exec(e.id);
      expect(m, e.id).not.toBeNull();
      expect([1, 4, 16]).toContain(Number(m![2]));
      expect(e.group).toBe('texcalib');
    }
  });

  it('the picker labels and orders every group the registry emits', () => {
    // buildPicker walks GROUP_ORDER, so a group missing from it would never
    // be offered at all — silently.
    const order = /const GROUP_ORDER = \[([^\]]*)\]/.exec(BENCH_UI)![1].match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));
    const labels = /const GROUP_LABELS = \{([\s\S]*?)\};/.exec(BENCH_UI)![1];
    expect(order).toEqual(['baseline', 'preset', 'noise', 'texture', 'calib', 'texcalib', 'combo', 'saved']);
    for (const g of new Set(reg.buildBenchRegistry(TSL, THREE).map((e) => e.group))) {
      expect(order, g).toContain(g);
      expect(labels, g).toMatch(new RegExp(`\\b${g}:`));
    }
  });

  it('all three benches pass THREE, carry copies onto results, and keep the groups OFF by default', () => {
    const micro = readSource('../../ShaderCarousel/bench-microplane/bench.js');
    const stat = readSource('../../ShaderCarousel/bench-static/bench.js');
    const inout = readSource('../../ShaderCarousel/bench-inout/bench.js');
    const driver = readSource('../../ShaderCarousel/lib/bench-driver.js');
    expect(micro).toContain('buildBenchRegistry(TSL, THREE)');
    expect(stat).toContain('buildBenchRegistry(TSL, THREE)');
    expect(inout).toContain('buildBenchRegistry(THREE.TSL, THREE)');
    // Without the carry bench-stats never sees `copies` and a per-fetch atom
    // exports the price of SIXTEEN fetches as one.
    for (const src of [driver, inout]) expect(src).toMatch(/\.\.\.\(s\.copies > 1 \? \{ copies: s\.copies \} : \{\}\)/);
    // The done popup pairs Marginal ms with per-copy Points, so a copies
    // atom's ms must be divided the same way (the CSV keeps the whole-shader
    // ms beside its `copies` column); undivided it read 16× its points.
    const popupRows = /const rows = results\.map\(r => \{([\s\S]*?)\n {4}\}\);/.exec(driver)?.[1] ?? '';
    expect(popupRows).toMatch(/points: r\.stats\.marginalPoints/);
    expect(popupRows).toMatch(/marginalMs: [^\n]*\/ \(r\.stats\.copies \?\? 1\)/);
    // Owner default: off in every bench until a Quest run passes the gates.
    for (const src of [micro, stat, inout]) {
      const groups = /DEFAULT_GROUPS = new Set\(\[([^\]]*)\]\)/.exec(src)![1];
      expect(groups).not.toMatch(/'texture'|'texcalib'/);
    }
  });
});

describe('bench texture atoms: what gets built', () => {
  it('builds every texture entry without the magenta fallback', () => {
    const { built, warns } = builtTextureEntries();
    expect(built.size).toBe(2 + 24 + 1); // 105 − 75 − the three c4096 levels
    expect(warns).toBe(0);
    for (const [id, node] of built) expect((node as AnyNode).isNode, id).toBe(true);
  });

  it('k copies are k distinct samples with k distinct uvs; the scaffold samples nothing', () => {
    const { built } = builtTextureEntries();
    for (const [id, node] of built) {
      const tex = textureNodesOf(node);
      const uvs = new Set(tex.map((t) => t.uvNode?.id));
      if (id.startsWith('calib_tex_scaffold_')) {
        expect(tex, id).toHaveLength(0);
        continue;
      }
      const want = id.startsWith('texture_') ? 16 : id === 'combo_tex4_perlin4' ? 4 : Number(K_RE.exec(id)![2]);
      expect(tex, id).toHaveLength(want);
      expect(uvs.size, id).toBe(want);
    }
  });

  it('shares one texture per config across every entry that samples it', () => {
    const { built } = builtTextureEntries();
    const texOf = (id: string) => {
      const values = new Set(textureNodesOf(built.get(id)).map((t) => t.value));
      expect(values.size, id).toBe(1);
      return [...values][0];
    };
    const c2048 = texOf('calib_tex_c2048_x1');
    expect(texOf('calib_tex_c2048_x16')).toBe(c2048);
    expect(texOf('calib_tex_c2048q_x4')).toBe(c2048); // same config, smaller footprint
    expect(texOf('texture_imageNode')).toBe(c2048);
    expect(texOf('combo_tex4_perlin4')).toBe(c2048);
    expect(texOf('texture_colormap')).toBe(texOf('calib_tex_lut256_x4'));
    expect(texOf('calib_tex_d2048_x1')).not.toBe(c2048);
  });

  it('a missing THREE class THROWS instead of measuring a free fetch', () => {
    const broken = { ...THREE, DataTexture: undefined };
    const entries = reg.buildBenchRegistry(TSL, broken);
    const imageNode = entries.find((e) => e.id === 'texture_imageNode')!;
    expect(() => imageNode.build!()).toThrow();
  });
});

describe('bench texture atoms: the textures', () => {
  it('TEX_OFFSETS: 16 distinct pairs inside [0,1)', () => {
    expect(reg.TEX_OFFSETS).toHaveLength(16);
    for (const [u, v] of reg.TEX_OFFSETS) {
      for (const x of [u, v]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
      }
    }
    for (let i = 0; i < 16; i++) {
      for (let j = i + 1; j < 16; j++) {
        const [a, b] = [reg.TEX_OFFSETS[i], reg.TEX_OFFSETS[j]];
        expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])), `${i}/${j}`).toBeGreaterThan(1e-3);
      }
    }
  });

  it('configures colour, data and LUT textures as specified', () => {
    // The two 2048² textures come out of the built registry (makeBenchTexture
    // via its per-config cache) rather than a second 32 MB allocation.
    const { built } = builtTextureEntries();
    const cached = (id: string) => textureNodesOf(built.get(id))[0].value as THREE.DataTexture;

    const c = cached('calib_tex_c2048_x1');
    expect([c.image.width, c.image.height]).toEqual([2048, 2048]);
    expect([c.format, c.type]).toEqual([THREE.RGBAFormat, THREE.UnsignedByteType]);
    expect(c.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(c.generateMipmaps).toBe(true);
    expect([c.minFilter, c.magFilter]).toEqual([THREE.LinearMipmapLinearFilter, THREE.LinearFilter]);
    expect([c.wrapS, c.wrapT]).toEqual([THREE.RepeatWrapping, THREE.RepeatWrapping]);

    const d = cached('calib_tex_d2048_x1');
    expect([d.image.width, d.image.height]).toEqual([2048, 2048]);
    expect(d.colorSpace).toBe(THREE.NoColorSpace);
    expect(d.generateMipmaps).toBe(false);
    expect([d.minFilter, d.magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter]);
    expect([d.wrapS, d.wrapT]).toEqual([THREE.RepeatWrapping, THREE.RepeatWrapping]);

    const l = reg.makeBenchTexture(THREE, 'lut256');
    expect([l.image.width, l.image.height]).toEqual([256, 1]);
    expect([l.format, l.type]).toEqual([THREE.RGBAFormat, THREE.HalfFloatType]);
    expect(l.image.data).toBeInstanceOf(Uint16Array);
    expect([l.minFilter, l.magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter]);
    expect(l.generateMipmaps).toBe(false);

    const small = reg.makeBenchTexture(THREE, 'c256');
    expect([small.image.width, small.image.height, small.colorSpace]).toEqual([256, 256, THREE.SRGBColorSpace]);
    expect(() => reg.makeBenchTexture(THREE, 'nope')).toThrow();
  });

  it('mirrors the app: imageTextureSetupLines (colour + data) and bakeColormapTexture', () => {
    // The app's colour image sets only its colour space and wrap and keeps
    // three's Texture defaults for everything else — so the bench's explicit
    // mips + LinearMipmapLinear must BE those defaults.
    const colour = imageTextureSetupLines('t', 'i', 'ok', readImageTextureSpec({})).join('\n');
    expect(colour).toContain('SRGBColorSpace');
    expect(colour).toContain('RepeatWrapping');
    expect(colour).not.toContain('generateMipmaps = false');
    expect(colour).not.toContain('minFilter');
    const def = new THREE.Texture();
    expect(def.generateMipmaps).toBe(true);
    expect(def.minFilter).toBe(THREE.LinearMipmapLinearFilter);

    const data = imageTextureSetupLines('t', 'i', 'ok', readImageTextureSpec({ colorSpace: 'data' })).join('\n');
    expect(data).toContain('NoColorSpace');
    expect(data).toContain('generateMipmaps = false');
    expect(data).toContain('minFilter = globalThis.THREE.LinearFilter');
    expect(data).toContain('magFilter = globalThis.THREE.LinearFilter');

    // The Colormap node's LUT: an RGBA half-float 256×1 DataTexture.
    const g2c = readSource('../engine/graphToCode.ts');
    const start = g2c.indexOf('function bakeColormapTexture');
    expect(start).toBeGreaterThan(-1);
    const body = g2c.slice(start, g2c.indexOf('\n}\n', start));
    expect(body).toContain('RGBAFormat, globalThis.THREE.HalfFloatType');
    expect(body).toContain('minFilter = globalThis.THREE.LinearFilter');
    expect(LUT_SIZE).toBe(reg.TEX_CONFIGS.lut256.side);
    expect(reg.TEX_CONFIGS.lut256.height).toBe(1);
  });

  it('generated texels are deterministic, high-entropy and opaque', () => {
    const a = reg.makeBenchTextureData(64, 64, 1);
    const b = reg.makeBenchTextureData(64, 64, 1);
    expect(a).toEqual(b);
    expect(reg.makeBenchTextureData(64, 64, 2)).not.toEqual(a);
    const rgb = new Set<number>();
    let opaque = true;
    for (let i = 0; i < a.length; i += 4) {
      rgb.add(a[i]); rgb.add(a[i + 1]); rgb.add(a[i + 2]);
      if (a[i + 3] !== 255) opaque = false;
    }
    expect(rgb.size).toBeGreaterThanOrEqual(250);
    expect(opaque).toBe(true);
  });
});
