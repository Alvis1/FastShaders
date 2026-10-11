import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { parse } from '@babel/parser';
import { MODULE_HELPERS } from './moduleHelpers';
import { withHelpers, withRecordingThree, tslTokenHits } from '@/lutHelperHarness';
import { toHalfFloat } from '@/utils/binaryCodec';
import { unitToken, hexToken, wordToken, splitRecords } from '@/utils/pointListCodec';
import { srgbToLinear01 } from '@/utils/colorUtils';
import { halfTable, FS_LUT_SIZE } from '@/utils/lutTable';
import { readColorRamp, rampHalfTable, rampTableKey, RAMP_INTERPS } from '@/utils/colorRamp';
import { readRgbCurves, rgbCurvesHalf, curvesTableKey, IDENTITY_CURVE } from '@/utils/rgbCurves';
import { vec3 } from 'three/tsl';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';

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

  it('withHelpers and withRecordingThree (the ONE THREE swap) restore globalThis.THREE and refuse an async callback', () => {
    const g = globalThis as Record<string, unknown>;
    const before = g.THREE;
    withHelpers(['fsLut'], () => {
      expect(g.THREE).toBeTruthy();
    });
    expect(g.THREE).toBe(before);
    expect(() => withHelpers(['fsLut'], async () => 1)).toThrow(/sync-only/);
    expect(g.THREE).toBe(before);
    withRecordingThree((three) => {
      expect(g.THREE).toBe(three);
    });
    expect(g.THREE).toBe(before);
    expect(() => withRecordingThree(async () => 1)).toThrow(/sync-only/);
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

/** The baked texture's `fsLut.make` cache entry, probed with the TS spelling of its key (`rampTableKey` /
 *  `curvesTableKey`, what graphToCode counts the texture budget by): a miss THROWS rather than baking. */
const cached = (h: Record<string, any>, key: string, nearest: boolean): { tex: THREE.DataTexture; slopes: number[] | null } =>
  h.fsLut.make(key, nearest, () => {
    throw new Error(`cache miss: the helper keyed this table differently from ${JSON.stringify(key.slice(0, 60))}`);
  });

/**
 * Color Ramp DRIFT: the helper is fed EXACTLY what codegen emits —
 * `readColorRamp(values).canonical` / `.interp`, never the raw stored string —
 * and the texture it bakes must equal the CPU twin's half table bit for bit,
 * cached under `rampTableKey` (so the texture budget counts what the helper
 * makes). The second half pins that the emitted call really carries those two
 * strings, so the test and codegen cannot feed the helper different input.
 */
describe('fsColorRamp — the emitted bake against rampHalfTable', () => {
  const STOPS: (string | undefined)[] = [
    undefined,
    '0 #ff0000 1,1 #0000ff 0',
    '0 #000000 1,0.5 #ff8800 0.5,1 #ffffff 1',
    '0.4 #336699 0.8',
    '0.5 #ff0000 1,0.5 #00ff00 0.5',
    '1 #ffffff 1,0 #000000 1,0.3 #123456 0.7',
    '0 #FF00AA 1,1 #00ffAA 0.5',
    '0.2 #ff0000 1,0.8 #0000ff 0.25',
    '0.12345678 #abcdef 1,0.99996 #fedcba 0.333333',
    Array.from({ length: 32 }, (_, i) => `${(i / 31).toFixed(5)} #${(i * 8).toString(16).padStart(2, '0')}40c0 ${((i % 5) / 4).toFixed(2)}`).join(','),
    'garbage',
    '0 #zz0000 1',
    '0 #000000 1</script>',
  ];
  const INTERPS: unknown[] = [...RAMP_INTERPS];
  const corpus: { stops: string | undefined; interp: unknown }[] = [];
  for (const stops of STOPS) for (const interp of INTERPS) corpus.push({ stops, interp });
  corpus.push({ stops: '0 #ff0000 1,1 #0000ff 0', interp: 'Linear' }, { stops: undefined, interp: '__proto__' });

  it(`the corpus is the size the spec asks for (${corpus.length} entries)`, () => {
    expect(corpus.length).toBeGreaterThanOrEqual(60);
  });

  for (const { stops, interp } of corpus) {
    it(`${String(stops).slice(0, 40)} / ${String(interp)}: bit-exact table, 257 wide, Nearest iff Constant`, () => {
      const r = readColorRamp({ stops, interp });
      withHelpers(['fsColorRamp'], (h, made) => {
        h.fsColorRamp(0.5, r.canonical, r.interp);
        expect(made).toHaveLength(1);
        const tex = made[0];
        expect([...(tex.image.data as Uint16Array)]).toEqual([...rampHalfTable(r)]);
        expect(tex.image.width).toBe(FS_LUT_SIZE);
        const filter = r.interp === 'constant' ? THREE.NearestFilter : THREE.LinearFilter;
        expect([tex.minFilter, tex.magFilter]).toEqual([filter, filter]);
        expect(cached(h, rampTableKey(r), r.interp === 'constant').tex).toBe(tex);
        // Equal arguments, one texture.
        h.fsColorRamp(0.25, r.canonical, r.interp);
        expect(made).toHaveLength(1);
      });
      const values: Record<string, string | number> = { fac: 0.5 };
      if (stops !== undefined) values.stops = stops;
      if (typeof interp === 'string') values.interp = interp;
      const code = graphToCode([makeNode('c', 'colorRamp', values), makeNode('out', 'output')], [makeEdge('c', 'out', 'out', 'color')]).code;
      expect(code).toContain(`fsColorRamp(0.5, ${JSON.stringify(r.canonical)}, ${JSON.stringify(r.interp)});`);
    });
  }

  it('an unreadable string bakes the DEFAULT ramp, whatever reaches the helper', () => {
    withHelpers(['fsColorRamp'], (h, made) => {
      h.fsColorRamp(0.5, '0 #zz0000 1', 'nope');
      expect([...(made[0].image.data as Uint16Array)]).toEqual([...rampHalfTable(readColorRamp({}))]);
    });
  });
});

describe('fsRgbCurves — the emitted bake against rgbCurvesHalf', () => {
  // The helper is fed EXACTLY what codegen emits (the reader's canonical strings), never a raw stored value:
  // the auto handles amplify any difference between a raw and a rounded point.
  const CURVES: (string | undefined)[] = [
    undefined,
    '0 0,1 1',
    '0 0.2,1 0.8',
    '0 0,0.25 0.15,0.75 0.85,1 1',
    '0 0,0.3 0.1,0.6 0.9,1 1',
    '0 0,0.5 1,1 0',
    '0 1,1 0',
    '0 0,0.5 0.5,1 1',
    '0.1 0,0.9 1',
    '0 0,0 1,1 1',
    '0 0,1 0,1 1',
    '0.5 0,0.5 1',
    '0.5 0.2,0.5 0.5,0.5 0.9',
    '0 0 auto,1 1 vector',
    '0 0,0.4 0.6 auto,1 1',
    '0.123456 0.98765,0.5 0.25',
    '0 0.00001,0.99999 1',
    '0 0.5,1 0.5',
    '0 0,0.02 1,1 1',
    '0 0,0.98 0,1 1',
    '0.2 0.3,0.4 0.1,0.6 0.9,0.8 0.7',
    Array.from({ length: 32 }, (_, i) => `${(i / 31).toFixed(4)} ${(0.5 + 0.5 * Math.sin(i)).toFixed(4)}`).join(','),
    Array.from({ length: 8 }, (_, i) => `${(i / 7).toFixed(3)} ${((i * 3) % 7 / 6).toFixed(3)}`).join(','),
    'garbage',
    '0 0',
    '0 0,1 1 Auto',
    '0 0,1 -1',
    '0 0,1 1e0',
    '0 0,1 1</script>',
  ];
  const corpus: Record<string, string>[] = [];
  CURVES.forEach((cv, i) => {
    const pick = (k: number) => CURVES[(i + k) % CURVES.length];
    for (const extend of ['extrapolate', 'horizontal']) {
      const v: Record<string, string> = {};
      if (cv !== undefined) v.curveC = cv;
      const r = pick(3);
      const g = pick(7);
      if (r !== undefined && i % 2 === 0) v.curveR = r;
      if (g !== undefined && i % 3 === 0) v.curveG = g;
      if (i % 4 === 1 && pick(11) !== undefined) v.curveB = pick(11)!;
      if (extend === 'horizontal') v.extend = 'horizontal';
      corpus.push(v);
    }
  });
  corpus.push({ extend: 'Horizontal' }, { curveR: '0 0.1,1 1' }, { curveB: '0 0,0.5 0.8,1 1', extend: 'nope' });
  // COINCIDENT points, as the editor itself makes them — the middle point of '0 0,0.5 0.5,1 1' dragged onto a corner,
  // a tap in the plot's corner padding, two points squeezed together at the top: they are the only curves here that
  // reach the zero-length-handle branches (`hypot(…) || 1`, the `tl === 0` skip, `fix()` → null, unitDir's [1, 0]),
  // so a one-sided edit there (the card and the CPU against the GPU) fails this suite rather than passing it. (The
  // `|| 1` VALUE is unobservable — the span-0 correction collapses whatever handle it scales — but dropping it bakes
  // NaN, and that is caught.)
  for (const cv of ['0 0,1 1,1 1', '0 0,0 0,1 1', '0.5 1,0.75 1,0.75 1']) {
    corpus.push({ curveC: cv }, { curveC: cv, extend: 'horizontal' }, { curveG: cv, curveB: '0 0.2,1 0.8' });
  }

  it(`the corpus is the size the spec asks for (${corpus.length} entries)`, () => {
    expect(corpus.length).toBeGreaterThanOrEqual(60);
  });

  for (const values of corpus) {
    it(`${JSON.stringify(values).slice(0, 70)}: bit-exact table, exact slopes, one texture`, () => {
      const c = readRgbCurves(values);
      withHelpers(['fsRgbCurves'], (h, made) => {
        h.fsRgbCurves(vec3(0.5), 1, c.c.canonical, c.r.canonical, c.g.canonical, c.b.canonical, c.extend);
        if (c.identity) {
          // Identity + Extrapolated is a bare vec3(): no texture, no binding — and no table key to count.
          expect(made).toHaveLength(0);
          expect(curvesTableKey(c)).toBeNull();
          return;
        }
        expect(made).toHaveLength(1);
        const { half, slopes } = rgbCurvesHalf(c);
        expect([...(made[0].image.data as Uint16Array)]).toEqual([...half]);
        expect(made[0].image.width).toBe(FS_LUT_SIZE);
        expect([made[0].minFilter, made[0].magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter]);
        const hit = cached(h, curvesTableKey(c)!, false);
        expect(hit.tex).toBe(made[0]);
        expect(hit.slopes).toEqual(slopes);
        // Equal arguments, one texture.
        h.fsRgbCurves(vec3(0.2), 0.5, c.c.canonical, c.r.canonical, c.g.canonical, c.b.canonical, c.extend);
        expect(made).toHaveLength(1);
      });
      const code = graphToCode([makeNode('k', 'rgbCurves', values), makeNode('out', 'output')], [makeEdge('k', 'out', 'out', 'color')]).code;
      const s = (k: 'c' | 'r' | 'g' | 'b') => JSON.stringify(c[k].canonical);
      expect(code).toContain(`fsRgbCurves(1, 1, ${s('c')}, ${s('r')}, ${s('g')}, ${s('b')}, ${JSON.stringify(c.extend)});`);
    });
  }

  it('identity + Horizontal bakes the identity table (Blender clamps it), never the shortcut', () => {
    const c = readRgbCurves({ extend: 'horizontal' });
    expect(c.identity).toBe(false);
    withHelpers(['fsRgbCurves'], (h, made) => {
      h.fsRgbCurves(vec3(0.5), 1, IDENTITY_CURVE, IDENTITY_CURVE, IDENTITY_CURVE, IDENTITY_CURVE, 'horizontal');
      expect(made).toHaveLength(1);
      const data = made[0].image.data as Uint16Array;
      for (let i = 0; i < FS_LUT_SIZE; i++) expect(data[i * 4 + 3]).toBe(toHalfFloat(Math.fround(i / 256)));
    });
  });

  it('an unreadable curve string bakes the straight line, whatever reaches the helper', () => {
    withHelpers(['fsRgbCurves'], (h, made) => {
      h.fsRgbCurves(vec3(0.5), 1, '0 0,1 1 BAD', 'nope', '0 0', '0 0,1 1', 'horizontal');
      expect([...(made[0].image.data as Uint16Array)]).toEqual([...rgbCurvesHalf(readRgbCurves({ extend: 'horizontal' })).half]);
    });
  });
});
