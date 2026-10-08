import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import * as THREE from 'three/webgpu';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { composeKhrTextureTransform } from './glbExportPlan';
import { sanitizeImageNodes } from '@/utils/imageNode';
import { readImagePlacement, placementAt, foldLegacyUvTransform } from '@/utils/imagePlacement';
import { readImageUvMapping, gltfTextureValues } from '@/utils/imageUvMapping';
import { getNodeValues, type AppEdge, type AppNode } from '@/types';
import { makeNode, makeEdge } from '../test-utils';

/**
 * The picture's TURN (`values.rotation`, utils/imagePlacement.ts) as the image
 * branch emits it: the last step of the chain, ONE numbers-only mat2 about the
 * picture's centre, nothing at all when there is no turn. Emitted text is
 * evaluated through REAL three — the expression is built with three/tsl and its
 * node tree walked, constants read off three's own Vector2/Matrix2 — the way
 * imageUvTransformTsl.test.ts pins the legacy mat2, because a transposed or
 * mis-signed matrix is perfect-looking source and a wrong picture.
 */

type P = [number, number];
const TAU = 2 * Math.PI;
const PNG = `data:image/png;base64,${btoa('abc')}`;
const VALID: Record<string, string | number> = { imageB64: PNG, width: 2, height: 2, fileName: 'x.png', colorSpace: 'color' };

/** An Image node whose `values` may hold ANYTHING, as a `.fastshader` may. */
function img(id: string, extra: Record<string, unknown> = {}): AppNode {
  const n = makeNode(id, 'imageNode');
  (n.data as { values: Record<string, unknown> }).values = { ...VALID, ...extra };
  return n;
}
function imageGraph(extra: Record<string, unknown> = {}): { nodes: AppNode[]; edges: AppEdge[] } {
  return { nodes: [img('img1', extra), makeNode('out1', 'output')], edges: [makeEdge('img1', 'out', 'out1', 'color')] };
}
const codeOf = (g: { nodes: AppNode[]; edges: AppEdge[] }) => graphToCode(g.nodes, g.edges).code;
/** The uv expression inside `const image1 = texture(_image1_tex, …).rgb;`. */
function uvExprOf(code: string): string {
  const m = /const image1 = texture\(_image1_tex, (.*)\)\.rgba?;/.exec(code);
  expect(m, code).not.toBeNull();
  return m![1];
}
const importLine = (code: string) => code.split('\n').find((l) => l.includes("from 'three/tsl'")) ?? '';

// ── the emitted expression, built and evaluated by real three ──────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;
const T = TSL as unknown as Record<string, TslNode>;

function buildEmitted(expr: string): TslNode {
  return new Function('mat2', 'vec2', 'uv', `return ${expr};`)(T.mat2, T.vec2, T.uv);
}

type Val = { m: number[] } | { v: P };
/** Walk three's node tree at one uv: OperatorNode + / *, ConstNode Vector2 /
 *  Matrix2 (elements COLUMN-major, so M·v = (e0·x + e2·y, e1·x + e3·y)),
 *  and the `uv` attribute. Anything else is a failure, not a guess. */
function evalNode(node: TslNode, at: P): Val {
  while (node?.isVarNode) node = node.node;
  if (node?.isOperatorNode) {
    const a = evalNode(node.aNode, at);
    const b = evalNode(node.bNode, at);
    if (node.op === '+' && 'v' in a && 'v' in b) return { v: [a.v[0] + b.v[0], a.v[1] + b.v[1]] };
    if (node.op === '*' && 'm' in a && 'v' in b) {
      const e = a.m;
      return { v: [e[0] * b.v[0] + e[2] * b.v[1], e[1] * b.v[0] + e[3] * b.v[1]] };
    }
    if (node.op === '*' && 'v' in a && 'v' in b) return { v: [a.v[0] * b.v[0], a.v[1] * b.v[1]] };
    throw new Error(`unexpected operator ${node.op}`);
  }
  if (node?.isConstNode && node.value?.isVector2) return { v: [node.value.x, node.value.y] };
  if (node?.isConstNode && node.value?.isMatrix2) return { m: [...node.value.elements] };
  if (typeof node?.getAttributeName === 'function' && node.getAttributeName() === 'uv') return { v: at };
  throw new Error(`unexpected node ${node?.type ?? typeof node}`);
}
function sampleAt(node: TslNode, at: P): P {
  const r = evalNode(node, at);
  if (!('v' in r)) throw new Error('not a vec2');
  return r.v;
}
const close = (a: P, b: P, tol = 1e-12) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

describe('no turn emits nothing', () => {
  const variants: Record<string, Record<string, unknown>> = {
    plain: {},
    gltf: { orientation: 'gltf' },
    flips: { flipX: 1, flipY: 1, tileX: 2, offsetY: 0.5 },
    legacy: { orientation: 'gltf', xfRotation: 0.4, xfScaleX: 2, xfScaleY: 0.5 },
  };
  const XF_JUNK: unknown[] = ['1', '0.5', 'abc', '', true, null, NaN, Infinity, -Infinity, 2e6, -2e6];
  const NO_TURN: unknown[] = [0, -0, TAU, -TAU, 2 * TAU, 3 * TAU, 1e-13, TAU - 1e-13, { toString: 1 }, Symbol('r'), [], {}];

  it('junk, a whole number of turns and float dust emit the bytes of no key at all', () => {
    const moved: string[] = [];
    for (const [name, extra] of Object.entries(variants)) {
      const base = codeOf(imageGraph(extra));
      [...XF_JUNK, ...NO_TURN].forEach((rotation, i) => {
        if (codeOf(imageGraph({ ...extra, rotation })) !== base) moved.push(`${name} rotation #${i} (${typeof rotation})`);
      });
    }
    expect(moved).toEqual([]);
  });
});

