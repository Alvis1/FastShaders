import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * The FROZEN shaderloaders, pinned by content hash.
 *
 * Every shader this app has ever exported names ONE loader file by URL on
 * jsdelivr (`CDN_BASE`/`LOADER_FILE` in engine/tslToShaderModule.ts), served
 * from the `a-frame-shaderloader` submodule's `js/` dir. An edit to 0.4, 0.5 or
 * 0.6 therefore ships retroactively to every recipient of an already-exported
 * shader the moment the submodule is pushed — which is why they are frozen, and
 * why new loader work goes in a NEW file.
 *
 * Until now the only thing that noticed an edit to 0.6 was vendorSync.test.ts,
 * comparing the submodule file with its `public/js` copy — and that copy is
 * about to stop existing (0.6 leaves the vendored set once every surface loads
 * a newer loader). 0.4 and 0.5 were never checked at all. These hashes are the
 * standing check, and they do not care where the file is vendored.
 *
 * A mismatch here is not fixed by updating the hash. Revert the edit and put
 * the change in the current loader instead.
 *
 * Skipped when the submodule is not checked out (a non-recursive clone has an
 * empty `a-frame-shaderloader/` directory), exactly like the vendorSync and
 * transform suites; `release.yml` checks it out recursively, so CI runs it.
 * With the submodule present, a MISSING frozen file fails — deleting one breaks
 * every shader that references it just as surely as editing it.
 */
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'a-frame-shaderloader/js');

const FROZEN: Record<string, string> = {
  'a-frame-shaderloader-0.4.js': '8ed7b689be7a16f03d4dad65e7635fe44fdcc3df0ffc92f3d45bca84667a2c59',
  'a-frame-shaderloader-0.5.js': '2bfd0ed0aaa7ddd2f4addee2315daf4ea8f2cf1a3863e90f3a1a19e7d0597707',
  'a-frame-shaderloader-0.6.js': 'eec83d910f0873e3548a99a2d37b300c544b961ab96415a5fbd67c3192a5218d',
};

describe.skipIf(!existsSync(JS))('frozen shaderloaders are byte-identical to what exports reference', () => {
  for (const [file, expected] of Object.entries(FROZEN)) {
    it(`${file} is unchanged`, () => {
      const p = path.join(JS, file);
      expect(existsSync(p), `frozen loader missing: ${p} — already-exported shaders fetch it`).toBe(true);
      const actual = createHash('sha256').update(readFileSync(p)).digest('hex');
      expect(
        actual,
        `${file} was edited. It is frozen: exported shaders load it by URL, so an edit ships ` +
          'retroactively. Revert it and put the change in the current loader.',
      ).toBe(expected);
    });
  }
});
