import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { scriptToTSL, scriptToTSLWithSettings } from './scriptToTSL';
import { codeToGraph } from './codeToGraph';
import { buildShaderModule } from './tslCodeProcessor';
import { getNodeValues } from '@/types';

/**
 * Assert the emitted TSL is syntactically valid JS.
 *
 * codeToGraph parses with `errorRecovery`, so it reports NO errors for source it
 * merely limped through — corrupted output (`const   const c = ...`) sails past
 * an `errors`-based assertion. Well-formedness needs a strict parse.
 */
function expectParses(tsl: string): void {
  expect(() => parse(tsl, { sourceType: 'module' })).not.toThrow();
}

/**
 * Regression suite for the .js → editor-TSL conversion.
 *
 * Every case here is a shape that silently corrupted the shader before: the
 * output either failed to parse, or parsed into a graph that quietly dropped
 * the author's uniforms. Each test therefore asserts on BOTH ends — the emitted
 * text and the graph codeToGraph builds from it — because "it parses" was never
 * the property that was broken.
 */

/** Parse the converted TSL the way the code editor does, and surface the damage. */
function toGraph(script: string) {
  const tsl = scriptToTSL(script);
  const { nodes, errors } = codeToGraph(tsl);
  return {
    tsl,
    nodes,
    errors,
    fatal: errors.filter((e) => e.severity !== 'warning'),
    cannotRepresent: errors.filter((e) => e.message.includes('Cannot represent')),
    properties: nodes
      .filter((n) => (n.data as { registryType?: string }).registryType === 'property_float')
      .map((n) => String(getNodeValues(n).name)),
  };
}

const SCHEMA = `export const schema = {
  Bands: { type: "number", default: 8 },
  Softness: { type: "number", default: 0.25 },
  Glow: { type: "number", default: 2 },
};`;

