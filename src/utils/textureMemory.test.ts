/**
 * The texture-memory FIGURE (utils/textureMemory.ts): the arithmetic, the
 * adversarial dimension gates, the sharing key, reachability, a cross-check
 * against the textures graphToCode really emits, a drift guard on the three
 * internals the PMREM term mirrors, the strings, and the one surface.
 *
 * Pure: node env, no stubs, no store mutation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import lv from '@/i18n/lv.json';
import type { AppNode, AppEdge } from '@/types';
import { makeNode, makeEdge } from '../test-utils';
import {
  mipChainTexels,
  pmremBytes,
  textureMemory,
  graphTextureMemory,
  textureMemoryLine,
  NO_TEXTURE_MEMORY,
  UNTRUSTED_TEXTURE_SIDE,
  TEXTURE_DIM_FIELD_MAX,
  TEXTURE_MEMORY_ONE_KEY,
  TEXTURE_MEMORY_MANY_KEY,
  TEXTURE_MEMORY_HINT_KEY,
  type TextureMemory,
  type TextureMemoryInput,
} from './textureMemory';
// Test-only imports: the module itself may not import either (see its header).
import { IMAGE_COST_REF_SIDE, IMAGE_COST_MAX_DIM } from './nodeCost';
import { unwrapCollapsedGroupEdges } from './edgeUtils';
import { graphToCode } from '@/engine/graphToCode';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const UI = lv.ui as Record<string, string>;

// Canonical `btoa` payloads, as engine/imageNode.test.ts builds them, so the
// raw stored string equals the canonical `src` the emission planner keys on.
const P1 = `data:image/webp;base64,${btoa('abc')}`;
const P2 = `data:image/png;base64,${btoa('xyz!')}`;

/** An Image node with valid 2x2 defaults; `extra` overrides any value. */
function img(id: string, extra: Record<string, string | number> = {}): AppNode {
  return makeNode(id, 'imageNode', { imageB64: P1, width: 2, height: 2, fileName: '', colorSpace: 'color', ...extra });
}

/** An Image node whose `values` is whatever the test hands it (adversarial). */
function rawImg(id: string, values: unknown): AppNode {
  return {
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'imageNode', label: id, cost: 0, values },
  } as unknown as AppNode;
}

const out = () => makeNode('out', 'output');

/** One image wired into the Output's Color. */
function oneImage(image: AppNode): TextureMemory {
  return graphTextureMemory([image, out()], [makeEdge(image.id, 'out', 'out', 'color')]);
}

/** Two images through a mul into Color. */
function twoImages(a: AppNode, b: AppNode): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [a, b, makeNode('m', 'mul'), out()],
    edges: [
      makeEdge(a.id, 'out', 'm', 'a'),
      makeEdge(b.id, 'out', 'm', 'b'),
      makeEdge('m', 'out', 'out', 'color'),
    ],
  };
}

const CHAIN_2048 = 5_592_405;

