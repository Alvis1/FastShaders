#!/usr/bin/env node
/**
 * Regenerates the two compressed-glTF fixtures the decoder suites load:
 *
 *   src/engine/fixtures/compressed/tri-draco.glb     KHR_draco_mesh_compression
 *   src/engine/fixtures/compressed/quad-meshopt.glb  EXT_meshopt_compression
 *
 * Both are the same unit quad — positions (0,0,0) (1,0,0) (1,1,0) (0,1,0),
 * triangles 0 1 2 / 0 2 3 — and both mark their extension REQUIRED, so a
 * loader with no decoder refuses them instead of reading a fallback.
 *
 * There is no network here and three's npm package ships no sample models, so
 * the files are ENCODED from nothing, by encoders already on disk:
 *   - Draco: three's own `examples/jsm/libs/draco/draco_encoder.js` (the default
 *     JS build), evaluated in `vm` — it is a UMD script that would otherwise
 *     reach for `module.exports`. Edgebreaker, POSITION quantized to 14 bits
 *     (0 and 1 are the ends of the quantized range, so they come back exact).
 *   - meshopt: `meshoptimizer/encoder` 1.1.1 (ATTRIBUTES + TRIANGLES), with a
 *     fallback buffer as the extension spec requires. meshoptimizer is only a
 *     TRANSITIVE dev dependency (via @types/three), so this script is
 *     documentation-grade: the fixtures are committed and CI never runs it.
 * The GLBs themselves are assembled by hand: the 12-byte header, the JSON chunk
 * padded with spaces, the BIN chunk padded with zeros.
 *
 * Run: node scripts/gen-compressed-fixtures.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder } from 'meshoptimizer/encoder';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/engine/fixtures/compressed');

const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const TRIANGLES = [0, 1, 2, 0, 2, 3];
const GENERATOR = 'FastShaders scripts/gen-compressed-fixtures.mjs';

const pad4 = (n) => (n + 3) & ~3;

function glb(json, bin) {
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonLen = pad4(text.length);
  const binLen = pad4(bin.length);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); // 'glTF'
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonLen, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  out.fill(0x20, 20, 20 + jsonLen);
  text.copy(out, 20);
  const binAt = 20 + jsonLen;
  out.writeUInt32LE(binLen, binAt);
  out.writeUInt32LE(0x004e4942, binAt + 4); // 'BIN\0'
  Buffer.from(bin).copy(out, binAt + 8);
  return out;
}

function draco() {
  const src = readFileSync(
    path.join(ROOT, 'node_modules/three/examples/jsm/libs/draco/draco_encoder.js'),
    'utf8',
  );
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'draco_encoder.js' });
  const M = ctx.DracoEncoderModule();
  const encoder = new M.Encoder();
  const builder = new M.MeshBuilder();
  const mesh = new M.Mesh();
  builder.AddFacesToMesh(mesh, TRIANGLES.length / 3, new Uint32Array(TRIANGLES));
  const positionId = builder.AddFloatAttributeToMesh(mesh, M.POSITION, 4, 3, POSITIONS);
  encoder.SetEncodingMethod(M.MESH_EDGEBREAKER_ENCODING);
  encoder.SetAttributeQuantization(M.POSITION, 14);
  const data = new M.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, data);
  if (!(length > 0)) throw new Error('Draco encoding failed');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = data.GetValue(i) & 0xff;
  for (const o of [data, mesh, builder, encoder]) M.destroy(o);

  const EXT = 'KHR_draco_mesh_compression';
  const json = {
    asset: { version: '2.0', generator: GENERATOR },
    extensionsUsed: [EXT],
    extensionsRequired: [EXT],
    buffers: [{ byteLength: pad4(bytes.length) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    accessors: [
      { componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { componentType: 5125, count: 6, type: 'SCALAR' },
    ],
    meshes: [
      {
        name: 'Quad',
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            mode: 4,
            extensions: { [EXT]: { bufferView: 0, attributes: { POSITION: positionId } } },
          },
        ],
      },
    ],
    nodes: [{ name: 'Quad', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return glb(json, bytes);
}

async function meshopt() {
  await MeshoptEncoder.ready;
  const vertexSource = new Uint8Array(POSITIONS.buffer);
  const indexSource = new Uint8Array(new Uint16Array(TRIANGLES).buffer);
  const vertices = MeshoptEncoder.encodeGltfBuffer(vertexSource, 4, 12, 'ATTRIBUTES');
  const indices = MeshoptEncoder.encodeGltfBuffer(indexSource, 6, 2, 'TRIANGLES');
  const indicesAt = pad4(vertices.length);
  const bin = new Uint8Array(indicesAt + indices.length);
  bin.set(vertices, 0);
  bin.set(indices, indicesAt);

  const EXT = 'EXT_meshopt_compression';
  const json = {
    asset: { version: '2.0', generator: GENERATOR },
    extensionsUsed: [EXT],
    extensionsRequired: [EXT],
    buffers: [
      { byteLength: pad4(bin.length) },
      // The uncompressed layout, never stored: the extension spec's fallback.
      { byteLength: 60, extensions: { [EXT]: { fallback: true } } },
    ],
    bufferViews: [
      {
        buffer: 1, byteOffset: 0, byteLength: 48, byteStride: 12, target: 34962,
        extensions: { [EXT]: { buffer: 0, byteOffset: 0, byteLength: vertices.length, byteStride: 12, count: 4, mode: 'ATTRIBUTES' } },
      },
      {
        buffer: 1, byteOffset: 48, byteLength: 12, target: 34963,
        extensions: { [EXT]: { buffer: 0, byteOffset: indicesAt, byteLength: indices.length, byteStride: 2, count: 6, mode: 'TRIANGLES' } },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    meshes: [{ name: 'Quad', primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    nodes: [{ name: 'Quad', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return glb(json, bin);
}

mkdirSync(OUT, { recursive: true });
for (const [name, bytes] of [
  ['tri-draco.glb', draco()],
  ['quad-meshopt.glb', await meshopt()],
]) {
  writeFileSync(path.join(OUT, name), bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(`${name}  ${bytes.length} B  sha256 ${sha}`);
}
