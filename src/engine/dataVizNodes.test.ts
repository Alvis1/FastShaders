import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';
import { makeDataNodeData } from '@/utils/dataNode';
import { LUT_SIZE, LUT_COORD_SCALE, LUT_COORD_OFFSET } from '@/utils/colormaps';

/**
 * Emission tests for the Colormap / Data Range / Isolines nodes.
 *
 * These three carry the scientific claims of the dataviz family — an exact
 * colormap, an honest domain, and readable contours — so what is pinned here is
 * the part a plausible-looking refactor would break silently: which colour
 * space the LUT is in, whether the domain came from the data or from a
 * placeholder, and that the contour derivative is taken of the CONTINUOUS phase
 * rather than of fract().
 */

function expectValidModule(code: string) {
  expect(() => parse(code, { sourceType: 'module' })).not.toThrow();
}

/** col0 = 0…4 (a clean linear ramp), col1 = an asymmetric range crossing zero. */
function dataValues() {
  return makeDataNodeData(
    {
      columnNames: ['ramp', 'signed'],
      columns: [
        [0, 1, 2, 3, 4],
        [-2, -1, 0, 1, 4],
      ],
      rowCount: 5,
    },
    2,
  ).values;
}

describe('graphToCode: Colormap', () => {
  const build = (values: Record<string, string | number>) => {
    const cm = makeNode('c1', 'colormap', values);
    const output = makeNode('out', 'output', {});
    return graphToCode([cm, output], [makeEdge('c1', 'out', 'out', 'color')]);
  };

  it('bakes a 256-texel RGBA half-float LUT clamped at both ends', () => {
    const gen = build({ map: 'viridis' });
    expectValidModule(gen.code);
    expect(gen.code).toContain(
      `new globalThis.THREE.DataTexture(new Uint16Array(`,
    );
    expect(gen.code).toContain(`, ${LUT_SIZE}, 1, globalThis.THREE.RGBAFormat, globalThis.THREE.HalfFloatType)`);
    // ClampToEdge is what makes an out-of-domain value saturate at the ramp end
    // instead of wrapping round to the opposite colour — a wrap would invent a
    // discontinuity exactly where the data is most extreme.
    expect(gen.code).toContain('_colormap1_lut.wrapS = globalThis.THREE.ClampToEdgeWrapping;');
    expect(gen.code).toContain('_colormap1_lut.minFilter = globalThis.THREE.LinearFilter;');
    // Module scope, before the shader Fn.
    expect(gen.code.indexOf('DataTexture')).toBeLessThan(gen.code.indexOf('Fn(() => {'));
  });

  it('samples with the half-texel inset and takes .rgb', () => {
    const gen = build({ map: 'viridis' });
    expect(gen.code).toContain(
      `const colormap1 = texture(_colormap1_lut, vec2(uv().x.mul(${LUT_COORD_SCALE}).add(${LUT_COORD_OFFSET}), 0.5)).rgb;`,
    );
  });

  it('ramps across uv.x when nothing is wired, so the node shows its map', () => {
    expect(build({}).code).toContain('uv().x.mul(');
  });

  it('quantizes to band centres when levels >= 2', () => {
    const gen = build({ map: 'viridis', levels: 4 });
    // clamp keeps t = 1 inside the top band; +0.5 picks the band CENTRE, which
    // is what the settings-menu preview draws.
    expect(gen.code).toContain(
      'const _colormap1_q = uv().x.clamp(0.0, 0.999999).mul(4).floor().add(0.5).div(4);',
    );
    expect(gen.code).toContain('vec2(_colormap1_q.mul(');
  });

  it('treats levels 0 and 1 as continuous', () => {
    for (const levels of [0, 1]) {
      expect(build({ map: 'viridis', levels }).code).not.toContain('.floor()');
    }
  });

  it('falls back to the default map for an unknown id and never injects it', () => {
    // The id rides a .fastshader file. It must not reach the emitted module.
    const nasty = build({ map: '"); evil(("' });
    expect(nasty.code).not.toContain('evil');
    expect(nasty.code).toBe(build({ map: 'viridis' }).code);
    expectValidModule(nasty.code);
  });

  it('reverse changes the baked table, not the emitted expression', () => {
    const fwd = build({ map: 'viridis' });
    const rev = build({ map: 'viridis', reverse: 1 });
    expect(rev.code).not.toBe(fwd.code);
    // Same fetch either way — the flip costs nothing per fragment.
    const fetchLine = (c: string) => c.split('\n').find((l) => l.includes('texture(_colormap1_lut'));
    expect(fetchLine(rev.code)).toBe(fetchLine(fwd.code));
  });

  it('is 3-channel, so the Output colour channel needs no widening', () => {
    // A 1-channel source on `color` gets wrapped in vec3(...) because TSL
    // splats a scalar across all four components, alpha included — a colormap
    // is already vec3, so it must go through untouched.
    const code = build({ map: 'viridis' }).code;
    expect(code).toContain('return colormap1;');
    expect(code).not.toContain('vec3(colormap1)');
  });
});

