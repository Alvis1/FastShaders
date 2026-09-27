/**
 * Route W, proven by SHADER TEXT: loader 0.8's splat wrapper (section 9b)
 * around three r186's GaussianSplat vertex node, built headlessly on the r184
 * node builders — the scratchpad proof (splat-test-184/test.mjs) promoted into
 * the suite, now against the SHIPPED files: the built runtime
 * (public/js/fs-splat-0.1.js) and the served loader, both evaluated in `vm`
 * over three/webgpu.
 *
 * The WebGL build runs the way a real WebGL frame does: the addon's four
 * storage reads and the sort's `orderRead` switched to PBO (what the addon's
 * enableWebGLBuffers + sort.enableWebGLBuffers do inside updateSort), so every
 * storage read is a texelFetch — and the wrapper reads the addon's OWN node
 * objects, so its two reads are texelFetches too (7 in all). A second
 * `storage()` over the same attribute would not have been switched and would
 * read unsorted data; that is the whole reason the wrapper reuses them.
 *
 * The specs are shaped like the editor emits them: TSL `Fn(([p, pw, n, c]) => …)`.
 * Files are read inside tests only.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import { REPO, loaderAvailable, loaderPath, loaderText } from './shaderloaderHarness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const V = '0.8';
const TSL = THREE.TSL;
const RUNTIME = path.join(REPO, 'public/js/fs-splat-0.1.js');
const ready = loaderAvailable(V) && existsSync(RUNTIME);

const TYPED = {
  ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
  Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
};

/** The runtime and the loader on one page, over three/webgpu. */
function page() {
  const warns: string[] = [];
  const sandbox: Record<string, unknown> = {
    THREE,
    window: { THREE },
    console: { log() {}, error() {}, warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')) },
    URL,
    location: { href: 'https://example.test/index.html' },
    Blob,
    DecompressionStream,
    TextDecoder,
    ...TYPED,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(RUNTIME, 'utf8'), sandbox, { filename: RUNTIME });
  vm.runInContext(loaderText(V), sandbox, { filename: loaderPath(V) });
  return { F: sandbox.FastShadersSplat as Any, FS: sandbox.FastShaders as Any, warns };
}

function makeSplat(F: Any, n = 8) {
  const centers = new Float32Array(n * 3).map((_, i) => ((i * 7) % 11) * 0.1 - 0.5);
  const cov = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) { cov[i * 6] = 0.01; cov[i * 6 + 3] = 0.01; cov[i * 6 + 5] = 0.01; }
  const colors = new Uint8ClampedArray(n * 4).fill(200);
  return new F.GaussianSplat(F.createGaussianSplatGeometry(centers, cov, colors), { autoSort: false });
}

/** The PBO program a real WebGL frame builds (enableWebGLBuffers + sort.enableWebGLBuffers). */
function enablePbo(s: Any) {
  for (const k of ['centerRead', 'covarianceARead', 'covarianceBRead', 'colorRead']) s._buffers[k].setPBO(true);
  s._sort.orderRead.setPBO(true);
}

function stubRenderer(webgl: boolean) {
  return {
    contextNode: TSL.context(),
    library: { fromMaterial: (m: unknown) => m },
    backend: {
      isWebGLBackend: webgl, isWebGPUBackend: !webgl,
      capabilities: { getUniformBufferLimit: () => 65536 },
      extensions: { has: () => false }, has: () => false, get: () => ({}),
    },
    getRenderTarget: () => null, getMRT: () => null,
    debug: { diagnostics: { keywords: false } },
    lighting: { enabled: false },
    _currentRenderContext: null,
  };
}

function runBuilder(builder: Any, object: Any) {
  builder.scene = new THREE.Scene();
  builder.material = object.material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.lightsNode = null;
  builder.environmentNode = null;
  builder.fogNode = null;
  builder.clippingContext = null;
  builder.build();
  return { vs: builder.vertexShader as string, fs: builder.fragmentShader as string };
}

const glsl = (object: Any) => runBuilder(new (THREE as Any).GLSLNodeBuilder(object, stubRenderer(true)), object);

const count = (s: string, re: RegExp) => (s.match(re) || []).length;
const COLLAPSE_GLSL = /vec4\( 2\.0, 2\.0, 2\.0, 1\.0 \)/g;