describe('the arithmetic', () => {
  it('sums the exact mip chain, floor-halving each axis down to 1x1', () => {
    expect(mipChainTexels(1, 1)).toBe(1);
    expect(mipChainTexels(2, 2)).toBe(5);
    expect(mipChainTexels(8, 8)).toBe(85);
    expect(mipChainTexels(16, 8)).toBe(171);
    expect(mipChainTexels(2048, 1024)).toBe(2_796_203);
    expect(mipChainTexels(2048, 2048)).toBe(CHAIN_2048);
  });

  it('counts nothing for an untrusted input rather than looping or going NaN', () => {
    for (const [w, h] of [[0, 4], [4, -1], [1.5, 2], [NaN, 2], [Infinity, 2]]) {
      expect(mipChainTexels(w, h)).toBe(0);
    }
  });

  it("prices PMREM as three r184 allocates it: two 3*max(c,112) x 4c half-float targets", () => {
    expect(pmremBytes(1)).toBe(5_376);
    expect(pmremBytes(2)).toBe(10_752);
    expect(pmremBytes(4)).toBe(21_504);
    expect(pmremBytes(256)).toBe(1_376_256);
    expect(pmremBytes(1024)).toBe(12_582_912);
    expect(pmremBytes(2048)).toBe(50_331_648);
    expect(pmremBytes(4096)).toBe(201_326_592);
    expect(pmremBytes(0)).toBe(0);
    expect(pmremBytes(NaN)).toBe(0);
  });

  const colour = (key: string, extra: Partial<TextureMemoryInput> = {}): TextureMemoryInput =>
    ({ key, width: 2048, height: 2048, mipmapped: true, environment: false, ...extra });

  it('a colour image pays its mip chain, a data map one level', () => {
    expect(textureMemory([colour('a')]).textureBytes).toBe(22_369_620);
    expect(textureMemory([colour('a', { mipmapped: false })]).textureBytes).toBe(16_777_216);
  });

  it('adds the PMREM term for an image that lights the scene', () => {
    const m = textureMemory([colour('a', { environment: true }), colour('b', { mipmapped: false })]);
    expect(m).toEqual({
      bytes: 89_478_484,
      count: 2,
      textureBytes: 22_369_620 + 16_777_216,
      environmentBytes: 50_331_648,
      dataMaps: 1,
      untrustedSizes: 0,
    });
  });

  it('one key is one texture, sized at its LARGEST member, environment ORed', () => {
    const m = textureMemory([
      colour('a', { width: 256, height: 256 }),
      colour('a', { width: 1024, height: 512, environment: true }),
      colour('a', { width: 512, height: 512 }),
    ]);
    expect(m.count).toBe(1);
    expect(m.textureBytes).toBe(mipChainTexels(1024, 512) * 4);
    expect(m.environmentBytes).toBe(pmremBytes(1024));
  });

  it('an empty list is the frozen zero', () => {
    expect(textureMemory([])).toBe(NO_TEXTURE_MEMORY);
    expect(Object.isFrozen(NO_TEXTURE_MEMORY)).toBe(true);
    expect(NO_TEXTURE_MEMORY).toEqual({ bytes: 0, count: 0, textureBytes: 0, environmentBytes: 0, dataMaps: 0, untrustedSizes: 0 });
  });
});