describe('scriptToTSL: params.* references', () => {
  it('hoists an inline params.X argument into a uniform (was: "Cannot represent")', () => {
    const { tsl, cannotRepresent, properties } = toGraph(`import { mul, oneMinus, color, positionLocal, normalLocal } from "three/tsl";

${SCHEMA}

export default function (params) {
  const a = mul(positionLocal, params.Bands);
  const b = oneMinus(params.Softness);
  return { colorNode: color(0xffffff), positionNode: positionLocal.add(normalLocal.mul(a)) };
}
`);
    expect(tsl).not.toContain('params.');
    expect(tsl).toContain('const Bands = uniform(8);');
    expect(tsl).toContain('const Softness = uniform(0.25);');
    expect(tsl).toContain('mul(positionLocal, Bands)');
    expect(tsl).toContain('oneMinus(Softness)');
    expect(cannotRepresent).toEqual([]);
    expect(properties).toEqual(expect.arrayContaining(['Bands', 'Softness']));
  });

  it('keeps the schema default rather than inventing 1.0', () => {
    const { tsl } = toGraph(`import { mul, color } from "three/tsl";

${SCHEMA}

export default function (params) {
  return { colorNode: mul(color(0xffffff), params.Glow) };
}
`);
    expect(tsl).toContain('const Glow = uniform(2);');
  });

  it('preserves the schema NAME when the local is renamed (const b = params.Bands)', () => {
    // The uniform's identifier is its public schema key — renaming it to `b`
    // would silently rename the a-entity property, so the hoist keeps `Bands`
    // and lets the local alias it.
    const { tsl, cannotRepresent, properties } = toGraph(`import { mul, color, positionLocal } from "three/tsl";

${SCHEMA}

export default function (params) {
  const b = params.Bands;
  return { colorNode: mul(color(0xffffff), b) };
}
`);
    expect(tsl).toContain('const Bands = uniform(8);');
    expect(tsl).toContain('const b = Bands;');
    expect(cannotRepresent).toEqual([]);
    expect(properties).toContain('Bands');
    expect(properties).not.toContain('b');
  });

  it('still reverses the classic `const X = params.X;` form without double-declaring', () => {
    const { tsl, cannotRepresent } = toGraph(`import { mul, color } from "three/tsl";

${SCHEMA}

export default function (params) {
  const Bands = params.Bands;
  return { colorNode: mul(color(0xffffff), Bands) };
}
`);
    expect(tsl.match(/const Bands = uniform\(8\);/g)).toHaveLength(1);
    expect(tsl).not.toContain('const Bands = Bands;');
    expect(cannotRepresent).toEqual([]);
  });

  it('imports uniform when a param is used but the module ships no schema', () => {
    const { tsl } = toGraph(`import { mul, color } from "three/tsl";

export default function (params) {
  return { colorNode: mul(color(0xffffff), params.Mystery) };
}
`);
    expect(tsl).toContain('uniform');
    expect(tsl).toContain('const Mystery = uniform(1);');
    expect(tsl).toMatch(/import \{[^}]*\buniform\b[^}]*\} from "three\/tsl"/);
  });

  it('leaves params.X alone when the name collides with an unrelated const', () => {
    // Hoisting would double-declare `Bands`. Degrade to the old warning rather
    // than emit code that cannot run.
    const { tsl } = toGraph(`import { mul, color, positionLocal } from "three/tsl";

${SCHEMA}

export default function (params) {
  const Bands = mul(positionLocal, 3);
  return { colorNode: mul(color(0xffffff), params.Bands) };
}
`);
    expect(tsl).toContain('params.Bands');
    expect(tsl).not.toContain('const Bands = uniform(8);');
  });

  it('refuses to hoist a param that would shadow an import', () => {
    // `mul(time, params.time)` is valid in the source module: imported clock ×
    // the `time` uniform. Hoisting `const time = uniform(1);` would shadow the
    // import and collapse both operands onto the constant — silently deleting
    // the animation. Leaving the reference alone keeps the existing warning.
    const { tsl } = toGraph(`import { mul, color, time, positionLocal, normalLocal } from "three/tsl";

export const schema = {
  time: { type: "number", default: 1 },
};

export default function (params) {
  const t = mul(time, params.time);
  return { colorNode: color(0xffffff), positionNode: positionLocal.add(normalLocal.mul(t)) };
}
`);
    expect(tsl).not.toContain('const time = uniform(1);');
    expect(tsl).not.toContain('mul(time, time)');
    expect(tsl).toContain('params.time');
  });

  it('leaves params.X inside comments and strings completely alone', () => {
    // The hoist is AST-driven, so a mention in a comment or a plain string is
    // not a reference: it must neither create a uniform nor have its text
    // rewritten. A textual rewrite silently edited both.
    const { tsl } = toGraph(`import { color } from "three/tsl";

${SCHEMA}

export default function (params) {
  // params.Ghost is only mentioned here
  const label = "params.Phantom";
  return { colorNode: color(0xffffff) };
}
`);
    expect(tsl).not.toContain('const Ghost');
    expect(tsl).not.toContain('const Phantom');
    // The text itself must survive verbatim — no silent edits.
    expect(tsl).toContain('// params.Ghost is only mentioned here');
    expect(tsl).toContain('"params.Phantom"');
  });

  it('treats a template interpolation as the real reference it is', () => {
    // `${params.X}` is code, not prose — the AST sees a MemberExpression. So it
    // must be hoisted like any other reference; rewriting the text WITHOUT
    // hoisting (what a regex did) left `${X}` naming an undeclared local.
    const { tsl } = toGraph(`import { color } from "three/tsl";

export const schema = { Wraith: { type: "number", default: 7 } };

export default function (params) {
  const label = \`speed=\${params.Wraith}\`;
  return { colorNode: color(0xffffff) };
}
`);
    expect(tsl).toContain('const Wraith = uniform(7);');
    expect(tsl).toContain('${Wraith}');
    expect(tsl).not.toContain('${params.Wraith}');
  });

  it('handles a trailing comment on the declaration (was: TDZ `const X = X;`)', () => {
    // The two predicates that decided "is this self-declared?" disagreed once a
    // comment was present, and the line collapsed to `const Speed = Speed;`.
    for (const decl of ['const', 'let', 'var']) {
      const { tsl, fatal } = toGraph(`import { mul, color } from "three/tsl";

export const schema = { Speed: { type: "number", default: 3 } };

export default function (params) {
  ${decl} Speed = params.Speed; // animation rate
  return { colorNode: mul(color(0xffffff), Speed) };
}
`);
      expect(tsl, decl).not.toMatch(/(const|let|var)\s+Speed\s*=\s*Speed\s*;/);
      expect(tsl, decl).toContain('const Speed = uniform(3);');
      expect(fatal, decl).toEqual([]);
    }
  });

  it('handles a declaration whose RHS wraps onto the next line', () => {
    const { tsl } = toGraph(`import { mul, color } from "three/tsl";

export const schema = { Gain: { type: "number", default: 4 } };

export default function (params) {
  const Gain =
    params.Gain;
  return { colorNode: mul(color(0xffffff), Gain) };
}
`);
    expect(tsl).not.toMatch(/const\s+Gain\s*=\s*Gain\s*;/);
    expect(tsl).toContain('const Gain = uniform(4);');
  });

  it('handles comma declarators without double-declaring', () => {
    const { tsl, fatal } = toGraph(`import { mul, color } from "three/tsl";

export const schema = { Gain: { type: "number", default: 4 } };

export default function (params) {
  const base = 1, Gain = params.Gain;
  return { colorNode: mul(color(0xffffff), mul(Gain, base)) };
}
`);
    expect(tsl.match(/const Gain = uniform\(4\);/g) ?? []).toHaveLength(1);
    expect(tsl).toContain('const base = 1;');
    expectParses(tsl);
    expectParses(tsl);
    expect(fatal).toEqual([]);
  });

  it('handles ADJACENT hoisted declarators in one statement', () => {
    // Two self-declared params side by side both lay claim to the comma between
    // them. Excised separately, the second splice lands on already-shifted text
    // and emits `const   const c = ...` — which codeToGraph accepts silently.
    const { tsl, fatal } = toGraph(`import { mul, color } from "three/tsl";

export const schema = {
  Speed: { type: "number", default: 2.5 },
  Bands: { type: "number", default: 4 },
};

export default function (params) {
  const Speed = params.Speed, Bands = params.Bands;
  return { colorNode: mul(color(0xffffff), mul(Speed, Bands)) };
}
`);
    expect(tsl).toContain('const Speed = uniform(2.5);');
    expect(tsl).toContain('const Bands = uniform(4);');
    expect(tsl).not.toMatch(/const\s+const/);
    expectParses(tsl);
    expectParses(tsl);
    expect(fatal).toEqual([]);
  });

  it('handles a mix of hoisted and surviving declarators in one statement', () => {
    const { tsl } = toGraph(`import { mul, color } from "three/tsl";

export const schema = {
  Speed: { type: "number", default: 2.5 },
  Bands: { type: "number", default: 4 },
};

export default function (params) {
  const Speed = params.Speed, k = 3.0, Bands = params.Bands, j = 2.0;
  return { colorNode: mul(color(0xffffff), mul(mul(Speed, Bands), mul(k, j))) };
}
`);
    expect(tsl).toContain('const Speed = uniform(2.5);');
    expect(tsl).toContain('const Bands = uniform(4);');
    expect(tsl).toContain('const k = 3.0, j = 2.0;');
    expectParses(tsl);
  });

  it('allows a reference above its own declaration (hoist goes to the top)', () => {
    const { tsl, fatal, cannotRepresent } = toGraph(`import { mul, color } from "three/tsl";

export const schema = { Speed: { type: "number", default: 3 } };

export default function (params) {
  const early = mul(color(0xffffff), params.Speed);
  const Speed = params.Speed;
  return { colorNode: mul(early, Speed) };
}
`);
    // The uniform must precede both uses.
    const decl = tsl.indexOf('const Speed = uniform(3);');
    expect(decl).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(tsl.indexOf('const early ='));
    expectParses(tsl);
    expect(fatal).toEqual([]);
    expect(cannotRepresent).toEqual([]);
  });

  it('resolves a reference nested inside an inner Fn', () => {
    const { tsl, cannotRepresent } = toGraph(`import { Fn, mul, color } from "three/tsl";

export const schema = { Gain: { type: "number", default: 5 } };

export default function (params) {
  const top = mul(color(0xffffff), params.Gain);
  const inner = Fn(() => {
    return mul(color(0xff0000), params.Gain);
  })();
  return { colorNode: mul(top, inner) };
}
`);
    expect(tsl).toContain('const Gain = uniform(5);');
    expect(tsl).not.toContain('params.Gain');
    expect(cannotRepresent).toEqual([]);
  });

  it('ignores a helper that shadows `params` with its own parameter', () => {
    // `params` inside the helper is the helper's own — hoisting a uniform for
    // it would bind a name the outer schema never declared.
    const { tsl } = toGraph(`import { Fn, mul, color } from "three/tsl";

export const schema = { Gain: { type: "number", default: 5 } };

const helper = Fn((params) => mul(color(0xffffff), params.Bogus));

export default function (params) {
  return { colorNode: mul(color(0xffffff), params.Gain) };
}
`);
    expect(tsl).toContain('const Gain = uniform(5);');
    expect(tsl).not.toContain('const Bogus');
  });

  it('leaves an unparseable module untouched rather than half-transforming it', () => {
    const broken = `import { color } from "three/tsl";

export default function (params) {
  const x = mul(color(0xffffff), params.Gain;
  return { colorNode: x };
}
`;
    expect(() => scriptToTSL(broken)).not.toThrow();
    // A hard parse error means no transform ran at all, so `params.` survives —
    // the editor must still receive the user's text so they can fix it.
    expect(scriptToTSL(broken)).toContain('params.Gain');
  });

  it('survives a module that parses only under error recovery', () => {
    // `errorRecovery` hands back an AST for source it merely limped through;
    // building scope over one of those throws (here: a duplicate declaration).
    // That throw used to escape and reject the whole import.
    const dup = `import { mul, color } from "three/tsl";

export const schema = { Gain: { type: "number", default: 4 } };

export default function (params) {
  const x = mul(color(0xffffff), params.Gain);
  const x = mul(color(0xff0000), 2.0);
  return { colorNode: x };
}
`;
    expect(() => scriptToTSL(dup)).not.toThrow();
  });
});

