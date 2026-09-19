/**
 * The GLB import's closed FEATURE vocabulary (GLB Phase 5 Step 8): what an
 * imported material asked for that the build could not represent. The import
 * report prints a translated label per id (utils/glbImportCopy.ts) and never a
 * string out of the file — which is why the list is closed, and why P5c's
 * `KHR_materials_*` name whitelist is gone: no file-supplied text reaches the
 * note at all.
 *
 * A LEAF that imports nothing. The report's copy reaches it from the store's
 * side (the store imports importNote, which imports the copy), so a heavier
 * home — gltfImportPlan reaches the store's import cycle through
 * textureMemory → outputMaterials — must not sit on that path.
 *
 * `wrapMirrored` / `wrapMixed` are exactly imageUvMapping's
 * `GltfSamplerFeature`, and `texCoord` is `gltfTextureValues`' one reachable
 * `unsupported` entry; `gltfImportPlan.test.ts` pins both at the type level.
 */

/** Every id, in the ONE fixed order the report prints them. */
export const GLTF_FEATURE_IDS = [
  'occlusion',
  'normalScale',
  'clearcoat',
  'transmission',
  'volume',
  'ior',
  'specular',
  'sheen',
  'iridescence',
  'anisotropy',
  'dispersion',
  'unlit',
  'specularGlossiness',
  'wrapMirrored',
  'wrapMixed',
  'texCoord',
  'alphaCutoff',
  'emissiveUnused',
  'mixedTangents',
] as const;

export type GltfFeatureId = (typeof GLTF_FEATURE_IDS)[number];

const FEATURE_SET: ReadonlySet<string> = new Set(GLTF_FEATURE_IDS);

export function isGltfFeatureId(v: unknown): v is GltfFeatureId {
  return typeof v === 'string' && FEATURE_SET.has(v);
}

/** Known ids only, each once, in `GLTF_FEATURE_IDS` order — whatever the input
 *  (a non-iterable yields [], junk entries are skipped). */
export function orderFeatures(ids: unknown): GltfFeatureId[] {
  const seen = new Set<string>();
  if (Array.isArray(ids) || ids instanceof Set) {
    for (const id of ids as Iterable<unknown>) if (isGltfFeatureId(id)) seen.add(id);
  }
  return GLTF_FEATURE_IDS.filter((id) => seen.has(id));
}
