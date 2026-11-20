// Stages the bundled AI engine (llama.cpp's llama-server) for the desktop
// build: src-tauri/engine-dist/<tag>/, which tauri.conf.json bundles as the
// resource folder `engine/` (docs/dev/node-generator.md, "The bundled engine").
//
//   npm run fetch:engine                       (this machine's platform)
//   node scripts/fetch-engine.mjs --platform windows-x64
//
// The pins live in ONE file, src-tauri/engine.json: the release asset, its
// sha256 and size, and every file the app ships with its own sha256 and size.
// engine.rs compiles the same file in and checks every file again before it
// runs anything, so a pin is changed there and nowhere else.
//
// What it does:
//   1. Downloads the platform's release asset into node_modules/.cache/
//      fetch-engine/ (a cached copy whose sha256 matches is reused; a cached
//      copy that does not match is deleted and fetched again).
//   2. Unpacks it with the system `tar` (bsdtar: it reads .tar.gz and .zip on
//      macOS and on Windows 10+) into a fresh temporary folder.
//   3. Replaces src-tauri/engine-dist/ with exactly the listed files, renamed
//      to their `to` names (no symbolic links are copied: the macOS archive's
//      `libggml.1.dylib -> libggml.1.0.0.dylib` links are replaced by the real
//      file under the name the loader asks for). Nothing in a file is edited,
//      so each keeps its own signature. A `repo` entry is copied from
//      src-tauri/ (the llama.cpp licence, which the Windows archive lacks).
//   4. Checks every staged file against its sha256 and size, and fails on any
//      difference. A failed run leaves engine-dist/ EMPTY, never half-staged.
//
// Platforms: macOS arm64 (the universal .dmg carries the arm64 engine; Intel
// Macs are pointed to LM Studio / Ollama, D19) and Windows x64 (Vulkan + CPU).
// Anywhere else it stages nothing and says so, which a dev build survives: the
// app then reports "not in this build".

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = path.join(ROOT, 'src-tauri');
const MANIFEST = path.join(TAURI, 'engine.json');
const DIST = path.join(TAURI, 'engine-dist');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'fetch-engine');
/** The tracked placeholder that keeps engine-dist/ present on a fresh clone. */
const KEEP = '.gitkeep';

/** A shipped name: one path segment of plain characters. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A path inside the archive or src-tauri/: relative, forward slashes, no `..`. */
const SAFE_REL = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;

function fail(msg) {
  console.error(`fetch-engine: ${msg}`);
  process.exit(1);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function hostPlatform() {
  if (process.platform === 'darwin') return 'macos-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  return null;
}

function parseArgs(argv) {
  const at = argv.indexOf('--platform');
  if (at === -1) return { platform: hostPlatform() };
  const platform = argv[at + 1];
  if (!platform) fail('--platform needs a value');
  return { platform };
}

/** Validates the manifest's shape; engine.rs's own parse refuses the same things. */
function readManifest() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (typeof m.tag !== 'string' || !SAFE_NAME.test(m.tag)) fail('engine.json: bad tag');
  for (const [key, p] of Object.entries(m.platforms ?? {})) {
    if (!HEX64.test(p.sha256) || !Number.isSafeInteger(p.size)) fail(`engine.json: ${key}: bad asset pin`);
    if (!/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\//.test(p.url)) fail(`engine.json: ${key}: url`);
    if (!p.url.endsWith(`/${m.tag}/${p.asset}`)) fail(`engine.json: ${key}: url does not name the tag and asset`);
    if (!p.files.some((f) => f.to === p.server)) fail(`engine.json: ${key}: the server is not a listed file`);
    const seen = new Set();
    for (const f of p.files) {
      if (!SAFE_NAME.test(f.to) || seen.has(f.to.toLowerCase())) fail(`engine.json: ${key}: bad or repeated name ${f.to}`);
      seen.add(f.to.toLowerCase());
      if (!HEX64.test(f.sha256) || !Number.isSafeInteger(f.size)) fail(`engine.json: ${key}: ${f.to}: bad pin`);
      const src = f.from ?? f.repo;
      if ((f.from == null) === (f.repo == null) || !SAFE_REL.test(src)) fail(`engine.json: ${key}: ${f.to}: needs exactly one safe from/repo`);
    }
  }
  return m;
}

/** Empties engine-dist/ but for the placeholder; never follows a link out of it. */
function clearDist() {
  if (existsSync(DIST) && lstatSync(DIST).isSymbolicLink()) fail('src-tauri/engine-dist is a symbolic link; refusing to write through it');
  mkdirSync(DIST, { recursive: true });
  for (const name of readdirSync(DIST)) {
    if (name !== KEEP) rmSync(path.join(DIST, name), { recursive: true, force: true });
  }
  writeFileSync(path.join(DIST, KEEP), '');
}

async function cachedAsset(p) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, p.asset);
  if (existsSync(file)) {
    if (sha256(file) === p.sha256) return file;
    rmSync(file);
  }
  console.log(`fetch-engine: downloading ${p.asset} (${(p.size / 1e6).toFixed(1)} MB)`);
  const res = await fetch(p.url, { redirect: 'follow' });
  if (!res.ok) fail(`download refused: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== p.size) fail(`${p.asset}: ${bytes.length} bytes, expected ${p.size}`);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== p.sha256) fail(`${p.asset}: sha256 ${got}, expected ${p.sha256}`);
  const tmp = `${file}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  return file;
}

async function main() {
  const { platform } = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  clearDist();
  if (!platform) {
    console.log(`fetch-engine: no bundled engine for ${process.platform}-${process.arch}; engine-dist/ left empty`);
    return;
  }
  const p = manifest.platforms[platform];
  if (!p) fail(`no platform "${platform}" in engine.json`);

  const archive = await cachedAsset(p);
  const work = mkdtempSync(path.join(tmpdir(), 'fs-engine-'));
  try {
    execFileSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' });
    const out = path.join(DIST, manifest.tag);
    mkdirSync(out);
    for (const f of p.files) {
      const src = f.from != null ? path.join(work, ...f.from.split('/')) : path.join(TAURI, ...f.repo.split('/'));
      if (!existsSync(src)) throw new Error(`${f.from ?? f.repo}: not in the ${f.from != null ? 'archive' : 'repository'}`);
      const st = lstatSync(src);
      if (!st.isFile()) throw new Error(`${f.from ?? f.repo}: not a regular file`);
      const dst = path.join(out, f.to);
      copyFileSync(src, dst);
      if (process.platform !== 'win32') chmodSync(dst, f.to.startsWith('LICENSE') ? 0o644 : 0o755);
    }
    // The check runs on what was STAGED, after every copy.
    for (const f of p.files) {
      const dst = path.join(out, f.to);
      const size = lstatSync(dst).size;
      const got = sha256(dst);
      if (size !== f.size || got !== f.sha256) throw new Error(`${f.to}: ${size} bytes / ${got}, expected ${f.size} / ${f.sha256}`);
    }
    const listed = new Set(p.files.map((f) => f.to));
    for (const name of readdirSync(out)) if (!listed.has(name)) throw new Error(`stray file ${name}`);
    const total = p.files.reduce((n, f) => n + f.size, 0);
    console.log(`fetch-engine: staged ${p.files.length} files (${(total / 1e6).toFixed(1)} MB) for ${platform} in src-tauri/engine-dist/${manifest.tag}/`);
  } catch (e) {
    clearDist();
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
