// Writes every file the repository deliberately does NOT track (.gitignore,
// "Generated at dev/build/test start"). vite.config.ts runs it when the config
// resolves (before the dev server snapshots public/), so `npm run dev`,
// `npm run build`, `npm test` and `npm run tauri …` all produce the files
// first. To produce them by hand (e.g. before serving ShaderCarousel/ or
// public/podest.html with a static server):
//
//   npm run sync:generated   (= node --experimental-strip-types scripts/sync-generated.mjs)
//
// A program, not a module: vite runs it in a child process and nothing imports
// it, so it exports nothing and does its work on load.
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
// stray copy can never ship from a local host deploy. A missing SOURCE is an
// error, never a skip: a clone without the submodule would otherwise build a
// dist with no js/.
//
// It never writes or prunes an output folder THROUGH a symbolic link. A folder
// that is a link, or lies under one, stops the start before anything is
// written or deleted: pruning through `public/js -> ../a-frame-shaderloader/js`
// would delete the submodule's frozen loaders. Inside an owned folder a link is a
// stray like any other file (the link goes, never what it points at), and one
// standing where a generated file belongs is compared through and, when it
// differs, replaced by the file rather than written through.
//
// Writes are compare-before-write, so a start with nothing new writes nothing
// (no mtime churn, and nothing for a restricted mount to refuse). A file that
// did change is written to a temp file in node_modules/.cache/sync-generated/
// and renamed into place, so a reader (the dev server, another start) sees the
// old bytes or the new ones, never half a file. Where the temp file or the
// rename is refused (EPERM/EBUSY for a file another process holds open on
// Windows, EXDEV when node_modules is another volume, a restricted mount) it
// falls back to the in-place write this script always did. Two starts may
// overlap (two test runs at once): every step tolerates the other's, a prune
// finding a stray already gone included.
//
// The teapot was most of a start (~70 of ~95 ms: loading its TypeScript and
// tessellating), so it is rebuilt only when a content stamp in that cache
// folder disagrees: TEAPOT_INPUTS or the Node version changed since it was
// written, or teapot.obj is missing or no longer what was written. Plain Node
// loads those modules with its own type stripping (Node ≥ 22.6 with
// --experimental-strip-types, the default from 23.6), so they may use only
// erasable TypeScript; a start that cannot load them stops with a message
// naming that rule.
import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUBMODULE_JS = path.join(ROOT, 'a-frame-shaderloader/js');
const THREE_BUILD = path.join(ROOT, 'node_modules/three/build');
/** Temp files and the teapot stamp: never shipped, never walked by the prune. */
const CACHE = path.join(ROOT, 'node_modules/.cache/sync-generated');

/**
 * From the submodule's js/. Loaders 0.4, 0.5 and 0.6 are deliberately NOT here
 * (see NOT_VENDORED in src/vendorSync.test.ts): every export and the A-Frame
 * tab reference them on the CDN by URL; the preview, its XR popup, podest's
 * stage and podest's VR popup load 0.8.
 */
const VENDOR_TARGETS = [
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
const THREE_TARGETS = [
  { file: 'three.core.min.js', dests: ['ShaderCarousel/lib/three'] },
  { file: 'three.tsl.min.js', dests: ['ShaderCarousel/lib/three'] },
  { file: 'three.webgpu.min.js', dests: ['ShaderCarousel/lib/three'] },
];

/** The folders this script owns outright (files not named above are pruned). */
const OWNED_DIRS = ['public/js', 'ShaderCarousel/components/three', 'ShaderCarousel/lib/three'];

const TEAPOT_OBJ = 'public/models/teapot.obj';

/**
 * What teapot.obj is built from; a change to any of them rebuilds it. The two
 * modules are every file teapotGeometry.ts loads, so a module it starts
 * importing must join them (syncGenerated.test.ts fails until it does), or
 * editing that module alone would leave teapot.obj stale. This script is one
 * because it picks the resolution and writes the file.
 */
const TEAPOT_INPUTS = ['src/engine/teapotGeometry.ts', 'src/engine/teapotData.ts', 'scripts/sync-generated.mjs'];

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The bytes at `abs`, following a link, or undefined when no file is there. */
function readIfFile(abs) {
  return statSync(abs, { throwIfNoEntry: false })?.isFile() ? readFileSync(abs) : undefined;
}

/** Every generated file and its bytes, all read before anything is written. */
function readSources() {
  const out = [];
  const read = (srcDir, srcLabel, rows) => {
    for (const { file, dests } of rows) {
      const bytes = readIfFile(path.join(srcDir, file));
      if (!bytes) {
        throw new Error(
          `[sync-generated] ${srcLabel}/${file} is missing. ` +
            (srcLabel.startsWith('a-frame-shaderloader')
              ? 'The submodule is not checked out — run: git submodule update --init'
              : 'Dependencies are not installed — run: npm ci'),
        );
      }
      for (const dest of dests) out.push({ rel: `${dest}/${file}`, bytes });
    }
  };
  read(SUBMODULE_JS, 'a-frame-shaderloader/js', VENDOR_TARGETS);
  read(THREE_BUILD, 'node_modules/three/build', THREE_TARGETS);
  return out;
}

/** Stop the start when the output folder `dir` is a symbolic link or lies under one. */
function refuseLinks(dir) {
  const owned = OWNED_DIRS.includes(dir);
  let rel = '';
  for (const part of dir.split('/')) {
    rel = rel ? `${rel}/${part}` : part;
    const abs = path.join(ROOT, rel);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return; // not there yet: the writes create it as a real folder
    if (st.isSymbolicLink()) {
      throw new Error(
        `[sync-generated] ${rel} is a symbolic link (to ${readlinkSync(abs)})` +
          (rel === dir ? '. ' : `, and ${dir} lies under it. `) +
          (owned
            ? `This script writes the generated files in ${dir} and DELETES every other file there, so ` +
              'through a link it would delete files in whatever the link points at. '
            : `This script writes ${TEAPOT_OBJ} there and will not write through a link. `) +
          'Nothing was changed: ' +
          (owned && rel === dir
            ? `remove the link (the next start rebuilds ${dir} as a real folder)`
            : `make ${rel} a real folder`) +
          ' and start again.',
      );
    }
    if (!st.isDirectory()) throw new Error(`[sync-generated] ${rel} is a file where ${dir} needs a folder.`);
  }
}

/**
 * Delete every entry under the owned folders that `expected` does not name. A
 * link is a leaf: it is removed itself and never followed. `force` because an
 * overlapping start may have deleted the same stray a moment ago.
 */
function prune(expected) {
  const walk = (rel) => {
    for (const d of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(child);
      else if (!expected.has(child)) rmSync(path.join(ROOT, child), { force: true });
    }
  };
  for (const dir of OWNED_DIRS) if (lstatSync(path.join(ROOT, dir), { throwIfNoEntry: false })) walk(dir);
}

let tmpCount = 0;
/**
 * Put `bytes` at `abs` with a rename, so a reader sees the old file or the new
 * one and never half of either (and a link there is replaced, not written
 * through). Where the temp file or the rename is refused, the in-place write
 * this script always did.
 */
function replaceFile(abs, bytes) {
  const tmp = path.join(CACHE, `${process.pid}-${randomBytes(4).toString('hex')}-${tmpCount++}.tmp`);
  try {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(tmp, bytes);
    renameSync(tmp, abs);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* a restricted mount keeps it; nothing ships from .cache */ }
    if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(abs);
    writeFileSync(abs, bytes);
  }
}

