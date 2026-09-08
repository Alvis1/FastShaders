/**
 * The `unknown`-node expression validator — the security control that decides
 * whether a stored `rawExpression` may be emitted VERBATIM into the generated
 * module (see the module's own header for the threat model).
 *
 * Two properties are pinned here:
 *   · what the validator accepts and rejects, and
 *   · that an UNVALIDATED expression is never accepted — the parser is loaded
 *     on demand now (to keep @babel/* off the boot payload), and the cold
 *     answer must be `false`, not "assume it's fine until we know".
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { isSafeUnknownExpression, loadUnknownExpressionValidator } from './unknownExpression';

beforeAll(() => loadUnknownExpressionValidator());

describe('isSafeUnknownExpression — pure data/TSL expressions pass', () => {
  it.each([
    'mysteryFn(1, 2, 3)',
    'mysteryFn(vec3(1, 2, 3), 0.5)',
    'mysteryFn(positionLocal.mul(2.0))',
    'mysteryFn(uv().x, -1.0)',
    'mysteryFn(a, b, c)',
    'mysteryFn(vec3(1).mul(2).add(3))',
    'mysteryFn([1, 2], "srgb", !flag)',
  ])('accepts %s', (expr) => {
    expect(isSafeUnknownExpression(expr)).toBe(true);
  });
});

describe('isSafeUnknownExpression — anything that could execute is rejected', () => {
  it.each([
    ['IIFE argument', 'mysteryFn((() => { window.location = "http://evil/" })())'],
    ['fetch in argument', 'mysteryFn(fetch("http://evil"))'],
    ['bare eval call', 'eval("alert(1)")'],
    ['forbidden global in argument', 'mysteryFn(window.document.cookie)'],
    ['member-expression callee', 'window.fetch("http://evil")'],
    ['statement list', 'mysteryFn(); fetch("http://evil")'],
    ['assignment in argument', 'mysteryFn(window.name = "x")'],
    ['computed property access', 'mysteryFn(self["eval"]("x"))'],
    ['not a call at all', 'positionLocal'],
    ['new expression', 'mysteryFn(new Worker("x"))'],
    ['template literal', 'mysteryFn(`${a}`)'],
    ['spread argument', 'mysteryFn(...args)'],
    ['sequence operator', 'mysteryFn((a, b))'],
    ['unparseable', 'mysteryFn(('],
    ['prototype hop', 'mysteryFn(x.constructor)'],
  ])('rejects %s', (_label, expr) => {
    expect(isSafeUnknownExpression(expr)).toBe(false);
  });
});

describe('the validator fails CLOSED before its parser has loaded', () => {
  // A fresh module instance is the only way to observe the cold state: the
  // parser reference and the verdict cache are module-scope, and this worker
  // shares module instances across files (vite.config.ts `isolate: false`).
  afterAll(() => { vi.resetModules(); });

  it('rejects an expression it has not actually parsed, then accepts it once it can', async () => {
    vi.resetModules();
    const cold = await import('./unknownExpression');
    expect(cold.isSafeUnknownExpression('mysteryFn(1, 2, 3)')).toBe(false);
    await cold.loadUnknownExpressionValidator();
    expect(cold.isSafeUnknownExpression('mysteryFn(1, 2, 3)')).toBe(true);
    // A fail-closed answer must not have been cached, and a real one must be.
    expect(cold.isSafeUnknownExpression('eval("x")')).toBe(false);
  });

  it('tells subscribers when the parser lands, so a producer can re-run', async () => {
    vi.resetModules();
    const cold = await import('./unknownExpression');
    const seen: number[] = [];
    const off = cold.onUnknownExpressionValidated(() => seen.push(1));
    // Only a COLD miss arms the notification — that is the case where an
    // already-emitted module is holding fallbacks.
    expect(cold.isSafeUnknownExpression('mysteryFn(1)')).toBe(false);
    await cold.loadUnknownExpressionValidator();
    await Promise.resolve();
    expect(seen.length).toBeGreaterThan(0);
    off();
  });
});
