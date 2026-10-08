import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { parse } from '@babel/parser';
import { MODULE_HELPERS } from './moduleHelpers';
import { withHelpers, tslTokenHits } from '@/lutHelperHarness';
import { toHalfFloat } from '@/utils/binaryCodec';
import { unitToken, hexToken, wordToken, splitRecords } from '@/utils/pointListCodec';
import { srgbToLinear01 } from '@/utils/colorUtils';
import { halfTable, FS_LUT_SIZE } from '@/utils/lutTable';

/**
 * `fsLut` is the plain-JS core the Color Ramp / RGB Curves helpers bake their
 * tables with, at MODULE LOAD inside the preview, the export and podest. Its
 * grammar and its half-float encoder have TS twins (utils/pointListCodec.ts,
 * utils/lutTable.ts, binaryCodec) that the editor, the card art and the CPU
 * evaluator read; a disagreement would show one ramp on the card and another
 * in the export. These run the EMITTED text (lutHelperHarness.ts) against the
 * twins over one adversarial corpus.
 */

const JS_HELPERS = [...MODULE_HELPERS].filter(([, h]) => h.kind === 'js');

/** Every token the grammar must refuse or accept the same way on both sides. */
const TOKENS: string[] = [
  '', '0', '1', '0.5', '.5', '5.', '.', '..', '1.2.3', '-0', '-0.5', '+1', '1e3', '1E3', '0x1f', 'Infinity', 'NaN',
  ' 1', '1 ', '\t1', '1\n', '1 ', '١', '１', '123456789012', '1234567890123', '0000000000.1', '1_0',
  '#000000', '#FFFFFF', '#ffaa09', '#AbCdEf', '#00000', '#0000000', '000000', '##0000', '#GGGGGG', '#@@@@@@', '#``````',
  '#gggggg', '#//////', '#::::::', '#\u0010\u0010\u0010\u0010\u0010\u0010', '#\u0019\u0019\u0019\u0019\u0019\u0019',
  '#ＦＦＦＦＦＦ', 'auto', 'vector', 'Auto', 'a1', 'abcdefghijkl', 'abcdefghijklm', 'é', '__proto__',
  'constructor', 'toString',
  ...Array.from({ length: 0x20 }, (_, k) => '#' + String.fromCharCode(k).repeat(6)),
];

const RECORD_STRINGS: string[] = [
  '0 #000000 1,1 #ffffff 1', ' 0  #000000  1 ,1 #ffffff 1 ', '0 0,1 1', '0 0 auto,1 1', '', ',', ',,', '0 0,', 'a,b,c',
  '0\t0,1 1', '0 0 1 1', '0 0,1 1 ', ' 0 0', Array(33).fill('0 0').join(','), Array(32).fill('0 0').join(','),
  '0'.repeat(1024), '0'.repeat(1025), '0 #000000 1</script>', '0 0/*,*/1 1',
];

