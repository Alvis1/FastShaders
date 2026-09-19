/**
 * The trusted-side glTF reader (`utils/gltfReader.ts`) and loader 0.8's parse
 * record (`FastShaders.gltfPlugin`, running the REAL r184 GLTFLoader) must
 * agree on the two things an index section is keyed by:
 *
 *   - the model SIGNATURE: the raw material names in `json.materials` order,
 *     '' for an absent or non-string name — `FastShaders.gltfRecord(scene)
 *     .materialNames` (and the `modelSignature` the loader would ask a module to
 *     carry) must equal `readGltfModel(bytes).model.signature.materials`;
 *   - the glTF MATERIAL INDEX of every mesh the reader names with certainty:
 *     `FastShaders.materialIndexOf(obj)` on the loader's Mesh of that name must
 *     be the reader's material (undefined in the loader = null in the reader).
 *
 * The loader runs in `vm` through src/shaderloaderHarness.ts; GLTFLoader needs
 * `self`, `createImageBitmap` and `ProgressEvent` in node, stubbed per test and
 * undone with vi.unstubAllGlobals() (`isolate: false`). Skipped when the served
 * 0.8 copy is absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { Object3D } from 'three';
import { evalLoader, loaderAvailable, type FastShadersApi } from './shaderloaderHarness';
import { GLTF_NODE_GLOBALS, glbBytes, gltfText, materials, parseWith, type GltfSpec } from './gltfTestFixtures';
import { readGltfModel } from './utils/gltfReader';
import { modelSignatureMatches, sanitizeModelSignature } from './engine/materialPartsContract';

const V = '0.8';

beforeEach(() => {
  for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function freshLoader(): FastShadersApi {
  const ev = evalLoader(V, {
    THREE,
    warn: () => {},
    globals: { document: { querySelectorAll: () => [] } },
  });
  if (!ev.FastShaders) throw new Error('0.8 installed no FastShaders api');
  return ev.FastShaders as FastShadersApi;
}

/**
 * A multi-primitive mesh (one primitive without tangents, which GLTFLoader
 * clones), one mesh on two nodes, a primitive with no material, and two
 * materials sharing the name 'Body'.
 */
function specWith(mats: unknown): GltfSpec {
  return {
    materials: mats,
    meshes: [
      { name: 'Multi', primitives: [{ material: 0 }, { material: 1, tangent: true }] },
      { name: 'Shared', primitives: [{ material: 2 }] },
      { primitives: [{}] },
      { name: 'Tail', primitives: [{ material: 3 }] },
    ],
    nodes: [
      { name: 'Multi', mesh: 0 },
      { name: 'A', mesh: 1 },
      { name: 'B', mesh: 1 },
      { mesh: 2 },
      { name: 'Body.001', mesh: 3 },
    ],
  };
}

const VARIANTS: [string, unknown, string[]][] = [
  ["'Body', unnamed, 'Glass', 'Body'", materials(['Body', undefined, 'Glass', 'Body']), ['Body', '', 'Glass', 'Body']],
  ['a numeric name (5) reads as empty on both sides', [{ name: 'Body' }, {}, { name: 5 }, { name: 'Body' }], ['Body', '', '', 'Body']],
];

describe.skipIf(!loaderAvailable(V))('the reader agrees with loader 0.8’s parse record', () => {
  for (const [label, mats, expected] of VARIANTS) {
    for (const kind of ['glb', 'gltf'] as const) {
      it(`${label} (.${kind})`, async () => {
        const spec = specWith(mats);
        const data = kind === 'glb' ? glbBytes(spec) : gltfText(spec);
        const bytes = kind === 'glb' ? new Uint8Array(data as ArrayBuffer) : new TextEncoder().encode(data as string);
        const r = readGltfModel(bytes, kind);
        expect(r.ok, r.ok ? '' : JSON.stringify(r.refusal)).toBe(true);
        if (!r.ok) return;
        expect(r.model.signature.materials).toEqual(expected);

        const FS = freshLoader();
        const gltf = await parseWith([FS.gltfPlugin], data);

        // The signature: the parse record, and what a module must carry.
        expect(FS.gltfRecord(gltf.scene).materialNames).toEqual(r.model.signature.materials);
        const loaderSig = sanitizeModelSignature(FS.modelSignature(gltf));
        expect(loaderSig).not.toBeNull();
        expect(modelSignatureMatches(loaderSig!, r.model.signature)).toBe(true);

        // The index of every certainly-named mesh.
        const byName = new Map<string, Object3D[]>();
        gltf.scene.traverse((o: Object3D) => {
          if (!(o as { isMesh?: boolean }).isMesh) return;
          const list = byName.get(o.name) ?? [];
          list.push(o);
          byName.set(o.name, list);
        });
        let checked = 0;
        for (const sm of r.model.sceneMeshes) {
          if (!sm.certain) continue;
          const objects = byName.get(sm.name) ?? [];
          expect(objects.length, `no loader mesh named ${sm.name}`).toBeGreaterThan(0);
          const indices = objects.map((o) => FS.materialIndexOf(o) ?? null);
          expect(indices, `${sm.name}`).toContain(sm.material);
          checked++;
        }
        expect(checked).toBeGreaterThanOrEqual(5);
      });
    }
  }
});