describe('graphToCode: Data Range', () => {
  const build = (values: Record<string, string | number>, handle = 'col0') => {
    const data = makeNode('d1', 'dataNode', dataValues());
    const norm = makeNode('n1', 'dataRange', values);
    const output = makeNode('out', 'output', {});
    return graphToCode(
      [data, norm, output],
      [makeEdge('d1', handle, 'n1', 'value'), makeEdge('n1', 'out', 'out', 'opacity')],
    );
  };

  it('bakes the wired column\'s own min/max', () => {
    const gen = build({ mode: 'minmax' });
    expectValidModule(gen.code);
    // col0 spans 0…4 → subtract 0, scale by 1/4. Multiply-by-reciprocal, not
    // divide: same result, a quarter of the cost in the complexity table.
    expect(gen.code).toContain('const dataRange1 = data1_col0.sub(0).mul(0.25).clamp(0.0, 1.0);');
  });

  it('symmetric mode puts zero at exactly 0.5 of the ramp', () => {
    // col1 spans -2…4, so the domain must be ±4 — NOT the -2…4 extent, or the
    // neutral colour of a diverging map would sit at 0.33 instead of on zero.
    const gen = build({ mode: 'symmetric' }, 'col1');
    expect(gen.code).toContain('const dataRange1 = data1_col1.sub(-4).mul(0.125).clamp(0.0, 1.0);');
  });

  it('log mode emits a log2 chain floored at the domain minimum', () => {
    const gen = build({ mode: 'log' });
    expectValidModule(gen.code);
    expect(gen.code).toMatch(/data1_col0\.max\([\d.e-]+\)\.log2\(\)\.sub\(/);
  });

  it('symlog mode is defined at zero and centres on 0.5', () => {
    const gen = build({ mode: 'symlog' }, 'col1');
    expectValidModule(gen.code);
    expect(gen.code).toContain('.sign()');
    expect(gen.code).toContain('.add(1.0).log2()');
    expect(gen.code).toContain('.mul(0.5).add(0.5)');
  });

  it('uses the manual domain when the mode is manual', () => {
    const gen = build({ mode: 'manual', domainMin: 1, domainMax: 3 });
    expect(gen.code).toContain('const dataRange1 = data1_col0.sub(1).mul(0.5).clamp(0.0, 1.0);');
  });

  it('falls back to the manual domain when no Data column is traceable', () => {
    // One hop only: an intervening node means "no statistics", not a guess.
    const norm = makeNode('n1', 'dataRange', { mode: 'minmax', domainMin: 0, domainMax: 2 });
    const output = makeNode('out', 'output', {});
    const gen = graphToCode([norm, output], [makeEdge('n1', 'out', 'out', 'opacity')]);
    expect(gen.code).toContain('const dataRange1 = uv().x.sub(0).mul(0.5).clamp(0.0, 1.0);');
  });

  it('an unknown mode degrades to minmax rather than emitting it', () => {
    const gen = build({ mode: 'evil(); //' });
    expect(gen.code).not.toContain('evil');
    expect(gen.code).toBe(build({ mode: 'minmax' }).code);
  });

  it('drops the clamp when the user turns it off', () => {
    expect(build({ mode: 'minmax', clamp: 0 }).code).toContain(
      'const dataRange1 = data1_col0.sub(0).mul(0.25);',
    );
  });

  it('never emits a division by zero for a flat column', () => {
    const data = makeNode('d1', 'dataNode', makeDataNodeData(
      { columnNames: ['flat'], columns: [[7, 7, 7, 7]], rowCount: 4 },
      2,
    ).values);
    const norm = makeNode('n1', 'dataRange', { mode: 'minmax' });
    const output = makeNode('out', 'output', {});
    const gen = graphToCode(
      [data, norm, output],
      [makeEdge('d1', 'col0', 'n1', 'value'), makeEdge('n1', 'out', 'out', 'opacity')],
    );
    expectValidModule(gen.code);
    expect(gen.code).not.toContain('Infinity');
    expect(gen.code).toContain('.mul(1)'); // widened to a unit-wide domain
  });

  /**
   * The custom-formula key. The whole feature rests on one storage rule: an
   * ABSENT (or unusable) `formula` emits exactly what this node emitted before
   * the feature existed, so every already-saved graph and every already-exported
   * `.js` is byte-identical.
   */
  describe('custom formula', () => {
    const MODES = ['minmax', 'robust', 'symmetric', 'zscore', 'log', 'symlog', 'manual'];

    it('emits identically to an untouched node when nothing was authored', () => {
      // The byte-stability sweep, and the reason it is worth its length: an
      // EXISTING saved graph has no `formula` key, and a corrupt or tampered one
      // produces a NON-STRING (the fs:graph autosave turns a non-finite into
      // `null`). Every value here must leave NOT ONE BYTE different — a coercing
      // read (String(), Number(), a truthiness test) would break at least one,
      // and `String(['(v-lo)'])` is a *valid formula*, which is exactly why the
      // read is an exact `typeof === 'string'`.
      //
      // Whitespace-only counts as "nothing authored": parseFormula trims first,
      // so the shader is already emitting the plain built-in chain, and every
      // surface must agree (hasCustomFormula is the one predicate).
      const NOT_AUTHORED: unknown[] = [
        undefined, null, '', '   ', '\t\n ', 0, 1, true, false, [], {}, NaN, Infinity, ['(v-lo)'],
      ];
      for (const mode of MODES) {
        const baseline = build({ mode }).code;
        for (const junk of NOT_AUTHORED) {
          const withJunk = build({ mode, formula: junk } as Record<string, string | number>).code;
          expect(withJunk, `${mode} + ${JSON.stringify(junk)}`).toBe(baseline);
        }
      }
    });

    it('falls back to the built-in chain AND says why when an authored formula is refused', () => {
      // A rejected formula still emits the method's chain, so the shader always
      // compiles — but silently swapping what the user asked for is the failure
      // this comment exists to prevent. It reaches the code panel, the Output
      // tab and the downloaded `.js`, so a recipient of a shared file sees it
      // too; the canvas chip cannot, because half these rejections depend on the
      // wired column's statistics.
      const REFUSED: [string, string][] = [
        ['zzz', 'unknown name'],
        ['v.mul(2)', 'unexpected character'],
        ['0); globalThis.__x=1; float(0', 'unexpected character'],
        ['аbs(v)', 'unexpected character'], // Cyrillic homoglyph
        ['v / 0', 'divides by zero on this data'],
        ['log2(0)', 'divides by zero on this data'],
        ['min(1)', 'wrong number of arguments'],
        ['lo(1)', 'that name is a value, not a function'],
        ['1e999', 'invalid number'],
        ['('.repeat(500) + 'v' + ')'.repeat(500), 'formula too long'],
        ['v'.repeat(600), 'formula too long'],
      ];
      for (const [formula, why] of REFUSED) {
        const gen = build({ mode: 'minmax', formula });
        expectValidModule(gen.code);
        // The chain itself is untouched...
        expect(gen.code, formula).toContain(
          'const dataRange1 = data1_col0.sub(0).mul(0.25).clamp(0.0, 1.0);',
        );
        // ...and the reason rides beside it.
        expect(gen.code, formula).toContain(
          `// Data Range: custom formula ignored (${why}) — using the minmax formula.`,
        );
      }
    });

    it('emits the user formula when it is usable', () => {
      const gen = build({ mode: 'minmax', formula: 'v * 2' });
      expectValidModule(gen.code);
      expect(gen.code).toContain('const dataRange1 = data1_col0.mul(2).clamp(0.0, 1.0);');
    });

    it('resolves the domain variables against the wired column', () => {
      // col0 spans 0…4, so `lo`/`hi` bind to 0 and 4 and the default text must
      // reproduce the built-in chain's numbers.
      const gen = build({ mode: 'minmax', formula: '(v - lo) / (hi - lo)' });
      expect(gen.code).toContain('const dataRange1 = data1_col0.sub(0).mul(0.25).clamp(0.0, 1.0);');
    });

    it('still applies the clamp suffix, and drops it when turned off', () => {
      expect(build({ mode: 'minmax', formula: 'v * 2', clamp: 0 }).code).toContain(
        'const dataRange1 = data1_col0.mul(2);',
      );
    });

    it('wraps a constant-only formula in float() so the clamp has a node to hang on', () => {
      const gen = build({ mode: 'minmax', formula: '0.25 + 0.25' });
      expectValidModule(gen.code);
      expect(gen.code).toContain('const dataRange1 = float(0.5).clamp(0.0, 1.0);');
    });

    it('adds the imports its formula needs', () => {
      // Without this the Output tab and the downloaded .js would reference a
      // symbol they never imported.
      const gen = build({ mode: 'minmax', formula: 'smoothstep(lo, hi, v)' });
      expectValidModule(gen.code);
      expect(gen.code).toMatch(/import \{[^}]*\bsmoothstep\b[^}]*\} from 'three\/tsl'/);
    });

    it('never lets a formula string reach the module', () => {
      // The injection pin. A hostile formula contributes zero characters.
      const payloads = [
        '0); globalThis.__x=1; float(0',
        'v.mul(fetch("http://evil"))',
        'eval("x")',
        'window.location="http://evil"',
      ];
      for (const formula of payloads) {
        const code = build({ mode: 'minmax', formula }).code;
        // The emitted CHAIN is exactly the untouched node's. (The whole module
        // is not byte-equal any more — a refused formula also emits the comment
        // saying so, which is the point of the test above.)
        expect(code, formula).toContain(
          'const dataRange1 = data1_col0.sub(0).mul(0.25).clamp(0.0, 1.0);',
        );
        // ...and not one character of the payload survives, comment included.
        expect(code).not.toContain('globalThis.__x');
        expect(code).not.toContain('fetch');
        expect(code).not.toContain('eval');
        expect(code).not.toContain('evil');
        expect(code).not.toContain('location');
      }
    });
  });
});