describe('scriptToTSL: multi-line return collapsing', () => {
  it('does not let a trailing // comment swallow the closing brace', () => {
    const { tsl, fatal } = toGraph(`import { color, positionLocal, normalLocal, mul } from "three/tsl";

export default function (params) {
  const d = mul(positionLocal, 2);
  return {
    colorNode: color(0xffffff),
    positionNode: positionLocal.add(normalLocal.mul(d)),
    fog: false, // the camera-following shell ignores scene fog
  };
}
`);
    // The exact corruption reported: the comment ate `};` and was then echoed
    // back as an ES6 shorthand property (`// note: // note`).
    const returnLine = tsl.split('\n').find((l) => l.includes('return {')) ?? '';
    expect(returnLine).not.toContain('//');
    expect(returnLine.trimEnd()).toMatch(/\};$/);
    expectParses(tsl);
    expect(fatal).toEqual([]);
  });

  it('does not truncate at a nested brace (object-literal argument)', () => {
    const { tsl, fatal } = toGraph(`import { color, mx_noise_float, positionLocal } from "three/tsl";

export default function (params) {
  return {
    colorNode: color(0xffffff),
    positionNode: positionLocal.add(mx_noise_float({ scale: 2, detail: 3 })),
  };
}
`);
    expect(tsl).not.toContain('};)');
    expect(tsl).toContain('{ scale: 2, detail: 3 }');
    expectParses(tsl);
    expect(fatal).toEqual([]);
  });

  it('keeps a nested call intact instead of shredding it on commas', () => {
    const { tsl, fatal } = toGraph(`import { mix, color, mx_noise_float, positionLocal, normalLocal } from "three/tsl";

export default function (params) {
  const noise = mx_noise_float(positionLocal);
  return {
    colorNode: mix(color(0xff0000), color(0x00ff00), noise),
    positionNode: positionLocal.add(normalLocal.mul(noise)),
  };
}
`);
    expect(tsl).toContain('color: mix(color(0xff0000), color(0x00ff00), noise)');
    // The shorthand-echo signature of the old comma split.
    expect(tsl).not.toMatch(/color\(0x00ff00\): color\(0x00ff00\)/);
    expectParses(tsl);
    expect(fatal).toEqual([]);
  });

  it('renames channel keys and strips material settings', () => {
    const { tsl } = toGraph(`import { color, positionLocal, normalLocal, mul } from "three/tsl";

export default function (params) {
  const d = mul(positionLocal, 2);
  return {
    colorNode: color(0xffffff),
    positionNode: positionLocal.add(normalLocal.mul(d)),
    side: 2,
  };
}
`);
    expect(tsl).toContain('color: color(0xffffff)');
    expect(tsl).toContain('position: d');
    expect(tsl).not.toContain('side:');
    expect(tsl).not.toContain('colorNode');
  });

  it('does not let a brace or comma inside a string break the return', () => {
    // splitTopLevelArgs counts brackets; without string awareness a `}` in a
    // literal closed the object early and deleted the rest of the return.
    const { tsl, fatal } = toGraph(`import { color, positionLocal, normalLocal, mul } from "three/tsl";

export default function (params) {
  const d = mul(positionLocal, 2);
  const label = "a } and a , inside";
  return {
    colorNode: color(0xffffff),
    positionNode: positionLocal.add(normalLocal.mul(d)),
  };
}
`);
    expect(tsl).toContain('color: color(0xffffff)');
    expect(tsl).toContain('position: d');
    expectParses(tsl);
    expect(fatal).toEqual([]);
  });

  it('handles a block comment inside the return body', () => {
    const { tsl, fatal } = toGraph(`import { color } from "three/tsl";

export default function (params) {
  return {
    colorNode: color(0xffffff), /* keep me out of the output */
  };
}
`);
    expect(tsl).not.toContain('keep me out');
    expectParses(tsl);
    expect(fatal).toEqual([]);
  });

  it('does not mistake a brace inside a comment for the return closer', () => {
    const { tsl, fatal } = toGraph(`import { color } from "three/tsl";

export default function (params) {
  return {
    // a stray } brace in a comment
    colorNode: color(0xffffff),
  };
}
`);
    expectParses(tsl);
    expect(fatal).toEqual([]);
    expect(tsl).toContain('color: color(0xffffff)');
  });
});