describe('fsLut — the emitted text against its TS twins', () => {
  it('half is binaryCodec.toHalfFloat, bit for bit', () => {
    const corpus = [0, -0, 1, -1, 0.5, 1 / 3, 65504, 65519, 65520, 70000, -70000, 6.1e-5, 5.96e-8, 2.98e-8, 1e-9, 3e-8,
      NaN, Infinity, -Infinity, 0.1, 0.2, 0.30000001, 1e-5, 1 - 1e-7];
    for (let i = 0; i < 4000; i++) corpus.push(Math.sin(i * 12.9898) * 43758.5453 % 3, (i - 2000) / 997, i * 1e-6);
    withHelpers(['fsLut'], ({ fsLut }) => {
      for (const v of corpus) expect(fsLut.half(v), String(v)).toBe(toHalfFloat(v));
    });
  });

  it('unit / hex / word agree with pointListCodec over the adversarial corpus', () => {
    withHelpers(['fsLut'], ({ fsLut }) => {
      for (const s of TOKENS) {
        const label = JSON.stringify(s);
        expect(fsLut.unit(s), label).toBe(unitToken(s));
        expect(fsLut.word(s), label).toBe(wordToken(s));
        const h = hexToken(s);
        const lin = fsLut.hex(s);
        if (h === null) {
          expect(lin, label).toBeNull();
        } else {
          // The helper decodes straight to LINEAR light; the twin keeps the hex. Same colour, one decode.
          const want = [1, 3, 5].map((o) => srgbToLinear01(parseInt(h.slice(o, o + 2), 16) / 255));
          expect(lin, label).toEqual(want);
        }
      }
    });
  });

  it('rows agrees with splitRecords for every bound', () => {
    withHelpers(['fsLut'], ({ fsLut }) => {
      for (const s of RECORD_STRINGS) {
        for (const [lo, hi] of [[1, 32], [2, 32]]) {
          expect(fsLut.rows(s, lo, hi), `${JSON.stringify(s.slice(0, 40))} ${lo}..${hi}`).toEqual(splitRecords(s, lo, hi));
        }
      }
    });
  });

  it('make bakes ONE half-float RGBA ClampToEdge texture per key, Linear or Nearest', () => {
    const vals = new Float32Array(FS_LUT_SIZE * 4);
    for (let i = 0; i < vals.length; i++) vals[i] = (i % 4) / 3 + i * 1e-4;
    withHelpers(['fsLut'], ({ fsLut }, made) => {
      let bakes = 0;
      const bake = () => {
        bakes++;
        return { vals, slopes: [1, 2] };
      };
      const a = fsLut.make('k1', false, bake);
      const b = fsLut.make('k1', false, bake);
      expect(b).toBe(a);
      expect(bakes).toBe(1);
      expect(made).toHaveLength(1);
      const tex = a.tex as THREE.DataTexture;
      expect(made[0]).toBe(tex);
      expect(a.slopes).toEqual([1, 2]);
      expect(tex.image.width).toBe(FS_LUT_SIZE);
      expect(tex.image.height).toBe(1);
      expect(tex.format).toBe(THREE.RGBAFormat);
      expect(tex.type).toBe(THREE.HalfFloatType);
      expect(tex.minFilter).toBe(THREE.LinearFilter);
      expect(tex.magFilter).toBe(THREE.LinearFilter);
      expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping);
      expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
      expect(tex.version).toBeGreaterThan(0);
      // The bytes the GPU gets are exactly the CPU twin's table.
      expect([...(tex.image.data as Uint16Array)]).toEqual([...halfTable(vals)]);

      const n = fsLut.make('k2', true, bake);
      expect(n.tex).not.toBe(tex);
      expect(n.tex.minFilter).toBe(THREE.NearestFilter);
      expect(n.tex.magFilter).toBe(THREE.NearestFilter);
      expect(made).toHaveLength(2);
    });
  });

  it('at samples the texture through the half-texel inset at level 0', () => {
    withHelpers(['fsLut'], ({ fsLut }) => {
      const { tex } = fsLut.make('k', false, () => ({ vals: new Float32Array(FS_LUT_SIZE * 4), slopes: null }));
      const node = fsLut.at(tex, 0.5);
      expect(node.value).toBe(tex);
      expect(node.levelNode).toBeTruthy();
    });
  });

  it('withHelpers restores globalThis.THREE and refuses an async callback', () => {
    const g = globalThis as Record<string, unknown>;
    const before = g.THREE;
    withHelpers(['fsLut'], () => {
      expect(g.THREE).toBeTruthy();
    });
    expect(g.THREE).toBe(before);
    expect(() => withHelpers(['fsLut'], async () => 1)).toThrow(/sync-only/);
    expect(g.THREE).toBe(before);
  });
});

describe('plain-JS helper text hygiene', () => {
  it('there is at least one js helper (a vacuous sweep would pass on nothing)', () => {
    expect(JS_HELPERS.length).toBeGreaterThan(0);
  });

  for (const [name, h] of JS_HELPERS) {
    const text = h.lines.join('\n');

    it(`${name}: exactly ONE top-level statement, \`const ${name} = …;\``, () => {
      const ast = parse(text, { sourceType: 'module' });
      expect(ast.program.body).toHaveLength(1);
      const decl = ast.program.body[0];
      expect(decl.type).toBe('VariableDeclaration');
      if (decl.type !== 'VariableDeclaration') return;
      expect(decl.kind).toBe('const');
      expect(decl.declarations).toHaveLength(1);
      expect(decl.declarations[0].id).toMatchObject({ type: 'Identifier', name });
    });

    it(`${name}: no token the loader would import beyond its own imports (strings included)`, () => {
      expect(tslTokenHits(text, [...h.imports, 'Fn'])).toEqual([]);
    });

    it(`${name}: none of the shapes the loaders, the parse or the splat sweep key on`, () => {
      expect(text).not.toMatch(/import \{|params\.\w|const \w+ = uniform\(|Fn\(\(\) => \{|\buv\(/);
      expect(text).not.toMatch(/\b(positionGeometry|positionLocal|positionWorld|positionView|normalLocal|normalWorld|screenUV|tangentLocal)\b/);
      expect(text).not.toMatch(/\b(const|let|var)\s+THREE\b|globalThis\.THREE\s*=[^=]/);
      expect(text).not.toContain('"');
      // No regex literal: the loaders' text transforms cannot tell one from a division.
      expect(JSON.stringify(parse(text, { sourceType: 'module' }).program)).not.toContain('"type":"RegExpLiteral"');
    });
  }
});