describe('the turn: ONE numbers-only mat2, after the offset', () => {
  it('wraps exactly the unturned chain, and pins the centre with one vec2', () => {
    const extra = { flipY: 1, tileX: 2, tileY: 3, offsetX: 0.25, offsetY: 0.5 };
    const unturned = uvExprOf(codeOf(imageGraph(extra)));
    const code = codeOf(imageGraph({ ...extra, rotation: 0.4 }));
    const expr = uvExprOf(code);
    const m = /^mat2\(([^()]*)\)\.mul\((.*)\)\.add\(vec2\(([^()]*)\)\)$/.exec(expr);
    expect(m, expr).not.toBeNull();
    expect(m![2]).toBe(unturned);
    expect(unturned.endsWith('.add(vec2(0.25, 0.5))')).toBe(true);
    expect(expr.split('mat2(').length - 1).toBe(1);
    for (const arg of [...m![1].split(','), ...m![3].split(',')]) {
      const a = arg.trim();
      expect(a !== '' && Number.isFinite(Number(a)), a).toBe(true);
    }
    expect(importLine(code)).toMatch(/\bmat2\b/);
    expect(importLine(code)).toMatch(/\bvec2\b/);
  });

  it('a wired Tile socket stays inside the turn, as a reference; the matrix stays numbers', () => {
    const g = imageGraph({ rotation: 0.4 });
    g.nodes.push(makeNode('f1', 'float', { value: 3 }));
    g.edges.push(makeEdge('f1', 'out', 'img1', 'tileX'));
    const expr = uvExprOf(codeOf(g));
    const m = /^mat2\(([^()]*)\)\.mul\((.*)\)\.add\(vec2\(([^()]*)\)\)$/.exec(expr);
    expect(m, expr).not.toBeNull();
    const ref = /\.mul\(vec2\(([A-Za-z_$][\w$]*), 1\)\)$/.exec(m![2]);
    expect(ref, m![2]).not.toBeNull();
    expect(codeOf(g)).toContain(`const ${ref![1]} = `);
    for (const a of m![1].split(',')) expect(Number.isFinite(Number(a.trim()))).toBe(true);
  });

  it('turns a residue\'s legacy stage too: the legacy mat2 inside, the turn outside', () => {
    // An unflipped glTF node turns by ψ = θ, so +90° is KHR's own quarter turn.
    const expr = uvExprOf(codeOf(imageGraph({ orientation: 'gltf', xfRotation: Math.PI / 2, rotation: Math.PI / 2 })));
    expect(expr).toBe('mat2(0, 1, -1, 0).mul(mat2(0, 1, -1, 0).mul(uv())).add(vec2(0, 1))');
  });

  it('is skipped when Direction is wired: the bytes of the unturned node', () => {
    const wire = (extra: Record<string, unknown>) => {
      const g = imageGraph(extra);
      g.nodes.push(makeNode('d1', 'vec3', { x: 0, y: 1, z: 0 }));
      g.edges.push(makeEdge('d1', 'out', 'img1', 'dir'));
      return codeOf(g);
    };
    const turned = wire({ tileX: 2, rotation: 0.4 });
    expect(turned).toBe(wire({ tileX: 2 }));
    expect(uvExprOf(turned)).toMatch(/^equirectUV\(\w+\)$/);
    expect(turned).not.toContain('mat2');
  });

  it('a forged `rotation` EDGE emits nothing: the turn is stored only', () => {
    const forged = (extra: Record<string, unknown>) => {
      const g = imageGraph(extra);
      g.nodes.push(makeNode('f1', 'float', { value: 1.2 }));
      g.edges.push(makeEdge('f1', 'out', 'img1', 'rotation'));
      return codeOf(g);
    };
    expect(uvExprOf(forged({}))).toBe(uvExprOf(codeOf(imageGraph())));
    expect(forged({})).not.toContain('mat2');
    // A stored turn still applies, untouched by the wire.
    expect(uvExprOf(forged({ rotation: 0.4 }))).toBe(uvExprOf(codeOf(imageGraph({ rotation: 0.4 }))));
  });

  it('stays INSIDE the one sample, so Apply drops the image line exactly as before and mints nothing', () => {
    // The Image node is one-way through codeToGraph: the whole `texture(…)`
    // line is unrepresentable. A turn that left the sample (a body line of its
    // own, a module-scope matrix) would be parsed into nodes on every Apply.
    const typesAfterApply = (extra: Record<string, unknown>) => {
      const g = imageGraph(extra);
      g.nodes.push(makeNode('m1', 'mul'));
      g.edges = [makeEdge('img1', 'out', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'color')];
      const parsed = codeToGraph(codeOf(g));
      return { types: parsed.nodes.map((n) => n.data.registryType), errors: parsed.errors.map((e) => e.severity) };
    };
    const plain = typesAfterApply({});
    expect(typesAfterApply({ rotation: 0.4, tileX: 2, offsetY: 0.5 })).toEqual(plain);
    expect(typesAfterApply({ orientation: 'gltf', xfRotation: 1, rotation: 0.4 })).toEqual(plain);
    expect(plain.errors).toEqual(['warning']);
  });

  it('never splits a shared texture', () => {
    const two = (b: Record<string, unknown>) => {
      const nodes = [img('img1'), img('img2', b), makeNode('m1', 'mul'), makeNode('out1', 'output')];
      const edges = [makeEdge('img1', 'out', 'm1', 'a'), makeEdge('img2', 'out', 'm1', 'b'), makeEdge('m1', 'out', 'out1', 'color')];
      return graphToCode(nodes, edges).code;
    };
    for (const b of [{ rotation: 0.4 }, { rotation: Math.PI, flipX: 1 }, { rotation: -1, tileX: 3 }]) {
      const c = two(b);
      expect(c.split('new globalThis.THREE.Texture(').length - 1, JSON.stringify(b)).toBe(1);
      expect(c.split('new Image()').length - 1).toBe(1);
      expect(c).toContain('mat2(');
    }
  });
});