/** Write `bytes` to `rel` (repo-relative) unless it already holds exactly them. */
function writeIfChanged(rel, bytes) {
  const abs = path.join(ROOT, rel);
  if (readIfFile(abs)?.equals(bytes)) return;
  mkdirSync(path.dirname(abs), { recursive: true });
  replaceFile(abs, bytes);
}

async function loadTeapotModule() {
  try {
    return await import('../src/engine/teapotGeometry.ts');
  } catch (e) {
    throw new Error(
      `[sync-generated] plain Node could not load src/engine/teapotGeometry.ts: ${e instanceof Error ? e.message : e}\n` +
        "It and every module it imports are loaded by Node's own type stripping (Node >= 22.6 with " +
        '--experimental-strip-types, as vite and `npm run sync:generated` run this script), with no bundler and ' +
        'no tsconfig, so they may use only erasable TypeScript: relative imports that spell `.ts` (no `@/` ' +
        'alias), `import type` for a name that is only a type, and no enum, namespace or parameter property.',
    );
  }
}

async function syncTeapot() {
  // Named after the checkout: git worktrees share one node_modules (a link),
  // and two trees taking turns must not keep invalidating each other's stamp.
  const stampFile = path.join(CACHE, `teapot-${digest(ROOT).slice(0, 16)}.json`);
  // Hashed BEFORE the import: an edit landing mid-run leaves a stamp naming the
  // older bytes, so the next start rebuilds rather than trusting a stale file.
  const source = {
    node: process.version,
    inputs: Object.fromEntries(TEAPOT_INPUTS.map((rel) => [rel, digest(readFileSync(path.join(ROOT, rel)))])),
  };
  let stamp;
  try { stamp = JSON.parse(readFileSync(stampFile, 'utf8')); } catch { /* none yet, or torn: rebuild */ }
  const obj = readIfFile(path.join(ROOT, TEAPOT_OBJ));
  if (
    obj && stamp?.output === digest(obj) &&
    JSON.stringify({ node: stamp.node, inputs: stamp.inputs }) === JSON.stringify(source)
  ) return;

  const { loadTeapot, STATIC_TEAPOT_RESOLUTION } = await loadTeapotModule();
  const bytes = Buffer.from(loadTeapot().obj(STATIC_TEAPOT_RESOLUTION), 'utf8');
  writeIfChanged(TEAPOT_OBJ, bytes);
  // Best effort: without a stamp the next start simply rebuilds.
  try { replaceFile(stampFile, JSON.stringify({ ...source, output: digest(bytes) }, null, 1)); } catch { /* ignore */ }
}

try {
  const files = readSources();
  for (const dir of [...OWNED_DIRS, path.posix.dirname(TEAPOT_OBJ)]) refuseLinks(dir);
  // Pruning before writing: a stray link where a generated FOLDER belongs
  // (public/js/decoders) is gone before anything is written beneath it.
  prune(new Set(files.map((f) => f.rel)));
  for (const { rel, bytes } of files) writeIfChanged(rel, bytes);
  await syncTeapot();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
