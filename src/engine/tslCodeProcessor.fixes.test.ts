import { describe, it, expect } from 'vitest';
import { buildShaderModule } from './tslCodeProcessor';
import { tslToShaderModule } from './tslToShaderModule';
import { scriptToTSL } from './scriptToTSL';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * Regression suite for the code-review fixes to the shared shader-module
 * builder. Each block names the finding it guards.
 */

// graphToCode emits the hsl/toHsl helpers at MODULE SCOPE, before the main Fn.
const HSL_SHADER = `import { Fn, mul, add, sub, abs, mod, clamp, float, vec3 } from 'three/tsl';

const hsl = Fn(([h, s, l]) => {
  const h6 = mul(h, float(6));
  const rk = clamp(sub(abs(sub(mod(add(h6, float(0)), float(6)), float(3))), float(1)), float(0), float(1));
  return vec3(add(l, rk), s, l);
});

const shader = Fn(() => {
  const hsl1 = hsl(0.5, 1, 0.5);
  return hsl1;
});

export default shader;
`;

describe('#1/#8: extractFnBody preserves module-scope preamble', () => {
  it('keeps the hsl helper Fn so the call resolves (preview)', () => {
    const out = buildShaderModule(HSL_SHADER, {});
    expect(out).toContain('const hsl = Fn(([h, s, l]) => {');
    expect(out).toContain('colorNode: hsl1');
    // helper body survives verbatim
    expect(out).toContain('const h6 = mul(h, float(6));');
    // Fn is imported (the helper needs it even with no discard)
    expect(out).toMatch(/import \{[^}]*\bFn\b[^}]*\} from 'three\/tsl';/);
    // the helper is emitted at module scope, before the default export
    expect(out.indexOf('const hsl = Fn(')).toBeLessThan(
      out.indexOf('export default function'),
    );
  });

  it('keeps the hsl helper in the .js export too', () => {
    const out = tslToShaderModule(HSL_SHADER);
    expect(out).toContain('const hsl = Fn(([h, s, l]) => {');
    expect(out).toContain('hsl1');
    expect(out).not.toContain('vec3(1, 0, 0)'); // not the empty-body fallback
  });

  it('preserves non-three/tsl imports (e.g. raw three)', () => {
    const code = `import { Fn, vec3 } from 'three/tsl';
import { MathUtils } from 'three';

const shader = Fn(() => {
  return vec3(1, 1, 1);
});
export default shader;
`;
    const out = buildShaderModule(code, {});
    expect(out).toContain("import { MathUtils } from 'three';");
  });
});

describe('#3: property names with non-identifier chars sanitize to valid schema keys', () => {
  // graphToCode would sanitize "my speed" → my_speed for the generated var.
  const code = `import { Fn, uniform, positionGeometry } from 'three/tsl';
const shader = Fn(() => {
  const my_speed = uniform(2.5);
  const mul1 = positionGeometry.mul(my_speed);
  return mul1;
});
export default shader;
`;
  const out = tslToShaderModule(code, undefined, [
    { name: 'my speed', type: 'float', defaultValue: 2.5 },
  ]);

  it('emits a valid (underscored) schema key, never a bare spaced key', () => {
    expect(out).toContain("my_speed: { type: 'number', default: 2.5 },");
    expect(out).not.toMatch(/\bmy speed\s*:/); // no invalid `my speed:` key
  });
  it('rewrites the matching uniform to params.my_speed', () => {
    expect(out).toContain('const my_speed = params.my_speed;');
  });
  it('the emitted schema object is syntactically valid JS', () => {
    const m = out.match(/export const schema = (\{[\s\S]*?\n\});/);
    expect(m).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    expect(() => new Function(`return ${m![1]}`)).not.toThrow();
  });
});

describe('#3b: two property names that sanitize to the same id both stay exposed', () => {
  // graphToCode numbers colliding generated vars: "my speed" → my_speed,
  // "my-speed" → my_speed2. Both must survive into the schema as params.
  const code = `import { Fn, uniform, add, positionGeometry } from 'three/tsl';
const shader = Fn(() => {
  const my_speed = uniform(2.5);
  const my_speed2 = uniform(3.5);
  const mul1 = positionGeometry.mul(add(my_speed, my_speed2));
  return mul1;
});
export default shader;
`;
  const out = tslToShaderModule(code, undefined, [
    { name: 'my speed', type: 'float', defaultValue: 2.5 },
    { name: 'my-speed', type: 'float', defaultValue: 3.5 },
  ]);

  it('rewrites BOTH colliding uniforms to params (neither left a dead literal)', () => {
    expect(out).toContain('const my_speed = params.my_speed;');
    expect(out).toContain('const my_speed2 = params.my_speed2;');
  });
  it('declares BOTH in the schema with their own literals', () => {
    expect(out).toContain("my_speed: { type: 'number', default: 2.5 },");
    expect(out).toContain("my_speed2: { type: 'number', default: 3.5 },");
  });
});

