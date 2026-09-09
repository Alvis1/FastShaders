/**
 * The loader extends its A-Frame schema ONCE per apply, with the module's whole
 * uniform set — and that is what makes the `fs:shader` hot swap correct across
 * modules with DIFFERENT uniform sets.
 *
 * A-Frame's `extendSchema` rebuilds from `{}` plus the component's ORIGINALLY
 * REGISTERED schema every time; it does not accumulate. Two consequences, and
 * the hot path depends on both:
 *
 *   · GOOD — swapping module A (colorA, speed) for module B (tint) leaves the
 *     component carrying B's properties alone. A's cannot linger as ghost
 *     attributes that the parent's uniform push would then write into nothing.
 *   · TRAP — splitting the call in two (say, numbers then colours, which is the
 *     obvious refactor when the builder grows) makes the SECOND call drop the
 *     first call's properties. Half the module's uniforms would silently stop
 *     existing, with no error anywhere: the shader still compiles, it just
 *     ignores those values.
 *
 * The loader states this in a comment beside the call. A comment is not a
 * guard, and neither half is observable from this suite at runtime — driving
 * `extendSchema` needs real A-Frame and a DOM, and the vitest env is `node`. So
 * both halves are pinned as source facts: the loader's single call, and the
 * vendored bundle's own implementation of the semantics it relies on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const loader = readFileSync(new URL('../public/js/a-frame-shaderloader-0.6.js', import.meta.url), 'utf8');
const aframe = readFileSync(new URL('../public/js/a-frame-180-a-01.min.js', import.meta.url), 'utf8');

describe('the loader extends its schema exactly once', () => {
  it('makes ONE extendSchema call, so no call can drop another call\'s uniforms', () => {
    const calls = loader.match(/this\.extendSchema\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // …and it is handed the whole map, not a slice of it.
    expect(loader).toContain('this.extendSchema(propSchema);');
  });

  it('keeps the reason beside the call', () => {
    // The next person to grow the property builder reads this line or repeats
    // the defect; it is the only thing standing between here and a silent
    // half-registered uniform set.
    expect(loader).toMatch(/does NOT accumulate across calls/);
  });
});

describe('the A-Frame behaviour that rule depends on', () => {
  /** `extendSchema:function(r){ … }` out of the minified bundle. */
  const body = (() => {
    const i = aframe.indexOf('extendSchema:function(');
    expect(i, 'extendSchema is no longer a plain method on the component prototype').toBeGreaterThan(-1);
    return aframe.slice(i, i + 300);
  })();

  it('rebuilds from the REGISTERED schema each time rather than accumulating', () => {
    // Minified identifiers change on every bundle rebuild, so this pins the
    // SHAPE: a fresh `{}` merged with the registry entry's `.schema`, keyed by
    // `this.name`. If a future A-Frame merged into `this.schema` instead, the
    // loader's single-call design would start accumulating stale uniforms
    // across every hot swap — and nothing else in this repo would notice.
    expect(body).toMatch(/\{\s*\}\s*,\s*\w+\[this\.name\]\.schema\)/);
    expect(body).toMatch(/this\.schema\s*=/);
  });

  it('does not seed the merge from the component\'s CURRENT schema', () => {
    // The accumulating shape would read `this.schema` as the base. Asserting
    // its absence is what makes the test above mean "not accumulating" rather
    // than merely "mentions a schema".
    const base = body.slice(0, body.indexOf('this.schema='));
    expect(base).not.toMatch(/\{\s*\}\s*,\s*this\.schema/);
  });
});
