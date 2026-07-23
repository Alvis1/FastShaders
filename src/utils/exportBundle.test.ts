import { describe, it, expect } from 'vitest';
import { buildExportBundle, buildExportReadme, meshPairingSnippet, type ExportMesh } from './exportBundle';
import { readZip } from './zipReader';

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
  });

  it('keeps the images section without a mesh (pre-mesh behavior)', () => {
    const readme = buildExportReadme('my-shader', true, null);
    expect(readme).toContain('images/ — the same images as regular files');
    expect(readme).not.toContain('models/');
  });
});
