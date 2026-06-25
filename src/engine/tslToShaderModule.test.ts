import { describe, it, expect } from 'vitest';
import { tslToShaderModule } from './tslToShaderModule';
import { buildShaderModule } from './tslCodeProcessor';
import { scriptToTSL } from './scriptToTSL';

/** graphToCode-style TSL: color + position + a wired discard. */
const COLOR_POS_DISCARD = `import { Fn, mix, vec3, greaterThan, Discard } from 'three/tsl';

const shader = Fn(() => {
  const mix1 = mix(vec3(1, 0, 0), vec3(0, 0, 1), 0.5);
  const greaterThan1 = greaterThan(0.5, 0.2);
  const mul3 = mix1.mul(0.1);
  Discard(greaterThan1);

  return { color: mix1, position: mul3 };
});

export default shader;
`;

/** color only + discard (single-value return). */
const COLOR_DISCARD = `import { Fn, mix, vec3, greaterThan, Discard } from 'three/tsl';

const shader = Fn(() => {
  const mix1 = mix(vec3(1, 0, 0), vec3(0, 0, 1), 0.5);
  const greaterThan1 = greaterThan(0.5, 0.2);
  Discard(greaterThan1);

  return mix1;
});

export default shader;
`;

/** color + position, no discard. */
const COLOR_POS = `import { Fn, mix, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const mix1 = mix(vec3(1, 0, 0), vec3(0, 0, 1), 0.5);
  const mul3 = mix1.mul(0.1);

  return { color: mix1, position: mul3 };
});

export default shader;
`;

describe('tslToShaderModule — discard + multi-channel (the struct-as-colorNode bug)', () => {
  const out = tslToShaderModule(COLOR_POS_DISCARD);

  it('never assigns a struct to colorNode', () => {
    // The bug: the simple-return regex greedily swallowed `{ color, position }`
    // and wrapped the whole struct in __pixel(), so `colorNode: __pixel()`
    // received a { color, position } struct.
    expect(out).not.toContain('colorNode: __pixel()');
    // A struct return inside __pixel is the tell-tale signature.
    expect(out).not.toMatch(/return\s*\{\s*color:/);
  });

  it('routes the color channel through __pixel with the color as a real value', () => {
    expect(out).toContain('colorNode: __pixel(greaterThan1, mix1)');
  });

  it('preserves the position channel (it was silently dropped before)', () => {
    expect(out).toContain('positionNode: positionLocal.add(normalLocal.mul(mul3))');
  });

  it('passes discard conditions + color as Fn parameters, never closure-captured', () => {
    // Closure capture failed in r173 where this was diagnosed (solid red material);
    // the bundle is now r184, but this explicit-param emission is version-independent.
    expect(out).toContain('const __pixel = Fn(([__c0, __color]) => {');
    expect(out).toContain('Discard(__c0);');
    expect(out).toContain('return __color;');
    expect(out).not.toMatch(/__pixel\s*=\s*Fn\(\(\)\s*=>/); // no empty-param closure form
  });

  it('re-imports Fn + positionLocal/normalLocal needed by the transforms', () => {
    expect(out).toMatch(/import \{[^}]*\bFn\b[^}]*\} from 'three\/tsl';/);
    expect(out).toMatch(/import \{[^}]*\bpositionLocal\b[^}]*\} from 'three\/tsl';/);
    expect(out).toMatch(/import \{[^}]*\bnormalLocal\b[^}]*\} from 'three\/tsl';/);
  });
});

describe('tslToShaderModule — color-only + discard', () => {
  const out = tslToShaderModule(COLOR_DISCARD);

  it('wraps the single color value in a param-passing __pixel', () => {
    expect(out).toContain('colorNode: __pixel(greaterThan1, mix1)');
    expect(out).toContain('const __pixel = Fn(([__c0, __color]) => {');
    expect(out).not.toContain('colorNode: __pixel()');
  });
});

describe('tslToShaderModule — multi-channel, no discard', () => {
  const out = tslToShaderModule(COLOR_POS);

  it('emits both channels directly, no __pixel', () => {
    expect(out).toContain('colorNode: mix1');
    expect(out).toContain('positionNode: positionLocal.add(normalLocal.mul(mul3))');
    expect(out).not.toContain('__pixel');
  });
});

describe('tslToShaderModule — property schema', () => {
  const withProp = `import { Fn, uniform, mul, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const amount = uniform(2.5);
  const mul1 = positionGeometry.mul(amount);

  return mul1;
});

export default shader;
`;
  const out = tslToShaderModule(withProp, undefined, [
    { name: 'amount', type: 'float', defaultValue: 2.5 },
  ]);

  it('rewrites the uniform to params and exports a schema with the declared default', () => {
    expect(out).toContain('const amount = params.amount;');
    expect(out).toContain("amount: { type: 'number', default: 2.5 },");
    expect(out).toContain('export default function(params) {');
  });
});

describe('preview ↔ export parity (single source of truth)', () => {
  it('export output is exactly the usage header + the preview module', () => {
    const previewModule = buildShaderModule(COLOR_POS_DISCARD, {});
    const exportModule = tslToShaderModule(COLOR_POS_DISCARD);
    // Strip the leading `// ...` header block + the blank line that follows it.
    const lines = exportModule.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].startsWith('//')) i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    const exportBody = lines.slice(i).join('\n');
    expect(exportBody).toBe(previewModule);
  });
});

describe('round-trip: export → scriptToTSL recovers the original channels', () => {
  it('color + position + discard survives the round-trip', () => {
    const exported = tslToShaderModule(COLOR_POS_DISCARD);
    const back = scriptToTSL(exported);

    // The param-passing wrapper is fully unwound.
    expect(back).not.toContain('__pixel');
    expect(back).not.toContain('__color');
    expect(back).not.toContain('__c0');
    // Discard restored as a bare statement with the real condition.
    expect(back).toContain('Discard(greaterThan1);');
    // Channels renamed back and displacement unwrapped.
    expect(back).toContain('return { color: mix1, position: mul3 };');
    expect(back).not.toContain('positionLocal');
    // Wrapped back into the canonical Fn shader form.
    expect(back).toContain('const shader = Fn(() => {');
    expect(back).toContain('export default shader;');
  });

  it('color-only + discard survives the round-trip', () => {
    const exported = tslToShaderModule(COLOR_DISCARD);
    const back = scriptToTSL(exported);
    expect(back).not.toContain('__pixel');
    expect(back).toContain('Discard(greaterThan1);');
    expect(back).toContain('return { color: mix1 };');
  });
});
