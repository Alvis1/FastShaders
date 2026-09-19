import { describe, it, expect } from 'vitest';
import { buildExportBundle, buildExportReadme, meshPairingSnippet, type ExportMesh } from './exportBundle';
import { readZip } from './zipReader';
import { buildZip } from './zipWriter';

const enc = new TextEncoder();
const dec = new TextDecoder();

const SCRIPT = 'export default function () { return 1; }';
const IMAGE = { name: 'tex.png', bytes: enc.encode('png-bytes') as Uint8Array<ArrayBuffer> };
const GLB_MESH: ExportMesh = {
  name: 'robot.glb',
  kind: 'glb',
  bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]) as Uint8Array<ArrayBuffer>,
};
const OBJ_MESH: ExportMesh = {
  name: 'rock.obj',
  kind: 'obj',
  bytes: enc.encode('v 0 0 0') as Uint8Array<ArrayBuffer>,
};

describe('exportBundle: js vs zip decision', () => {
  it('stays a bare .js with no images and no mesh', () => {
    const b = buildExportBundle('my-shader', SCRIPT, [], null);
    expect(b.kind).toBe('js');
    expect(b.fileName).toBe('my-shader.js');
    expect(dec.decode(b.bytes)).toBe(SCRIPT);
  });

  it('becomes a zip when images are present', async () => {
    const b = buildExportBundle('my-shader', SCRIPT, [IMAGE], null);
    expect(b.kind).toBe('zip');
    const names = (await readZip(b.bytes)).map((e) => e.name);
    expect(names).toEqual(['my-shader.js', 'images/tex.png', 'README.txt']);
  });

  it('becomes a zip when only a mesh is present', async () => {
    const b = buildExportBundle('my-shader', SCRIPT, [], GLB_MESH);
    expect(b.kind).toBe('zip');
    expect(b.fileName).toBe('my-shader.zip');
    const entries = await readZip(b.bytes);
    const names = entries.map((e) => e.name);
    expect(names).toEqual(['my-shader.js', 'models/robot.glb', 'README.txt']);
    const model = entries.find((e) => e.name === 'models/robot.glb');
    expect(Array.from(model?.data ?? [])).toEqual(Array.from(GLB_MESH.bytes));
  });

  it('carries images and the mesh together', async () => {
    const b = buildExportBundle('s', SCRIPT, [IMAGE], OBJ_MESH);
    const names = (await readZip(b.bytes)).map((e) => e.name);
    expect(names).toEqual(['s.js', 'images/tex.png', 'models/rock.obj', 'README.txt']);
  });
});

describe('exportBundle: README content', () => {
  it('mentions models/ and the gltf-model pairing snippet for a glb mesh', () => {
    const readme = buildExportReadme('my-shader', false, GLB_MESH);
    expect(readme).toContain('models/robot.glb');
    expect(readme).toContain('gltf-model="url(models/robot.glb)"');
    expect(readme).toContain('shader="src: my-shader.js"');
    expect(readme).not.toContain('images/');
  });

  it('uses obj-model for an obj mesh', () => {
    expect(meshPairingSnippet(OBJ_MESH, 's.js')).toContain('obj-model="obj: url(models/rock.obj)"');
    // Eye height, three metres out — must agree with the A-Frame tab's
    // OBJECT_POSITION so the app's two pairing instructions match.
    expect(meshPairingSnippet(OBJ_MESH, 's.js')).toContain('position="0 1.6 -3"');
  });

  it('keeps the images section without a mesh (pre-mesh behavior)', () => {
    const readme = buildExportReadme('my-shader', true, null);
    expect(readme).toContain('images/ — the same images as regular files');
    expect(readme).not.toContain('models/');
  });
});

describe('exportBundle: size facts the export pre-flight reads', () => {
  it('a bare .js counts its own length and carries no model', () => {
    const b = buildExportBundle('s', SCRIPT, [], null);
    expect(b.unpackedBytes).toBe(b.bytes.length);
    expect(b.meshBytes).toBe(0);
    expect(b.unpackedBytesWithoutMesh).toBe(b.unpackedBytes);
  });

  it('a zip counts exactly what readZip reads back', async () => {
    const b = buildExportBundle('s', SCRIPT, [IMAGE], GLB_MESH);
    const entries = await readZip(b.bytes);
    expect(b.unpackedBytes).toBe(entries.reduce((s, e) => s + e.data.length, 0));
    expect(b.meshBytes).toBe(GLB_MESH.bytes.length);
  });

  it('predicts the without-model size exactly, zip to zip and zip to js', () => {
    const both = buildExportBundle('s', SCRIPT, [IMAGE], GLB_MESH);
    expect(both.unpackedBytesWithoutMesh).toBe(buildExportBundle('s', SCRIPT, [IMAGE], null).unpackedBytes);

    const meshOnly = buildExportBundle('s', SCRIPT, [], GLB_MESH);
    const plain = buildExportBundle('s', SCRIPT, [], null);
    expect(plain.kind).toBe('js');
    expect(meshOnly.unpackedBytesWithoutMesh).toBe(enc.encode(SCRIPT).length);
    expect(meshOnly.unpackedBytesWithoutMesh).toBe(plain.unpackedBytes);
  });

  it('counts the entries readZip counts, with and without the model', async () => {
    const plain = buildExportBundle('s', SCRIPT, [], null);
    expect(plain.entryCount).toBe(1);
    expect(plain.entryCountWithoutMesh).toBe(1);

    const IMAGE2 = { name: 'tex2.png', bytes: enc.encode('png-2') as Uint8Array<ArrayBuffer> };
    const both = buildExportBundle('s', SCRIPT, [IMAGE, IMAGE2], GLB_MESH);
    expect(both.entryCount).toBe((await readZip(both.bytes)).length);
    const noMesh = buildExportBundle('s', SCRIPT, [IMAGE, IMAGE2], null);
    expect(both.entryCountWithoutMesh).toBe((await readZip(noMesh.bytes)).length);
    expect(noMesh.entryCountWithoutMesh).toBe(noMesh.entryCount);

    // Mesh only: dropping the model leaves a bare .js.
    const meshOnly = buildExportBundle('s', SCRIPT, [], GLB_MESH);
    expect(meshOnly.entryCount).toBe((await readZip(meshOnly.bytes)).length);
    expect(meshOnly.entryCountWithoutMesh).toBe(1);
  });

  it('the size refactor did not change a single byte', () => {
    const b = buildExportBundle('s', SCRIPT, [IMAGE], OBJ_MESH);
    const expected = buildZip([
      { name: 's.js', data: enc.encode(SCRIPT) },
      { name: 'images/tex.png', data: IMAGE.bytes },
      { name: 'models/rock.obj', data: OBJ_MESH.bytes },
      { name: 'README.txt', data: enc.encode(buildExportReadme('s', true, OBJ_MESH)) },
    ]);
    expect(Array.from(b.bytes)).toEqual(Array.from(expected));
    expect(Array.from(buildExportBundle('s', SCRIPT, [], null).bytes)).toEqual(Array.from(enc.encode(SCRIPT)));
  });
});
