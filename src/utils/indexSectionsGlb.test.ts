/**
 * Index-section DORMANCY and the DOUBLE CLAIM on real (hand-built) GLB bytes
 * (GLB Phase 5 Step 6). Every model below goes through `createPreviewMesh`, the
 * single constructor the drop, the zip import and the IndexedDB restore share,
 * so these are the facts the Output node really sees — never the sandbox's
 * forgeable inventory.
 *
 * The fixture is P5d's: materials Body, Glass and an unnamed one; meshes Body
 * (material 0), Glass (material 1) and a two-primitive Car (materials 0 and 2,
 * which GLTFLoader names `Car` and `Car_1` — gltfNaming's parity suite pins
 * that against the real loader).
 */
import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge, makeGlb, gltfPrimitiveDoc, TRIANGLE_POSITIONS } from '@/test-utils';
import type { AppNode, OutputMaterial } from '@/types';
import { createPreviewMesh, type PreviewMesh } from './previewMesh';
import { meshToRecord, recordToMesh } from './previewMeshCache';
import {
  outputEdgeIsDormant,
  indexSectionCoverage,
  indexSectionsAwake,
  loadedModelOf,
  outputDormancyFromState,
  outputMaterials,
  pickFreeMesh,
  planNamedParts,
} from './outputMaterials';
import { SIGNATURE_NAME_MAX, SIGNATURE_TOTAL_CHARS_MAX } from '@/engine/materialPartsContract';
import { indexChipTitle } from '@/components/NodeEditor/nodes/sectionLabelText';

const prim = (material?: number) => ({
  attributes: { POSITION: 0 },
  ...(material !== undefined ? { material } : {}),
});

function modelGlb(materials: object[], meshes: { name: string; primitives: object[] }[]): Uint8Array<ArrayBuffer> {
  const doc = gltfPrimitiveDoc({
    materials,
    meshes,
    nodes: meshes.map((_, i) => ({ mesh: i })),
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    scene: 0,
  });
  return makeGlb(doc, TRIANGLE_POSITIONS.slice());
}

const CAR_MESHES = [
  { name: 'Body', primitives: [prim(0)] },
  { name: 'Glass', primitives: [prim(1)] },
  { name: 'Car', primitives: [prim(0), prim(2)] },
];

function loaded(name: string, bytes: Uint8Array): PreviewMesh {
  const r = createPreviewMesh(name, bytes);
  if (!('mesh' in r)) throw new Error('refused: ' + r.error);
  return r.mesh;
}

const CAR = () => loaded('car.glb', modelGlb([{ name: 'Body' }, { name: 'Glass' }, {}], CAR_MESHES));

/** An Output whose added sections are index sections g = 0, 1, 2 (plus any
 *  extra named sections), with the node-level signature. */
function carOutput(extra: OutputMaterial[] = [], signature: string[] = ['Body', 'Glass', '']): AppNode {
  const node = makeNode('o1', 'output');
  const d = node.data as Record<string, unknown>;
  d.materials = [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }, { gltfMaterialIndex: 2 }, ...extra];
  d.modelSignature = { materials: signature };
  return node;
}

const stateOf = (out: AppNode, previewMesh: unknown) => ({
  nodes: [out],
  edges: [],
  previewMesh,
  // The sandbox has not reported (the swap window): index dormancy must not
  // wait for it, because the trusted facts exist the moment the model is.
  previewMeshInventory: null,
});