// ── a SCALAR wired into UV, under the turn, built by real three's GLSL builder ──
// `mat2.mul(float)` is a mat2 in TSL (OperatorNode: matrix × scalar = matrix),
// so a turn applied straight to a scalar UV built `mat2 + vec2`, which neither
// GLSL nor WGSL compiles — the preview showed an error and the export was
// broken, where the unturned node samples (x, x) on WebGPU. The headless
// builder is the stub-renderer harness splatRouteW.test.ts uses.

function stubRenderer(): Record<string, unknown> {
  return {
    contextNode: T.context(),
    library: { fromMaterial: (m: unknown) => m },
    backend: {
      isWebGLBackend: true, isWebGPUBackend: false,
      capabilities: { getUniformBufferLimit: () => 65536 },
      extensions: { has: () => false }, has: () => false, get: () => ({}),
    },
    getRenderTarget: () => null, getMRT: () => null,
    debug: { diagnostics: { keywords: false } },
    lighting: { enabled: false },
    _currentRenderContext: null,
  };
}

/** The GLSL fragment shader real three builds for `texture(tex, uvNode).rgb`. */
function glslFragment(uvNode: TslNode): string {
  const W = THREE as unknown as Record<string, TslNode>;
  const material = new W.MeshBasicNodeMaterial();
  material.colorNode = T.texture(new THREE.Texture(), uvNode).rgb;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  const builder = new W.GLSLNodeBuilder(mesh, stubRenderer());
  Object.assign(builder, {
    scene: new THREE.Scene(), material, camera: new THREE.PerspectiveCamera(),
    lightsNode: null, environmentNode: null, fogNode: null, clippingContext: null,
  });
  builder.build();
  return builder.fragmentShader as string;
}

