#!/usr/bin/env node
/**
 * Writes the two KTX2 glTF fixtures under src/engine/fixtures/ktx2/:
 *
 *   quad-uastc-required.glb  KHR_texture_basisu in extensionsUsed AND
 *                            extensionsRequired; the texture has no core
 *                            `source`, so nothing can stand in for the KTX2.
 *   quad-uastc-fallback.glb  KHR_texture_basisu in extensionsUsed only; the
 *                            texture's core `source` is a 40x40 solid-magenta
 *                            PNG, so a fallback is unmistakable on screen.
 *
 * Both hold one quad (POSITION + TEXCOORD_0 + uint16 indices) whose material's
 * baseColorTexture is texture 0, and images[0] = 2d_uastc.ktx2 (three r184's
 * own test texture, copied beside the outputs) in a bufferView.
 *
 * Documentation-grade: run it by hand and commit the outputs. The committed
 * GLBs are the source of truth. `src/test-utils.ts`'s makeKtx2Glb is a second
 * copy of the layout below, and src/ktx2Transcode.test.ts fails if the two
 * stop producing the same bytes (it re-uses the committed PNG, so a different
 * zlib build re-running this script cannot fail that check).
 *
 * Usage: node scripts/gen-ktx2-fixture-glbs.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = fileURLToPath(new URL('../src/engine/fixtures/ktx2/', import.meta.url));
const UASTC = '2d_uastc.ktx2';
const UASTC_SHA256 = '21b6912cae1f074ae3eda1b751f43c36eafc7eb83f3af71f85bba2ccbafce125';

/* ── a 40x40 solid-magenta PNG (RGB8) ─────────────────────────────────────── */

// Our own CRC-32: zlib.crc32 is Node >= 22.2 and CI runs Node 20.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function solidPng(w, h, [r, g, b]) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3); // filter byte 0 (None), then the pixels
    for (let x = 0; x < w; x++) raw.set([r, g, b], row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type 2 (RGB), deflate, no filter set, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── the GLB (same layout as src/test-utils.ts makeKtx2Glb) ──────────────── */

const pad4 = (n) => (n + 3) & ~3;

function makeKtx2Glb({ ktx2, fallbackPng, required }) {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const parts = [
    new Uint8Array(positions.buffer),
    new Uint8Array(uvs.buffer),
    new Uint8Array(indices.buffer),
    ktx2,
    ...(fallbackPng ? [fallbackPng] : []),
  ];
  const views = [];
  let at = 0;
  for (const p of parts) {
    at = pad4(at);
    views.push({ offset: at, length: p.length });
    at += p.length;
  }
  const binLength = at;
  const bin = new Uint8Array(pad4(binLength));
  parts.forEach((p, i) => bin.set(p, views[i].offset));

  const bufferViews = views.map((v, i) => ({
    buffer: 0,
    byteOffset: v.offset,
    byteLength: v.length,
    ...(i === 0 || i === 1 ? { target: 34962 } : i === 2 ? { target: 34963 } : {}),
  }));
  const json = {
    asset: { version: '2.0', generator: 'FastShaders scripts/gen-ktx2-fixture-glbs.mjs' },
    extensionsUsed: ['KHR_texture_basisu'],
    ...(required ? { extensionsRequired: ['KHR_texture_basisu'] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'quad', mesh: 0 }],
    meshes: [{ name: 'quad', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'ktx2', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    textures: [
      fallbackPng
        ? { source: 1, extensions: { KHR_texture_basisu: { source: 0 } } }
        : { extensions: { KHR_texture_basisu: { source: 0 } } },
    ],
    images: [
      { name: '2d_uastc', bufferView: 3, mimeType: 'image/ktx2' },
      ...(fallbackPng ? [{ name: 'magenta', bufferView: 4, mimeType: 'image/png' }] : []),
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(text.length);
  const total = 12 + 8 + jsonLen + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(text, 20);
  const binAt = 20 + jsonLen;
  dv.setUint32(binAt, bin.length, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // 'BIN\0'
  out.set(bin, binAt + 8);
  return out;
}

/* ── write ────────────────────────────────────────────────────────────────── */

const ktx2 = new Uint8Array(readFileSync(path.join(DIR, UASTC)));
const sha = createHash('sha256').update(ktx2).digest('hex');
if (sha !== UASTC_SHA256) {
  console.error(`${UASTC} is not three r184's test texture (sha256 ${sha}); refusing to build from it.`);
  process.exit(1);
}
const magenta = new Uint8Array(solidPng(40, 40, [0xff, 0x00, 0xff]));
for (const [name, glb] of [
  ['quad-uastc-required.glb', makeKtx2Glb({ ktx2, required: true })],
  ['quad-uastc-fallback.glb', makeKtx2Glb({ ktx2, fallbackPng: magenta, required: false })],
]) {
  writeFileSync(path.join(DIR, name), glb);
  console.log(`${name}  ${glb.length} B  sha256 ${createHash('sha256').update(glb).digest('hex')}`);
}
