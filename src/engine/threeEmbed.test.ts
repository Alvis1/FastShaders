/**
 * The code panel's **Three.js** tab: a copy-ready `index.html` that loads the
 * exported module from beside it and hands it to loader 0.8's plain-three core.
 *
 * It is the A-Frame tab's sibling, so `tslToAFrameHTML.test.ts` covers the
 * rules they share (the schema is the uniform source, the shader is a sibling
 * file, the page carries no comments). What is pinned HERE is what only this
 * page has to get right: the loader's call sequence, the tessellation, and —
 * in the second half — that the page's OWN script, executed against the served
 * loader, real three and real generated modules, ends with the material the
 * loader builds. The page used to wire the module by hand and got five things
 * wrong with no error to show for it (tslToThreeHTML.ts's header lists them);
 * the executed half is what would notice any of them coming back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import { buildThreeEmbedHTML, THREE_VERSION } from './tslToThreeHTML';
import { CDN_BASE, LOADER_FILE, tslToShaderModule } from './tslToShaderModule';
import { graphToCode } from './graphToCode';
import { collectShaderProperties, marchMaterialSettings } from './exportShader';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge, OutputNodeData } from '@/types';
import { CURRENT_LOADER, REPO, evalLoader, loaderAvailable, type FastShadersApi } from '../shaderloaderHarness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const MODULE = `// TSL Shader Module
import { Fn, uniform, vec3, mix, positionLocal } from 'three/tsl';

export const schema = {
  colorA: { type: 'color', default: '#1b2a4a' },
  speed: { type: 'number', default: 2 },
};

export default function(params) {
  const colorA = uniform(params.colorA);
  const speed = uniform(params.speed);
  return { colorNode: mix(colorA, vec3(1), speed), roughnessNode: speed };
}
`;

const DISPLACING = MODULE.replace(
  'return { colorNode:',
  'return { positionNode: positionLocal.add(vec3(0, 0.1, 0)), colorNode:',
);

const build = (src = MODULE, opts = {}) =>
  buildThreeEmbedHTML(src, { shaderFile: 'my-shader.js', title: 'My Shader', ...opts });

const LOADER_TAG = `<script src="${CDN_BASE}/${LOADER_FILE}"></` + 'script>';

describe('the Three.js embed page', () => {
  it('loads the module from beside it, by a bare relative path', () => {
    const html = build();
    expect(html).toContain("const shader = await FastShaders.load('./my-shader.js');");
    // A traversal or an absolute path would make "drop the .js next to it"
    // false, which is the page's entire install step.
    // The guard takes the last segment and strips everything that is not a
    // bare file-name character, so a traversal cannot survive it.
    expect(buildThreeEmbedHTML(MODULE, { shaderFile: '../../etc/passwd' }))
      .toContain("await FastShaders.load('./passwd');");
  });

  it('pins three to the version the app is built against', () => {
    const pkg = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    // The module is authored against THIS TSL surface. A floating tag would let
    // a later rename break a page the user has already saved, with an import
    // error that names nothing the user recognises. Read by pattern rather
    // than parsed, so no reviver is needed for a file this test does not own.
    const dep = /"three"\s*:\s*"([^"]+)"/.exec(pkg);
    expect(dep, 'package.json names no three dependency').not.toBeNull();
    expect(dep![1]).toContain(THREE_VERSION);
    const html = build();
    expect(html).toContain(`three@${THREE_VERSION}/build/three.webgpu.min.js`);
    expect(html).toContain(`three@${THREE_VERSION}/build/three.tsl.min.js`);
    expect(html).not.toContain('@latest');
  });

  it('maps three, three/webgpu and three/tsl — the page imports the second', () => {
    const html = build();
    for (const spec of ['"three"', '"three/webgpu"', '"three/tsl"']) {
      expect(html, `${spec} missing from the import map`).toContain(spec);
    }
  });

  it('loads the current loader once, as a classic script between the import map and the page module', () => {
    const html = build();
    // An import map must precede every module script; the loader is a classic
    // script, so it runs before the (deferred) page module either way — but it
    // has to be on the page, from the same path every export header names.
    const map = html.indexOf('<script type="importmap">');
    const loader = html.indexOf(LOADER_TAG);
    const mod = html.indexOf('<script type="module">');
    expect(map).toBeGreaterThan(-1);
    expect(loader).toBeGreaterThan(map);
    expect(mod).toBeGreaterThan(loader);
    expect(html.split(LOADER_TAG).length - 1).toBe(1);
  });

  it('hands the module to the loader: use, load, then a synchronous apply', () => {
    const html = build();
    const use = html.indexOf('FastShaders.use(THREE);');
    const load = html.indexOf('await FastShaders.load(');
    const apply = html.indexOf('const binding = FastShaders.apply(mesh, shader, { values: params });');
    expect(use, 'use(THREE) — the loader reads no THREE of its own on a plain page').toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(use);
    expect(apply).toBeGreaterThan(load);
    // The mesh has to exist before apply stores its original material.
    expect(html.indexOf('const mesh = new THREE.Mesh(geometry);')).toBeLessThan(apply);
    // apply() is synchronous and takes no THREE: use() bound it. The async
    // `apply(mesh, url, { THREE })` an early draft documented never existed.
    expect(html).not.toContain('await FastShaders.apply(');
    expect(html).not.toMatch(/FastShaders\.apply\([^)]*\{\s*THREE\s*[,}]/);
  });

  it('wires nothing by hand — the loader owns the material, parts, the weld and side', () => {
    for (const html of [
      build(),
      build(DISPLACING, { geometry: 'cube' }),
      build(MODULE, { geometry: 'marchSphere', marchWindow: 4 }),
    ]) {
      for (const manual of [
        'MeshStandardNodeMaterial',
        'MeshPhysicalNodeMaterial',
        'Object.assign',
        'shader(params)',
        'import shader',
        'parts',
        'mergeVertices',
        'BufferGeometryUtils',
        'barycentric',
        'material.side',
        'DoubleSide',
        'Node =',
      ]) {
        expect(html, `the page restates "${manual}" instead of leaving it to the loader`).not.toContain(manual);
      }
    }
  });

  it('gives a displacing shader vertices to displace', () => {
    const flat = build();
    // A default PlaneGeometry is four corners: a positionNode moves nothing and
    // the relief is ABSENT, not coarse. Tessellation stays the page's job.
    expect(flat).toContain('new THREE.SphereGeometry(0.8, 64, 32)');
    expect(build(DISPLACING, { geometry: 'plane' })).toContain('new THREE.PlaneGeometry(1.6, 1.6, 64, 64)');
    expect(build(DISPLACING, { geometry: 'cube' })).toContain('new THREE.BoxGeometry(1, 1, 1, 64, 64, 64)');
    expect(build(DISPLACING)).toContain('new THREE.SphereGeometry(0.8, 128, 64)');
  });

  it('renders a march window from inside, sized by the Window', () => {
    const html = build(MODULE, { geometry: 'marchSphere', marchWindow: 4 });
    expect(html).toContain('new THREE.SphereGeometry(4, 64, 32)');
    // The camera sits inside the window sphere, so a back face is what it sees.
    expect(html).toContain('camera.position.set(0, 0, 0.001);');
  });

  it("is fed the march's double side through the module, not a line of its own", () => {
    // The page has no DoubleSide line: the module the tab is built from carries
    // `side: 2` whenever a Raymarch Output drives, and the loader puts it on
    // the material (executed below). That holds only while CodeEditor feeds the
    // tab the march-aware settings — pinned here from source.
    const editor = readFileSync(`${REPO}/src/components/CodeEditor/CodeEditor.tsx`, 'utf8');
    expect(editor).toContain("sdfDrives ? { ...rawMaterialSettings, side: 'double' as const } : rawMaterialSettings");
    expect(editor).toContain('return buildThreeEmbedHTML(scriptCode, {');
    expect(editor).toMatch(/tslToShaderModule\(\s*inlineImageAssetsFromNodes\([\s\S]*?\.nodes\),\s*materialSettings,/);
    const code = "import { Fn, vec3 } from 'three/tsl';\n\nconst shader = Fn(() => {\n  return vec3(1, 0, 0);\n});\n\nexport default shader;\n";
    expect(tslToShaderModule(code, { side: 'double' })).toMatch(/\bside: 2\b/);
  });

  it('lists every uniform the module declares, and only those, as the values it applies', () => {
    const html = build();
    // A colour must be a JS STRING here. The schema's `defaultValue` is
    // normalized for an A-Frame attribute, where a bare `#1b2a4a` is fine; in a
    // JS object literal it is a comment that swallows the rest of the line.
    expect(html).toContain("colorA: '#1b2a4a'");
    expect(html).toContain('speed: 2');
    expect(html).toContain('{ values: params }');
    const none = buildThreeEmbedHTML(MODULE.replace(/export const schema = \{[\s\S]*?\};/, ''), {
      shaderFile: 'x.js',
    });
    expect(none).toContain('const params = {};');
  });

  it('falls back to a primitive for a model geometry, which it cannot load', () => {
    // `custom` and `bunny` are model files the editor fetches; a standalone
    // page has no such file beside it, so promising one would render nothing.
    // That is also why the page registers no glTF plugin and no decoders.
    for (const g of ['custom', 'bunny', 'teapot'] as const) {
      const html = build(MODULE, { geometry: g });
      expect(html).toContain('new THREE.SphereGeometry(0.8,');
      expect(html).not.toContain('gltfPlugin');
      expect(html).not.toContain('decoders');
    }
  });

  it('carries no comments, like its A-Frame sibling', () => {
    const html = build();
    const body = html.slice(html.indexOf('<body>'));
    expect(body).not.toMatch(/^\s*\/\//m);
    expect(body).not.toContain('<!--');
  });

  it('escapes the title rather than interpolating it into markup', () => {
    const html = buildThreeEmbedHTML(MODULE, { shaderFile: 'x.js', title: '</title><script>x' });
    expect(html).not.toContain('</title><script>x');
    expect(html).toContain('&lt;/title&gt;');
  });

  it('the README plain-three snippet pins the same three as this page', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    // The export header links this section, so it is the other half of the
    // drift set: THREE_VERSION = the snippet's three@ URLs = package.json.
    expect(readme).toContain(`three@${THREE_VERSION}/build/three.tsl.min.js`);
    expect(readme).toContain(`three@${THREE_VERSION}/build/three.webgpu.min.js`);
    const pinned = [...readme.matchAll(/three@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(pinned.length).toBeGreaterThan(0);
    for (const v of pinned) expect(v).toBe(THREE_VERSION);
    expect(readme).not.toContain('@latest');
    const start = readme.indexOf('## Using the shader module with plain Three.js');
    expect(start).toBeGreaterThan(0);
    const next = readme.indexOf('\n## ', start + 1);
    const section = readme.slice(start, next < 0 ? undefined : next);
    // The recipe is loader 0.8's core: the classic script from the CDN, bound
    // to the page's three with use(), then load() and apply() — the same three
    // calls this page makes.
    expect(section).toContain(LOADER_TAG);
    const use = section.indexOf('FastShaders.use(THREE)');
    const load = section.indexOf("await FastShaders.load('./myshader.js')");
    const apply = section.indexOf('FastShaders.apply(');
    expect(use, 'use(THREE) — the loader reads no THREE of its own on a plain page').toBeGreaterThan(0);
    expect(load).toBeGreaterThan(use);
    expect(apply).toBeGreaterThan(load);
    // apply() is synchronous and returns the binding; the async-apply form an
    // early draft documented does not exist in 0.8.
    expect(section).not.toContain('await FastShaders.apply(');
    expect(section).not.toMatch(/FastShaders\.apply\([^)]*\{\s*THREE\s*[,}]/);
    // The section no longer tells readers the tab wires the module by hand.
    expect(section).not.toContain('by hand, so it does not cover');
  });
});

// ─── The page, executed ────────────────────────────────────────────────────
//
// The page's own `<script type="module">` runs inside the harness's vm sandbox,
// after the SERVED 0.8 loader has been evaluated there, exactly as a browser
// runs the two scripts in document order. Three things are stood in for, and
// nothing else:
//   · `import * as THREE from 'three/webgpu'` — the one import the page makes —
//     is handed in as the real namespace with a no-op WebGPURenderer (node has
//     no GPU; nothing here renders, it only builds);
//   · FastShaders.fetch returns the generated module's text;
//   · FastShaders.importSource evaluates the loader-PREPARED source in the same
//     sandbox. vm has no dynamic import, which is the one leg the default
//     (Blob URL → import) needs a browser for; the stand-in translates only the
//     three `export` forms a generated module has, and fails on anything else.
// So the page's calls, their order, the values literal, the loader's
// transforms and apply, and the generated module's own code are all real.

class FakeRenderer {
  domElement = { nodeName: 'CANVAS' };
  inited = false;
  loop: unknown = null;
  constructor(public opts: unknown) {}
  setPixelRatio() {}
  setSize() {}
  init() {
    this.inited = true;
    return Promise.resolve(this);
  }
  setAnimationLoop(fn: unknown) {
    this.loop = fn;
  }
  render() {}
}

const PAGE_THREE = { ...THREE, WebGPURenderer: FakeRenderer };
const PAGE_IMPORT = "import * as THREE from 'three/webgpu';";

/** The page module's body, minus its one import, which the run hands in. */
function pageScript(html: string): string {
  const open = '<script type="module">';
  const start = html.indexOf(open);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</' + 'script>', start);
  const body = html.slice(start + open.length, end);
  expect(body).toContain(PAGE_IMPORT);
  const rest = body.replace(PAGE_IMPORT, '');
  expect(rest, 'the page imports something the run does not provide').not.toMatch(/^\s*import\b/m);
  return rest;
}

