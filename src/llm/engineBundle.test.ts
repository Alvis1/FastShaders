/**
 * The bundled engine's packaging (P5): ONE manifest, src-tauri/engine.json,
 * that the fetch script stages from and engine.rs compiles in; the resource
 * mapping that puts it in the app; the gitignore that keeps the binaries out
 * of git; and the release job that fetches it before every desktop build.
 * engine.rs's own tests hold the Rust half (cargo test).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

interface FilePin { from?: string; repo?: string; to: string; sha256: string; size: number }
interface Platform { server: string; asset: string; url: string; sha256: string; size: number; files: FilePin[] }
interface ModelPin { key: string; label: string; repo: string; quant: string; commit: string; file: string; sha256: string; size: number }
const manifest = JSON.parse(read('src-tauri/engine.json')) as { tag: string; release: string; platforms: Record<string, Platform>; models: ModelPin[] };

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

describe('src-tauri/engine.json', () => {
  it('pins one llama.cpp build for exactly the two bundled platforms', () => {
    expect(manifest.tag).toMatch(/^b\d+$/);
    expect(Object.keys(manifest.platforms).sort()).toEqual(['macos-arm64', 'windows-x64']);
  });

  it('every asset is a release file of that tag, pinned by sha256 and size', () => {
    for (const [key, p] of Object.entries(manifest.platforms)) {
      expect(p.url, key).toBe(`https://github.com/ggml-org/llama.cpp/releases/download/${manifest.tag}/${p.asset}`);
      expect(p.sha256, key).toMatch(HEX64);
      expect(Number.isSafeInteger(p.size) && p.size > 0, key).toBe(true);
    }
  });

  it('every shipped file has a safe, unique name, a pin, and one source', () => {
    for (const [key, p] of Object.entries(manifest.platforms)) {
      const names = p.files.map((f) => f.to.toLowerCase());
      expect(new Set(names).size, key).toBe(names.length);
      expect(p.files.map((f) => f.to), key).toContain(p.server);
      for (const f of p.files) {
        expect(f.to, `${key} ${f.to}`).toMatch(SAFE_NAME);
        expect(f.sha256, `${key} ${f.to}`).toMatch(HEX64);
        expect(Number.isSafeInteger(f.size) && f.size > 0, `${key} ${f.to}`).toBe(true);
        expect((f.from === undefined) !== (f.repo === undefined), `${key} ${f.to}`).toBe(true);
        const src = f.from ?? f.repo!;
        expect(src.split('/'), `${key} ${f.to}`).not.toContain('..');
        // A repo file is in the repo, with the pinned bytes.
        if (f.repo !== undefined) expect(existsSync(path.join(ROOT, 'src-tauri', f.repo)), f.repo).toBe(true);
      }
    }
  });

  it('ships llama.cpp’s licence on both platforms', () => {
    for (const p of Object.values(manifest.platforms)) {
      const licence = p.files.find((f) => f.to === 'LICENSE');
      expect(licence?.repo).toBe('engine-licenses/llama.cpp-LICENSE');
    }
    expect(read('src-tauri/engine-licenses/llama.cpp-LICENSE')).toMatch(/^MIT License\n\nCopyright \(c\) 2023-2026 The ggml authors/);
  });

  it('leaves out the Windows RPC backend (ggml would load any ggml-*.dll beside the exe)', () => {
    expect(manifest.platforms['windows-x64'].files.some((f) => /rpc/i.test(f.to))).toBe(false);
  });
});

describe('the pinned model', () => {
  it('is ONE model: a repository to fetch from, and the size and hash the file must have', () => {
    expect(manifest.models).toHaveLength(1);
    const m = manifest.models[0];
    expect(m.key).toMatch(SAFE_NAME);
    expect(m.repo).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(m.quant).toMatch(SAFE_NAME);
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.file).toMatch(SAFE_NAME);
    expect(m.file.endsWith('.gguf')).toBe(true);
    expect(m.sha256).toMatch(HEX64);
    expect(Number.isSafeInteger(m.size) && m.size > 0).toBe(true);
    // Fits the 8 GB machines the survey lets through.
    expect(m.size).toBeLessThan(4 * 1024 ** 3);
    expect(m.label.length).toBeGreaterThan(0);
  });

  it('the fetch script never touches it: the model is downloaded on the user’s yes, at run time', () => {
    expect(read('scripts/fetch-engine.mjs')).not.toMatch(/\.models\b|gguf/);
  });
});

describe('getting it into the app', () => {
  it('tauri.conf.json bundles engine-dist/ as the resource folder engine/', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { bundle: { resources: Record<string, string> } };
    expect(conf.bundle.resources['engine-dist/']).toBe('engine/');
  });

  it('the staged binaries are never committed, and the folder always exists', () => {
    const ignore = read('src-tauri/.gitignore');
    expect(ignore).toContain('/engine-dist/*\n!/engine-dist/.gitkeep');
    expect(existsSync(path.join(ROOT, 'src-tauri/engine-dist/.gitkeep'))).toBe(true);
  });

  it('npm run fetch:engine runs the script, and the script holds no pin of its own', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['fetch:engine']).toBe('node scripts/fetch-engine.mjs');
    const script = read('scripts/fetch-engine.mjs');
    expect(script).toContain("path.join(TAURI, 'engine.json')");
    expect(script).not.toMatch(/[0-9a-f]{64}/);
    expect(script).not.toMatch(/b\d{4,}/);
  });

  it('the release job fetches the engine before each desktop build and zips it into the portable build', () => {
    const yml = read('.github/workflows/release.yml');
    const desktop = yml.slice(yml.indexOf('\n  desktop:'), yml.indexOf('\n  web:'));
    const fetchAt = desktop.indexOf('run: npm run fetch:engine');
    expect(fetchAt).toBeGreaterThan(desktop.indexOf('- run: npm ci'));
    expect(fetchAt).toBeLessThan(desktop.indexOf('npm run tauri build'));
    expect(desktop).toContain('cp -r src-tauri/target/release/engine portable/engine');
  });
});
