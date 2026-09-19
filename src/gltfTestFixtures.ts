/**
 * In-memory glTF / GLB fixtures for the suites that run the REAL r184
 * GLTFLoader under the `node` vitest env (the shaderloader glTF plugin and
 * materialParts suites). Not a test file: it registers no tests.
 *
 * GLTFLoader needs three browser globals in node. `GLTF_NODE_GLOBALS` holds
 * them; a suite stubs them with `vi.stubGlobal` in a beforeEach and MUST undo
 * that with `vi.unstubAllGlobals()` in an afterEach (`isolate: false` shares a
 * worker's globals between files). Node 22 fetches the `data:` buffers itself.
 *
 * Every fixture has ONE buffer: a triangle's positions (accessor 0) and a vec4
 * tangent per vertex (accessor 1), then any extra `blobs` as bufferViews 2, 3, …
 */
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeGlb, TRIANGLE_POSITIONS } from './test-utils';

class ProgressEventStub {
  type: string;
  constructor(type: string, init?: object) {
    this.type = type;
    Object.assign(this, init ?? {});
  }
}

export const GLTF_NODE_GLOBALS: Readonly<Record<string, unknown>> = {
  self: globalThis,
  createImageBitmap: async () => ({}),
  ProgressEvent: ProgressEventStub,
};

const GEOMETRY = (() => {
  const tan = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const out = new Uint8Array(84);
  out.set(TRIANGLE_POSITIONS, 0);
  out.set(new Uint8Array(tan.buffer), 36);
  return out;
})();

export interface GltfPrimitiveSpec {
  material?: number;
  /** Carry a TANGENT attribute (no tangent = GLTFLoader's derivative-tangents clone). */
  tangent?: boolean;
  /** glTF primitive mode; 0 = POINTS. */
  mode?: number;
}

export interface GltfSpec {
  /** The raw `materials` value (usually `materials([...])`; anything, for hostile cases). */
  materials?: unknown;
  meshes: Array<{ name?: string; primitives: GltfPrimitiveSpec[] }>;
  /** Every node goes into scene 0. */
  nodes: Array<{ name?: string; mesh: number }>;
  images?: unknown[];
  /** Extra bytes, appended to the buffer as bufferViews 2, 3, … */
  blobs?: Uint8Array[];
  extras?: unknown;
}

/** `[{ name }, …]`; undefined leaves the name out. */
export function materials(names: Array<string | undefined>): Array<{ name?: string }> {
  return names.map((name) => (name === undefined ? {} : { name }));
}

const pad4 = (n: number) => (n + 3) & ~3;

export function gltfParts(spec: GltfSpec): { json: Record<string, unknown>; bin: Uint8Array } {
  const blobs = spec.blobs ?? [];
  const views: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 48 },
  ];
  let length = GEOMETRY.length;
  for (const b of blobs) {
    const offset = pad4(length);
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.length });
    length = offset + b.length;
  }
  const bin = new Uint8Array(pad4(length));
  bin.set(GEOMETRY, 0);
  blobs.forEach((b, i) => bin.set(b, views[2 + i].byteOffset));
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    meshes: spec.meshes.map((m) => ({
      ...(m.name !== undefined ? { name: m.name } : {}),
      primitives: m.primitives.map((p) => ({
        attributes: p.tangent ? { POSITION: 0, TANGENT: 1 } : { POSITION: 0 },
        ...(p.material !== undefined ? { material: p.material } : {}),
        ...(p.mode !== undefined ? { mode: p.mode } : {}),
      })),
    })),
    nodes: spec.nodes.map((n) => ({ ...(n.name !== undefined ? { name: n.name } : {}), mesh: n.mesh })),
    scenes: [{ nodes: spec.nodes.map((_, i) => i) }],
    scene: 0,
  };
  if (spec.materials !== undefined) json.materials = spec.materials;
  if (spec.images) json.images = spec.images;
  if (spec.extras !== undefined) json.extras = spec.extras;
  return { json, bin };
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** A `.gltf` text, its buffer inlined as a `data:` URI. */
export function gltfText(spec: GltfSpec): string {
  const { json, bin } = gltfParts(spec);
  (json.buffers as Array<Record<string, unknown>>)[0].uri =
    'data:application/octet-stream;base64,' + base64(bin);
  return JSON.stringify(json);
}

/** A `.glb`: the 12-byte header, the JSON chunk (space-padded), the BIN chunk (zero-padded). */
export function glbBytes(spec: GltfSpec): ArrayBuffer {
  const { json, bin } = gltfParts(spec);
  return packGlb(json, bin);
}

/** A `.glb` from a glTF JSON object and its BIN chunk (padded to 4 bytes) —
 *  the shared `makeGlb` container, as the ArrayBuffer GLTFLoader.parse takes. */
export function packGlb(json: object, binBytes: Uint8Array): ArrayBuffer {
  return makeGlb(json, binBytes).buffer;
}

/** GLTFLoader keeps its callbacks on an undeclared field. */
export function pluginCallbacks(loader: GLTFLoader): unknown[] {
  return (loader as unknown as { pluginCallbacks: unknown[] }).pluginCallbacks;
}

/** Parse a fixture with a fresh loader that has `plugins` registered, in order. */
export function parseWith(plugins: unknown[], data: string | ArrayBuffer): Promise<GLTF> {
  const loader = new GLTFLoader();
  for (const p of plugins) loader.register(p as Parameters<GLTFLoader['register']>[0]);
  return loader.parseAsync(data, '');
}