/** importSource stand-in: evaluate prepared module source in the sandbox. */
function importInSandbox(sandbox: Record<string, unknown>, source: string): Promise<Record<string, unknown>> {
  const body = source
    .replace(/^export default function\b/m, '__module.default = function')
    .replace(/^export const ([A-Za-z_$][\w$]*)\s*=/gm, 'const $1 = __module.$1 =');
  expect(body, 'a module form this stand-in does not translate').not.toMatch(/^\s*(?:import|export)\b/m);
  const mod: Record<string, unknown> = {};
  const run = vm.runInContext(`(async function (__module) {\n${body}\n})`, sandbox) as (m: object) => Promise<void>;
  return run(mod).then(() => mod);
}

interface PageRun {
  scene: Any;
  camera: Any;
  geometry: Any;
  mesh: Any;
  binding: Any;
  renderer: FakeRenderer;
  sandbox: Record<string, unknown>;
  fetched: string[];
  warns: string[];
  errors: string[];
  listeners: string[];
  appended: unknown[];
}

async function runPage(html: string, moduleText: string): Promise<PageRun> {
  const warns: string[] = [];
  const errors: string[] = [];
  const listeners: string[] = [];
  const appended: unknown[] = [];
  const fetched: string[] = [];
  const join = (a: unknown[]) => a.map(String).join(' ');
  // A plain page: no A-Frame and no global THREE until the page's use().
  const ev = evalLoader(CURRENT_LOADER, {
    aframe: false,
    warn: (...a: unknown[]) => warns.push(join(a)),
    error: (...a: unknown[]) => errors.push(join(a)),
    globals: {
      document: {
        body: { appendChild: (el: unknown) => appended.push(el) },
        currentScript: null,
        querySelectorAll: () => [],
      },
      addEventListener: (type: string) => listeners.push(type),
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      // A baked texture (Data, Colormap) decodes its payload with atob, which
      // every page has; the vm context does not.
      atob,
    },
  });
  const FS = ev.FastShaders as FastShadersApi;
  expect(FS, 'the served loader installed no FastShaders').not.toBeNull();
  expect(ev.sandbox.THREE).toBeUndefined();
  FS.fetch = (url: string) => {
    fetched.push(url);
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(moduleText) });
  };
  FS.importSource = (source: string) => importInSandbox(ev.sandbox, source);
  const run = vm.runInContext(
    `(async (THREE) => {\n${pageScript(html)}\nreturn { scene, camera, geometry, mesh, binding, renderer };\n})`,
    ev.sandbox,
  ) as (t: unknown) => Promise<Omit<PageRun, 'sandbox' | 'fetched' | 'warns' | 'errors' | 'listeners' | 'appended'>>;
  const page = await run(PAGE_THREE);
  return { ...page, sandbox: ev.sandbox, fetched, warns, errors, listeners, appended };
}