describe('scriptToTSL: end-to-end', () => {
  it('converts a legacy params-style module into a fully wired graph', () => {
    const { tsl, fatal, cannotRepresent, properties } = toGraph(`// TSL Shader Module — for use with a-frame-shaderloader
import { add, color, mix, mul, mx_noise_float, positionWorld, time, uniform, positionLocal, normalLocal } from "three/tsl";

export const schema = {
  scale: { type: "number", default: 1 },
  speed: { type: "number", default: 1 },
};

export default function (params) {
  const color1 = color(0xffffff);
  const mul1 = mul(time, params.speed);
  const add1 = add(mul1, positionWorld);
  const noise1 = mx_noise_float(add1);
  const mix1 = mix(color1, 0, noise1);
  const mul2 = mul(noise1, params.scale);
  return {
    colorNode: mix1,
    positionNode: positionLocal.add(normalLocal.mul(mul2)),
    side: 2, // double-sided
  };
}
`);
    expectParses(tsl);
    expect(fatal).toEqual([]);
    expect(cannotRepresent).toEqual([]);
    expect(tsl).not.toContain('params.');
    expect(properties).toEqual(expect.arrayContaining(['scale', 'speed']));
    expect(tsl).toContain('const shader = Fn(() => {');
    expect(tsl).toContain('export default shader;');
  });
});

