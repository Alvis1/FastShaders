import { describe, it, expect } from 'vitest';
import { buildShaderModule } from './tslCodeProcessor';

/**
 * `parseBody` is line-based and used to treat EVERY `return` line as the
 * shader's return. A nested `Fn(() => { … return v; })()` — the only shape that
 * can carry `Loop`/`If`/`.assign` into a module the loader calls as a plain
 * function — therefore lost its own return (hijacked as the colour channel and
 * deleted from the body), which left the inner Fn VOID. In the A-Frame bundle
 * that surfaced as a `getTypeFromLength` crash; unminified, as "Invalid
 * generated code, expected a vec3". Only a depth-0 `return` is the shader's.
 */
const NESTED = `import { Fn, vec3, float, Loop } from 'three/tsl';

const shader = Fn(() => {
  const march = Fn(() => {
    const acc = float(0).toVar();
    Loop(4, () => {
      acc.addAssign(0.1);
    });
    return vec3(acc);
  })();
  return { color: march, emissive: march };
});

export default shader;
`;

describe('parseBody keeps a nested Fn’s return where it is', () => {
  it('the inner return survives inside the helper and the outer one becomes the channels', () => {
    const mod = buildShaderModule(NESTED, {});
    expect(mod).toContain('return vec3(acc);');
    expect(mod).toContain('colorNode: march');
    expect(mod).toContain('emissiveNode: march');
    // The inner return must not have been promoted to a channel.
    expect(mod).not.toMatch(/colorNode:\s*vec3\(acc\)/);
    // Exactly one top-level return: the channels object.
    const topReturns = mod.split('\n').filter((l) => /^  return \{/.test(l));
    expect(topReturns).toHaveLength(1);
  });

  it('a flat body is unchanged: its bare return is still the colour channel', () => {
    const flat = `import { Fn, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const c = vec3(1, 0, 0);
  return c;
});

export default shader;
`;
    const mod = buildShaderModule(flat, {});
    expect(mod).toContain('colorNode: c');
    expect(mod).not.toContain('\n  return c;');
  });

  it('a brace inside a string does not shift the depth', () => {
    const tricky = `import { Fn, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const label = "{";
  const c = vec3(1, 0, 0);
  return c;
});

export default shader;
`;
    const mod = buildShaderModule(tricky, {});
    expect(mod).toContain('colorNode: c');
  });
});

describe('extractFnBody picks the SHADER, not a zero-parameter helper above it', () => {
  it('a `const helper = Fn(() => {…})` declared before `const shader` stays a preamble helper', () => {
    const code = `import { Fn, vec3, normalize, sub, positionWorld, cameraPosition } from 'three/tsl';

const rayDirection = Fn(() => {
  return normalize(sub(positionWorld, cameraPosition));
});

const shader = Fn(() => {
  const rayDirection1 = rayDirection();
  const c = vec3(1, 0, 0);
  return { color: c, emissive: rayDirection1 };
});

export default shader;
`;
    const mod = buildShaderModule(code, {});
    expect(mod).toContain('const rayDirection = Fn(() => {');
    expect(mod).toContain('const rayDirection1 = rayDirection();');
    expect(mod).toContain('colorNode: c');
    expect(mod).toContain('emissiveNode: rayDirection1');
    expect(mod).not.toContain('colorNode: normalize(');
  });
});
