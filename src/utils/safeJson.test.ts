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

  /**
   * The OTHER half of the guarantee, and the one that was missing: uniqueness of
   * the DECLARATION says nothing about universality of the USE. Six app-side
   * parses opted out for years — `utils/costOverride.ts` (a user-dropped
   * benchmark/profile file, twice), `utils/dataNode.ts` (a `.fastshader`
   * payload), `utils/previewMesh.ts` (a dropped model's glTF header),
   * `engine/exportShader.ts` (six preview-pref localStorage keys that get
   * embedded VERBATIM into the downloaded `.js`) and
   * `components/NodeEditor/menus/recentNodes.ts` (localStorage). Every one was
   * contained by its own downstream shape check, so nothing was exploitable —
   * which is exactly why nobody noticed that the deny-list only applied where
   * someone had remembered it.
   *
   * Scope. `src/nodeDesigner/` is exempt: it is the dev-only ported vanilla app
   * (`@ts-nocheck`), it never runs in the shipped editor, and it already handles
   * the same hazard its own way (`Object.create(null)` on every catch). Test
   * files are exempt because a test's fixture is its own author's string.
   *
   * The check is line-scoped (the call and the line after it), which is enough
   * for every call in the tree today. A future multi-line `JSON.parse(` that
   * really does pass the reviver will fail here — reformat the call onto one
   * line rather than widening the rule, since a looser match is how this kind
   * of grep guard stops catching anything.
   */
  it('every app-side JSON.parse passes the reviver', () => {
    const bare: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) {
          if (e !== 'nodeDesigner') walk(p);
          continue;
        }
        if (!/\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p)) continue;
        if (p.endsWith(join('utils', 'safeJson.ts'))) continue;
        const lines = readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!line.includes('JSON.parse(')) return;
          const window = line + '\n' + (lines[i + 1] ?? '');
          if (!window.includes('safeJsonReviver')) bare.push(`${p}:${i + 1}`);
        });
      }
    };
    walk('src');
    expect(
      bare,
      'JSON.parse without safeJsonReviver — every parse in the app sits at a ' +
        'trust boundary (localStorage, a shared .fastshader, a dropped file), ' +
        'so the deny-list must apply there too. Pass safeJsonReviver as the ' +
        'second argument.',
    ).toEqual([]);
  });
});