describe('graphToCode: Isolines', () => {
  const build = (values: Record<string, string | number> = {}) => {
    const iso = makeNode('i1', 'isolines', values);
    const output = makeNode('out', 'output', {});
    return graphToCode([iso, output], [makeEdge('i1', 'out', 'out', 'opacity')]);
  };

  it('takes the derivative of the CONTINUOUS phase, never of fract()', () => {
    // The whole antialiasing scheme depends on this: fract() is discontinuous
    // once per level, so dFdx(fract(p)) spikes there and draws a spurious line
    // through every contour it is meant to smooth.
    const gen = build();
    expectValidModule(gen.code);
    const lines = gen.code.split('\n');
    const fwLine = lines.find((l) => l.includes('_isolines1_fw'))!;
    expect(fwLine).toContain('dFdx(_isolines1_p)');
    expect(fwLine).toContain('dFdy(_isolines1_p)');
    expect(fwLine).not.toContain('fract');
    // fract appears only later, on the distance term.
    expect(lines.find((l) => l.includes('_isolines1_d'))).toContain('.fract()');
  });

  it('floors the derivative so a flat region cannot collapse the smoothstep', () => {
    expect(build().code).toContain('.max(0.00001)');
  });

  it('fades sub-pixel-dense contours to their average coverage', () => {
    // Without this the lines alias into moiré as soon as the period drops
    // below a pixel — the same guard Data Stripes uses.
    const gen = build();
    expect(gen.code).toContain('const _isolines1_avg =');
    // Function form — the chained `.mix` puts the RECEIVER in the factor slot
    // (three's mixElement), so this faded toward `fw` using the line mask as
    // the blend amount instead of the other way round.
    expect(gen.code).toMatch(/mix\(_isolines1_ln, _isolines1_avg, _isolines1_fw\.mul\(2\.0\)/);
  });

  it('bakes its numeric parameters and coerces non-finite ones', () => {
    expect(build({ levels: 20, offset: 0.25 }).code).toContain(
      'const _isolines1_p = uv().x.sub(0.25).mul(20);',
    );
    // A tampered value must never reach the module as text.
    const nasty = build({ levels: '5); evil((' });
    expect(nasty.code).not.toContain('evil');
    expect(nasty.code).toContain('.mul(10);'); // fell back to the registry default
  });

  it('reads a wired parameter from its upstream variable', () => {
    // Defensive, not yet UI-reachable: `levels`/`width`/`offset` are
    // settings-only today (the same standing as the Time node's `speed` —
    // `usesExposedPorts` does not list `isolines`), so only a hand-authored or
    // imported graph carries such an edge. The emitter handles it because the
    // alternative is silently ignoring a connection that exists.
    const iso = makeNode('i1', 'isolines', { levels: 10 });
    const lv = makeNode('f1', 'float', { value: 7 });
    const output = makeNode('out', 'output', {});
    const gen = graphToCode(
      [lv, iso, output],
      [makeEdge('f1', 'out', 'i1', 'levels'), makeEdge('i1', 'out', 'out', 'opacity')],
    );
    expect(gen.code).toContain('.mul(float1);');
  });
});

describe('graphToCode: Data → Data Range → Colormap → Output', () => {
  // The pipeline the three nodes exist to make possible: raw units in, a
  // defensible colour out.
  const data = makeNode('d1', 'dataNode', dataValues());
  const norm = makeNode('n1', 'dataRange', { mode: 'minmax' });
  const cm = makeNode('c1', 'colormap', { map: 'cividis' });
  const output = makeNode('out', 'output', {});
  const gen = graphToCode(
    [data, norm, cm, output],
    [
      makeEdge('d1', 'col0', 'n1', 'value'),
      makeEdge('n1', 'out', 'c1', 'value'),
      makeEdge('c1', 'out', 'out', 'color'),
    ],
  );

  it('emits a valid module that threads the column through both nodes', () => {
    expectValidModule(gen.code);
    expect(gen.code).toContain('const dataRange1 = data1_col0.sub(0).mul(0.25).clamp(0.0, 1.0);');
    expect(gen.code).toContain('texture(_colormap1_lut, vec2(dataRange1.mul(');
    expect(gen.code).toContain('return colormap1;');
  });

  it('declares each node before it is used', () => {
    const at = (s: string) => gen.code.indexOf(s);
    expect(at('const data1_col0')).toBeLessThan(at('const dataRange1'));
    expect(at('const dataRange1')).toBeLessThan(at('const colormap1'));
  });
});

describe('dataviz inputs coerce a non-scalar source to .x', () => {
  it('takes .x from a vec3 wired into a scalar value input', () => {
    // Nothing validates connection types, and vec2(<vec3>, 0.5) is a compile
    // error rather than a wrong picture.
    const v = makeNode('v1', 'vec3', { x: 1, y: 2, z: 3 });
    const cm = makeNode('c1', 'colormap', { map: 'viridis' });
    const output = makeNode('out', 'output', {});
    const gen = graphToCode(
      [v, cm, output],
      [makeEdge('v1', 'out', 'c1', 'value'), makeEdge('c1', 'out', 'out', 'color')],
    );
    expectValidModule(gen.code);
    expect(gen.code).toContain('vec2(vec31.x.mul(');
  });
});
