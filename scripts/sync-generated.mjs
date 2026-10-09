// Writes every file the repository deliberately does NOT track (.gitignore,
// "Generated at dev/build/test start"). vite.config.ts runs it at buildStart,
// so `npm run dev`, `npm run build`, `npm test` and `npm run tauri …` all
// produce the files first. To produce them by hand (e.g. before serving
// ShaderCarousel/ or public/podest.html with a static server):
//
//   npm run sync:generated   (= node --experimental-strip-types scripts/sync-generated.mjs)
//
// What it writes, and from where:
//   - public/js/**                       ← a-frame-shaderloader/js (the submodule)
//   - ShaderCarousel/components/three/   ← a-frame-shaderloader/js (the A-Frame bundle)
//   - ShaderCarousel/lib/three/          ← node_modules/three/build (the bench's three)
//   - public/models/teapot.obj           ← src/engine/teapotGeometry.ts at STATIC_TEAPOT_RESOLUTION
//
// Edit only the SOURCES: a hand edit to an output is overwritten on the next
// start. The script OWNS its three output folders: a file there that the
// tables below do not name is deleted, so a dropped row, an old branch or a
// stray copy can never ship from a local host deploy. Writes are
// compare-before-write (no mtime churn, no unlink: an in-place write never
// EPERMs on a restricted mount). A missing SOURCE is an error, never a skip:
// a clone without the submodule would otherwise build a dist with no js/.
//
// The teapot import needs Node ≥ 22.6 with --experimental-strip-types (the
// default from 23.6), so teapotGeometry.ts and teapotData.ts keep relative
// `.ts` imports only — teapotGeometry.test.ts pins that.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUBMODULE_JS = path.join(ROOT, 'a-frame-shaderloader/js');
const THREE_BUILD = path.join(ROOT, 'node_modules/three/build');

/**
 * From the submodule's js/. Loaders 0.4, 0.5 and 0.6 are deliberately NOT here
 * (see NOT_VENDORED in src/vendorSync.test.ts): every export and the A-Frame
 * tab reference them on the CDN by URL; the preview, its XR popup, podest's
 * stage and podest's VR popup load 0.8.
 */
export const VENDOR_TARGETS = [
  { file: 'a-frame-180-a-01.min.js', dests: ['public/js', 'ShaderCarousel/components/three'] },
  { file: 'a-frame-shaderloader-0.8.js', dests: ['public/js'] },
  // The glTF decoders (three r184's glTF Draco build and meshopt 1.1, the Basis
  // Universal KTX2 transcoder, plus the README carrying their provenance and the
  // Apache-2.0 text that must travel with Draco and Basis alike) sit beside the
  // loader, whose FastShaders.decoders section installs them. They ship in EVERY
  // build (web, both psftp hosts, the desktop app): a surface that decodes a
  // dropped compressed model — mesh or texture — must work offline, and the
  // sandboxed preview can fetch nothing, so its parent pushes these bytes in.
  { file: 'decoders/draco_wasm_wrapper.js', dests: ['public/js'] },
  { file: 'decoders/draco_decoder.wasm', dests: ['public/js'] },
  { file: 'decoders/meshopt_decoder.module.js', dests: ['public/js'] },
  { file: 'decoders/basis_transcoder.js', dests: ['public/js'] },
  { file: 'decoders/basis_transcoder.wasm', dests: ['public/js'] },
  { file: 'decoders/README.md', dests: ['public/js'] },
  { file: 'aframe-orbit-controls.min.js', dests: ['public/js'] },
  // The Gaussian-splat runtime (three r186's GaussianSplat addon + its loaders,
  // built by the submodule's build/build-splat.mjs). Top-level js/, never under
  // decoders/: a page loads it with a <script> tag after the A-Frame bundle,
  // and only a document showing a splat model emits that tag.
  { file: 'fs-splat-0.1.js', dests: ['public/js'] },
];

/**
 * From node_modules/three/build: the ShaderCarousel benches' import-map
 * targets. The benches PRICE nodes for the app, so they must run the app's own
 * three — generating them from the installed package is what keeps the two
 * from drifting (engine/threeRevision.test.ts pins that package to
 * THREE_REVISION).
 */
export const THREE_TARGETS = [
  { file: 'three.core.min.js', dests: ['ShaderCarousel/lib/three'] },
  { file: 'three.tsl.min.js', dests: ['ShaderCarousel/lib/three'] },
  { file: 'three.webgpu.min.js', dests: ['ShaderCarousel/lib/three'] },
];

/** The folders this script owns outright (files not named above are pruned). */
export const OWNED_DIRS = ['public/js', 'ShaderCarousel/components/three', 'ShaderCarousel/lib/three'];

export const TEAPOT_OBJ = 'public/models/teapot.obj';

/** Write `bytes` to `rel` (repo-relative) only when they differ. */
function writeIfChanged(rel, bytes) {
  const dst = path.join(ROOT, rel);
  if (existsSync(dst) && readFileSync(dst).equals(bytes)) return false;
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, bytes);
  return true;
}

function listFiles(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(path.join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]);
}

export async function syncGenerated() {
  const expected = new Set();
  const copy = (srcDir, srcLabel, rows) => {
    for (const { file, dests } of rows) {
      const src = path.join(srcDir, file);
      if (!existsSync(src)) {
        throw new Error(
          `[sync-generated] ${srcLabel}/${file} is missing. ` +
            (srcLabel.startsWith('a-frame-shaderloader')
              ? 'The submodule is not checked out — run: git submodule update --init'
              : 'Dependencies are not installed — run: npm ci'),
        );
      }
      const bytes = readFileSync(src);
      for (const dest of dests) {
        const rel = `${dest}/${file}`;
        expected.add(rel);
        writeIfChanged(rel, bytes);
      }
    }
  };
  copy(SUBMODULE_JS, 'a-frame-shaderloader/js', VENDOR_TARGETS);
  copy(THREE_BUILD, 'node_modules/three/build', THREE_TARGETS);

  for (const dir of OWNED_DIRS) {
    for (const f of listFiles(path.join(ROOT, dir))) {
      const rel = `${dir}/${f}`;
      if (!expected.has(rel)) rmSync(path.join(ROOT, rel));
    }
  }

  const { loadTeapot, STATIC_TEAPOT_RESOLUTION } = await import('../src/engine/teapotGeometry.ts');
  writeIfChanged(TEAPOT_OBJ, Buffer.from(loadTeapot().obj(STATIC_TEAPOT_RESOLUTION), 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncGenerated().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