describe('#4: property whose name shadows a TSL import (fixTDZ rename)', () => {
  // `mix` is both imported and the property name → fixTDZ renames the local to
  // `_mix`, but the schema key / params access must stay `mix`.
  const code = `import { Fn, uniform, mix, vec3 } from 'three/tsl';
const shader = Fn(() => {
  const mix = uniform(2.0);
  const tint = mix(vec3(1, 0, 0), vec3(0, 0, 1), mix);
  return tint;
});
export default shader;
`;
  const out = tslToShaderModule(code, undefined, [
    { name: 'mix', type: 'float', defaultValue: 2.0 },
  ]);

  it('assigns params.mix to the renamed local _mix', () => {
    expect(out).toContain('const _mix = params.mix;');
  });
  it('declares schema key "mix" (the overlay/auto-detect name), not "_mix"', () => {
    expect(out).toContain("mix: { type: 'number', default: 2 },");
    expect(out).not.toContain("_mix: { type: 'number'");
  });
});

describe('#5: uniform rewrite accepts scientific-notation / leading-dot literals', () => {
  it('rewrites uniform(1e-7) in export mode (was left as a dead literal)', () => {
    const code = `import { Fn, uniform, positionGeometry } from 'three/tsl';
const shader = Fn(() => {
  const eps = uniform(1e-7);
  const m = positionGeometry.mul(eps);
  return m;
});
export default shader;
`;
    const out = tslToShaderModule(code, undefined, [
      { name: 'eps', type: 'float', defaultValue: 1e-7 },
    ]);
    expect(out).toContain('const eps = params.eps;');
    expect(out).toMatch(/eps: \{ type: 'number', default: 1e-7 \}/);
  });

  it('auto-detects uniform(.5) in preview mode', () => {
    const code = `import { Fn, uniform, positionGeometry } from 'three/tsl';
const shader = Fn(() => {
  const a = uniform(.5);
  const m = positionGeometry.mul(a);
  return m;
});
export default shader;
`;
    const out = buildShaderModule(code, {});
    expect(out).toContain('const a = params.a;');
    expect(out).toContain("a: { type: 'number', default: 0.5 },");
  });
});

describe('#6: Discard with no color channel still applies the cutout', () => {
  const code = `import { Fn, greaterThan, Discard, positionGeometry } from 'three/tsl';
const shader = Fn(() => {
  const greaterThan1 = greaterThan(0.5, 0.2);
  const disp = positionGeometry.mul(0.1);
  Discard(greaterThan1);
  return { position: disp };
});
export default shader;
`;
  const out = buildShaderModule(code, {});

  it('routes the discard through colorNode with a white fallback (not a dead __pixel)', () => {
    expect(out).toContain('colorNode: __pixel(greaterThan1, vec3(1, 1, 1))');
    expect(out).toContain('const __pixel = Fn(([__c0, __color]) => {');
    expect(out).toContain('Discard(__c0);');
    expect(out).toContain('positionNode: positionLocal.add(');
    // vec3 imported for the fallback color
    expect(out).toMatch(/import \{[^}]*\bvec3\b[^}]*\} from 'three\/tsl';/);
  });
});

describe('#7: Discard with a trailing comment is not silently dropped', () => {
  const code = `import { Fn, mix, vec3, greaterThan, Discard } from 'three/tsl';
const shader = Fn(() => {
  const mix1 = mix(vec3(1, 0, 0), vec3(0, 0, 1), 0.5);
  const greaterThan1 = greaterThan(0.5, 0.2);
  Discard(greaterThan1); // cull far fragments
  return mix1;
});
export default shader;
`;
  const out = buildShaderModule(code, {});

  it('keeps the real condition (no empty __pixel())', () => {
    expect(out).toContain('colorNode: __pixel(greaterThan1, mix1)');
    expect(out).toContain('Discard(__c0);');
    expect(out).not.toContain('__pixel()');
  });
});

describe('#7b: a Discard with a balanced nested-call condition survives', () => {
  it('extracts the full condition with nested parens', () => {
    const code = `import { Fn, vec3, greaterThan, distance, positionWorld, cameraPosition, Discard } from 'three/tsl';
const shader = Fn(() => {
  const cond = greaterThan(distance(positionWorld, cameraPosition), 5.0);
  Discard(greaterThan(distance(positionWorld, cameraPosition), 5.0));
  return vec3(1, 0, 0);
});
export default shader;
`;
    const out = buildShaderModule(code, {});
    expect(out).toContain(
      'colorNode: __pixel(greaterThan(distance(positionWorld, cameraPosition), 5.0), vec3(1, 0, 0))',
    );
  });
});