interface Graph { nodes: AppNode[]; edges: AppEdge[] }

/** The module the tab is built from — CodeEditor's scriptCode, fed a graph. */
function tabModule({ nodes, edges }: Graph): string {
  const output = findDefaultOutput(nodes);
  return tslToShaderModule(
    graphToCode(nodes, edges).code,
    marchMaterialSettings(nodes, edges, (output?.data as OutputNodeData | undefined)?.materialSettings),
    collectShaderProperties(nodes),
  );
}

const out = () => makeNode('out', 'output');

describe.skipIf(!loaderAvailable(CURRENT_LOADER))('the Three.js page, executed against the served loader', () => {
  it('builds uniform NODES from the schema and applies the page values to them, live', async () => {
    const mod = tabModule({
      nodes: [
        makeNode('p1', 'property_color', { name: 'tint', hex: '#3366ff' }),
        makeNode('p2', 'property_float', { name: 'speed', value: 0.5 }),
        out(),
      ],
      edges: [makeEdge('p1', 'out', 'out', 'color'), makeEdge('p2', 'out', 'out', 'roughness')],
    });
    const html = build(mod);
    expect(html).toContain("tint: '#3366ff'");
    expect(html).toContain('speed: 0.5');
    // A reader edits the values literal; the edit has to reach the uniforms.
    const edited = html.replace("tint: '#3366ff'", "tint: '#ff8800'").replace('speed: 0.5', 'speed: 0.25');
    const r = await runPage(edited, mod);

    expect(r.fetched).toEqual(['./my-shader.js']);
    // use() installed the page's namespace as the global the module reads.
    expect(r.sandbox.THREE).toBe(PAGE_THREE);
    // The hand-wired page passed these as plain values: a colour arrived as a
    // STRING and nothing could change it afterwards.
    const u = r.binding.uniforms;
    expect(u.tint.value.isColor).toBe(true);
    expect(u.tint.value.getHexString()).toBe('ff8800');
    expect(u.speed.value).toBe(0.25);
    expect(r.binding.set('speed', 3)).toBe(true);
    expect(u.speed.value).toBe(3);
    expect(r.binding.set('tint', '#00ff00')).toBe(true);
    expect(u.tint.value.getHexString()).toBe('00ff00');

    expect(r.mesh.material).toBe(r.binding.material);
    expect(r.mesh.material.type).toBe('MeshPhysicalNodeMaterial');
    expect(r.mesh.material.colorNode).not.toBeNull();
    expect(r.mesh.material.roughnessNode).not.toBeNull();
    expect(r.scene.children).toContain(r.mesh);

    expect(r.renderer.inited).toBe(true);
    expect(typeof r.renderer.loop).toBe('function');
    expect(r.appended).toContain(r.renderer.domElement);
    expect(r.listeners).toEqual(['pointerdown', 'pointerup', 'pointermove', 'resize']);
    // No revision mismatch, no second THREE, nothing thrown into the console.
    expect(r.warns).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('welds a displaced box by position — which mergeVertices never did — and dispose undoes it', async () => {
    const mod = tabModule({
      nodes: [makeNode('f1', 'float', { value: 0.1 }), out()],
      edges: [makeEdge('f1', 'out', 'out', 'position')],
    });
    expect(mod).toMatch(/positionNode\s*:/);
    const html = build(mod, { geometry: 'cube' });
    expect(html).toContain('new THREE.BoxGeometry(1, 1, 1, 64, 64, 64)');
    const r = await runPage(html, mod);

    expect(r.geometry.type).toBe('BoxGeometry');
    expect(r.mesh.material.positionNode).not.toBeNull();
    // A BoxGeometry gives each face its own corner copies (different normal and
    // uv), so BufferGeometryUtils.mergeVertices kept all of them and the faces
    // separated under displacement. The loader welds by POSITION.
    expect(r.mesh.geometry).not.toBe(r.geometry);
    expect(r.mesh.geometry.attributes.position.count).toBeLessThan(r.geometry.attributes.position.count);
    r.binding.dispose();
    expect(r.mesh.geometry).toBe(r.geometry);
    expect(r.warns).toEqual([]);
  });

  it('runs a texture shader — the global THREE exists before the module does', async () => {
    const mod = tabModule({
      nodes: [makeNode('f1', 'float', { value: 0.3 }), makeNode('c1', 'colormap', { map: 'viridis' }), out()],
      edges: [makeEdge('f1', 'out', 'c1', 'value'), makeEdge('c1', 'out', 'out', 'color')],
    });
    // A Colormap bakes a DataTexture at module scope from THREE.
    expect(mod).toContain("import * as THREE from 'three/webgpu';");
    const r = await runPage(build(mod), mod);
    expect(r.mesh.material.colorNode).not.toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.warns).toEqual([]);
  });

  it("puts a march window's double side on the material from the module", async () => {
    const mod = tabModule({
      nodes: [
        makeNode('pos', 'positionLocal'),
        makeNode('sd', 'sdCircle'),
        makeNode('col', 'color', { hex: '#2d6cdf' }),
        makeNode('rm', 'raymarchOutput'),
      ],
      edges: [
        makeEdge('pos', 'out', 'sd', 'p'),
        makeEdge('sd', 'out', 'rm', 'field'),
        makeEdge('col', 'out', 'rm', 'color'),
      ],
    });
    expect(mod).toMatch(/\bside: 2\b/);
    const r = await runPage(build(mod, { geometry: 'marchSphere', marchWindow: 4 }), mod);
    expect(r.geometry.parameters.radius).toBe(4);
    expect(r.camera.position.z).toBe(0.001);
    expect(r.mesh.material.side).toBe(THREE.DoubleSide);
    expect(r.errors).toEqual([]);
  });
});
