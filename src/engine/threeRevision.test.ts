import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REVISION } from 'three';
import { THREE_REVISION } from './threeRevision';
import { THREE_VERSION } from './tslToThreeHTML';
import { tslToShaderModule } from './tslToShaderModule';
import { buildShaderModule } from './tslCodeProcessor';
import { CURRENT_LOADER, loaderAvailable, loaderText } from '@/shaderloaderHarness';

/**
 * `THREE_REVISION` is one member of a drift set (see threeRevision.ts). A
 * number that drifts from the rest fails nowhere else: a page on the wrong
 * three still loads, and only the revision warning — or a shader that stops
 * compiling on a recipient's page — would ever say so.
 *
 * This is the LOADER half; the emission half (every new module declaring
 * `export const threeRevision`) follows it below.
 */
describe('THREE_REVISION — the drift set', () => {
  it('is the installed three', () => {
    expect(REVISION).toBe(THREE_REVISION);
    // package.json's version is 0.<revision>.<patch>. Read by pattern rather
    // than parsed, so no reviver is needed for a file this test does not own.
    const pkg = readFileSync(path.resolve(__dirname, '../../node_modules/three/package.json'), 'utf8');
    const m = /"version"\s*:\s*"0\.(\d+)\.\d+"/.exec(pkg);
    expect(m, 'node_modules/three/package.json has no 0.<rev>.<patch> version').not.toBeNull();
    expect(m![1]).toBe(THREE_REVISION);
  });

  it('is the three the Three.js tab pins', () => {
    expect(THREE_VERSION).toBe(`0.${THREE_REVISION}.0`);
  });

  it.skipIf(!loaderAvailable(CURRENT_LOADER))('is the revision the current loader is written for', () => {
    // The loader compares a page's three against this constant; a stale one
    // would warn on every correctly built page, or stay silent on a wrong one.
    expect(loaderText(CURRENT_LOADER)).toContain(`var THREE_REVISION = "${THREE_REVISION}";`);
  });
});

/**
 * The EMISSION half: every module buildShaderModule writes — the downloaded
 * export and the preview module alike, since they share one builder — declares
 * the revision it was emitted for, right after the imports (integration §2g).
 * Loader 0.8 compares it with the page's THREE.REVISION and warns on a
 * mismatch; 0.4–0.6 read only `default` and `schema`, so it is inert there.
 */
describe('every new module declares threeRevision', () => {
  const DECL = `export const threeRevision = '${THREE_REVISION}';`;
  const TSL = `import { Fn, uniform, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const amount = uniform(2.5);
  const mul1 = positionGeometry.mul(amount);

  return mul1;
});

export default shader;
`;

  it('once, after the imports, a blank line, then the schema', () => {
    const lines = tslToShaderModule(TSL, undefined, [
      { name: 'amount', type: 'float', defaultValue: 2.5 },
    ]).split('\n');
    expect(lines.filter((l) => l === DECL)).toHaveLength(1);
    const at = lines.indexOf(DECL);
    const lastImport = Math.max(...lines.map((l, i) => (/^import\b/.test(l) ? i : -1)));
    expect(lastImport).toBeGreaterThan(-1);
    expect(lines[lastImport + 1]).toBe('');
    expect(at).toBe(lastImport + 2);
    expect(lines[at + 1]).toBe('');
    expect(lines[at + 2]).toBe('export const schema = {');
  });

  it('the preview module carries it too (one builder)', () => {
    const preview = buildShaderModule(TSL);
    expect(preview.split('\n').filter((l) => l === DECL)).toHaveLength(1);
  });

  it('a pasted declaration never makes it twice', () => {
    // Code-panel text that already carries the line (pasted from an export):
    // extractFnBody drops it from the preamble, or the module would export
    // `threeRevision` twice — a SyntaxError for the whole module.
    const pasted = `${DECL}\n${TSL}`;
    const out = buildShaderModule(pasted);
    expect(out.split('\n').filter((l) => /threeRevision/.test(l))).toEqual([DECL]);
  });
});