describe('#9: preview and export agree on the schema default (parity)', () => {
  it('a wired property derives its default from the code literal in BOTH modes', () => {
    const code = `import { Fn, uniform, positionGeometry } from 'three/tsl';
const shader = Fn(() => {
  const amount = uniform(2.5);
  const m = positionGeometry.mul(amount);
  return m;
});
export default shader;
`;
    const preview = buildShaderModule(code, {});
    // Even with a DIFFERENT declared defaultValue, export must match the preview
    // because both take the wired default from the literal (2.5).
    const exported = buildShaderModule(code, {
      properties: [{ name: 'amount', defaultValue: 9.9 }],
    });
    expect(exported).toBe(preview);
    expect(preview).toContain("amount: { type: 'number', default: 2.5 },");
  });
});

describe('#1 end-to-end: a real graphToCode HSL graph exports a working module', () => {
  it('exports the hsl helper + the call that references it', () => {
    const hsl = makeNode('h', 'hsl');
    const out = makeNode('out', 'output');
    const { code } = graphToCode([hsl, out], [makeEdge('h', 'out', 'out', 'color')]);
    const exported = tslToShaderModule(code);

    // The helper survives at module scope (the bug dropped it → ReferenceError).
    expect(exported).toContain('const hsl = Fn(([h, s, l]) => {');
    expect(exported).toContain('colorNode: hsl1');
    expect(exported).toMatch(/import \{[^}]*\bFn\b[^}]*\} from 'three\/tsl';/);
    // The call site must be defined: hsl appears as a decl before its use.
    expect(exported.indexOf('const hsl = Fn(')).toBeLessThan(
      exported.indexOf('const hsl1 = hsl('),
    );
  });
});

describe('#1 round-trip: an HSL export survives scriptToTSL', () => {
  it('keeps the hsl helper through export → scriptToTSL', () => {
    const exported = tslToShaderModule(HSL_SHADER);
    const back = scriptToTSL(exported);
    expect(back).toContain('const hsl = Fn(([h, s, l]) => {');
    expect(back).toContain('const shader = Fn(() => {');
    expect(back).toContain('export default shader;');
  });
});

describe('buildShaderModule — material settings survive and are sanitized', () => {
  const wrap = (body: string) =>
    `import { Fn, vec3 } from 'three/tsl';\n\nconst shader = Fn(() => {\n${body}\n});\n\nexport default shader;\n`;

  it('a trailing comment on the return no longer dead-codes the module return', () => {
    // The regexes are end-anchored, so `// default red` used to make this line
    // a body STATEMENT that returned first — silently discarding transparent /
    // alphaTest / side / depthWrite and any Discard.
    const mod = buildShaderModule(wrap('  return vec3(1, 0, 0); // default red'), {
      materialSettings: { transparent: true, alphaTest: 0.4 },
    });
    expect(mod).toContain('colorNode:');
    expect(mod).toContain('transparent: true');
    expect(mod).toContain('alphaTest: 0.4');
    // Exactly one return survives in the emitted function body.
    expect(mod.match(/\breturn\b/g)!.length).toBe(1);
  });

  it('clamps alphaTest below 1 — at 1.0 three discards every fragment', () => {
    const mod = buildShaderModule(wrap('  return vec3(1, 0, 0);'), {
      materialSettings: { alphaTest: 1 },
    });
    expect(mod).toContain('alphaTest: 0.99');
  });

  it('never interpolates a non-numeric alphaTest from an untrusted project block', () => {
    const mod = buildShaderModule(wrap('  return vec3(1, 0, 0);'), {
      materialSettings: { alphaTest: '0.5 }; globalThis.pwned = 1; ({ x: 0' as unknown as number },
    });
    expect(mod).not.toContain('pwned');
    expect(mod).not.toMatch(/alphaTest:\s*0\.5 \}/);
  });

  it('drops depthWrite:false on an OPAQUE material (it only sorts transparency)', () => {
    // Latched by unchecking Transparent after unchecking Depth Write; on an
    // opaque mesh it self-occludes into cutout-looking holes.
    const opaque = buildShaderModule(wrap('  return vec3(1, 0, 0);'), {
      materialSettings: { depthWrite: false },
    });
    expect(opaque).not.toContain('depthWrite');
    const transparent = buildShaderModule(wrap('  return vec3(1, 0, 0);'), {
      materialSettings: { depthWrite: false, transparent: true },
    });
    expect(transparent).toContain('depthWrite: false');
  });
});

