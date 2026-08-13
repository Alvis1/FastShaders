import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { safeJsonReviver } from './safeJson';

describe('safeJsonReviver', () => {
  it('drops __proto__ / constructor / prototype as own keys', () => {
    const out = JSON.parse(
      '{"__proto__":{"polluted":1},"constructor":{"x":1},"prototype":{"y":1},"a":1}',
      safeJsonReviver,
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['a']);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('leaves ordinary nested data untouched', () => {
    expect(JSON.parse('{"nodes":[{"id":"n1","data":{"values":{"v":2}}}]}', safeJsonReviver))
      .toEqual({ nodes: [{ id: 'n1', data: { values: { v: 2 } } }] });
  });

  /**
   * The whole reason this module exists: the reviver used to be copy-pasted
   * into useAppStore, fastShadersProject AND ShaderPreview — three trust
   * boundaries, one rule, maintained three times. A fourth copy would silently
   * miss any future deny-list key, so fail the build on one.
   */
  it('is the only declaration of the reviver in src/', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(p)) continue;
        // The util itself, and THIS file — whose needle below is literally the
        // string it searches for.
        if (p.endsWith(join('utils', 'safeJson.ts'))) continue;
        if (p.endsWith(join('utils', 'safeJson.test.ts'))) continue;
        if (readFileSync(p, 'utf8').includes('function safeJsonReviver')) hits.push(p);
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});