describe('scriptToTSL — the discard wrapper survives a download → Load Script trip', () => {
  const moduleFor = (body: string) =>
    buildShaderModule(`import { Fn, vec3, greaterThan, Discard, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
${body}

  return vec3(1, 0, 0);
});

export default shader;
`);

  it('restores a conditional discard', () => {
    const tsl = scriptToTSL(moduleFor(`  const cond = greaterThan(positionGeometry.y, 0.0);
  Discard(cond);`));
    expectParses(tsl);
    expect(tsl).toContain('Discard(cond);');
    expect(tsl).not.toContain('__pixel');
  });

  it('restores an UNCONDITIONAL discard, which carries no param and no call arg', () => {
    // Correlating call args to Fn params alone cannot see this one — there is
    // nothing to correlate — so it used to vanish on re-import.
    const tsl = scriptToTSL(moduleFor('  Discard();'));
    expectParses(tsl);
    expect(tsl).toMatch(/Discard\(\s*\);/);
    expect(tsl).not.toContain('__pixel');
  });

  it('restores a mixed pair in the order they were written', () => {
    const tsl = scriptToTSL(moduleFor(`  const cond = greaterThan(positionGeometry.y, 0.0);
  Discard(cond);
  Discard();`));
    expectParses(tsl);
    expect(tsl.indexOf('Discard(cond);')).toBeLessThan(tsl.indexOf('Discard();'));
    expect(tsl).not.toContain('__pixel');
  });
});