describe('adversarial dimensions and payloads', () => {
  it('shares its constants with imageNodeCost', () => {
    expect(UNTRUSTED_TEXTURE_SIDE).toBe(IMAGE_COST_REF_SIDE);
    expect(TEXTURE_DIM_FIELD_MAX).toBe(IMAGE_COST_MAX_DIM);
  });

  it('a size decodeImageNode would refuse creates no texture at all', () => {
    for (const junk of [null, '', [], 0, -1, 1.5, NaN, Infinity, 9000]) {
      for (const key of ['width', 'height']) {
        const m = oneImage(rawImg('i', { imageB64: P1, width: 2, height: 2, [key]: junk }));
        expect(m.count, `${key}: ${String(junk)}`).toBe(0);
        expect(m.bytes).toBe(0);
      }
    }
  });

  it('a size decode COERCES but imageNodeCost does not trust is counted as 2048 squared', () => {
    for (const junk of [true, '512', [512]]) {
      for (const key of ['width', 'height']) {
        const m = oneImage(rawImg('i', { imageB64: P1, width: 2, height: 2, [key]: junk }));
        expect(m.count, `${key}: ${String(junk)}`).toBe(1);
        expect(m.untrustedSizes).toBe(1);
        expect(m.bytes).toBe(CHAIN_2048 * 4);
      }
    }
  });

  it('a payload outside the whitelist creates no texture', () => {
    for (const payload of [
      'not a data url',
      `data:image/svg+xml;base64,${btoa('<svg/>')}`,
      `data:image/gif;base64,${btoa('GIF8')}`,
      `https://example.com/a.png`,
      '',
      5,
      null,
    ]) {
      expect(oneImage(rawImg('i', { imageB64: payload, width: 2, height: 2 })).count, String(payload)).toBe(0);
    }
  });

  it('counts an atob-invalid payload the regex admits (a documented over-report)', () => {
    expect(oneImage(img('i', { imageB64: 'data:image/png;base64,A=A=' })).count).toBe(1);
  });

  it('never throws on a primitive or prototype-shaped values object', () => {
    expect(() => oneImage(rawImg('i', 5))).not.toThrow();
    expect(oneImage(rawImg('i', 5)).count).toBe(0);
    expect(oneImage(rawImg('i', 'x')).count).toBe(0);
    expect(oneImage(rawImg('i', null)).count).toBe(0);
    const proto = { ['__proto__']: { imageB64: P2 }, imageB64: P1, width: 2, height: 2 };
    expect(() => oneImage(rawImg('i', proto))).not.toThrow();
    expect(oneImage(rawImg('i', proto)).count).toBe(1);
  });

  it('every result is a finite integer', () => {
    const cases: unknown[] = [
      { imageB64: P1, width: 8192, height: 8192 },
      { imageB64: P1, width: true, height: '7' },
      { imageB64: P1, width: 3, height: 1 },
      { imageB64: 'data:image/png;base64,A=A=', width: 1, height: 8192, colorSpace: 'data' },
    ];
    for (const values of cases) {
      const m = oneImage(rawImg('i', values));
      for (const v of Object.values(m)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});

describe('the sharing key is the emission key', () => {
  const count = (a: AppNode, b: AppNode) => {
    const g = twoImages(a, b);
    return graphTextureMemory(g.nodes, g.edges).count;
  };

  it('the same payload with the same settings is one texture, however the string was built', () => {
    const rebuilt = ['data:image/webp;base64,', btoa('abc')].join('');
    expect(count(img('a'), img('b', { imageB64: rebuilt }))).toBe(1);
  });

  it('a texture-OBJECT setting splits it', () => {
    expect(count(img('a'), img('b', { colorSpace: 'data' }))).toBe(2);
    expect(count(img('a'), img('b', { filter: 'nearest' }))).toBe(2);
    expect(count(img('a', { repeat: 0 }), img('b', { repeat: 1 }))).toBe(2);
    expect(count(img('a'), img('b', { imageB64: P2 }))).toBe(2);
  });

  it('uv maths never does', () => {
    const uvOnly: Record<string, number>[] = [{ tileX: 3 }, { offsetX: 0.5 }, { flipX: 1 }, { flipY: 1 }];
    for (const extra of uvOnly) {
      expect(count(img('a'), img('b', extra)), JSON.stringify(extra)).toBe(1);
    }
  });

  it('reads the settings exactly as graphToCode does', () => {
    // Only the literal 'data' is a data map.
    for (const cs of ['DATA', 5, 'color']) expect(count(img('a'), img('b', { colorSpace: cs }))).toBe(1);
    // Only the literal 'nearest' is Nearest.
    for (const f of ['Nearest', 1, 'linear']) expect(count(img('a'), img('b', { filter: f }))).toBe(1);
    // A non-finite repeat falls back to 1 (repeat); 0.4 is clamp; '1' is repeat.
    for (const r of [NaN, 'x', '1']) expect(count(img('a'), img('b', { repeat: r }))).toBe(1);
    expect(count(img('a', { repeat: 0 }), img('b', { repeat: 0.4 }))).toBe(1);
  });

  it('a data map carries no mip chain', () => {
    const m = oneImage(img('i', { colorSpace: 'data', width: 16, height: 8 }));
    expect(m.dataMaps).toBe(1);
    expect(m.textureBytes).toBe(16 * 8 * 4);
  });
});

describe('reachability from the ACTIVE sink', () => {
  it('an image feeding nothing costs nothing', () => {
    expect(graphTextureMemory([img('i'), out()], []).count).toBe(0);
  });

  it('an image feeding only an INACTIVE Output costs nothing', () => {
    const active = makeNode('active', 'output');
    (active.data as Record<string, unknown>).activeOutput = true;
    const idle = makeNode('idle', 'output');
    const m = graphTextureMemory([img('i'), idle, active], [makeEdge('i', 'out', 'idle', 'color')]);
    expect(m.count).toBe(0);
  });

  /** An Output carrying added materials (`data.materials`). */
  function outWith(materials: unknown[]): AppNode {
    const o = out();
    (o.data as Record<string, unknown>).materials = materials;
    return o;
  }
  /** Whether graphToCode emits an envNode -- the PMREM term must agree with it. */
  const emitsEnv = (nodes: AppNode[], edges: AppEdge[]) => /env: texture\(/.test(graphToCode(nodes, edges).code);

  it('an added material counts, and so does its Environment', () => {
    const body = () => outWith([{ meshTargets: ['Body'] }]);
    expect(graphTextureMemory([img('i'), body()], [makeEdge('i', 'out', 'out', 'm1:color')]).count).toBe(1);
    const nodes = [img('i'), body()];
    const edges = [makeEdge('i', 'out', 'out', 'm1:env')];
    expect(emitsEnv(nodes, edges)).toBe(true);
    expect(graphTextureMemory(nodes, edges).environmentBytes).toBe(pmremBytes(2));
  });

  it('no PMREM for an Environment wire graphToCode never emits', () => {
    // A handle past the node's materials (a crafted file), and a material
    // stripped of its last mesh (kept, but skipped by emission).
    for (const [output, handle] of [
      [out(), 'm7:env'],
      [outWith([{ meshTargets: [] }]), 'm1:env'],
    ] as const) {
      const nodes = [img('i'), output];
      const edges = [makeEdge('i', 'out', 'out', handle)];
      expect(emitsEnv(nodes, edges), handle).toBe(false);
      const m = graphTextureMemory(nodes, edges);
      expect(m.environmentBytes, handle).toBe(0);
      expect(m.count, handle).toBe(1); // still reachable: the cost walk's definition
    }
  });

  it('no PMREM for an Environment wire from a CHANNEL socket: graphToCode emits a scalar ambient', () => {
    // Only the Color socket (`out`) reaches the texture-object/IBL path; an
    // Alpha/R/G/B edge emits `env: vec3(imageN.<c>)`, so three builds no PMREM.
    const big = () => img('i', { width: 2048, height: 1024 });
    for (const [handle, comp] of [['alpha', 'a'], ['r', 'r'], ['g', 'g'], ['b', 'b']] as const) {
      const nodes = [big(), out()];
      const edges = [makeEdge('i', handle, 'out', 'env')];
      expect(graphToCode(nodes, edges).code, handle).toMatch(new RegExp(`env: vec3\\(\\w+\\.${comp}\\)`));
      expect(emitsEnv(nodes, edges), handle).toBe(false);
      const m = graphTextureMemory(nodes, edges);
      expect(m.environmentBytes, handle).toBe(0);
      expect(m.count, handle).toBe(1); // the texture is still sampled
    }
    const nodes = [big(), out()];
    const edges = [makeEdge('i', 'out', 'out', 'env')];
    expect(emitsEnv(nodes, edges)).toBe(true);
    expect(graphTextureMemory(nodes, edges).environmentBytes).toBe(pmremBytes(2048));
  });

  it('one image into both Environment and Color is one texture, prefiltered once', () => {
    const m = graphTextureMemory([img('i'), out()], [
      makeEdge('i', 'out', 'out', 'env'),
      makeEdge('i', 'out', 'out', 'color'),
    ]);
    expect(m.count).toBe(1);
    expect(m.environmentBytes).toBe(pmremBytes(2));
    expect(m.bytes).toBe(mipChainTexels(2, 2) * 4 + pmremBytes(2));
  });

  it("an image in an active Raymarch Output's Background chain counts, with no PMREM term", () => {
    const rm = makeNode('rm', 'raymarchOutput');
    (rm.data as Record<string, unknown>).activeOutput = true;
    const m = graphTextureMemory([img('i'), rm], [makeEdge('i', 'out', 'rm', 'background')]);
    expect(m.count).toBe(1);
    expect(m.environmentBytes).toBe(0);
  });

  it('a feeder inside a collapsed group counts once the caller unwraps', () => {
    const group = {
      id: 'g1',
      type: 'group',
      position: { x: 0, y: 0 },
      data: {
        label: 'g1',
        collapsed: true,
        collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'i', originalHandleId: 'out' }],
      },
    } as unknown as AppNode;
    const nodes = [img('i'), out(), group];
    const edges = [makeEdge('g1', 's-out', 'out', 'color')];
    expect(graphTextureMemory(nodes, edges).count).toBe(0);
    expect(graphTextureMemory(nodes, unwrapCollapsedGroupEdges(nodes, edges)).count).toBe(1);
  });

  it('a graph with no sink is the frozen zero', () => {
    expect(graphTextureMemory([img('i')], [])).toBe(NO_TEXTURE_MEMORY);
  });
});

describe('the count agrees with what graphToCode emits', () => {
  const TEXTURE_RE = /new globalThis\.THREE\.Texture\(/g;
  const NO_MIPS_RE = /\.generateMipmaps = false;/g;
  const fixtures: Record<string, { nodes: AppNode[]; edges: AppEdge[] }> = {
    'one image into Color': { nodes: [img('i'), out()], edges: [makeEdge('i', 'out', 'out', 'color')] },
    'two different payloads': twoImages(img('a'), img('b', { imageB64: P2 })),
    'two identical payloads, same settings': twoImages(img('a'), img('b')),
    'one image into Environment and Color': {
      nodes: [img('i'), out()],
      edges: [makeEdge('i', 'out', 'out', 'env'), makeEdge('i', 'out', 'out', 'color')],
    },
    'a colour image beside a data map': twoImages(img('a'), img('b', { imageB64: P2, colorSpace: 'data' })),
  };

  for (const [name, { nodes, edges }] of Object.entries(fixtures)) {
    it(name, () => {
      const { code } = graphToCode(nodes, edges);
      const m = graphTextureMemory(nodes, edges);
      expect(m.count).toBe((code.match(TEXTURE_RE) ?? []).length);
      expect(m.dataMaps).toBe((code.match(NO_MIPS_RE) ?? []).length);
      expect(m.count).toBeGreaterThan(0);
    });
  }
});

describe('the PMREM term mirrors three r184, and fails loudly if three moves', () => {
  it('a 2048x1024 equirect: PMREM is ~4.5x the image, as the header and CLAUDE.md state', () => {
    const MiB = 1024 * 1024;
    const image = mipChainTexels(2048, 1024) * 4;
    expect(image / MiB).toBeCloseTo(10.67, 2);
    expect(pmremBytes(2048)).toBe(48 * MiB);
    expect(pmremBytes(2048) / image).toBeCloseTo(4.5, 2);
    expect((pmremBytes(2048) + image) / image).toBeCloseTo(5.5, 2);
    const header = read('./textureMemory.ts').replace(/\n \*\s+/g, ' ');
    expect(header).toContain("For a 2048x1024 equirect that is 48 MiB beside the image's own 10.7 MiB");
    expect(header).toContain('under-report an env-lit shader about 5.5x');
    expect(read('../../CLAUDE.md')).toContain('about 4.5× (48 MiB beside 10.7 MiB for a 2048×1024 equirect)');
  });

  it('PMREMGenerator sizes, types and keeps its targets as priced', () => {
    const src = read('../../node_modules/three/src/renderers/common/extras/PMREMGenerator.js');
    for (const anchor of [
      'this._setSize( texture.image.width / 4 )',
      'this._lodMax = Math.floor( Math.log2( cubeSize ) )',
      'this._cubeSize = Math.pow( 2, this._lodMax )',
      '3 * Math.max( this._cubeSize, 16 * 7 )',
      '4 * this._cubeSize',
      'type: HalfFloatType',
      'generateMipmaps: false',
      'this._pingPongRenderTarget = _createRenderTarget( renderTarget.width, renderTarget.height )',
    ]) {
      expect(src, anchor).toContain(anchor);
    }
  });

  it('EnvironmentNode prefilters a texture envNode', () => {
    const src = read('../../node_modules/three/src/nodes/lighting/EnvironmentNode.js');
    const at = src.indexOf('envNode.isTextureNode');
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf('pmremTexture( value )', at)).toBeGreaterThan(at);
  });
});

describe('the strings', () => {
  const placeholders = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();

  it.each([TEXTURE_MEMORY_ONE_KEY, TEXTURE_MEMORY_MANY_KEY, TEXTURE_MEMORY_HINT_KEY])(
    'has a Latvian entry with the same placeholders: %s',
    (key) => {
      expect(typeof UI[key]).toBe('string');
      expect(UI[key]).not.toBe(key);
      expect(placeholders(UI[key])).toEqual(placeholders(key));
    },
  );

  it('fills the one/other sentences in both languages', () => {
    expect(textureMemoryLine(22_369_620, 1, 'lv')).toBe('Tekstūru atmiņa: ~21,4 MB (1 tekstūra)');
    expect(textureMemoryLine(89_478_484, 2, 'en')).toBe('Texture memory: ~85.4 MB (2 textures)');
    expect(textureMemoryLine(89_478_484, 21, 'lv')).toBe('Tekstūru atmiņa: ~85,4 MB (tekstūru skaits: 21)');
    expect(textureMemoryLine(684, 1, 'en')).toBe('Texture memory: ~0.1 MB (1 texture)');
  });

  it('leaves no placeholder behind', () => {
    for (const lang of ['en', 'lv'] as const) {
      for (const n of [1, 2, 7]) expect(textureMemoryLine(1234567, n, lang)).not.toContain('{');
    }
  });
});

describe('the surface and the import rule', () => {
  const menu = read('../components/NodeEditor/menus/ShaderSettingsMenu.tsx');
  const mod = read('./textureMemory.ts');

  it('the menu memoises on the RAW arrays and unwraps inside the memo', () => {
    const at = menu.indexOf('function textureMemoryKey(');
    expect(at).toBeGreaterThan(-1);
    const body = menu.slice(at, menu.indexOf('\n}\n', at));
    expect(body).toContain('.nodes === nodes && ');
    expect(body).toContain('.edges === edges');
    expect(body).toContain('graphTextureMemory(');
    expect(body).toContain('unwrapCollapsedGroupEdges(');
  });

  it('the line is hidden in every study arm and when nothing is counted', () => {
    expect(menu).toContain('const showTextureMemory = !isEvalMode();');
    expect(menu).toContain('showTextureMemory && texCount > 0 && (');
    expect(menu).toContain('title={t(TEXTURE_MEMORY_HINT_KEY, language)}');
    expect(menu).toContain('textureMemoryLine(texBytes, texCount, language)');
  });

  it('textureMemory.ts imports neither edgeUtils, nodeCost nor the store (the costTable.ts lesson)', () => {
    const imports = mod.split('\n').filter((l) => /^import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/['"]\.\/edgeUtils['"]|['"]\.\/nodeCost['"]|['"]@\/store|useAppStore/);
    }
  });

  it("nodeCost's comment points at the figure", () => {
    expect(read('./nodeCost.ts')).toContain('priced in points at all — utils/textureMemory.ts reports it as a separate');
  });
});
