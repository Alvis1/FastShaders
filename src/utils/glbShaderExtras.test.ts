/**
 * The trusted-side reader of a FastShaders single-GLB (utils/glbShaderExtras.ts)
 * on hand-built GLBs (test-utils `makeFastShadersGlb`). Every refusal and
 * every asset rule, under hostile input. No network, nothing stubbed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { imageAssetFor, inlineImageAssets } from '@/engine/imageAssets';
import { embedProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { moduleImageLiterals } from '@/engine/projectImageRefs';
import { fnv1a32Hex } from './payloadDigest';
import {
  FS_EMBED_ASSET_BYTES_MAX,
  FS_EMBED_ASSETS_MAX,
  FS_EMBED_TOTAL_BYTES_MAX,
  FS_MODULE_MAX_BYTES,
  FS_PROJECT_BEGIN,
  FS_PROJECT_END,
} from '@/engine/glbShaderContract';
import {
  FS_JSON_SNIFF,
  assetLiteralText,
  inlineFsAssets,
  readFsExtras,
  readGlbFsExtras,
  type FsExtrasRead,
} from './glbShaderExtras';
import {
  canonicalSrc,
  fakeWebp,
  makeFastShadersGlb,
  makeFastShadersGltfJson,
  makeRealPng,
  pngHeaderBytes,
  type FsGlbFixture,
} from '@/test-utils';

const PNG = makeRealPng(2, 2, [10, 20, 30, 255]);
const WEBP = fakeWebp(4, 4, true);
const KEY_P = 'p-00000000';
const KEY_W = 'w-00000001';
const MODULE = `export default () => null;\nconst a = "fs-asset:${KEY_P}";\nconst b = "fs-asset:${KEY_W}";\nconst c = "fs-asset:gone-00000000";\n`;
const PROJECT_OBJ = { version: 1, shaderName: 's', graph: { nodes: [], edges: [] }, preview: {}, ui: {} } as unknown as FastShadersProject;
const PROJECT = embedProjectState('', PROJECT_OBJ).trim();

const full = (o: FsGlbFixture = {}): Uint8Array =>
  makeFastShadersGlb({
    module: MODULE,
    project: `\n\n${PROJECT}\n`,
    assets: { [KEY_P]: { mime: 'image/png', bytes: PNG }, [KEY_W]: { mime: 'image/webp', bytes: WEBP } },
    ...o,
  });

const ok = (r: FsExtrasRead) => {
  if (r.state !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.shader;
};
const refusal = (r: FsExtrasRead) => (r.state === 'refused' ? r.reason : r.state);

describe('accept', () => {
  it('module + project + a PNG and a WebP asset → ok, inlined, canonical, trimmed', () => {
    const s = ok(readGlbFsExtras(full()));
    expect([...s.assets]).toEqual([
      [KEY_P, canonicalSrc('image/png', PNG)],
      [KEY_W, canonicalSrc('image/webp', WEBP)],
    ]);
    expect(s.assetsRefused).toBe(0);
    expect(s.moduleEdited).toBe(false);
    expect(s.projectText).toBe(PROJECT);
    expect(s.moduleText).toContain(`"${canonicalSrc('image/png', PNG)}"`);
    expect(s.moduleText).toContain(`"${canonicalSrc('image/webp', WEBP)}"`);
    expect(s.moduleText).toContain('"fs-asset:gone-00000000"');
    for (const v of s.assets.values()) expect(v).toMatch(/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/);
  });

  it('inlineFsAssets is inlineImageAssets, key for key — including a key minted from a hostile node id', () => {
    const src = `data:image/webp;base64,${btoa('abc')}`;
    const hostile = imageAssetFor('a"b/../x', { imageB64: src, width: 2, height: 2, fileName: 'h.webp' })!;
    const map = new Map([[hostile.key, hostile.src], [KEY_P, canonicalSrc('image/png', PNG)]]);
    const stored = `x("${hostile.placeholder}"); y("fs-asset:${KEY_P}"); z("fs-asset:nope"); w("$&");`;
    expect(inlineFsAssets(stored, map)).toBe(inlineImageAssets(stored, map));
    expect(inlineFsAssets(stored, map)).toContain(`"${hostile.src}"`);
    expect(inlineFsAssets(stored, map)).toContain('"fs-asset:nope"');
    expect(inlineFsAssets(stored, new Map())).toBe(stored);
    // A payload holding a substitution pattern is inserted verbatim.
    const dollar = new Map([[KEY_P, 'data:image/png;base64,$&$1']]);
    expect(inlineFsAssets(`"fs-asset:${KEY_P}"`, dollar)).toBe('"data:image/png;base64,$&$1"');
    // A module-only file reads with an empty map and the placeholders verbatim.
    const s = ok(readGlbFsExtras(makeFastShadersGlb({ module: MODULE, omitAssets: true })));
    expect(s.assets.size).toBe(0);
    expect(s.moduleText).toBe(MODULE);
    expect(s.projectText).toBeNull();
  });

  it('assetLiteralText feeds moduleImageLiterals exactly the map\'s values', () => {
    const s = ok(readGlbFsExtras(full()));
    expect([...moduleImageLiterals(assetLiteralText(s.assets))]).toEqual([...s.assets.values()]);
    expect(assetLiteralText(new Map())).toBe('');
  });

  it('a scene marker that DISAGREES with the root is ignored (the root is authoritative, §3 C2)', () => {
    const bytes = full({ sceneExtras: { fastshaders: { v: 1, module: { bufferView: 0 }, project: { bufferView: 0 } } } });
    expect(readGlbFsExtras(bytes).state).toBe('ok');
    expect(readGlbFsExtras(full({ omitSceneExtras: true })).state).toBe('ok');
  });

  it('moduleEdited: absent → false; matching → false; different → true; malformed → false', () => {
    expect(ok(readGlbFsExtras(full({ fnv1a: null }))).moduleEdited).toBe(false);
    expect(ok(readGlbFsExtras(full({ fnv1a: fnv1a32Hex(MODULE) }))).moduleEdited).toBe(false);
    expect(ok(readGlbFsExtras(full({ fnv1a: fnv1a32Hex(MODULE + ' ') }))).moduleEdited).toBe(true);
    expect(ok(readGlbFsExtras(full({ fnv1a: 'XYZ' }))).moduleEdited).toBe(false);
    expect(ok(readGlbFsExtras(full({ fnv1a: 'DEADBEEF' }))).moduleEdited).toBe(false);
  });
});

describe("'none'", () => {
  it('no extras, extras without fastshaders, an assets-only stash', () => {
    expect(readGlbFsExtras(full({ omitExtras: true, omitSceneExtras: true })).state).toBe('none');
    expect(readGlbFsExtras(full({ extras: { other: 1 }, omitSceneExtras: true })).state).toBe('none');
    expect(readGlbFsExtras(full({ module: null, project: null })).state).toBe('none');
    // The scene marker alone (root extras absent) is not a payload.
    expect(readGlbFsExtras(full({ omitExtras: true })).state).toBe('none');
  });

  it('a .gltf text, an OBJ, non-GLB bytes, an empty file', () => {
    const enc = new TextEncoder();
    expect(readGlbFsExtras(enc.encode(makeFastShadersGltfJson({ module: MODULE }))).state).toBe('none');
    expect(readGlbFsExtras(enc.encode('v 0 0 0\nf 1 1 1\n# "fastshaders"')).state).toBe('none');
    expect(readGlbFsExtras(new Uint8Array([1, 2, 3, 4, 5])).state).toBe('none');
    expect(readGlbFsExtras(new Uint8Array(0)).state).toBe('none');
  });

  it('the sniff string only inside a material name', () => {
    const bytes = full({ materials: ['fastshaders'], omitExtras: true, omitSceneExtras: true });
    expect(new TextDecoder().decode(bytes)).toContain(FS_JSON_SNIFF);
    expect(readGlbFsExtras(bytes).state).toBe('none');
  });

  it('readFsExtras on a non-document', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { extras: null }, { extras: { fastshaders: [] } }]) {
      expect(readFsExtras(bad, null).state).toBe('none');
    }
  });
});

describe("'refused'", () => {
  it('unsupported-version: v 2 (and a huge integer); damaged: any other v', () => {
    const withV = (v: unknown) =>
      full({ json: (d) => { ((d.extras as Record<string, Record<string, unknown>>).fastshaders).v = v; } });
    expect(refusal(readGlbFsExtras(withV(2)))).toBe('unsupported-version');
    expect(refusal(readGlbFsExtras(withV(999)))).toBe('unsupported-version');
    for (const v of ['1', 0, -1, 1.5, null, true, {}, 2 ** 53]) expect(refusal(readGlbFsExtras(withV(v))), String(v)).toBe('damaged');
  });

  it('damaged: a malformed module or project pointer', () => {
    for (const moduleEntry of [3, null, [], 'x', { bufferView: '1' }, { bufferView: 1.5 }, { bufferView: -1 }, { bufferView: 99, mimeType: 'text/javascript' }, {}]) {
      expect(refusal(readGlbFsExtras(full({ moduleEntry }))), JSON.stringify(moduleEntry)).toBe('damaged');
    }
    for (const projectEntry of [7, { bufferView: '2' }, { bufferView: 42 }, {}]) {
      expect(refusal(readGlbFsExtras(full({ projectEntry }))), JSON.stringify(projectEntry)).toBe('damaged');
    }
  });

  it('damaged: what the loader refuses on the view (parity)', () => {
    // The wrong mimeType, or none.
    expect(refusal(readGlbFsExtras(full({ moduleEntry: { bufferView: 3, mimeType: 'application/javascript' } })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ moduleEntry: { bufferView: 3 } })))).toBe('damaged');
    // A view on buffer 1 (a data: buffer, or an external one nothing fetched).
    expect(refusal(readGlbFsExtras(full({ moduleBuffer: 'data-uri' })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ moduleBuffer: 'external' })))).toBe('damaged');
    // buffers[0] carrying a uri.
    expect(refusal(readGlbFsExtras(full({ json: (d) => { (d.buffers as Record<string, unknown>[])[0].uri = 'x.bin'; } })))).toBe('damaged');
    // A stride, a target, an extension on the view; an empty view.
    for (const moduleView of [{ byteStride: 4 }, { target: 34962 }, { extensions: { EXT_meshopt_compression: {} } }, { byteLength: 0 }]) {
      expect(refusal(readGlbFsExtras(full({ moduleView }))), JSON.stringify(moduleView)).toBe('damaged');
    }
    // A view past the BIN (cut short), and one with a junk offset.
    expect(refusal(readGlbFsExtras(full({ moduleView: { byteLength: 1_000_000 } })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ projectView: { byteOffset: -4 } })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ projectView: { buffer: 1 } })))).toBe('damaged');
  });

  it('damaged: not UTF-8, an empty module, a project without its markers', () => {
    expect(refusal(readGlbFsExtras(full({ module: new Uint8Array([0xc3, 0x28]) })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ project: new Uint8Array([0xff, 0xfe, 0x00]) })))).toBe('damaged');
    // A BOM alone decodes to '' — empty, like the loader says.
    expect(refusal(readGlbFsExtras(full({ module: new Uint8Array([0xef, 0xbb, 0xbf]) })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ project: 'no markers at all' })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ project: `${FS_PROJECT_BEGIN}\n{}` })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ project: `{}\n${FS_PROJECT_END}` })))).toBe('damaged');
    expect(refusal(readGlbFsExtras(full({ project: FS_PROJECT_END + FS_PROJECT_BEGIN })))).toBe('damaged');
  });

  it('damaged: a malformed container or JSON AFTER a sniff hit (fail closed)', () => {
    const bytes = full();
    const broken = bytes.slice();
    new DataView(broken.buffer).setUint32(8, 20, true); // the declared total length: chunks fall outside it
    expect(refusal(readGlbFsExtras(broken))).toBe('damaged');
    const junkJson = makeFastShadersGlb({ json: (d) => { d.asset = 'x'; } });
    // Still valid JSON; make the JSON chunk itself unparseable by overwriting the first byte.
    const hit = junkJson.slice();
    hit[20] = 0x5d; // ']'
    expect(new TextDecoder().decode(hit)).toContain(FS_JSON_SNIFF);
    expect(refusal(readGlbFsExtras(hit))).toBe('damaged');
    // Without a sniff hit the same corruption is simply not a FastShaders file.
    const plain = makeFastShadersGlb({ omitExtras: true, omitSceneExtras: true });
    const plainBroken = plain.slice();
    new DataView(plainBroken.buffer).setUint32(8, 20, true);
    expect(readGlbFsExtras(plainBroken).state).toBe('none');
  });

  it('inconsistent: the module and project on one view, overlapping views, a view an accessor also reads', () => {
    // The default layout: view 0 = triangle, 1 = PNG, 2 = WebP, 3 = module, 4 = project.
    expect(refusal(readGlbFsExtras(full({ projectEntry: { bufferView: 3 } })))).toBe('inconsistent');
    expect(refusal(readGlbFsExtras(full({ moduleEntry: { bufferView: 4, mimeType: 'text/javascript' } })))).toBe('inconsistent');
    const overlapping = full({
      json: (d) => {
        const views = d.bufferViews as Array<{ byteOffset: number; byteLength: number }>;
        views[4] = { byteOffset: views[3].byteOffset + 4, byteLength: 8 };
        Object.assign(views[4], { buffer: 0 });
      },
    });
    expect(refusal(readGlbFsExtras(overlapping))).toBe('inconsistent');
    const accessorReads = full({
      json: (d) => { (d.accessors as unknown[]).push({ bufferView: 3, componentType: 5121, count: 1, type: 'SCALAR' }); },
    });
    expect(refusal(readGlbFsExtras(accessorReads))).toBe('inconsistent');
    const sparseReads = full({
      json: (d) => {
        (d.accessors as Record<string, unknown>[])[0].sparse = { count: 1, indices: { bufferView: 4, componentType: 5121 }, values: { bufferView: 0 } };
      },
    });
    expect(refusal(readGlbFsExtras(sparseReads))).toBe('inconsistent');
    const primitiveExt = full({
      json: (d) => {
        const prim = (d.meshes as Array<{ primitives: Record<string, unknown>[] }>)[0].primitives[0];
        prim.extensions = { KHR_draco_mesh_compression: { bufferView: 3, attributes: {} } };
      },
    });
    expect(refusal(readGlbFsExtras(primitiveExt))).toBe('inconsistent');
  });

  it('too-large: a module view of 16 MiB + 1 bytes', () => {
    const big = new Uint8Array(FS_MODULE_MAX_BYTES + 1);
    expect(refusal(readGlbFsExtras(makeFastShadersGlb({ module: big, fnv1a: null })))).toBe('too-large');
    // Exactly the cap is fine (zero bytes decode as UTF-8).
    const atCap = new Uint8Array(FS_MODULE_MAX_BYTES);
    atCap.set(new TextEncoder().encode('export default () => 1;'));
    expect(readGlbFsExtras(makeFastShadersGlb({ module: atCap, fnv1a: null })).state).toBe('ok');
  });

  it('never throws on a hostile document', () => {
    const hostile = {
      extras: {
        fastshaders: {
          v: 1,
          get module() {
            throw new Error('hostile');
          },
        },
      },
    };
    expect(refusal(readFsExtras(hostile, new Uint8Array(4)))).toBe('damaged');
    expect(refusal(readFsExtras({ extras: { fastshaders: { v: 1, module: { bufferView: 0, mimeType: 'text/javascript' } } }, bufferViews: [{ buffer: 0, byteLength: 4 }], buffers: [{}] }, null))).toBe('damaged');
  });
});

describe('assets: each refusal counts and leaves the placeholder verbatim', () => {
  const placeholder = (key: string) => `"fs-asset:${key}"`;
  const one = (o: FsGlbFixture) => ok(readGlbFsExtras(full(o)));

  it('a uri image, a disallowed mime, a PNG mime with WebP magic, a mime with no magic', () => {
    const uriImage = one({ json: (d) => { (d.images as Record<string, unknown>[])[0].uri = 'x.png'; } });
    expect(uriImage.assetsRefused).toBe(1);
    expect(uriImage.moduleText).toContain(placeholder(KEY_P));
    expect(uriImage.assets.has(KEY_W)).toBe(true);
    const gif = one({ json: (d) => { (d.images as Record<string, unknown>[])[0].mimeType = 'image/gif'; } });
    expect(gif.assetsRefused).toBe(1);
    expect(gif.assets.has(KEY_P)).toBe(false);
    const wrongMagic = one({ assets: { [KEY_P]: { mime: 'image/png', bytes: WEBP }, [KEY_W]: { mime: 'image/webp', bytes: WEBP } } });
    expect(wrongMagic.assetsRefused).toBe(1);
    expect(wrongMagic.moduleText).toContain(placeholder(KEY_P));
    expect(wrongMagic.moduleText).not.toContain(placeholder(KEY_W));
    const noMime = one({ json: (d) => { delete (d.images as Record<string, unknown>[])[1].mimeType; } });
    expect(noMime.assetsRefused).toBe(1);
  });

  it('an index out of range, a key failing the regex, a non-object assets, the 65th key', () => {
    expect(one({ assetsEntry: { [KEY_P]: 5, [KEY_W]: 1 } }).assetsRefused).toBe(1);
    expect(one({ assetsEntry: { [KEY_P]: 1.5, [KEY_W]: -1 } }).assetsRefused).toBe(2);
    const badKey = one({ assetsEntry: { 'bad key!': 0, [KEY_W]: 1 } });
    expect(badKey.assetsRefused).toBe(1);
    expect(badKey.assets.has(KEY_W)).toBe(true);
    const junk = one({ assetsEntry: 'junk' });
    expect(junk.assetsRefused).toBe(0);
    expect(junk.assets.size).toBe(0);
    const many: Record<string, number> = {};
    for (let i = 0; i < FS_EMBED_ASSETS_MAX + 1; i++) many[`k${i}`] = 0;
    const capped = one({ assetsEntry: many });
    expect(capped.assets.size).toBe(FS_EMBED_ASSETS_MAX);
    expect(capped.assetsRefused).toBe(1);
  });

  it('one image over 16 MiB is refused; the running total over 64 MiB refuses the key that crosses it', () => {
    const over = pngHeaderBytes(1, 1, FS_EMBED_ASSET_BYTES_MAX + 1 - 33);
    expect(over.length).toBe(FS_EMBED_ASSET_BYTES_MAX + 1);
    const tooBig = ok(readGlbFsExtras(makeFastShadersGlb({ module: MODULE, assets: { [KEY_P]: { mime: 'image/png', bytes: over } } })));
    expect(tooBig.assetsRefused).toBe(1);
    // Five keys naming ONE 16 MiB image: the total is summed per KEY, so the fifth crosses 64 MiB.
    const cap = pngHeaderBytes(1, 1, FS_EMBED_ASSET_BYTES_MAX - 33);
    expect(cap.length).toBe(FS_EMBED_ASSET_BYTES_MAX);
    expect(5 * cap.length).toBeGreaterThan(FS_EMBED_TOTAL_BYTES_MAX);
    const five = ok(
      readGlbFsExtras(
        makeFastShadersGlb({
          module: 'export default () => 1;',
          assets: { a: { mime: 'image/png', bytes: cap } },
          assetsEntry: { a: 0, b: 0, c: 0, d: 0, e: 0 },
        }),
      ),
    );
    expect([...five.assets.keys()]).toEqual(['a', 'b', 'c', 'd']);
    expect(five.assetsRefused).toBe(1);
    expect(five.assets.get('a')).toBe(five.assets.get('d'));
  });

  it('__proto__ / constructor keys are dropped by the reviver: no throw, nothing resolved', () => {
    const assetsEntry = { [KEY_W]: 1 };
    Object.defineProperty(assetsEntry, '__proto__', { value: 0, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(assetsEntry, 'constructor', { value: 0, enumerable: true, configurable: true, writable: true });
    const bytes = full({ assetsEntry });
    expect(new TextDecoder().decode(bytes)).toContain('"__proto__"');
    const s = ok(readGlbFsExtras(bytes));
    expect([...s.assets.keys()]).toEqual([KEY_W]);
    expect(s.assetsRefused).toBe(0);
  });
});

describe('source pins', () => {
  it('imports only leaves: the container, the caps, the reviver, the digest, the contract, and a TYPE from previewMesh', () => {
    const text = readFileSync(path.join(__dirname, 'glbShaderExtras.ts'), 'utf8');
    const imports = [...text.matchAll(/^import (type )?[\s\S]*?from '([^']+)';/gm)].map((m) => [m[1] === 'type ', m[2]]);
    expect(imports).toEqual([
      [false, './glbContainer'],
      [false, './gltfCompression'],
      [false, './gltfReader'],
      [false, './safeJson'],
      [false, './payloadDigest'],
      [true, './previewMesh'],
      [false, '@/engine/glbShaderContract'],
    ]);
    expect(text).not.toContain('useAppStore');
    expect(text).not.toMatch(/from '[^']*imageAssets'/);
    // Every JSON.parse carries the reviver, and the decoder is fatal.
    for (const m of text.matchAll(/JSON\.parse\([^\n]*/g)) expect(m[0]).toContain('safeJsonReviver');
    expect(text).toContain("new TextDecoder('utf-8', { fatal: true })");
  });
});
