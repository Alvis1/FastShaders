import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * scripts/sync-generated.mjs, run the way vite runs it at every dev/build/test
 * start (a child `node --experimental-strip-types`), inside a throwaway
 * checkout: a copy of the script, a one-line stand-in for every source its
 * tables name, and a stand-in teapot module that logs each time Node loads it.
 * The real outputs are pinned elsewhere (vendorSync.test.ts the copies,
 * teapotGeometry.test.ts teapot.obj); this pins what the script DOES: the
 * stamp that skips the teapot (and that its inputs cover every module the real
 * teapot loads), the prune, symbolic links, overlapping starts, the in-place
 * fallback and the messages a broken start prints.
 */
const SCRIPT = path.resolve(__dirname, '../scripts/sync-generated.mjs');
const TEAPOT = 'public/models/teapot.obj';
const onWindows = process.platform === 'win32'; // symlinks need privileges there; CI tests on Linux

// The rows, read from the script the way vendorSync.test.ts reads them.
const ROWS = [...readFileSync(SCRIPT, 'utf8').matchAll(/\{ file: '([^']+)', dests: \[([^\]]*)\] \}/g)]
  .map((m) => ({ file: m[1], dests: m[2].split(',').map((d) => d.trim().replace(/^'|'$/g, '')) }));
const sourceOf = (file: string) =>
  file.startsWith('three.') ? `node_modules/three/build/${file}` : `a-frame-shaderloader/js/${file}`;

// Real TypeScript (annotations to strip, a relative `.ts` import) with the generator's API.
const FAKE_TEAPOT_GEOMETRY = [
  "import { appendFileSync } from 'node:fs';",
  "import { LABEL } from './teapotData.ts';",
  "appendFileSync(new URL('./loads.log', import.meta.url), 'x');",
  'export const STATIC_TEAPOT_RESOLUTION: number = 16;',
  'export function loadTeapot(): { obj(n: number): string } {',
  '  return { obj: (n: number): string => `# ${LABEL} at ${n}\\n` };',
  '}',
  '',
].join('\n');
const fakeTeapotData = (label: string) => `export const LABEL: string = '${label}';\n`;

function put(root: string, rel: string, data: string | Buffer) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), data);
}

const roots: string[] = [];
function makeRoot(): string {
  // realpath: macOS's tmpdir lies under the /var link; only the alias test starts through a link.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fs-sync-generated-')));
  roots.push(root);
  put(root, 'package.json', '{ "type": "module" }\n'); // as the real one says: the .ts modules are ESM
  put(root, 'scripts/sync-generated.mjs', readFileSync(SCRIPT));
  for (const { file } of ROWS) put(root, sourceOf(file), `source of ${file}\n`);
  put(root, 'src/engine/teapotGeometry.ts', FAKE_TEAPOT_GEOMETRY);
  put(root, 'src/engine/teapotData.ts', fakeTeapotData('teapot v1'));
  mkdirSync(path.join(root, 'public/models'), { recursive: true });
  return root;
}

// Without the caller's NODE_OPTIONS: a developer's --experimental-transform-types must not mask a breach.
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;
const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

function sync(root: string, script = path.join(root, 'scripts/sync-generated.mjs')) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, script], { encoding: 'utf8', env: childEnv });
  return { status: r.status, stderr: r.stderr };
}

function syncInBackground(root: string): Promise<number | null> {
  return new Promise((resolve) => {
    spawn(process.execPath, [...NODE_ARGS, path.join(root, 'scripts/sync-generated.mjs')], {
      stdio: 'ignore',
      env: childEnv,
    }).on('close', resolve);
  });
}

/** How many times Node loaded the stand-in teapot module. */
function loads(root: string): number {
  const log = path.join(root, 'src/engine/loads.log');
  return existsSync(log) ? readFileSync(log, 'utf8').length : 0;
}

const teapotText = (root: string) => readFileSync(path.join(root, TEAPOT), 'utf8');

/**
 * The specifiers a module loads at run time under plain Node's type stripping:
 * comments dropped, a whole `import type` statement erased (Node keeps
 * `import { type A } from` as a load). bootWave.test.ts's clause grammar.
 */
function runtimeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const clause = String.raw`(?:(?!\b(?:import|export)\b)[\w\s{},*$])*?`;
  const from = new RegExp(String.raw`^[ \t]*(?:import|export)\s+(type\s+)?${clause}\s*from\s*['"]([^'"]+)['"]`, 'gm');
  return [
    ...[...code.matchAll(from)].filter((m) => !m[1]).map((m) => m[2]),
    ...[...code.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ].sort();
}