describe('scriptToTSL: metalness + env channels survive Load Script', () => {
  it('maps metalnessNode and envNode back to editor channels', () => {
    // Exactly what FastShaders' own export emits for the Metalness widget and
    // an Environment image — a module lacking these mappings imported with
    // zero errors but silently rendered fully diffuse with no env.
    const { tsl, fatal } = toGraph(`// TSL Shader Module — for use with a-frame-shaderloader
import { color, float, texture } from "three/tsl";

export default function () {
  const color1 = color(0xffffff);
  return {
    colorNode: color1,
    roughnessNode: float(0.15),
    metalnessNode: float(0.9),
  };
}
`);
    expect(fatal).toEqual([]);
    expect(tsl).toContain('metalness: float(0.9)');
    expect(tsl).toContain('roughness: float(0.15)');
  });
});

describe("scriptToTSLWithSettings: a module's own material settings survive", () => {
  const mod = (props: string) => `import { color, positionLocal, normalLocal, mul } from "three/tsl";

export default function (params) {
  const d = mul(positionLocal, 2);
  return {
    colorNode: color(0xffffff),
    positionNode: positionLocal.add(normalLocal.mul(d)),
${props}  };
}
`;

  it('extracts transparent / side / alphaTest / depthWrite and still strips them', () => {
    const r = scriptToTSLWithSettings(mod(
      '    transparent: true,\n    side: 2, // double-sided\n    alphaTest: 0.5,\n    depthWrite: false,\n'));
    expect(r.materialSettings).toEqual({
      transparent: true, side: 'double', alphaTest: 0.5, depthWrite: false,
    });
    expect(r.code).not.toContain('alphaTest');
    expect(r.code).not.toContain('side:');
    expect(r.code).toContain('position: d');
  });

  it('clamps alphaTest below 1, drops 0, drops a non-numeric payload', () => {
    expect(scriptToTSLWithSettings(mod('    alphaTest: 1,\n')).materialSettings)
      .toEqual({ alphaTest: 0.99 });
    expect(scriptToTSLWithSettings(mod('    alphaTest: 3,\n')).materialSettings)
      .toEqual({ alphaTest: 0.99 });
    expect(scriptToTSLWithSettings(mod('    alphaTest: 0,\n')).materialSettings).toBeUndefined();
    expect(scriptToTSLWithSettings(
      mod("    alphaTest: 0.5 }; globalThis.pwned = 1; ({ x: 0,\n")).materialSettings)
      .toBeUndefined();
  });

  it('drops depthWrite:false on an opaque module (it self-occludes into holes)', () => {
    expect(scriptToTSLWithSettings(mod('    depthWrite: false,\n')).materialSettings)
      .toBeUndefined();
  });

  it('maps every side spelling it knows and drops the ones it does not', () => {
    expect(scriptToTSLWithSettings(mod('    side: 1,\n')).materialSettings).toEqual({ side: 'back' });
    expect(scriptToTSLWithSettings(mod("    side: 'double',\n")).materialSettings).toEqual({ side: 'double' });
    expect(scriptToTSLWithSettings(mod('    side: THREE.DoubleSide,\n')).materialSettings).toBeUndefined();
  });

  it('drops prototype-chain side values instead of carrying an inherited Function', () => {
    // A Record lookup resolved side:'constructor' to Object.prototype's
    // constructor — a Function that survived into materialSettings, and the
    // next pushHistory's structuredClone threw DataCloneError out of a React
    // effect, blanking the editor. The settings must stay structured-cloneable
    // for EVERY input.
    for (const evil of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const settings = scriptToTSLWithSettings(mod(`    side: ${evil},\n`)).materialSettings;
      expect(settings, evil).toBeUndefined();
      expect(() => structuredClone(settings)).not.toThrow();
    }
  });

  it('returns undefined settings and code byte-identical to scriptToTSL', () => {
    const src = mod('');
    const r = scriptToTSLWithSettings(src);
    expect(r.materialSettings).toBeUndefined();
    expect(r.code).toBe(scriptToTSL(src));
  });

  it('handles the single-line return form the Tests/ corpus uses', () => {
    const src = 'import { color } from "three/tsl";\n\n'
      + 'export default function (params) {\n'
      + '  return { colorNode: color(0xffffff), transparent: true, alphaTest: 0.25 };\n}\n';
    expect(scriptToTSLWithSettings(src).materialSettings)
      .toEqual({ transparent: true, alphaTest: 0.25 });
  });

  it('leaves raw editor TSL alone', () => {
    const raw = 'import { Fn, color } from "three/tsl";\n'
      + 'const shader = Fn(() => { return { color: color(0xffffff) }; });\n'
      + 'export default shader;\n';
    const r = scriptToTSLWithSettings(raw);
    expect(r.code).toBe(raw);
    expect(r.materialSettings).toBeUndefined();
  });

  it('recovers offset displacement mode (normal mode stays the default)', () => {
    const offset = 'import { color, positionLocal, mul } from "three/tsl";\n\n'
      + 'export default function (params) {\n  const d = mul(positionLocal, 2);\n'
      + '  return { colorNode: color(0xffffff), positionNode: positionLocal.add(d) };\n}\n';
    expect(scriptToTSLWithSettings(offset).materialSettings).toEqual({ displacementMode: 'offset' });
    const normal = offset.replace('positionLocal.add(d)', 'positionLocal.add(normalLocal.mul(d))');
    expect(scriptToTSLWithSettings(normal).materialSettings).toBeUndefined();
  });

  it('returns a FRESH settings object every call (reference selectors bail on Object.is)', () => {
    const src = mod('    transparent: true,\n');
    const a = scriptToTSLWithSettings(src).materialSettings;
    const b = scriptToTSLWithSettings(src).materialSettings;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