describe('#10: `cond.discard()` (TSL method chaining) is routed through __pixel', () => {
  // `addMethodChaining('discard', Discard)` makes this the idiomatic spelling.
  // It used to survive verbatim into the module, landing at plain-function
  // scope where `.toStack()` has no active stack and is a silent no-op —
  // measured against three r184's GLSLNodeBuilder, the verbatim form emitted
  // ZERO `discard` instructions while the wrapped form emitted one.
  const code = `import { Fn, vec3, greaterThan, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const cond = greaterThan(positionGeometry.y, 0.0);
  cond.discard();

  return vec3(1, 0, 0);
});

export default shader;
`;

  it('lifts the receiver into the wrapper as the condition', () => {
    const out = buildShaderModule(code);
    expect(out).toContain('const __pixel = Fn(([__c0, __color]) => {');
    expect(out).toContain('Discard(__c0);');
    expect(out).toContain('colorNode: __pixel(cond, vec3(1, 0, 0))');
    expect(out).not.toContain('cond.discard()');
  });

  it('imports Discard even though the source never named it', () => {
    // The shaderloader's auto-import would recover this at runtime, but a bare
    // `import()` of the downloaded `.js` would not.
    expect(buildShaderModule(code)).toMatch(/import \{[^}]*\bDiscard\b[^}]*\} from 'three\/tsl';/);
  });

  it('handles a chain whose receiver is itself a call', () => {
    const out = buildShaderModule(`import { Fn, vec3, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  positionGeometry.y.greaterThan(0.0).discard();

  return vec3(1, 0, 0);
});

export default shader;
`);
    expect(out).toContain('__pixel(positionGeometry.y.greaterThan(0.0), vec3(1, 0, 0))');
  });
});

describe('#11: extractDiscards scans CODE only — comments and strings are inert', () => {
  const wrapBody = (body: string) => `import { Fn, vec3, greaterThan, Discard, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const cond = greaterThan(positionGeometry.y, 0.0);
${body}

  return vec3(1, 0, 0);
});

export default shader;
`;

  it('leaves a commented-out discard commented out', () => {
    // Scanning raw text ate the comment's body AND injected a live cutout.
    const out = buildShaderModule(wrapBody('  /* Discard(cond); */'));
    expect(out).not.toContain('__pixel');
    expect(out).toContain('/* Discard(cond); */');
  });

  it('does not lift a discard out of a string literal', () => {
    // `const s = 'Discard(1)';` became `const s = '';` plus a real
    // UNCONDITIONAL cull — the mesh vanished because of a string.
    const out = buildShaderModule(`import { Fn, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const s = 'Discard(1)';

  return vec3(1, 0, 0);
});

export default shader;
`);
    expect(out).not.toContain('__pixel');
    expect(out).toContain("const s = 'Discard(1)';");
  });

  it('still lifts a real discard that carries a comment with an apostrophe', () => {
    const out = buildShaderModule(wrapBody("  Discard(cond); // don't keep these"));
    expect(out).toContain('__pixel(cond, vec3(1, 0, 0))');
  });
});

describe('#12: degenerate discard spellings no longer emit invalid JS', () => {
  it('bare Discard() becomes an unconditional cull, not `__pixel(, …)`', () => {
    // three's own parameterless form. The empty condition used to be passed
    // through as an empty call argument — a SyntaxError that killed the module.
    const out = buildShaderModule(`import { Fn, vec3, Discard } from 'three/tsl';

const shader = Fn(() => {
  Discard();

  return vec3(1, 0, 0);
});

export default shader;
`);
    expect(out).toContain('const __pixel = Fn(([__color]) => {');
    expect(out).toContain('Discard();');
    expect(out).toContain('colorNode: __pixel(vec3(1, 0, 0))');
    expect(out).not.toContain('__pixel(,');
  });

  it('an assigned Discard is left verbatim, not sliced into a dangling `const k =`', () => {
    const out = buildShaderModule(`import { Fn, vec3, Discard, greaterThan, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const cond = greaterThan(positionGeometry.y, 0.0);
  const k = Discard(cond);

  return vec3(1, 0, 0);
});

export default shader;
`);
    expect(out).toContain('const k = Discard(cond);');
    expect(out).not.toMatch(/const k =\s*$/m);
  });
});

describe('#13: a discard on an emissive-only shader keeps the emissive colour', () => {
  it('passes emissive through the wrapper instead of falling back to white', () => {
    // shaderloader 0.5 copies emissiveNode→colorNode only when colorNode is
    // undefined, and the wrapper always defines colorNode — so the white
    // fallback washed the surface out the moment a discard was added.
    const out = buildShaderModule(`import { Fn, vec3, greaterThan, Discard, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const cond = greaterThan(positionGeometry.y, 0.0);
  Discard(cond);

  return { emissive: vec3(0, 1, 0) };
});

export default shader;
`);
    expect(out).toContain('colorNode: __pixel(cond, vec3(0, 1, 0))');
    expect(out).toContain('emissiveNode: vec3(0, 1, 0)');
    expect(out).not.toContain('vec3(1, 1, 1)');
  });
});
