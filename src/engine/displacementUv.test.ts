/**
 * A displaced sphere's seam is welded only when its DISPLACEMENT reads uv
 * (owner, 2026-10-18): a uv() that only coloured it used to weld the seam
 * anyway, squeezing the texture into one vertical column. The editor traces
 * what the `position` channel reads and tells loader 0.8 with
 * `uvDisplaced: false`; the loader honours it (shaderloaderWeld.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { displacementReadsUv } from './displacementUv';
import { buildShaderModule } from './tslCodeProcessor';
import { scriptToTSL } from './scriptToTSL';

const module = (body: string, ret: string) =>
  buildShaderModule(`import { Fn } from 'three/tsl';\n\nconst shader = Fn(() => {\n${body}\n  return ${ret};\n});\n\nexport default shader;\n`);

describe('displacementReadsUv — what the position channel actually reads', () => {
  it('a position-driven wave beside a uv-driven colour reads no uv', () => {
    const defs = ['  const u = uv();', '  const c = mul(u.x, 8);', '  const h = sin(mul(positionGeometry.y, 8));'];
    expect(displacementReadsUv('h', defs)).toBe(false);
  });

  it('a uv-driven height does — directly, through a chain, or through a sampler', () => {
    expect(displacementReadsUv('h', ['  const u = uv();', '  const a = mul(u.y, 4);', '  const h = sin(a);'])).toBe(true);
    expect(displacementReadsUv('mul(uv().x, 0.1)', [])).toBe(true);
    // texture(map) samples at uv() without spelling it.
    expect(displacementReadsUv('h', ['  const t = texture(map);', '  const h = t.r;'])).toBe(true);
  });

  it('answers yes whenever it cannot trace — a statement or a multi-line block keeps the weld', () => {
    expect(displacementReadsUv('h', ['  const h = Fn(() => {', '    return 1;', '  })();'])).toBe(true);
    expect(displacementReadsUv('h', ['  h.assign(1);'])).toBe(true);
  });

  it('follows module-scope helpers too', () => {
    expect(displacementReadsUv('h', ['  const h = helper(1);'], ['const helper = Fn(([x]) => uv().x.mul(x));'])).toBe(true);
    expect(displacementReadsUv('h', ['  const h = helper(1);'], ['const helper = Fn(([x]) => x.mul(2));'])).toBe(false);
  });
});

describe('buildShaderModule emits `uvDisplaced: false` exactly when it changes something', () => {
  const wave = '  const h = sin(mul(positionGeometry.y, 8));';
  it('a position wave with a uv checker colour', () => {
    const m = module(`  const u = uv();\n  const c = vec3(u.x);\n${wave}`, '{ color: c, position: h }');
    expect(m).toContain('uvDisplaced: false');
  });

  it('not when the height itself reads uv — that seam really separates', () => {
    const m = module('  const u = uv();\n  const h = sin(mul(u.y, 8));', '{ color: vec3(1), position: h }');
    expect(m).not.toContain('uvDisplaced');
  });

  it('not without a displacement, and not without any uv() (byte-identical modules)', () => {
    expect(module('  const u = uv();\n  const c = vec3(u.x);', 'c')).not.toContain('uvDisplaced');
    expect(module(wave, '{ color: vec3(1), position: h }')).not.toContain('uvDisplaced');
  });
});

describe('import', () => {
  it('drops the hint — it is re-derived on every export, never a channel', () => {
    const m = module('  const u = uv();\n  const c = vec3(u.x);\n  const h = sin(mul(positionGeometry.y, 8));', '{ color: c, position: h }');
    expect(m).toContain('uvDisplaced: false');
    const back = scriptToTSL(m);
    expect(back).not.toContain('uvDisplaced');
    expect(back).toMatch(/position: h/);
  });
});
