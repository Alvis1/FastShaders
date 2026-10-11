import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectDocs } from './projectDocs';

/**
 * The docs name things a reader will RUN or OPEN, so each must exist.
 * 2026-10-09 moved and retired several at once — teapot.obj became generated
 * (scripts/gen-teapot-obj.mjs and its npm script went), Tests/ became
 * tests/corpus/, server/ became scripts/eval-endpoint/, and the vendor copies
 * left git — and a dozen references kept naming the old ones: the npm script
 * failed with "Missing script", and `Tests/` resolved only on a
 * case-insensitive disk.
 *
 * Reads the claim corpus (CLAUDE.md + docs/dev, `projectDocs`) and the three
 * READMEs a user follows. EVAL_MODE_PLAN.md is an archive and keeps the names
 * that were true when it was written.
 */
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const READMES = ['README.md', 'docs/PODEST.md', 'ShaderCarousel/README.md'];
const corpus = () => [projectDocs(), ...READMES.map(read)].join('\n');

describe('what the docs tell a reader to run', () => {
  it('every scripts/ path they name exists', () => {
    // Never `a-frame-shaderloader/scripts/…` or `…/scripts/` inside another path: those are not the repo's.
    const named = [...new Set([...corpus().matchAll(/(?<![\w./-])scripts\/[\w./-]*/g)].map((m) => m[0].replace(/[.,;:]+$/, '')))];
    expect(named).toContain('scripts/sync-generated.mjs'); // the scan finds what is there
    expect(named.filter((p) => !existsSync(path.join(ROOT, p)))).toEqual([]);
  });

  it('every `npm run` they name is a script — the root package\'s, or the submodule\'s for what runs inside it', () => {
    const named = [...new Set([...corpus().matchAll(/\bnpm run ([a-z][\w:-]*)/g)].map((m) => m[1]))];
    expect(named).toContain('sync:generated');
    const scriptsOf = (rel: string) => Object.keys((JSON.parse(read(rel)) as { scripts?: object }).scripts ?? {});
    // Read here, never at module top level: the vitest start already refuses a checkout without the submodule.
    const known = new Set([...scriptsOf('package.json'), ...scriptsOf('a-frame-shaderloader/package.json')]);
    expect(named.filter((n) => !known.has(n))).toEqual([]);
  });
});

describe('claims the 2026-10 review retracted stay retracted', () => {
  it('the moved folders and the generated files are not described the old way', () => {
    const docs = corpus();
    for (const retracted of [
      'the `Tests/` corpus',
      '- `Tests/` —',
      '`server/*.php`',
      'compares the committed bytes',
      // public/js is generated, pruned and gitignored, and a hand edit is overwritten before any test runs.
      'VENDORED, do not hand-edit',
      '(vendorSync.test.ts fails on drift)',
      '(`VENDOR_TARGETS`, `vite.config.ts`)',
      'the plugin only ever copies',
    ]) {
      expect(docs, retracted).not.toContain(retracted);
    }
  });

  it('no doc counts the suites that read the corpus — that is a search (`projectDocs`)', () => {
    expect(projectDocs()).not.toMatch(/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+suites\s+depend\s+on\s+(?:this|it)\b/i);
  });

  it('dark mode keeps every reading\'s hue, and the docs name the one opacity lift (the RGB Curves editor plot)', () => {
    const docs = projectDocs();
    expect(docs).toContain('Their HUES never change');
    expect(docs).toContain('`.fs-curves__inactive`');
  });
});
