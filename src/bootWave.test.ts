import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBuiltinTextureIds } from '@/registry/builtinTextureIds';
import {
  getBuiltinTextures,
  getBuiltinTextureIds as idsViaLibrary,
} from '@/registry/builtinTextures';

/**
 * Babel stays OFF the main app's boot wave.
 *
 * `vendor-babel` is 805 KB raw / 204 KB gzip, and vite modulepreloads every
 * chunk the entry reaches through STATIC imports. Until 2026-09-29 exactly one
 * such edge existed (the content browser importing the two built-in libraries,
 * which build through codeGroupBuilder → codeToGraph → @babel/*), and it put
 * 244 KB gzip on the wave while every other call site carried a comment saying
 * its `import()` kept Babel off it. Every one of those comments was true of
 * its own file and false of the app, which is why nobody saw it: a lazy import
 * buys nothing while any static path to the same module survives.
 *
 * So this walks the static import graph from `main.tsx` and fails on the first
 * path that reaches a Babel-bearing module, printing the chain. It reads the
 * SOURCE, not `dist/` (the suite runs before the build in release.yml), which
 * makes it conservative in one direction: a value import used only as a type
 * is elided by the bundler but counted here. Mark it `import type`.
 */

const SRC = fileURLToPath(new URL('./', import.meta.url));
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** A clause of names, braces, commas and `* as`, never running into the next statement. */
const CLAUSE = String.raw`((?:(?!\b(?:import|export)\b)[\w\s{},*$])*?)`;
const FROM_RE = new RegExp(
  String.raw`^[ \t]*(?:import|export)\s+(type\s+)?${CLAUSE}\s*from\s*['"]([^'"]+)['"]`,
  'gm',
);
const SIDE_EFFECT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;

/** `{ type A, type B }`: every name is a type, so the bundler drops the import. */
function allNamesAreTypes(clause: string): boolean {
  const braces = clause.trim().match(/^\{([\s\S]*)\}$/);
  if (!braces) return false;
  const names = braces[1].split(',').map((n) => n.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** The specifiers a module imports or re-exports STATICALLY, as values. */
function staticSpecifiers(source: string): string[] {
  const code = codeOnly(source);
  const out: string[] = [];
  for (const m of code.matchAll(FROM_RE)) {
    if (m[1] || allNamesAreTypes(m[2])) continue;
    out.push(m[3]);
  }
  for (const m of code.matchAll(SIDE_EFFECT_RE)) out.push(m[1]);
  return out;
}

/** A local specifier's source file, or null (a package, a stylesheet, data). */
function resolveLocal(spec: string, importer: string): string | null {
  if (spec.includes('?')) return null;
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(importer), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface StaticGraph {
  /** Every module reached, mapped to the module that first imported it. */
  importerOf: Map<string, string | null>;
  /** Every package specifier met, mapped to a module that imports it. */
  packages: Map<string, string>;
}

function walkStatic(entry: string): StaticGraph {
  const importerOf = new Map<string, string | null>([[entry, null]]);
  const packages = new Map<string, string>();
  const queue = [entry];
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      const local = resolveLocal(spec, file);
      if (local) {
        if (!importerOf.has(local)) {
          importerOf.set(local, file);
          queue.push(local);
        }
      } else if (!spec.startsWith('.') && !spec.startsWith('@/') && !packages.has(spec)) {
        packages.set(spec, file);
      }
    }
  }
  return { importerOf, packages };
}

const rel = (file: string) => relative(SRC, file);

function chainTo(graph: StaticGraph, file: string): string {
  const chain: string[] = [];
  for (let at: string | null | undefined = file; at; at = graph.importerOf.get(at)) chain.unshift(rel(at));
  return chain.join(' → ');
}

/** Modules that import @babel/* as values, or exist only to feed one that does. */
const BABEL_BEARING = [
  'engine/codeToGraph.ts',
  'engine/scriptToTSL.ts',
  'registry/codeGroupBuilder.ts',
  'registry/builtinTextures.ts',
  'registry/builtinPresets.ts',
  'registry/descriptionSplice.ts',
];

describe('the static import scanner', () => {
  it('reads value imports, re-exports and side-effect imports', () => {
    expect(
      staticSpecifiers(
        [
          "import a from './a';",
          "import { b,\n  c } from '@/b';",
          "import * as d from 'pkg-d';",
          "export { e } from './e';",
          "export * from './f';",
          "import './g.css';",
        ].join('\n'),
      ),
    ).toEqual(['./a', '@/b', 'pkg-d', './e', './f', './g.css']);
  });

  it('skips what the build erases or defers', () => {
    expect(
      staticSpecifiers(
        [
          "import type { A } from './types-a';",
          "import { type B, type C } from './types-b';",
          "export type { D } from './types-d';",
          "// import { x } from './commented';",
          "const lazy = () => import('./dynamic');",
          "type T = typeof import('./type-query').t;",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('does not let a type export swallow the value import below it', () => {
    expect(staticSpecifiers("export type { A }\nimport { b } from './b';")).toEqual(['./b']);
  });
});

describe('the main app boot wave', () => {
  const graph = walkStatic(join(SRC, 'main.tsx'));

  it('walks the real app (the guard is not vacuous)', () => {
    for (const reached of ['App.tsx', 'store/useAppStore.ts', 'components/NodeEditor/ContentBrowser.tsx', 'engine/graphToCode.ts']) {
      expect(graph.importerOf.has(join(SRC, reached)), reached).toBe(true);
    }
    expect(graph.packages.has('react')).toBe(true);
  });

  it.each(BABEL_BEARING)('never reaches %s through static imports', (file) => {
    const abs = join(SRC, file);
    expect(existsSync(abs), `${file} moved: update BABEL_BEARING`).toBe(true);
    expect(
      graph.importerOf.has(abs) ? chainTo(graph, abs) : null,
      'a static path to a Babel-bearing module puts vendor-babel (204 KB gz) on the boot wave: load it with import()',
    ).toBeNull();
  });

  it('never imports @babel/* as a value', () => {
    const offenders = [...graph.packages]
      .filter(([spec]) => spec.startsWith('@babel/'))
      .map(([spec, file]) => `${spec} ← ${chainTo(graph, file)}`);
    expect(offenders).toEqual([]);
  });

  it('the Babel-bearing list is true: each one does reach @babel/*', () => {
    for (const file of BABEL_BEARING) {
      const own = walkStatic(join(SRC, file));
      expect([...own.packages.keys()].some((spec) => spec.startsWith('@babel/')), file).toBe(true);
    }
  });
});

describe('the built-in texture ids leaf', () => {
  it('imports nothing', () => {
    const src = readFileSync(join(SRC, 'registry/builtinTextureIds.ts'), 'utf8');
    expect(staticSpecifiers(src)).toEqual([]);
    expect(codeOnly(src)).not.toMatch(/\bimport\s*\(/);
  });

  it('lists exactly the textures the library builds, in its order', () => {
    // The ids are written out twice (TEXTURE_ENTRIES has to stay in
    // builtinTextures.ts for the description splice), so they are a drift pair.
    expect(getBuiltinTextureIds()).toEqual(getBuiltinTextures().map((t) => t.id));
  });

  it('is what the library re-exports, and hands out a fresh array', () => {
    expect(idsViaLibrary).toBe(getBuiltinTextureIds);
    expect(getBuiltinTextureIds()).not.toBe(getBuiltinTextureIds());
  });
});