describe('createPreviewMesh derives the trusted facts', () => {
  it('the signature and the predicted mesh → material map', () => {
    const mesh = CAR();
    expect(mesh.gltf?.signature).toEqual(['Body', 'Glass', '']);
    expect([...mesh.gltf!.meshMaterials].map(([n, e]) => [n, e.materials])).toEqual([
      ['Body', [0]],
      ['Glass', [1]],
      ['Car', [0]],
      ['Car_1', [2]],
    ]);
  });

  it('an OBJ carries no facts; a refused glTF carries null (it hides nothing)', () => {
    const obj = loaded('m.obj', new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));
    expect('gltf' in obj).toBe(false);
    // Over the editor's signature bound: the strict reader refuses the model,
    // and the model still loads model-only.
    const long = 'x'.repeat(SIGNATURE_NAME_MAX);
    const count = Math.ceil((SIGNATURE_TOTAL_CHARS_MAX + 1) / SIGNATURE_NAME_MAX);
    const huge = loaded('huge.glb', modelGlb(Array.from({ length: count }, () => ({ name: long })), [
      { name: 'Body', primitives: [prim(0)] },
    ]));
    expect(huge.gltf).toBeNull();
  });

  it('the IndexedDB record carries only the name and bytes; the restore recomputes the facts', () => {
    const mesh = CAR();
    const rec = meshToRecord(mesh);
    expect(Object.keys(rec).sort()).toEqual(['bytes', 'name']);
    const back = recordToMesh(rec)!;
    expect(back.gltf?.signature).toEqual(mesh.gltf?.signature);
    expect([...back.gltf!.meshMaterials]).toEqual([...mesh.gltf!.meshMaterials]);
  });

  it('the facts hold strings and numbers only, no view of the file', () => {
    const mesh = CAR();
    for (const [name, e] of mesh.gltf!.meshMaterials) {
      expect(typeof name).toBe('string');
      expect(ArrayBuffer.isView(e.materials)).toBe(false);
      expect(e.materials.every((m) => typeof m === 'number')).toBe(true);
    }
  });
});

describe('dormancy against the loaded model', () => {
  it('the matching model keeps every index section awake, before the sandbox reports', () => {
    expect(outputDormancyFromState(stateOf(carOutput(), CAR()))).toEqual({
      outputId: 'o1', dormant: new Set(), visibleCount: 4,
    });
  });

  it('a different signature sleeps them all: count, a renamed material, a trailing space', () => {
    for (const sig of [['Body', 'Glass'], ['Body', 'Glas', ''], ['Body', 'Glass', ' ']]) {
      const r = outputDormancyFromState(stateOf(carOutput([], sig), CAR()));
      expect(r.dormant, sig.join('|')).toEqual(new Set([1, 2, 3]));
      expect(r.visibleCount).toBe(1);
    }
  });

  it('an OBJ, or no model at all, sleeps them; an unreadable glTF hides nothing', () => {
    const obj = loaded('m.obj', new TextEncoder().encode('v 0 0 0\n'));
    expect(outputDormancyFromState(stateOf(carOutput(), obj)).dormant).toEqual(new Set([1, 2, 3]));
    expect(outputDormancyFromState(stateOf(carOutput(), null)).dormant).toEqual(new Set([1, 2, 3]));
    const unknown = { ...CAR(), gltf: null };
    expect(outputDormancyFromState(stateOf(carOutput(), unknown)).dormant).toEqual(new Set());
  });

  it('a named section keeps following the inventory, never the signature', () => {
    const out = carOutput([{ meshTargets: ['Body'] }]);
    const mesh = CAR();
    // Unreported: the name rule holds off (rule 1), the index sections are awake.
    expect(outputDormancyFromState(stateOf(out, mesh)).dormant).toEqual(new Set());
    // Reported without Body (two meshes, so the 0.6 single-mesh exemption is
    // not in play): only the named section sleeps.
    const reported = {
      ...stateOf(out, mesh),
      previewMeshInventory: { meshes: [{ name: 'Other' }, { name: 'Else' }] },
    };
    expect(outputDormancyFromState(reported).dormant).toEqual(new Set([4]));
  });

  it('the 008 swallow resolves the edge to its Output, index sections included', () => {
    // The wire React Flow could not place: into material 2's Color handle.
    const wire = makeEdge('feeder', 'out', 'o1', 'm2:color');
    const withWire = (out: AppNode, mesh: unknown) => ({ ...stateOf(out, mesh), edges: [wire] });
    // A signature the loaded model does not match sleeps every index section,
    // so the absent handle is the visibility rule's steady state.
    expect(outputEdgeIsDormant(withWire(carOutput([], ['Other', 'Model', 'Here']), CAR()), wire.id)).toBe(true);
    // The matching model keeps them awake: the same missing handle is a bug.
    expect(outputEdgeIsDormant(withWire(carOutput(), CAR()), wire.id)).toBe(false);
    // An id naming no edge in the store excuses nothing — the warning prints.
    expect(outputEdgeIsDormant(withWire(carOutput([], ['Other']), CAR()), 'e-nope')).toBe(false);
  });
});