describe('a scalar wired into UV keeps compiling under the turn', () => {
  /** An Image node fed by `src` on its UV socket. */
  function wiredUv(extra: Record<string, unknown>, src: AppNode): { nodes: AppNode[]; edges: AppEdge[] } {
    const g = imageGraph(extra);
    g.nodes.push(src);
    g.edges.push(makeEdge(src.id, 'out', 'img1', 'uv'));
    return g;
  }
  const float03 = () => makeNode('f1', 'float', { value: 0.3 });
  /** The variable graphToCode gave the Float node (`const <ref> = float(…)`). */
  const floatRef = (code: string) => {
    const m = /const (\w+) = float\(/.exec(code);
    expect(m, code).not.toBeNull();
    return m![1];
  };

  it('a turn with no stage before it widens the wired reference to vec2 — an unflipped photo or glTF texture', () => {
    for (const state of [{}, { orientation: 'gltf' }]) {
      const code = codeOf(wiredUv({ ...state, rotation: Math.PI / 6 }, float03()));
      const ref = floatRef(code);
      expect(uvExprOf(code), JSON.stringify(state)).toMatch(
        new RegExp(`^mat2\\([^()]*\\)\\.mul\\(vec2\\(${ref}\\)\\)\\.add\\(vec2\\([^()]*\\)\\)$`),
      );
    }
    const timed = wiredUv({ rotation: Math.PI / 6 }, makeNode('t1', 'time'));
    expect(uvExprOf(codeOf(timed))).toMatch(/^mat2\([^()]*\)\.mul\(vec2\(\w+\)\)\.add\(vec2\([^()]*\)\)$/);
  });

  it('…and only then: unturned, or after a stage that already made it a vec2, the bytes are untouched', () => {
    // No turn: the bare reference, exactly as before the turn existed.
    for (const state of [{}, { orientation: 'gltf' }]) {
      const plain = codeOf(wiredUv(state, float03()));
      expect(uvExprOf(plain), JSON.stringify(state)).toBe(floatRef(plain));
    }
    // A mirror stage before the turn: `x.mul(vec2(…))` is already a vec2.
    const mirrored = codeOf(wiredUv({ orientation: 'gltf', flipX: 1, rotation: Math.PI / 6 }, float03()));
    expect(mirrored).not.toContain(`vec2(${floatRef(mirrored)})`);
    expect(uvExprOf(mirrored)).toMatch(new RegExp(`^mat2\\([^()]*\\)\\.mul\\(${floatRef(mirrored)}\\.mul\\(vec2\\(-1, 1\\)\\)`));
  });

  it('Apply still drops the whole image line and mints nothing for the widening', () => {
    const typesAfterApply = (extra: Record<string, unknown>) => {
      const g = wiredUv(extra, float03());
      g.nodes.push(makeNode('m1', 'mul'));
      g.edges = [makeEdge('f1', 'out', 'img1', 'uv'), makeEdge('img1', 'out', 'm1', 'a'), makeEdge('m1', 'out', 'out1', 'color')];
      const parsed = codeToGraph(codeOf(g));
      return { types: parsed.nodes.map((n) => n.data.registryType).sort(), errors: parsed.errors.map((e) => e.severity) };
    };
    const unturned = typesAfterApply({ orientation: 'gltf' });
    expect(typesAfterApply({ orientation: 'gltf', rotation: Math.PI / 6 })).toEqual(unturned);
    expect(unturned.types).not.toContain('vec2');
  });

  it('builds through real three: the matrix multiplies a vec2, never a scalar into a mat2', () => {
    const code = codeOf(wiredUv({ orientation: 'gltf', rotation: Math.PI / 6 }, float03()));
    const expr = uvExprOf(code);
    const node = new Function('mat2', 'vec2', floatRef(code), `return ${expr};`)(T.mat2, T.vec2, T.float(0.3));
    const fs = glslFragment(node);
    expect(fs).toMatch(/mat2\([^()]*\) \* vec2\( 0\.3 \)/);
    // What the unwidened emission built: `( 0.3 * mat2( … ) ) + vec2( … )`.
    expect(fs).not.toMatch(/\* mat2\(/);
    const unwidened = T.mat2(1, 0, 0, 1).mul(T.float(0.3)).add(T.vec2(0, 0));
    expect(glslFragment(unwidened), 'the harness sees the defect').toMatch(/\* mat2\(/);
  });
});

describe('what the turn MEANS, evaluated by real three', () => {
  it('example 3: an app-orientation photo turned +90° samples (v, 1 − u) — inside the picture', () => {
    const expr = uvExprOf(codeOf(imageGraph({ repeat: 0, rotation: Math.PI / 2 })));
    expect(expr).toBe('mat2(0, 1, -1, 0).mul(uv()).add(vec2(0, 1))');
    const node = buildEmitted(expr);
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const u: P = [i / 10, j / 10];
        const w = sampleAt(node, u);
        expect(close(w, [u[1], 1 - u[0]]), `${u}`).toBe(true);
        // Repeat is off: every sample stays inside the picture.
        expect(w[0] >= 0 && w[0] <= 1 && w[1] >= 0 && w[1] <= 1).toBe(true);
      }
    }
    // On three's primitives the screen runs with the uvs (u right, v up). The
    // picture's top-centre, (0.5, 1), sits at screen (0.5, 1) unturned — the
    // picture as stored, nothing mirrored — and at (0, 0.5) turned: top to
    // left, a COUNTER-clockwise quarter turn, as three.js's Texture.rotation turns.
    const unturned = buildEmitted(uvExprOf(codeOf(imageGraph({ repeat: 0 }))));
    expect(uvExprOf(codeOf(imageGraph({ repeat: 0 })))).toBe('uv()');
    expect(close(sampleAt(unturned, [0.5, 1]), [0.5, 1])).toBe(true);
    // …and its right-centre (1, 0.5) is on the RIGHT: the picture reads the
    // right way round, not mirrored.
    expect(close(sampleAt(unturned, [1, 0.5]), [1, 0.5])).toBe(true);
    expect(close(sampleAt(node, [0, 0.5]), [0.5, 1])).toBe(true);
  });

  // Screen point S (X right, Y up, the view centred on the picture) → uv, for
  // the three kinds of UV a preview shows, and the way a POSITIVE turn reads on
  // each — the frames real Chrome showed, every front-facing triangle
  // measured. On screen the sense is θ·sign(det uv→screen)·sign(tileX·tileY):
  // ψ's sign factor cancels the mirror's determinant, so the orientation and
  // the Flips never change it, and no sign rule could make every shape read
  // one way. The sign is three.js's (`Texture.rotation`, counter-clockwise on
  // its own primitives) and glTF's (KHR `rotation`, clockwise as seen on a
  // v-down model).
  const FRAMES: Record<string, { uvOf: (s: P) => P; ccw: boolean }> = {
    // three's primitives run u right and v up — so a dropped picture, sampled
    // as stored, reads the right way round on them at 0°.
    'Sphere/Plane/Cube/Teapot (u right, v up)': { uvOf: (s) => [s[0], s[1]], ccw: true },
    // fit-bounds' generated spherical UVs ARE three's SphereGeometry uv since
    // 2026-10-08 (previewFitBounds.test.ts pins it): u right, v up at the front.
    // They ran u LEFT before, which is why the app once baked a 1-u in.
    'Stanford Bunny / an OBJ without UVs (spherical: u right, v up)': { uvOf: (s) => [s[0], s[1]], ccw: true },
    // A glTF model's UVs run v DOWN: its texture is stored top-down.
    'glTF model (u right, v down)': { uvOf: (s) => [s[0], 1 - s[1]], ccw: false },
  };
  /** Whether `state`'s unturned picture reads MIRRORED through `uvOf`: the
   *  picture's own right (u + δ in its texel space) must show to the right of
   *  its left, its up above its down. Flips excluded, this is the 0° look. */
  function readsMirrored(state: Record<string, unknown>, uvOf: (s: P) => P): boolean {
    const base = buildEmitted(uvExprOf(codeOf(imageGraph(state))));
    // The texel frame: w is (u, v) for a picture uploaded flipY (app), (u, 1 − v)
    // for a glTF texture stored top-down; either way "up" in the picture is +v
    // after the upload, so screen-right must raise w.x and screen-up raise the
    // picture's up.
    const gltf = state.orientation === 'gltf';
    const pic = (s: P): P => {
      const w = sampleAt(base, uvOf(s));
      return gltf ? [w[0], 1 - w[1]] : w;
    };
    const o = pic([0.5, 0.5]);
    const r = pic([0.6, 0.5]);
    const u = pic([0.5, 0.6]);
    const det = (r[0] - o[0]) * (u[1] - o[1]) - (r[1] - o[1]) * (u[0] - o[0]);
    return det < 0;
  }
  const STATES: Record<string, unknown>[] = [false, true].flatMap((gltf) =>
    [0, 1].flatMap((flipX) => [0, 1].map((flipY) => ({ ...(gltf ? { orientation: 'gltf' } : {}), flipX, flipY }))),
  );
  const THETA = 0.7;
  /** `state`'s emitted chain, unturned and turned by +THETA, built by real three. */
  const pairOf = (state: Record<string, unknown>) => ({
    base: buildEmitted(uvExprOf(codeOf(imageGraph(state)))),
    turned: buildEmitted(uvExprOf(codeOf(imageGraph({ ...state, rotation: THETA })))),
  });
  /** Whether the turn moves the picture's content counter-clockwise (`ccw`) or
   *  clockwise about the centre, seen through `uvOf`: the content at S must
   *  show at S turned by ±THETA. */
  function turnsAs(pair: { base: TslNode; turned: TslNode }, uvOf: (s: P) => P, ccw: boolean): boolean {
    const a = ccw ? THETA : -THETA;
    const turn = (s: P): P => {
      const [x, y] = [s[0] - 0.5, s[1] - 0.5];
      return [x * Math.cos(a) - y * Math.sin(a) + 0.5, x * Math.sin(a) + y * Math.cos(a) + 0.5];
    };
    for (let k = 0; k < 50; k++) {
      const s: P = [((k * 37) % 50) / 50, ((k * 11) % 50) / 50];
      if (!close(sampleAt(pair.turned, uvOf(turn(s))), sampleAt(pair.base, uvOf(s)), 1e-9)) return false;
    }
    return true;
  }

  it('a positive turn goes ONE way per shape, in all 8 orientation × flip states: counter-clockwise on three’s primitives and the Bunny, clockwise on a glTF model', () => {
    const wrong: string[] = [];
    for (const state of STATES) {
      const pair = pairOf(state);
      for (const [name, { uvOf, ccw }] of Object.entries(FRAMES)) {
        // Both senses are checked, so a reversed ψ fails every one of the 24.
        if (!turnsAs(pair, uvOf, ccw) || turnsAs(pair, uvOf, !ccw)) wrong.push(`${JSON.stringify(state)} ${name}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('at 0° with no Flip ticked a picture reads the RIGHT WAY ROUND on the UVs it is meant for; one ticked Flip mirrors it', () => {
    // An app-orientation photo on three's primitives and on the generated
    // spherical UVs; a glTF texture on its model's v-down UVs. Until
    // 2026-10-08 the app's baked 1-u read MIRRORED on every primitive.
    const home: Record<'app' | 'gltf', string[]> = {
      app: ['Sphere/Plane/Cube/Teapot (u right, v up)', 'Stanford Bunny / an OBJ without UVs (spherical: u right, v up)'],
      gltf: ['glTF model (u right, v down)'],
    };
    const wrong: string[] = [];
    for (const state of STATES) {
      const flips = Number(state.flipX) + Number(state.flipY);
      for (const name of home[state.orientation === 'gltf' ? 'gltf' : 'app']) {
        if (readsMirrored(state, FRAMES[name].uvOf) !== (flips === 1)) wrong.push(`${JSON.stringify(state)} ${name}`);
      }
    }
    expect(wrong).toEqual([]);
    // Not vacuous: the check sees a mirror where there is one.
    expect(readsMirrored({}, (s) => [1 - s[0], s[1]])).toBe(true);
  });

  it('the two orientations differ ONLY by Texture.flipY: glTF(fx, fy, K, ox, oy, θ) ≡ app(fx, ¬fy, K, ox, 1 − ky − oy, θ)', () => {
    // A glTF texture is uploaded unflipped, so its texel at w is the picture's
    // (w.x, 1 − w.y): one top-to-bottom mirror, which toggling Flip Y (with
    // Offset Y reflected) undoes — the Flip X box and the Rotation number are
    // the same in both.
    const rnd = lcg(0x0f11);
    for (let i = 0; i < 200; i++) {
      const flipX = i % 2;
      const flipY = (i >> 1) % 2;
      const tileX = rnd() * 6 - 3;
      const tileY = rnd() * 6 - 3;
      const offsetX = rnd() * 2 - 1;
      const offsetY = rnd() * 2 - 1;
      const rotation = i < 8 ? 0 : rnd() * 14 - 7;
      const g = { orientation: 'gltf', flipX, flipY, tileX, tileY, offsetX, offsetY, rotation };
      const a = { flipX, flipY: 1 - flipY, tileX, tileY, offsetX, offsetY: 1 - tileY - offsetY, rotation };
      const gn = buildEmitted(uvExprOf(codeOf(imageGraph(g))));
      const an = buildEmitted(uvExprOf(codeOf(imageGraph(a))));
      const tol = 1e-12 * Math.max(1, Math.abs(tileX), Math.abs(tileY), Math.abs(offsetX), Math.abs(offsetY));
      for (const u of POINTS) {
        const w = sampleAt(gn, u);
        expect(close([w[0], 1 - w[1]], sampleAt(an, u), tol), JSON.stringify(g)).toBe(true);
      }
    }
  });

  it('a negative Tile on exactly ONE axis mirrors once more and reverses it; on both axes it does not', () => {
    // The offset keeps the screen centre on the picture's centre, so each tile
    // is a pure scale or mirror about it and the turn stays a rotation there.
    const tiles: [number, number, boolean][] = [[-1, 1, true], [1, -1, true], [-2, 2, true], [-1, -1, false], [2, 2, false]];
    const wrong: string[] = [];
    for (const state of STATES) {
      for (const [kx, ky, reversed] of tiles) {
        const placed = { ...state, tileX: kx, tileY: ky, offsetX: (1 - kx) / 2, offsetY: (1 - ky) / 2 };
        const pair = pairOf(placed);
        for (const [name, { uvOf, ccw }] of Object.entries(FRAMES)) {
          const sense = reversed ? !ccw : ccw;
          if (!turnsAs(pair, uvOf, sense) || turnsAs(pair, uvOf, !sense)) wrong.push(`${JSON.stringify(placed)} ${name}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('placementAt — the fold\'s recheck — is what the emitted code computes', () => {
    let seed = 0x1234;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 8) / 16777216;
    };
    for (let i = 0; i < 150; i++) {
      const v: Record<string, string | number> = {
        flipX: rnd() < 0.5 ? 1 : 0, flipY: rnd() < 0.5 ? 1 : 0,
        tileX: rnd() * 6 - 3, tileY: rnd() * 6 - 3, offsetX: rnd() * 2 - 1, offsetY: rnd() * 2 - 1,
        rotation: rnd() * 14 - 7,
      };
      if (rnd() < 0.5) v.orientation = 'gltf';
      if (rnd() < 0.5) Object.assign(v, { xfRotation: rnd() * 7, xfScaleX: rnd() * 4 - 2, xfOffsetY: rnd() - 0.5 });
      const node = buildEmitted(uvExprOf(codeOf(imageGraph(v))));
      const p = readImagePlacement(v);
      for (const u of [[0, 0], [1, 0], [0, 1], [0.3, 0.6]] as P[]) {
        expect(close(sampleAt(node, u), placementAt(p, u[0], u[1]), 1e-12), JSON.stringify(v)).toBe(true);
      }
    }
  });
});

describe('a restored legacy node draws what it drew, through the real emitter', () => {
  it('folded or left as residue, on 300 random legacy nodes', () => {
    let seed = 0xbeef;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 8) / 16777216;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    let folded = 0;
    for (let i = 0; i < 300; i++) {
      const v: Record<string, string | number> = {
        flipX: pick([0, 1]), flipY: pick([0, 1]),
        tileX: pick([1, 2, -1, rnd() * 6 - 3]), offsetX: pick([0, rnd() * 2 - 1]), offsetY: pick([0, rnd() * 2 - 1]),
        xfRotation: pick([0, Math.PI / 2, Math.PI, rnd() * 14 - 7]), xfScaleX: pick([1, 2, rnd() * 4 - 2]),
        xfScaleY: pick([1, 0.5, rnd() * 4 - 2]), xfOffsetX: pick([0, rnd() - 0.5]), xfOffsetY: pick([0, rnd() - 0.5]),
      };
      if (rnd() < 0.5) v.orientation = 'gltf';
      v.tileY = pick([v.tileX as number, -(v.tileX as number), 1]);
      if (rnd() < 0.3) v.rotation = rnd() * 14 - 7;
      const g = imageGraph(v);
      const before = codeOf(g);
      const restored = sanitizeImageNodes(g.nodes, g.edges, false).nodes;
      const after = graphToCode(restored, g.edges).code;
      if (readImageUvMapping(getNodeValues(restored[0])).transform) {
        // Residue: the very same module.
        expect(after).toBe(before);
        continue;
      }
      folded++;
      const was = buildEmitted(uvExprOf(before));
      const now = buildEmitted(uvExprOf(after));
      const tol = 1e-9 * Math.max(1, Math.abs(v.tileX as number), Math.abs(v.tileY as number));
      for (const u of [[0, 0], [1, 0], [0, 1], [0.37, 0.81], [-1.5, 2.25]] as P[]) {
        expect(close(sampleAt(now, u), sampleAt(was, u), tol), `${JSON.stringify(v)} at ${u}`).toBe(true);
      }
    }
    expect(folded).toBeGreaterThan(150);
  });
});

// ── a model's KHR_texture_transform: import → node → export ───────────────
// gltfTextureValues writes it as the node's own Tile/Offset/Rotation;
// composeKhrTextureTransform reads the node back through the emitter's reader.
// Both are held to the Khronos REFERENCE below, never to each other alone.

type Khr = { offset?: [number, number]; rotation?: number; scale?: [number, number] };
const NO_WIRES = { tileX: false, tileY: false, offsetX: false, offsetY: false };

/** KHR_texture_transform as the Khronos reference applies it — T·R·S, rows
 *  (cos, sin), (−sin, cos) — in exact arithmetic, nothing snapped. */
function khrAt(k: Khr | null, u: P): P {
  const [sx, sy] = k?.scale ?? [1, 1];
  const [tx, ty] = k?.offset ?? [0, 0];
  const r = k?.rotation ?? 0;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx * u[0] + s * sy * u[1] + tx, -s * sx * u[0] + c * sy * u[1] + ty];
}
const imported = (k: Khr) => gltfTextureValues({ extensions: { KHR_texture_transform: k } }, { normalGreenFlip: false }).values;
/** What the importer wrote before: the raw numbers as `xf*` keys, defaults left out. */
function legacyKeys(k: Khr): Record<string, string | number> {
  const v: Record<string, string | number> = { orientation: 'gltf' };
  const put = (key: string, n: number | undefined, dflt: number) => {
    if (n !== undefined && n !== dflt) v[key] = n;
  };
  put('xfOffsetX', k.offset?.[0], 0);
  put('xfOffsetY', k.offset?.[1], 0);
  put('xfRotation', k.rotation, 0);
  put('xfScaleX', k.scale?.[0], 1);
  put('xfScaleY', k.scale?.[1], 1);
  return v;
}
/** Two angles equal mod 2π. */
const sameAngle = (a: number, b: number, tol: number) => {
  const d = Math.abs((a - b) % TAU);
  return Math.min(d, TAU - d) <= tol;
};
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s >>> 8) / 16777216;
  };
}
/** A random transform as a file might carry it: any part may be missing. */
function randomKhr(rnd: () => number): Khr {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const k: Khr = {};
  if (rnd() < 0.8) k.offset = [rnd() * 4 - 2, rnd() * 4 - 2];
  if (rnd() < 0.8) k.rotation = pick([Math.PI / 2, Math.PI, -Math.PI / 2, 3 * Math.PI / 2, rnd() * 14 - 7, rnd() * 14 - 7]);
  if (rnd() < 0.8) {
    const sx = pick([1, 2, 0.5, rnd() * 6 - 3]);
    k.scale = [sx, pick([sx, -sx, 1, rnd() * 6 - 3])];
  }
  return k;
}
const magnitude = (k: Khr) => Math.max(1, ...(k.scale ?? [1, 1]).map(Math.abs), ...(k.offset ?? [0, 0]).map(Math.abs));
const POINTS: P[] = [[0, 0], [1, 0], [0, 1], [0.5, 0.5], [0.37, 0.81], [-1.5, 2.25]];