function expectSynced(root: string) {
  for (const { file, dests } of ROWS) {
    for (const dest of dests) {
      const p = path.join(root, dest, file);
      expect(lstatSync(p, { throwIfNoEntry: false })?.isFile(), `${dest}/${file} is a real file`).toBe(true);
      expect(readFileSync(p, 'utf8'), `${dest}/${file}`).toBe(`source of ${file}\n`);
    }
  }
}

describe('scripts/sync-generated.mjs', () => {
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it('writes every row and the teapot; a start with nothing new writes nothing and never loads the teapot', () => {
    // Both tables parsed, or every check below would pass on nothing.
    expect(ROWS.map((r) => r.file)).toContain('a-frame-shaderloader-0.8.js');
    expect(ROWS.map((r) => r.file)).toContain('three.webgpu.min.js');
    const root = makeRoot();
    expect(sync(root).status).toBe(0);
    expectSynced(root);
    expect(teapotText(root)).toBe('# teapot v1 at 16\n');
    expect(loads(root)).toBe(1);

    const outputs = [
      ...ROWS.flatMap(({ file, dests }) => dests.map((d) => path.join(root, d, file))),
      path.join(root, TEAPOT),
    ];
    const mtimes = outputs.map((p) => statSync(p).mtimeMs);
    expect(sync(root).status).toBe(0);
    expect(loads(root), 'the stamp held, so the TypeScript was not even loaded').toBe(1);
    expect(outputs.map((p) => statSync(p).mtimeMs), 'nothing rewritten').toEqual(mtimes);
    const cache = path.join(root, 'node_modules/.cache/sync-generated');
    expect(readdirSync(cache).filter((f) => f.endsWith('.tmp')), 'every temp file renamed into place').toEqual([]);
  });

  it('rebuilds the teapot when an input changes, and when teapot.obj is missing or hand-edited', () => {
    const root = makeRoot();
    sync(root);
    put(root, 'src/engine/teapotData.ts', fakeTeapotData('teapot v2'));
    expect(sync(root).status).toBe(0);
    expect(teapotText(root)).toBe('# teapot v2 at 16\n');
    expect(loads(root)).toBe(2);

    rmSync(path.join(root, TEAPOT));
    expect(sync(root).status).toBe(0);
    expect(teapotText(root)).toBe('# teapot v2 at 16\n');
    expect(loads(root)).toBe(3);

    writeFileSync(path.join(root, TEAPOT), 'a hand edit\n');
    expect(sync(root).status).toBe(0);
    expect(teapotText(root)).toBe('# teapot v2 at 16\n');
    expect(loads(root)).toBe(4);
  });

  it.skipIf(onWindows)('prunes what its tables do not name, removing a link rather than following it', () => {
    const root = makeRoot();
    sync(root);
    const outside = path.join(root, 'outside');
    put(root, 'outside/keep.txt', 'keep\n');
    put(root, 'outside/other.js', 'not the source\n');
    put(root, 'ShaderCarousel/lib/three/.DS_Store', 'stray\n');
    symlinkSync(path.join(outside, 'keep.txt'), path.join(root, 'public/js/stray-link.js'));
    // A link where a generated FOLDER belongs, and one where a generated FILE belongs.
    rmSync(path.join(root, 'public/js/decoders'), { recursive: true });
    symlinkSync(outside, path.join(root, 'public/js/decoders'));
    rmSync(path.join(root, 'public/js/aframe-orbit-controls.min.js'));
    symlinkSync(path.join(outside, 'other.js'), path.join(root, 'public/js/aframe-orbit-controls.min.js'));

    expect(sync(root).status).toBe(0);
    expectSynced(root);
    expect(existsSync(path.join(root, 'ShaderCarousel/lib/three/.DS_Store'))).toBe(false);
    expect(lstatSync(path.join(root, 'public/js/stray-link.js'), { throwIfNoEntry: false })).toBeUndefined();
    // What the links pointed at is untouched: nothing written into it, nothing written through it.
    expect(readdirSync(outside).sort()).toEqual(['keep.txt', 'other.js']);
    expect(readFileSync(path.join(outside, 'other.js'), 'utf8')).toBe('not the source\n');
  });

  it.skipIf(onWindows)('refuses an output folder that is, or lies under, a symbolic link, and changes nothing', () => {
    for (const link of ['public/js', 'ShaderCarousel/lib']) {
      const root = makeRoot();
      // What the link points at: files nobody may delete (the submodule's frozen loaders, say).
      const precious = path.join(root, 'precious');
      put(root, 'precious/a-frame-shaderloader-0.4.js', 'frozen\n');
      put(root, 'precious/three/a-frame-shaderloader-0.5.js', 'frozen\n');
      mkdirSync(path.dirname(path.join(root, link)), { recursive: true });
      symlinkSync(precious, path.join(root, link));

      const r = sync(root);
      expect(r.status, link).toBe(1);
      expect(r.stderr).toContain(`${link} is a symbolic link`);
      expect(readdirSync(precious, { recursive: true }).map(String).sort(), link)
        .toEqual(['a-frame-shaderloader-0.4.js', 'three', 'three/a-frame-shaderloader-0.5.js']);
      expect(existsSync(path.join(root, TEAPOT)), 'nothing written anywhere').toBe(false);
    }
  });

  it('two overlapping starts both succeed', async () => {
    const root = makeRoot(); // so the first pair also races to write everything from nothing
    for (let i = 0; i < 8; i++) {
      // Strays both prunes go for: whichever deletes one second must shrug.
      for (let k = 0; k < 100; k++) put(root, `ShaderCarousel/lib/three/stray-${k}.js`, 'stray\n');
      expect(await Promise.all([syncInBackground(root), syncInBackground(root)])).toEqual([0, 0]);
    }
    expectSynced(root);
    expect(teapotText(root)).toBe('# teapot v1 at 16\n');
  });

  it('writes in place where its temp folder cannot be made (a restricted mount)', () => {
    const root = makeRoot();
    put(root, 'node_modules/.cache/sync-generated', 'a file where the temp folder goes\n');
    expect(sync(root).status).toBe(0);
    expectSynced(root);
    expect(teapotText(root)).toBe('# teapot v1 at 16\n');
  });

  it.skipIf(onWindows)('runs the same when started through a symbolic link to the checkout', () => {
    const root = makeRoot();
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    roots.push(alias);
    expect(sync(root, path.join(alias, 'scripts/sync-generated.mjs')).status).toBe(0);
    expectSynced(root);
  });

  it('a teapot module plain Node cannot load stops the start, naming the rule it broke', () => {
    const root = makeRoot();
    put(root, 'src/engine/teapotData.ts', `export enum Kind { A }\n${fakeTeapotData('teapot')}`);
    const r = sync(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not load src/engine/teapotGeometry.ts');
    expect(r.stderr).toContain('only erasable TypeScript');
    expect(r.stderr).toContain('no enum, namespace or parameter property');
  });

  it('TEAPOT_INPUTS names every module plain Node loads to build the real teapot', () => {
    // The stamp skips the teapot while those files hash the same, so a module
    // teapotGeometry.ts loads that is not listed could change, or stop loading
    // under plain Node, with no start noticing (the drift test only sees an
    // edit that changes the OBJ).
    const listed = [...(readFileSync(SCRIPT, 'utf8').match(/const TEAPOT_INPUTS = \[([^\]]*)\]/)?.[1] ?? '')
      .matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listed).toContain('scripts/sync-generated.mjs');
    // The scan sees every loading form, and neither a comment nor `import type`.
    expect(runtimeImports([
      "import { A, type B } from './a.ts';", "import type { C } from './erased.ts';",
      "export * from './b.ts';", "import './c.ts';", "const d = await import('./d.ts');",
      "// import { E } from './comment.ts';", "import {\n  F,\n} from 'node:fs';",
    ].join('\n'))).toEqual(['./a.ts', './b.ts', './c.ts', './d.ts', 'node:fs']);

    const repo = path.resolve(__dirname, '..');
    const walked = ['src/engine/teapotGeometry.ts'];
    for (const rel of walked) {
      expect(listed, `${rel} is loaded to build teapot.obj: add it to TEAPOT_INPUTS`).toContain(rel);
      for (const spec of runtimeImports(readFileSync(path.join(repo, rel), 'utf8'))) {
        if (spec.startsWith('node:')) continue; // Node's own: the stamp holds its version
        expect(
          spec.startsWith('.'),
          `${rel} imports '${spec}': plain Node resolves no \`@/\` alias, and the stamp cannot see a package`,
        ).toBe(true);
        const next = path.posix.join(path.posix.dirname(rel), spec);
        if (!walked.includes(next)) walked.push(next);
      }
    }
    expect(walked, 'the walk followed the real import').toContain('src/engine/teapotData.ts');
  });

  it('a missing source stops the start before anything is written, and says what to run', () => {
    const root = makeRoot();
    rmSync(path.join(root, sourceOf('fs-splat-0.1.js')));
    const r = sync(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a-frame-shaderloader/js/fs-splat-0.1.js is missing');
    expect(r.stderr).toContain('git submodule update --init');
    expect(existsSync(path.join(root, 'public/js')), 'nothing written').toBe(false);

    put(root, sourceOf('fs-splat-0.1.js'), 'source of fs-splat-0.1.js\n');
    rmSync(path.join(root, sourceOf('three.tsl.min.js')));
    const r2 = sync(root);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('node_modules/three/build/three.tsl.min.js is missing');
    expect(r2.stderr).toContain('npm ci');
  });
});