describe('the double claim', () => {
  const coverageFor = (out: AppNode, mesh: PreviewMesh) => {
    const mats = outputMaterials(out);
    const sig = (out.data as { modelSignature: { materials: string[] } }).modelSignature.materials;
    return indexSectionCoverage(mats, sig, loadedModelOf(mesh), planNamedParts(mats));
  };

  it('each index section covers the meshes that wear its material', () => {
    const c = coverageFor(carOutput(), CAR());
    expect(c.get(1)).toEqual({ meshes: ['Body', 'Car'], overridden: [], state: 'covered' });
    expect(c.get(2)).toEqual({ meshes: ['Glass'], overridden: [], state: 'covered' });
    expect(c.get(3)).toEqual({ meshes: ['Car_1'], overridden: [], state: 'covered' });
  });

  it('a name section claiming one of them overrides it; claiming all of them overrides the section', () => {
    const partial = coverageFor(carOutput([{ meshTargets: ['Car'] }]), CAR());
    expect(partial.get(1)).toEqual({ meshes: ['Body', 'Car'], overridden: ['Car'], state: 'covered' });
    const full = coverageFor(carOutput([{ meshTargets: ['Body', 'Car'] }]), CAR());
    expect(full.get(1)?.state).toBe('overridden');
    // Material 0 naming a mesh is a name claim too.
    const out = carOutput();
    (out.data as Record<string, unknown>).meshTargets = ['Glass'];
    expect(coverageFor(out, CAR()).get(2)?.state).toBe('overridden');
  });

  it('the chip title names what the section shades and what a mesh section took', () => {
    const c = coverageFor(carOutput([{ meshTargets: ['Car'] }]), CAR()).get(1);
    const title = indexChipTitle('Body', c, 'en');
    expect(title).toBe('glTF material “Body” — shades: Body\nShaded instead by a mesh section: Car');
  });

  it('a material no mesh of the loaded model wears is unused; asleep, nothing is claimed', () => {
    const mesh = loaded('two.glb', modelGlb([{ name: 'Body' }, { name: 'Glass' }, {}], [
      { name: 'Body', primitives: [prim(0)] },
    ]));
    const c = coverageFor(carOutput(), mesh);
    expect(c.get(2)).toEqual({ meshes: [], overridden: [], state: 'unused' });
    const asleep = coverageFor(carOutput([], ['A', 'B', 'C']), CAR());
    expect([...asleep.values()].every((x) => x.state === 'unknown' && x.meshes.length === 0)).toBe(true);
  });

  it('"+ Add output" prefers a mesh no section covers, then mints an override', () => {
    const out = carOutput();
    const mats = outputMaterials(out);
    const cov = coverageFor(out, CAR());
    expect(pickFreeMesh(['Body', 'Glass', 'Car', 'Car_1', 'Extra'], mats, cov)).toBe('Extra');
    expect(pickFreeMesh(['Body', 'Glass', 'Car', 'Car_1'], mats, cov)).toBe('Body');
    const claimed = carOutput([{ meshTargets: ['Body', 'Glass', 'Car', 'Car_1'] }]);
    expect(pickFreeMesh(['Body', 'Glass', 'Car', 'Car_1'], outputMaterials(claimed), coverageFor(claimed, CAR()))).toBeNull();
  });

  it('awake is loader 0.8\'s exact rule, on the raw names', () => {
    const mesh = CAR();
    expect(indexSectionsAwake(['Body', 'Glass', ''], loadedModelOf(mesh))).toBe(true);
    // NFD "a\u0304" against the NFC "\u0101" in the file: never normalised.
    const nfc = loaded('lv.glb', modelGlb([{ name: '\u0101' }], [{ name: 'M', primitives: [prim(0)] }]));
    expect(indexSectionsAwake(['a\u0304'], loadedModelOf(nfc))).toBe(false);
    expect(indexSectionsAwake(['\u0101'], loadedModelOf(nfc))).toBe(true);
  });
});
