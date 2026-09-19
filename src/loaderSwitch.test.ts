import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CDN_BASE, LOADER_FILE, tslToShaderModule } from './engine/tslToShaderModule';
import { THREE_REVISION } from './engine/threeRevision';
import { CURRENT_LOADER, REPO, evalLoader, loaderAvailable, loaderText } from './shaderloaderHarness';
import { buildThreeEmbedHTML } from './engine/tslToThreeHTML';
import { DECODER_DIR, DECODER_FILES } from './utils/meshDecoders';

/**
 * The loader switch (Phase 3 Step 5): every surface that runs a module and
 * every new export name ONE loader, the current one.
 *
 * The preview, its XR popup and the A-Frame tab follow `LOADER_FILE` by
 * construction; podest.html hardcodes it twice (perMeshMaterials.test.ts pins
 * those two literals to LOADER_FILE); the README and PODEST.md restate it for
 * readers. A surface left on the frozen 0.6 would preview a shader on a loader
 * without 0.8's FastShaders core, glTF plugin and `materialParts` dispatch, while
 * the file it exports names 0.8 — and nothing would fail loudly, because 0.6
 * still runs most modules.
 */

const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');

/** Every ``` fence inside the README section headed exactly `heading`. */
function readmeFences(heading: string): string[] {
  const readme = read('README.md');
  const start = readme.indexOf(`\n${heading}\n`);
  expect(start, `README has no "${heading}" section`).toBeGreaterThan(-1);
  const next = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, next < 0 ? undefined : next);
  return [...section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

const FROZEN_FILE = /a-frame-shaderloader-0\.[4-6]\.js/;

describe('the loader switch — one loader on every surface', () => {
  it('LOADER_FILE is the current loader, and public/js serves it', () => {
    expect(LOADER_FILE).toBe(`a-frame-shaderloader-${CURRENT_LOADER}.js`);
    expect(existsSync(path.join(REPO, 'public/js', LOADER_FILE))).toBe(true);
  });

  it('no surface names a frozen loader file', () => {
    for (const rel of [
      'public/podest.html',
      'src/engine/tslToPreviewHTML.ts',
      'src/engine/tslToAFrameHTML.ts',
      'src/engine/tslToThreeHTML.ts',
    ]) {
      expect(read(rel), rel).not.toMatch(FROZEN_FILE);
    }
  });

  it("the README's two snippets load the current loader and no frozen one", () => {
    const fences = [
      ...readmeFences('## Using the shader module with a-frame-shaderloader'),
      ...readmeFences('## Using the shader module with plain Three.js'),
    ];
    expect(fences.length).toBeGreaterThanOrEqual(2);
    for (const f of fences) expect(f).not.toMatch(FROZEN_FILE);
    const loaderRefs = fences.filter((f) => f.includes(`${CDN_BASE}/${LOADER_FILE}`));
    // One in the A-Frame snippet, one in the plain-three one.
    expect(loaderRefs.length).toBe(2);
  });

  it('README and docs/PODEST.md name the served loader', () => {
    expect(read('README.md')).toContain(`js/${LOADER_FILE}`);
    // Podest's self-hosting list: a host that copies the old list serves a
    // podest.html whose two loader URLs 404.
    expect(read('docs/PODEST.md')).toContain(`js/${LOADER_FILE}`);
    expect(read('docs/PODEST.md')).not.toMatch(FROZEN_FILE);
  });

  it('docs/PODEST.md lists every decoder file podest fetches, and the licence that travels with them', () => {
    // podest.html fetches js/decoders/<file> on demand, so a host that copies
    // only the listed files answers every Draco or meshopt drop with a 404.
    expect(read('public/podest.html')).toContain(`"${DECODER_DIR}"`);
    const doc = read('docs/PODEST.md');
    for (const f of Object.values(DECODER_FILES)) expect(doc).toContain(`${DECODER_DIR}${f}`);
    expect(doc).toContain(`${DECODER_DIR}README.md`);
    expect(doc).not.toContain('Nothing else is fetched');
  });

  it.skipIf(!existsSync(path.join(REPO, 'a-frame-shaderloader/README.md')))(
    "the loader's own README tells a self-hoster to copy js/decoders/, and how a plain page configures them",
    () => {
      const readme = read('a-frame-shaderloader/README.md');
      const setup = readme.slice(readme.indexOf('\n## Setup\n'), readme.indexOf('\n### The files\n'));
      expect(setup).toContain('js/decoders/');
      expect(readme).toMatch(/^\| `decoders\/` \|/m);
      // KTX2 needs the loader CLASS and the renderer too (the transcode target
      // depends on the GPU), so the recipe names all three — a page following the
      // Draco-only form got ERR_KTX2_NO_RENDERER and silent fallback images.
      expect(readme).toContain('FastShaders.decoders.configure({ DRACOLoader, KTX2Loader, renderer })');
      expect(readme).toContain('FastShaders.decoders.install(loader)');
    },
  );
});

/**
 * The loader internals the surfaces read off `entity.components.shader` and the
 * events they listen for. P3a kept every one of them in 0.8 (the component IS
 * the core's state object); a rename there breaks the preview's highlight,
 * uniform and hot-swap code and podest's picker and sliders with NO error. The
 * list must not go stale either: every name is still read by a surface.
 */
describe.skipIf(!loaderAvailable(CURRENT_LOADER))('the loader internals the surfaces read', () => {
  const CONTRACT = [
    '_propertyUniforms',
    'originalMaterials',
    '_partMaterials',
    '_shaderMaterial',
    'shader-applied',
    'shader-error',
  ];

  it('are still read by the preview or podest', () => {
    const surfaces = read('src/engine/tslToPreviewHTML.ts') + read('public/podest.html');
    for (const name of CONTRACT) expect(surfaces, name).toContain(name);
  });

  it('are still defined by the served loader', () => {
    const loader = loaderText(CURRENT_LOADER);
    for (const name of CONTRACT) expect(loader, name).toContain(name);
  });
});

/**
 * Every `FastShaders.<name>` the export header and the README's plain-three
 * section spell must be a key the served loader's api object carries. P3d's
 * first draft documented an async `apply(mesh, url, { THREE })` that 0.8 never
 * defined; a header naming a missing call would ship inside every export.
 */
describe.skipIf(!loaderAvailable(CURRENT_LOADER))('the documented FastShaders api exists', () => {
  const { FastShaders } = evalLoader(CURRENT_LOADER);

  const referenced = (text: string): Array<[string, string | undefined]> =>
    [...text.matchAll(/FastShaders\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)].map((m) => [m[1], m[2]]);

  const check = (label: string, text: string) => {
    const refs = referenced(text);
    expect(refs.length, `${label} names no FastShaders call`).toBeGreaterThan(0);
    for (const [key, sub] of refs) {
      expect(FastShaders, 'the loader installed no FastShaders').not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(FastShaders, key), `${label}: FastShaders.${key}`).toBe(true);
      if (sub) {
        const inner = (FastShaders as Record<string, Record<string, unknown>>)[key];
        expect(sub in inner, `${label}: FastShaders.${key}.${sub}`).toBe(true);
      }
    }
  };

  it('in the export header', () => {
    const header = tslToShaderModule(
      "import { Fn, vec3 } from 'three/tsl';\n\nconst shader = Fn(() => {\n  return vec3(1, 0, 0);\n});\n\nexport default shader;\n",
    )
      .split('\n')
      .filter((l) => l.startsWith('//'))
      .join('\n');
    check('header', header);
  });

  it("in the code panel's Three.js tab page", () => {
    const page = buildThreeEmbedHTML(
      tslToShaderModule(
        "import { Fn, vec3 } from 'three/tsl';\n\nconst shader = Fn(() => {\n  return vec3(1, 0, 0);\n});\n\nexport default shader;\n",
      ),
      { shaderFile: 'x.js' },
    );
    check('Three.js tab', page);
  });

  it("in the README's plain-three section", () => {
    const readme = read('README.md');
    const start = readme.indexOf('\n## Using the shader module with plain Three.js\n');
    const next = readme.indexOf('\n## ', start + 1);
    check('README', readme.slice(start, next < 0 ? undefined : next));
  });
});

/**
 * THREE_REVISION is one drift set (engine/threeRevision.ts): the installed
 * three is pinned in threeRevision.test.ts; this is the A-Frame bundle's
 * `super-three`, which the submodule's own package.json pins. Read by pattern,
 * not parsed: this test owns no part of that file.
 */
describe.skipIf(!existsSync(path.join(REPO, 'a-frame-shaderloader/package.json')))(
  'THREE_REVISION — the bundle half of the drift set',
  () => {
    it("matches the submodule's super-three minor", () => {
      const pkg = read('a-frame-shaderloader/package.json');
      const m = /"super-three"\s*:\s*"[~^]?0\.(\d+)\.\d+"/.exec(pkg);
      expect(m, 'a-frame-shaderloader/package.json pins no super-three 0.<rev>.<patch>').not.toBeNull();
      expect(m![1]).toBe(THREE_REVISION);
    });
  },
);