describe('a model\'s KHR_texture_transform: import → node → export', () => {
  it('the spec\'s example 1 — KHR {30°, (2, 1), (0.1, 0.2)} — draws what KHR draws, and exports back exactly', () => {
    const k: Khr = { rotation: Math.PI / 6, scale: [2, 1], offset: [0.1, 0.2] };
    const values = imported(k);
    // The file's own number: Rotation +30°, Tile 2×1, the offset carrying the pivot term.
    expect(values.rotation).toBe(Math.PI / 6);
    expect([values.tileX, values.tileY ?? 1]).toEqual([2, 1]);
    expect(values.offsetX as number).toBeCloseTo(0.30359, 5);
    expect(values.offsetY as number).toBeCloseTo(0.040192, 6);
    const node = buildEmitted(uvExprOf(codeOf(imageGraph(values))));
    for (const u of POINTS) expect(close(sampleAt(node, u), khrAt(k, u), 1e-12), `${u}`).toBe(true);
    expect(sampleAt(node, [1, 0])[0]).toBeCloseTo(1.832051, 6);
    expect(sampleAt(node, [1, 0])[1]).toBeCloseTo(-0.8, 12);

    const back = composeKhrTextureTransform(values, NO_WIRES);
    expect(back.exact).toBe(true);
    expect(back.transform!.scale).toEqual([2, 1]);
    expect(Math.abs(back.transform!.rotation! - Math.PI / 6)).toBeLessThanOrEqual(1e-15);
    expect(Math.abs(back.transform!.offset![0] - 0.1)).toBeLessThanOrEqual(1e-15);
    expect(Math.abs(back.transform!.offset![1] - 0.2)).toBeLessThanOrEqual(1e-15);

    // Flip X ticked: the mirror becomes a signed scale, still exact, still the shader's map.
    const flipped = { ...values, flipX: 1 };
    const f = composeKhrTextureTransform(flipped, NO_WIRES);
    expect(f.exact).toBe(true);
    expect(f.transform!.scale).toEqual([-2, 1]);
    const fnode = buildEmitted(uvExprOf(codeOf(imageGraph(flipped))));
    for (const u of POINTS) expect(close(sampleAt(fnode, u), khrAt(f.transform, u), 1e-12), `${u}`).toBe(true);
  });

  it('2,000 random transforms draw what KHR draws, write no negative Tile, and export back within 1e-12', () => {
    const rnd = lcg(0x4b4852);
    let negative = 0;
    for (let i = 0; i < 2000; i++) {
      const k = randomKhr(rnd);
      const values = imported(k);
      const tol = 1e-12 * magnitude(k);
      // A negative scale is that axis's Flip, ticked, with tile |s| — never a
      // negative Tile — and the turn re-signed so the chain still turns by φ.
      const [sx, sy] = k.scale ?? [1, 1];
      expect([values.flipX === 1, values.flipY === 1], JSON.stringify(k)).toEqual([sx < 0, sy < 0]);
      expect(Number(values.tileX ?? 1) >= 0 && Number(values.tileY ?? 1) >= 0, JSON.stringify(values)).toBe(true);
      if (sx < 0 || sy < 0) negative++;
      const p0 = readImagePlacement(values);
      expect(sameAngle(p0.psi, k.rotation ?? 0, 1e-12), JSON.stringify(k)).toBe(true);
      // The chain on the CPU (placementAt — the emitter's map, pinned against
      // real three above); the first 200 through the emitted code and real three.
      const p = readImagePlacement(values);
      for (const u of POINTS) expect(close(placementAt(p, u[0], u[1]), khrAt(k, u), tol), JSON.stringify(k)).toBe(true);
      if (i < 200) {
        const node = buildEmitted(uvExprOf(codeOf(imageGraph(values))));
        for (const u of POINTS) expect(close(sampleAt(node, u), khrAt(k, u), tol), JSON.stringify(k)).toBe(true);
      }
      const back = composeKhrTextureTransform(values, NO_WIRES);
      expect(back.exact, JSON.stringify(k)).toBe(true);
      expect(back.transform?.scale ?? [1, 1], JSON.stringify(k)).toEqual(k.scale ?? [1, 1]);
      expect(close((back.transform?.offset ?? [0, 0]) as P, k.offset ?? [0, 0], tol), JSON.stringify(k)).toBe(true);
      expect(sameAngle(back.transform?.rotation ?? 0, k.rotation ?? 0, 1e-12), JSON.stringify(k)).toBe(true);
    }
    // Not vacuous: plenty of the files carried a negative scale.
    expect(negative).toBeGreaterThan(300);
  });

  it('an import is EXACTLY the restore fold of the same transform stored as legacy keys', () => {
    // Two writers of one placement: the importer now, the fold for every file
    // saved before it. They must agree to the bit, or the same model would
    // look subtly different depending on when it was imported.
    const rnd = lcg(0xf01d);
    for (let i = 0; i < 2000; i++) {
      const k = randomKhr(rnd);
      const folded = foldLegacyUvTransform(legacyKeys(k), false);
      expect(readImagePlacement(folded), JSON.stringify(k)).toEqual(readImagePlacement(imported(k)));
    }
  });

  it('an unrotated import emits the very bytes the legacy import did — float dust included — unless a scale is negative', () => {
    const cases: Khr[] = [
      { offset: [0.25, 0], scale: [2, 2] },
      { offset: [1e-13, 0.5], scale: [2 + 1e-13, -0] },
      { offset: [0.5 + 1e-13, -3] },
      { scale: [0, 3] },
      { offset: [0.1, 0.2], rotation: 2 * Math.PI },
      { scale: [1.5, 1], rotation: -4 * Math.PI },
      { rotation: 0 },
      { offset: [0.25, 0.5], scale: [-2, 3] },
    ];
    const rnd = lcg(0xb17e5);
    for (let i = 0; i < 200; i++) {
      const k = randomKhr(rnd);
      delete k.rotation;
      cases.push(k);
    }
    let flipped = 0;
    for (const k of cases) {
      const values = imported(k);
      const legacy = codeOf(imageGraph(legacyKeys(k)));
      if (values.flipX === undefined && values.flipY === undefined) {
        expect(codeOf(imageGraph(values)), JSON.stringify(k)).toBe(legacy);
        continue;
      }
      // A negative scale is that axis's Flip now: other text, the same picture.
      flipped++;
      const was = buildEmitted(uvExprOf(legacy));
      const now = buildEmitted(uvExprOf(codeOf(imageGraph(values))));
      for (const u of POINTS) expect(close(sampleAt(now, u), sampleAt(was, u), 1e-12 * magnitude(k)), JSON.stringify(k)).toBe(true);
    }
    expect(flipped).toBeGreaterThan(20);
    expect(uvExprOf(codeOf(imageGraph(imported(cases[0]))))).toBe('uv().mul(vec2(2, 2)).add(vec2(0.25, 0))');
    // (−2u + 0.25, 3v + 0.5) as Flip X (the glTF mirror 1 − u), tile 2 and offset 0.25 − 2.
    expect(imported(cases[7])).toEqual({ orientation: 'gltf', flipX: 1, tileX: 2, tileY: 3, offsetX: -1.75, offsetY: 0.5 });
  });

  it('the export reproduces the chain the shader runs, in every Flip state', () => {
    const rnd = lcg(0xe4b0);
    for (let i = 0; i < 200; i++) {
      const values: Record<string, string | number> = {
        orientation: 'gltf', flipX: i % 2, flipY: (i >> 1) % 2,
        tileX: rnd() * 6 - 3, tileY: rnd() < 0.5 ? 2 : rnd() * 6 - 3, offsetX: rnd() * 2 - 1, offsetY: rnd() * 2 - 1,
        rotation: rnd() * 14 - 7,
      };
      const r = composeKhrTextureTransform(values, NO_WIRES);
      expect(r.exact).toBe(true);
      const node = buildEmitted(uvExprOf(codeOf(imageGraph(values))));
      const tol = 1e-12 * Math.max(1, Math.abs(values.tileX as number), Math.abs(values.tileY as number));
      for (const u of POINTS) expect(close(sampleAt(node, u), khrAt(r.transform, u), tol), JSON.stringify(values)).toBe(true);
    }
  });

  it('a Flip survives export → import: the box comes back ticked, the Tile positive, the Rotation its own number', () => {
    // KHR has no flip, so the export writes a mirrored axis as a NEGATIVE
    // scale (and ψ as the rotation); the import writes that scale back as the
    // box — never as a negative Tile — and re-signs θ by the box, so the
    // number the Rotation row shows comes back as it was.
    const cases: Record<string, string | number>[] = [
      { orientation: 'gltf', flipX: 1, tileX: 2, rotation: Math.PI / 6 },
      { orientation: 'gltf', flipX: 1, tileX: 2, offsetX: 0.30358983848622445, offsetY: 0.04019237886466842, rotation: Math.PI / 6 },
      { orientation: 'gltf', flipY: 1, tileX: 3, tileY: 0.5, offsetY: -0.25, rotation: -1 },
      { orientation: 'gltf', flipX: 1, flipY: 1, tileX: 1.5, tileY: 1.5, rotation: 2 },
    ];
    const rnd = lcg(0xf11b);
    for (let i = 0; i < 400; i++) {
      const tileX = 0.25 + rnd() * 4;
      cases.push({
        orientation: 'gltf', flipX: i % 2, flipY: (i >> 1) % 2,
        tileX, tileY: rnd() < 0.3 ? tileX : 0.25 + rnd() * 4,
        offsetX: rnd() * 4 - 2, offsetY: rnd() * 4 - 2, rotation: rnd() * 12 - 6,
      });
    }
    cases.forEach((v, i) => {
      const out = composeKhrTextureTransform(v, NO_WIRES);
      expect(out.exact, JSON.stringify(v)).toBe(true);
      const back = imported(out.transform ?? {});
      const was = readImagePlacement(v);
      const now = readImagePlacement(back);
      const tol = 1e-12 * Math.max(1, was.tileX, was.tileY, Math.abs(was.offsetX), Math.abs(was.offsetY));
      expect([now.flipX, now.flipY], JSON.stringify(v)).toEqual([was.flipX, was.flipY]);
      expect(Number(back.tileX ?? 1) > 0 && Number(back.tileY ?? 1) > 0, JSON.stringify(back)).toBe(true);
      expect(Math.abs(now.tileX - was.tileX) + Math.abs(now.tileY - was.tileY), JSON.stringify(v)).toBeLessThanOrEqual(tol);
      expect(close([now.offsetX, now.offsetY], [was.offsetX, was.offsetY], tol), JSON.stringify(v)).toBe(true);
      expect(Math.abs(now.theta - was.theta), JSON.stringify(v)).toBeLessThanOrEqual(1e-12);
      // The same picture: the chain on the CPU everywhere, real three for the first few.
      for (const u of POINTS) expect(close(placementAt(now, u[0], u[1]), placementAt(was, u[0], u[1]), tol), JSON.stringify(v)).toBe(true);
      if (i < 40) {
        const a = buildEmitted(uvExprOf(codeOf(imageGraph(v))));
        const b = buildEmitted(uvExprOf(codeOf(imageGraph(back))));
        for (const u of POINTS) expect(close(sampleAt(b, u), sampleAt(a, u), tol), JSON.stringify(v)).toBe(true);
      }
    });
    // Example 1 with Flip X ticked writes scale [−2, 1] and comes back exactly as it went.
    const ex = composeKhrTextureTransform(cases[0], NO_WIRES).transform!;
    expect(ex.scale).toEqual([-2, 1]);
    const back = imported(ex);
    expect([back.flipX, back.tileX, back.rotation]).toEqual([1, 2, Math.PI / 6]);
  });
});