// What the editor emits for a Splat Output with Color, Cut and Move wired.
const editorSpec = () => ({
  shade: TSL.Fn(([p, pw, n, c]: Any[]) => {
    const positionWorld1 = pw;
    return TSL.vec4(TSL.mix(c.rgb, TSL.vec3(0.2, 0.4, 1), TSL.float(0.3).add(positionWorld1.y.mul(0).add(n.z.mul(0)))), 0.8);
  }),
  shape: TSL.Fn(([p]: Any[]) => {
    const positionLocal1 = p;
    return TSL.vec4(TSL.vec3(0, TSL.sin(positionLocal1.x.mul(9.125)).mul(0.1), 0), TSL.length(positionLocal1).sub(0.4));
  }),
  feather: 0.05,
});

function wrapped(spec: Any) {
  const { F, FS, warns } = page();
  const s = makeSplat(F);
  const state: Any = {};
  expect(FS.internals.wrapSplats(state, s, spec)).toBe(1);
  enablePbo(s);
  return { s, state, warns };
}

describe.skipIf(!ready)('route W — the loader wrapper, built to GLSL (WebGL PBO program)', () => {
  it('the addon projection runs first, then the wrapper, then gl_Position = the wrapper clip', () => {
    const { s, warns } = wrapped(editorSpec());
    const { vs, fs } = glsl(s);
    expect(warns).toEqual([]);
    // The addon's per-splat read and projection precede the wrapper's.
    expect(vs.indexOf('splatIndex =')).toBeGreaterThan(0);
    expect(vs.indexOf('fsIdx =')).toBeGreaterThan(vs.indexOf('splatIndex ='));
    expect(vs.indexOf('fsClip = clip;')).toBeGreaterThan(vs.indexOf('clip = ( centerClip'));
    expect(vs).toMatch(/gl_Position = fsClip;/);
    // vSplatColor: the addon's assignment, then the wrapper's.
    expect(count(vs, /vSplatColor\s*=/g)).toBe(2);
    expect(vs.lastIndexOf('vSplatColor =')).toBeGreaterThan(vs.indexOf('fsC = vSplatColor;'));
    // The collapse: the addon's cull, the re-run cull on the moved centre, the
    // cut, and the "the addon already culled it" snapshot.
    expect(count(vs, COLLAPSE_GLSL)).toBe(4);
    expect(vs).toMatch(/fsOldCulled = .*fsClip\.x == 2\.0/);
    // The r184 polyfill for the addon's one r186-only name is a real function.
    expect(vs).toContain('fs_unpackUnorm4x8');
    // Two extra texelFetches per vertex (order + centre), 7 in all.
    expect(count(vs, /texelFetch/g)).toBe(7);
    // The fragment stage is the addon's, untouched: one discard, the kernel.
    expect(count(fs, /\bdiscard\b/g)).toBe(1);
    expect(fs).toMatch(/\bexp\s*\(/);
  });

  it('displacement REBUILDS the clip from the moved centre and re-runs the cull there', () => {
    const { s } = wrapped(editorSpec());
    const { vs } = glsl(s);
    expect(vs).toMatch(/fsVNew = \( highpModelViewMatrix \* vec4\( \( fsP \+ fsShape\.xyz \), 1\.0 \) \);/);
    expect(vs).toMatch(/fsClip = \( fsCNew \+ \( fsOff \* vec4\( fsS \) \) \);/);
    expect(vs).toMatch(/fsVNew\.z >= -0\.01/);
    // The footprint growth is capped at the addon's own 2048 px bound.
    expect(vs).toMatch(/fsS = min\( 1\.0, \( 2048\.0 \/ max\( fsPx, 0\.000001 \) \) \);/);
  });

  it('the cut is a SIGN test with a feathered edge; invert only for the literal true', () => {
    const plain = glsl(wrapped(editorSpec()).s).vs;
    expect(plain).toMatch(/fsKeep = clamp\( \( 1\.0 - \( fsShape\.w \/ max\( 0\.05, 0\.000001 \) \) \), 0\.0, 1\.0 \);/);
    expect(plain).toMatch(/if \( \( fsShape\.w > 0\.05 \) \)/);
    expect(plain).toMatch(/vSplatColor = vec4\( fsShade\.xyz, \( \( fsC\.w \* fsShade\.w \) \* fsKeep \) \);/);

    const inverted = glsl(wrapped({ ...editorSpec(), invert: true }).s).vs;
    const neg = /(\w+) = \( - fsShape\.w \);/.exec(inverted);
    expect(neg).not.toBeNull();
    expect(inverted).toContain(`if ( ( ${neg![1]} > 0.05 ) )`);
    for (const notTrue of ['true', 1, {}]) {
      const vs = glsl(wrapped({ ...editorSpec(), invert: notTrue }).s).vs;
      expect(vs).not.toMatch(/- fsShape\.w/);
    }
  });

  it('size and feather take a function of (p, pw, n, c), a number, or a node', () => {
    const fn = glsl(wrapped({
      size: TSL.Fn(([p, , n]: Any[]) => p.x.add(n.z).add(3)),
      feather: (p: Any) => p.y.mul(0.25),
    }).s).vs;
    expect(fn).toMatch(/fsS = min\( \( \( fsP\.x \+ fsN\.z \) \+ 3\.0 \)/);

    expect(glsl(wrapped({ size: 2 }).s).vs).toMatch(/fsS = min\( 2\.0,/);
    const u = TSL.uniform(2.5);
    const node = glsl(wrapped({ size: u }).s).vs;
    expect(node).not.toMatch(/fsS = min\( 2\.5,/); // a uniform, not a baked literal
    expect(node).toMatch(/fsS = min\( \w+,/);

    // Anything else is the default: size 1 (and with no shape and a default
    // size there is still a rebuild — size was named), feather 0.
    expect(glsl(wrapped({ size: 'big', shape: editorSpec().shape }).s).vs).toMatch(/fsS = min\( 1\.0,/);
    expect(glsl(wrapped({ shape: editorSpec().shape, feather: Number.NaN }).s).vs)
      .toMatch(/max\( 0\.0, 0\.000001 \)/);
  });

  it('shade only: no rebuild, no cut — the colour line and nothing else', () => {
    const { vs } = glsl(wrapped({ shade: editorSpec().shade }).s);
    expect(vs).not.toContain('fsCOld');
    expect(vs).not.toContain('fsKeep');
    expect(count(vs, COLLAPSE_GLSL)).toBe(2); // the addon's cull + the snapshot
    expect(vs).toMatch(/vSplatColor = vec4\( fsShade\.xyz, \( \( fsC\.w \* fsShade\.w \) \* 1\.0 \) \);/);
  });

  it('an empty spec is the identity program: the addon colour, the addon clip', () => {
    const { vs } = glsl(wrapped({}).s);
    // shade absent → vec4(c.rgb, 1); keep absent → 1.
    const own = /(\w+) = vec4\( fsC\.xyz, 1\.0 \);/.exec(vs);
    expect(own).not.toBeNull();
    expect(vs).toContain(`vSplatColor = vec4( ${own![1]}.xyz, ( ( fsC.w * ${own![1]}.w ) * 1.0 ) );`);
    expect(vs).not.toContain('fsCOld');
    expect(vs).toMatch(/gl_Position = fsClip;/);
  });

  it('unwrapping restores the addon program exactly', () => {
    const { F, FS } = page();
    const s = makeSplat(F);
    enablePbo(s);
    // Binding slots are numbered per build, so compare with them renamed.
    const norm = (vs: string) => vs.replace(/nodeUniform\d+/g, 'U').replace(/nodeVar(ying)?\d+/g, 'V');
    const baseline = glsl(s).vs;
    const state: Any = {};
    FS.internals.wrapSplats(state, s, editorSpec());
    expect(norm(glsl(s).vs)).not.toBe(norm(baseline));
    FS.internals.unsplat(state);
    expect(norm(glsl(s).vs)).toBe(norm(baseline));
    expect(count(baseline, /texelFetch/g)).toBe(5);
    expect(count(baseline, /vSplatColor\s*=/g)).toBe(1);
  });
});

describe.skipIf(!ready)('route W — built to WGSL (the WebGPU backend)', () => {
  it('builds with the same structure', (ctx) => {
    const { s } = wrapped(editorSpec());
    let builder: Any;
    try {
      // r184 exports no WGSLNodeBuilder; the backend mints one.
      builder = new (THREE as Any).WebGPUBackend().createNodeBuilder(s, stubRenderer(false));
    } catch (e) {
      ctx.skip(`r184's WGSLNodeBuilder cannot be constructed here: ${(e as Error).message}`);
      return;
    }
    const { vs, fs } = runBuilder(builder, s);
    expect(count(vs, /vSplatColor\s*=/g)).toBe(2);
    expect(vs.indexOf('fsIdx')).toBeGreaterThan(vs.indexOf('splatIndex'));
    expect(count(vs, /vec4<f32>\( 2\.0, 2\.0, 2\.0, 1\.0 \)|vec4f\( 2\.0, 2\.0, 2\.0, 1\.0 \)/g)).toBe(4);
    expect(count(fs, /\bdiscard\b/g)).toBe(1);
    expect(fs).toMatch(/\bexp\s*\(/);
  });
});

/**
 * `lit: true` — the splat's own SURFACE NORMAL as `n` (loader 0.8 section 9b,
 * `splatSurfaceNormal`): the thinnest axis of the covariance by inverse power
 * iteration from the direction to the camera, in world space, facing the
 * camera. The wrapper reads the addon's OWN covariance nodes (the centerRead
 * rule: only they are switched to PBO on WebGL), so a lit program fetches
 * both of them once more. Only the literal `true` lights; a splat whose addon
 * lacks the covariance nodes keeps the camera-facing `n`, with one warning.
 */
describe.skipIf(!ready)('route W — lit: true, the splat surface normal', () => {
  const T: Any = TSL;
  const litShade = () => T.Fn(([, , n, c]: Any[]) =>
    T.vec4(T.mul(c.rgb, T.max(T.dot(n, T.normalize(T.vec3(0.6, 0.8, 0.5))), 0)), 1));
  const fsNLine = (vs: string) => vs.split('\n').find((l) => /^\s*fsN = /.test(l)) ?? '';

  it('builds on WebGL: the covariance is read through the addon nodes, three steps, the normal matrix, facing the camera', () => {
    const { s, warns } = wrapped({ shade: litShade(), lit: true });
    const { vs } = glsl(s);
    expect(warns).toEqual([]);
    // 5 addon reads + the wrapper's order and centre + its two covariance reads.
    expect(count(vs, /texelFetch/g)).toBe(9);
    expect(vs).toMatch(/fsCovA = /);
    expect(vs).toMatch(/fsCovB = /);
    for (const step of ['fsNv1', 'fsNv2', 'fsNv3']) expect(vs, step).toMatch(new RegExp(`\\b${step} = normalize\\(`));
    expect(vs).not.toMatch(/\bfsNv4\b/);
    expect(vs).toMatch(/fsNw = normalize\( \( \w+ \* fsNv3 \) \);/);
    // The start is the OBJECT-space direction to the camera (the fallback).
    expect(vs).toMatch(/fsNv = normalize\( \( \( \w+ \* vec4\( cameraPosition, 1\.0 \) \)\.xyz - fsP \) \);/);
    // n is the normal FLIPPED toward the camera (select lowers to an if),
    // never the camera direction itself.
    const flip = /if \( \( dot\( fsNw, \( cameraPosition - fsPw \) \) < 0\.0 \) \) \{\s*(\w+) = \( - fsNw \);\s*\} else \{\s*\1 = fsNw;/.exec(vs);
    expect(flip).not.toBeNull();
    expect(fsNLine(vs).trim()).toBe(`fsN = ${flip![1]};`);
  });

  it('unlit: `n` is the direction to the camera and the covariance is never read by the wrapper', () => {
    for (const lit of [undefined, false, 1, 'true', {}]) {
      const { vs } = glsl(wrapped({ shade: litShade(), lit }).s);
      expect(vs, String(lit)).not.toMatch(/fsCovA|fsNw/);
      expect(count(vs, /texelFetch/g), String(lit)).toBe(7);
      expect(fsNLine(vs), String(lit)).toMatch(/^\s*fsN = normalize\( \( \w+ - fsPw \) \);$/);
    }
  });

  it('an addon without the covariance nodes: one warning, `n` stays the camera direction, the rest still applies', () => {
    const { F, FS, warns } = page();
    const s = makeSplat(F);
    enablePbo(s);
    const covA = s._buffers.covarianceARead;
    s._buffers.covarianceARead = undefined;
    const state: Any = {};
    expect(FS.internals.wrapSplats(state, s, { shade: litShade(), lit: true })).toBe(1);
    expect(warns.filter((w) => w.includes('splat lighting unavailable'))).toHaveLength(1);
    s._buffers.covarianceARead = covA; // the addon's own vertex node still reads it
    const { vs } = glsl(s);
    expect(vs).not.toMatch(/fsCovA|fsNw/);
    expect(vs).toMatch(/vSplatColor = vec4\( fsShade\.xyz/);
  });

  it('builds on WGSL (the WebGPU backend) with the same normal', (ctx) => {
    const { s } = wrapped({ shade: litShade(), lit: true });
    let builder: Any;
    try {
      builder = new (THREE as Any).WebGPUBackend().createNodeBuilder(s, stubRenderer(false));
    } catch (e) {
      ctx.skip(`r184's WGSLNodeBuilder cannot be constructed here: ${(e as Error).message}`);
      return;
    }
    const { vs } = runBuilder(builder, s);
    expect(vs).toMatch(/fsCovA/);
    expect(vs).toMatch(/fsNv3 = normalize\(/);
    expect(vs).toMatch(/fsNw/);
  });
});

describe('route W — the parameter names', () => {
  it('p, pw, n and c are not TSL names, so the loader never injects an import over them', () => {
    // autoInjectTSLImports adds any called name THREE.TSL exports; a future
    // three exporting one of these would shadow the Fn parameter.
    for (const name of ['p', 'pw', 'n', 'c']) expect(name in TSL, name).toBe(false);
  });
});

/**
 * An EDITOR-EMITTED program, end to end: graphToCode → buildShaderModule →
 * the module's default export run over this suite's three → the loader's
 * wrapper → the GLSL the WebGL backend builds. A noise on Cut whose position
 * is left UNWIRED used to emit `mx_noise_float(positionGeometry)` in the flat
 * body, captured by the Fn — and in the splat's vertex stage
 * `positionGeometry` is the instanced quad's CORNER attribute (`position`,
 * ±2): the same for every splat, different at each corner, so the cut was
 * not per splat and a per-corner cut tore the collapsed quad. The editor now
 * binds that default to the Fn's `p` (utils/sdfPartition.ts implicitRootOf),
 * which the wrapper feeds the splat's centre, `fsP`.
 */
describe.skipIf(!ready)('route W — an editor-emitted noise on Cut reads the splat CENTRE, never the quad corner', () => {
  /** The module's default export, over the same three the loader and runtime use. */
  const runModule = (text: string): Any => {
    const body = text
      .replace(/^import \* as THREE from 'three\/webgpu';$/m, '')
      .replace(/^import \{([^}]*)\} from 'three\/tsl';$/m, 'const {$1} = TSL;')
      .replace(/^export const /gm, 'const ')
      .replace(/^export default function/m, 'return function');
    return new Function('TSL', 'THREE', body)(TSL, THREE);
  };

  /** Emit `nodes`/`edges` (a Splat Output 'sp' among them) and build the wrapped splat's shaders. */
  async function editorBuild(
    nodes: Any[],
    edges: Any[],
    edit: (tsl: string) => string = (s) => s,
    webgl = true,
  ) {
    const { graphToCode } = await import('./engine/graphToCode');
    const { buildShaderModule } = await import('./engine/tslCodeProcessor');
    const tsl = edit(graphToCode(nodes, edges).code);
    const mod = buildShaderModule(tsl);
    const spec = runModule(mod)({}).splat;
    const { F, FS, warns } = page();
    const s = makeSplat(F);
    expect(FS.internals.wrapSplats({}, s, spec)).toBe(1);
    enablePbo(s);
    const built = webgl
      ? glsl(s)
      : runBuilder(new (THREE as Any).WebGPUBackend().createNodeBuilder(s, stubRenderer(false)), s);
    return { tsl, mod, warns, ...built };
  }

  /** The argument text of every CALL of the built perlin function (not its definition). */
  const noiseArgs = (vs: string): string[] => {
    const out: string[] = [];
    const re = /mx_perlin_noise_float_\d+\(/g;
    for (let m = re.exec(vs); m; m = re.exec(vs)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const from = i;
      while (i < vs.length && depth > 0) {
        if (vs[i] === '(') depth++;
        else if (vs[i] === ')') depth--;
        i++;
      }
      out.push(vs.slice(from, i - 1).trim());
    }
    return out;
  };

  const graph = async (noiseValues: Record<string, string | number> = {}) => {
    const { makeNode, makeEdge } = await import('./test-utils');
    return {
      nodes: [makeNode('nz', 'perlin', noiseValues), makeNode('sp', 'splatOutput')],
      edges: [makeEdge('nz', 'out', 'sp', 'cut')],
    };
  };

  it('the shape Fn\'s noise reads fsP — the centre the wrapper reads per splat — and no `position` attribute', async () => {
    const { nodes, edges } = await graph();
    const { tsl, vs, warns } = await editorBuild(nodes, edges);
    expect(warns).toEqual([]);
    expect(tsl).toContain('    const noise1 = mx_noise_float(p);');
    expect(tsl).not.toContain('positionGeometry');
    // The one noise call in the program, and its argument is the centre.
    expect(noiseArgs(vs)).toEqual(['fsP']);
    const shapeLine = vs.split('\n').find((l) => /^\s*fsShape = /.test(l))!;
    expect(shapeLine).toMatch(/mx_perlin_noise_float_\d+\( fsP \)/);
    expect(shapeLine).not.toMatch(/\bposition\b/);
    // fsP is the wrapper's per-splat centre read, taken before the shape runs.
    expect(vs.indexOf('fsP = ')).toBeGreaterThan(0);
    expect(vs.indexOf('fsP = ')).toBeLessThan(vs.indexOf('fsShape = '));
    // The quad attribute is read by the ADDON's corner offset alone, never by the wrapper.
    for (const l of vs.split('\n').filter((line) => /\bposition\b/.test(line) && !/\bin vec3 position\b/.test(line))) {
      expect(l).toMatch(/^\s*(vSplatUv|offsetPixels) = /);
    }
  });

  it('NEGATIVE CONTROL: the pre-fix emission (a flat noise over positionGeometry, captured) reads the quad corner', async () => {
    const { nodes, edges } = await graph();
    const { vs } = await editorBuild(nodes, edges, (tsl) =>
      tsl
        .replace(
          '  const sp1Shape = Fn(([p, pw, n, c]) => {\n    const noise1 = mx_noise_float(p);',
          '  const noise1 = mx_noise_float(positionGeometry);\n  const sp1Shape = Fn(([p, pw, n, c]) => {',
        )
        .replace("import { Fn, mx_noise_float, vec4 } from 'three/tsl';", "import { Fn, mx_noise_float, positionGeometry, vec4 } from 'three/tsl';"),
    );
    expect(noiseArgs(vs)).toEqual(['position']);
  });

  it('a scaled position and a stored world-centre position bind the same way', async () => {
    const scaled = await graph({ pos: 'positionGeometry', scale: 3 });
    const s = await editorBuild(scaled.nodes, scaled.edges);
    expect(s.tsl).toContain('mx_noise_float(p.mul(3))');
    expect(noiseArgs(s.vs)).toEqual(['( fsP * vec3( 3.0 ) )']);
    const world = await graph({ pos: 'positionWorld', scale: 1 });
    const w = await editorBuild(world.nodes, world.edges);
    expect(w.tsl).toContain('mx_noise_float(pw)');
    expect(noiseArgs(w.vs)).toEqual(['fsPw']);
    expect(w.vs).toMatch(/fsPw = \( \w+ \* vec4\( fsP, 1\.0 \) \)\.xyz;/);
  });

  it('a View Position cut and a Ray Direction colour are read at the centre as well', async () => {
    const { makeNode, makeEdge } = await import('./test-utils');
    const { vs, warns } = await editorBuild(
      [
        makeNode('pv', 'positionView'), makeNode('len', 'length'), makeNode('rd', 'rayDirection'), makeNode('ab', 'abs'),
        makeNode('sp', 'splatOutput'),
      ],
      [
        makeEdge('pv', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'cut'),
        makeEdge('rd', 'out', 'ab', 'x'), makeEdge('ab', 'out', 'sp', 'color'),
      ],
    );
    expect(warns).toEqual([]);
    const line = (name: string) => vs.split('\n').find((l) => new RegExp(`^\\s*${name} = `).test(l))!;
    // |modelView · (p, 1)| — the centre's distance from the camera.
    expect(line('fsShape')).toMatch(/length\( \( \w+ \* vec4\( fsP, 1\.0 \) \)\.xyz \)/);
    // normalize(pw − cameraPosition) over the wrapper's world centre — never
    // −n, which a lit spec turns into the surface normal.
    expect(line('fsShade')).toMatch(/abs\( normalize\( \( fsPw - cameraPosition \) \) \)/);
    for (const name of ['fsShape', 'fsShade']) expect(line(name), name).not.toMatch(/\bposition\b/);
  });

  it('WGSL (the WebGPU backend) builds the same read', async (ctx) => {
    const { nodes, edges } = await graph();
    let vs: string;
    try {
      ({ vs } = await editorBuild(nodes, edges, undefined, false));
    } catch (e) {
      ctx.skip(`r184's WGSLNodeBuilder cannot be constructed here: ${(e as Error).message}`);
      return;
    }
    expect(noiseArgs(vs)).toEqual(['fsP']);
    expect(vs.split('\n').find((l) => /^\s*fsShape = /.test(l))).toMatch(/mx_perlin_noise_float_\d+\( fsP \)/);
  });
});
