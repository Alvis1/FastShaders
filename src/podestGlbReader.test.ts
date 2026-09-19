/**
 * Podest's FastShaders GLB reader is a hand-written TWIN of
 * src/utils/glbShaderExtras.ts (podest is a standalone vanilla page and
 * cannot import the editor's modules). This suite RUNS the twin — sliced out
 * of public/podest.html between its section anchors and evaluated with
 * `new Function` — beside the editor's reader over the same GLBs, and fails
 * on any disagreement: the constants, the verdict (state, reason, the inlined
 * module text, the digest flag) and the drop's output BYTES.
 *
 * It also pins the page's wiring: the confirm before a GLB's shader runs, the
 * payload drop before the stage sees the model, and that no podest document
 * spells the loader's model opt-in.
 *
 * Nothing here touches a global (the twin is evaluated in the main realm with
 * no stubs), so `isolate: false` is safe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FS_JSON_ESCAPE_SNIFF,
  FS_JSON_SNIFF,
  dropFastShadersPayload,
  readGlbFsExtras,
  type FsExtrasRead,
} from '@/utils/glbShaderExtras';
import {
  FS_ASSET_KEY_RE,
  FS_EMBED_ASSET_BYTES_MAX,
  FS_EMBED_ASSETS_MAX,
  FS_EMBED_TOTAL_BYTES_MAX,
  FS_EXTRAS_VERSION,
  FS_MODULE_MAX_BYTES,
  FS_MODULE_MIME,
  FS_PROJECT_BEGIN,
  FS_PROJECT_END,
  FS_PROJECT_MAX_BYTES,
  FS_SCENES_SCAN_MAX,
} from '@/engine/glbShaderContract';
import { GLB_JSON_MAX_BYTES, GLB_MAX_CHUNKS, decodeDataUri, parseGlbContainer } from '@/utils/glbContainer';
import { GLB_READ_MAX_BYTES } from '@/utils/gltfCompression';
import { GLTF_READ_CAPS } from '@/utils/gltfReader';
import { safeJsonReviver } from '@/utils/safeJson';
import { fakeWebp, makeFastShadersGlb, makeFastShadersGlbEscapedKey, makeGlb, makeRealPng, type FsGlbFixture } from '@/test-utils';

const page = readFileSync(new URL('../public/podest.html', import.meta.url), 'utf8');

function between(from: string, to: string): string {
  const a = page.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = page.indexOf(to, a + from.length);
  expect(b, `anchor not found after ${from}: ${to}`).toBeGreaterThan(a);
  return page.slice(a, b);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SLICE = between('  // ── FastShaders GLB reader (twin of src/utils/glbShaderExtras.ts', '  // ── File dispatch');
const twin = new Function(
  SLICE +
    '\nreturn { fsReadGlb: fsReadGlb, fsDropPayload: fsDropPayload, fsJsonReviver: fsJsonReviver, fsSafeName: fsSafeName,' +
    ' FS_EXTRAS_VERSION: FS_EXTRAS_VERSION, FS_MODULE_MIME: FS_MODULE_MIME, FS_MODULE_MAX_BYTES: FS_MODULE_MAX_BYTES,' +
    ' FS_PROJECT_MAX_BYTES: FS_PROJECT_MAX_BYTES, FS_ASSETS_MAX: FS_ASSETS_MAX, FS_ASSET_BYTES_MAX: FS_ASSET_BYTES_MAX,' +
    ' FS_ASSETS_TOTAL_MAX: FS_ASSETS_TOTAL_MAX, FS_ASSET_KEY_RE: FS_ASSET_KEY_RE, FS_GLB_JSON_MAX_BYTES: FS_GLB_JSON_MAX_BYTES,' +
    ' FS_GLB_MAX_CHUNKS: FS_GLB_MAX_CHUNKS, FS_SCENES_SCAN_MAX: FS_SCENES_SCAN_MAX, FS_PROJECT_BEGIN: FS_PROJECT_BEGIN,' +
    ' FS_BUFFER_MAX_BYTES: FS_BUFFER_MAX_BYTES, fsDecodeDataUri: fsDecodeDataUri,' +
    ' FS_PROJECT_END: FS_PROJECT_END, FS_JSON_SNIFF: FS_JSON_SNIFF, FS_JSON_ESCAPE_SNIFF: FS_JSON_ESCAPE_SNIFF,' +
    ' FS_READ_CAPS: FS_READ_CAPS, FS_REASON_TEXT: FS_REASON_TEXT };',
)() as Any;

/** The editor's verdict in the twin's flat shape. */
function editorVerdict(r: FsExtrasRead): Record<string, unknown> {
  if (r.state === 'none') return { state: 'none' };
  if (r.state === 'refused') return { state: 'refused', reason: r.reason };
  return {
    state: 'ok',
    moduleText: r.shader.moduleText,
    projectText: r.shader.projectText,
    hasProject: r.shader.projectText !== null,
    assetsRefused: r.shader.assetsRefused,
    moduleEdited: r.shader.moduleEdited,
  };
}

function expectAgree(bytes: Uint8Array<ArrayBuffer>, label: string): void {
  expect(twin.fsReadGlb(bytes), label).toEqual(editorVerdict(readGlbFsExtras(bytes)));
  const mine = dropFastShadersPayload('glb', bytes);
  const theirs = twin.fsDropPayload(bytes);
  if (!mine.ok) {
    expect(theirs, label).toBeNull();
    return;
  }
  expect(theirs, label).not.toBeNull();
  expect(new Uint8Array(theirs), label).toEqual(new Uint8Array(mine.bytes));
  // Nothing to drop: both hand back the SAME object.
  if (mine.bytes === bytes) expect(theirs, label).toBe(bytes);
}

const PNG = makeRealPng(2, 2, [1, 2, 3, 255]);
const WEBP = fakeWebp(4, 4, true);
const PROJECT = `${FS_PROJECT_BEGIN}\n{"version":1}\n${FS_PROJECT_END}`;
const MODULE = 'export default function () { return {}; }\nconst a = "fs-asset:p-00000000";\nconst b = "fs-asset:gone-11111111";\n';

const FIXTURES: Array<[string, FsGlbFixture]> = [
  ['the default fixture', {}],
  ['module + project + two assets + a texture', {
    module: MODULE,
    project: PROJECT,
    assets: { 'p-00000000': { mime: 'image/png', bytes: PNG }, 'w-22222222': { mime: 'image/webp', bytes: WEBP } },
    textureFromAsset: 'w-22222222',
  }],
  ['no extras', { omitExtras: true, omitSceneExtras: true }],
  ['module only, no assets key', { omitAssets: true }],
  ['assets only', { module: null, assets: { 'p-00000000': { mime: 'image/png', bytes: PNG } } }],
  ['v 2', { extras: { fastshaders: { v: 2 } } }],
  ["v '1'", { extras: { fastshaders: { v: '1' } } }],
  ['a bad module pointer', { moduleEntry: { bufferView: 'x' } }],
  ['a wrong mimeType', { moduleEntry: { bufferView: 1, mimeType: 'application/javascript' } }],
  ['a strided view', { moduleView: { byteStride: 4 } }],
  ['a target', { moduleView: { target: 34962 } }],
  ['a view extension', { moduleView: { extensions: { EXT_meshopt_compression: {} } } }],
  ['a data: buffer module', { moduleBuffer: 'data-uri' }],
  ['an external buffer module', { moduleBuffer: 'external' }],
  ['a view past the BIN', { moduleView: { byteLength: 100000 } }],
  ['an empty view', { moduleView: { byteLength: 0 } }],
  ['not UTF-8', { module: new Uint8Array([0xc3, 0x28]) }],
  ['an edited module', { fnv1a: '00000000' }],
  ['a malformed digest', { fnv1a: 'XYZ' }],
  ['a project without its markers', { project: 'no markers' }],
  ['module and project on one view', { project: PROJECT, projectEntry: { bufferView: 1 } }],
  ['the module view read by an accessor', { json: (d) => { (d.accessors as Array<Record<string, unknown>>)[0].bufferView = 1; } }],
  ['a refused asset (PNG bytes as WebP)', { module: MODULE, assets: { 'p-00000000': { mime: 'image/webp', bytes: PNG } } }],
  ['junk assets', { assetsEntry: { 'bad key!': 0, neg: -1, ok: 99 } }],
  ['a scene marker only', { omitExtras: true }],
  ['a sniff only in a material name', { omitExtras: true, omitSceneExtras: true, materials: ['"fastshaders"', 'x'] }],
  ['a hostile constructor key', { json: (d) => { Reflect.set(d.extras as object, 'constructor', { v: 1 }); } }],
];

describe('podest GLB reader twin — constants', () => {
  it('equal the editor\'s', () => {
    expect(twin.FS_EXTRAS_VERSION).toBe(FS_EXTRAS_VERSION);
    expect(twin.FS_MODULE_MIME).toBe(FS_MODULE_MIME);
    expect(twin.FS_MODULE_MAX_BYTES).toBe(FS_MODULE_MAX_BYTES);
    expect(twin.FS_PROJECT_MAX_BYTES).toBe(FS_PROJECT_MAX_BYTES);
    expect(twin.FS_ASSETS_MAX).toBe(FS_EMBED_ASSETS_MAX);
    expect(twin.FS_ASSET_BYTES_MAX).toBe(FS_EMBED_ASSET_BYTES_MAX);
    expect(twin.FS_ASSETS_TOTAL_MAX).toBe(FS_EMBED_TOTAL_BYTES_MAX);
    expect(twin.FS_ASSET_KEY_RE.source).toBe(FS_ASSET_KEY_RE.source);
    expect(twin.FS_GLB_JSON_MAX_BYTES).toBe(GLB_JSON_MAX_BYTES);
    expect(twin.FS_GLB_MAX_CHUNKS).toBe(GLB_MAX_CHUNKS);
    // The drop's `data:` buffer decode cap. vitest runs the WEB profile, so
    // this is the 96 MiB literal podest keeps inside the desktop app too
    // (zipReader's own convention for its caps).
    expect(twin.FS_BUFFER_MAX_BYTES).toBe(GLB_READ_MAX_BYTES);
    expect(twin.FS_SCENES_SCAN_MAX).toBe(FS_SCENES_SCAN_MAX);
    expect(twin.FS_PROJECT_BEGIN).toBe(FS_PROJECT_BEGIN);
    expect(twin.FS_PROJECT_END).toBe(FS_PROJECT_END);
    expect(twin.FS_JSON_SNIFF).toBe(FS_JSON_SNIFF);
    expect(twin.FS_JSON_ESCAPE_SNIFF).toBe(FS_JSON_ESCAPE_SNIFF);
    for (const k of ['accessors', 'images', 'meshes', 'primitives'] as const) expect(twin.FS_READ_CAPS[k], k).toBe(GLTF_READ_CAPS[k]);
    expect(Object.keys(twin.FS_REASON_TEXT).sort()).toEqual(['damaged', 'inconsistent', 'too-large', 'unsupported-version']);
  });

  it('the `data:` buffer decoder answers exactly what glbContainer\'s does', () => {
    // The drop's only new dependency, and the twin's is hand-written, so the
    // fixtures alone would never reach the canonical-base64 rules: an
    // over-permissive twin would decode a URI the editor refuses, zero it, and
    // hand back different bytes on a file nothing in FIXTURES spells.
    const B = 'data:application/octet-stream;base64,';
    const URIS = [
      `${B}QQ==`, `${B}QUJD`, B, // ok: one byte, three bytes, empty
      'data:;base64,QQ==', 'data:application/gltf-buffer;base64,QQ==', // the other two buffer media types
      'DATA:APPLICATION/OCTET-STREAM;BASE64,QQ==', // the scheme, the type and `;base64` are case-insensitive
      'data:image/png;base64,QQ==', // an image type is not a buffer type
      'data:application/octet-stream,QQ==', // no `;base64` at all
      'data:application/octet-stream;charset=utf-8;base64,QQ==', // a second parameter
      `${B}QR==`, // non-zero discarded bits: canonical spelling is QQ==
      `${B}QUI=`, `${B}QUJ=`, // the 1-pad rule, passing then failing
      `${B}QQ`, `${B}Q===`, `${B}-_==`, `${B}QQ ==`, `${B}Q\nQ==`, // length, padding, URL-safe, whitespace
      `data:${'x'.repeat(130)};base64,QQ==`, // a header past 128 characters
      'https://blocked.test/module.bin', 'data:application/octet-stream', '',
    ];
    const flat = (r: { ok: true; mime: string; bytes: Uint8Array } | { ok: false }) =>
      r.ok ? { mime: r.mime, bytes: [...r.bytes] } : null;
    for (const uri of URIS) {
      const mine = decodeDataUri(uri, 'buffer', GLB_READ_MAX_BYTES);
      const theirs = twin.fsDecodeDataUri(uri, GLB_READ_MAX_BYTES);
      expect(theirs === null ? null : { mime: theirs.mime, bytes: [...theirs.bytes] }, uri).toEqual(flat(mine));
    }
    // Not vacuous: the list really does hold accepted AND refused spellings.
    expect(URIS.filter((u) => decodeDataUri(u, 'buffer', GLB_READ_MAX_BYTES).ok).length).toBe(7);
    // The size is checked BEFORE a byte is decoded, on both sides.
    expect(twin.fsDecodeDataUri(`${B}QUJD`, 2)).toBeNull();
    expect(decodeDataUri(`${B}QUJD`, 'buffer', 2).ok).toBe(false);
  });

  it('the reviver drops the same keys as safeJsonReviver', () => {
    for (const k of ['__proto__', 'constructor', 'prototype', 'a', '', 'v']) {
      expect(twin.fsJsonReviver(k, 1), k).toBe(safeJsonReviver(k, 1));
    }
  });

  it('a file name is made safe for a message', () => {
    expect(twin.fsSafeName('a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x2028) + 'c')).toBe('a b c');
    expect(twin.fsSafeName('x'.repeat(500))).toHaveLength(200);
  });
});

describe('podest GLB reader twin — agrees with the editor, fixture for fixture', () => {
  it.each(FIXTURES)('%s', (label, fixture) => {
    expectAgree(makeFastShadersGlb(fixture), label);
  });

  it('an ESCAPED key (`"\\u0066astshaders"`, both occurrences) is read and dropped, not waved through', () => {
    const evil = makeFastShadersGlbEscapedKey({
      module: MODULE,
      project: PROJECT,
      assets: { 'p-00000000': { mime: 'image/png', bytes: PNG } },
    });
    // Not vacuous: neither occurrence of the key is spelled literally, so a
    // twin that gates on FS_JSON_SNIFF alone answers `none` and hands the
    // module on. (expectAgree alone would pass with BOTH readers blind.)
    expect(new TextDecoder().decode(evil)).not.toContain(FS_JSON_SNIFF);
    expect(twin.fsReadGlb(evil).state, 'twin').toBe('ok');
    expect(readGlbFsExtras(evil).state, 'editor').toBe('ok');
    expectAgree(evil, 'escaped key');
    const out = twin.fsDropPayload(evil) as Uint8Array;
    expect(new TextDecoder().decode(out)).not.toContain('export default');
  });

  it('a module in a data: BUFFER is zeroed by BOTH — agreement alone passes while both are blind', () => {
    // The `data: buffer module` row above goes through expectAgree, and it
    // agreed for as long as neither side touched a buffer other than the BIN:
    // two readers blind in the same way are byte-identical. So decode the
    // buffer and look, the way the escaped-key case does.
    const src = makeFastShadersGlb({ moduleBuffer: 'data-uri', project: PROJECT });
    const moduleOf = (bytes: Uint8Array): string => {
      const c = parseGlbContainer(bytes);
      if (!c.ok) throw new Error('container: ' + c.error);
      const doc = JSON.parse(c.chunks.json, safeJsonReviver) as { buffers: Array<{ uri?: unknown }> };
      const d = decodeDataUri(String(doc.buffers[1].uri), 'buffer', 1 << 24);
      if (!d.ok) throw new Error('buffers[1]: ' + d.error);
      return new TextDecoder().decode(d.bytes);
    };
    expect(moduleOf(src)).toContain('export default');
    const mine = dropFastShadersPayload('glb', src);
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const theirs = twin.fsDropPayload(src) as Uint8Array;
    expect(moduleOf(mine.bytes), 'editor').not.toContain('export default');
    expect(moduleOf(theirs), 'twin').not.toContain('export default');
    expectAgree(src, 'data: buffer module');
  });

  it('non-GLB bytes, a short file, a broken container after a sniff hit, and JSON that will not parse', () => {
    expectAgree(new TextEncoder().encode('{"fastshaders":1}') as Uint8Array<ArrayBuffer>, 'json text');
    expectAgree(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), 'short');
    const v3 = makeFastShadersGlb();
    v3[4] = 3;
    expectAgree(v3, 'version 3');
    expectAgree(makeGlb({ jsonText: '{"extras":{"fastshaders":' }), 'truncated JSON');
    expectAgree(makeGlb({ jsonText: '{"extras":{"fastshaders":{"v":1}}}' }), 'extras only, no views');
  });

  it('a seeded byte-mutation sweep never splits the verdicts', () => {
    const base = makeFastShadersGlb({
      module: MODULE,
      project: PROJECT,
      assets: { 'p-00000000': { mime: 'image/png', bytes: PNG } },
    });
    let seed = 0x5eed;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 300; i++) {
      const b = base.slice();
      const n = 1 + Math.floor(rand() * 4);
      for (let j = 0; j < n; j++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
      expectAgree(b, `mutation ${i}`);
    }
  });

  it('the drop removes the payload the twin read, and keeps the length', () => {
    const src = makeFastShadersGlb({ project: PROJECT });
    const out = twin.fsDropPayload(src) as Uint8Array;
    expect(out.length).toBe(src.length);
    expect(twin.fsReadGlb(out)).toEqual({ state: 'none' });
  });
});

describe('podest.html wiring (source pins)', () => {
  const dispatch = between('  function handleFiles(files) {', '  function handleZip(');
  const loadModel = between('  function loadModelBuffer(buf, name) {', '  // ── Uniform sliders');

  it('a dropped GLB is read BEFORE the model loads, only without a shader, and runs only after a confirm naming it', () => {
    const read = dispatch.indexOf('fsReadGlb(new Uint8Array(buf))');
    expect(read).toBeGreaterThan(-1);
    expect(dispatch.slice(read - 60, read)).toContain('!shader && extOf(model.name) === "glb"');
    expect(dispatch.indexOf('loadModelBuffer(buf, model.name)')).toBeGreaterThan(read);
    const confirm = dispatch.indexOf('window.confirm(');
    expect(confirm).toBeGreaterThan(read);
    expect(dispatch.slice(confirm)).toContain('fsSafeName(model.name)');
    expect(dispatch.slice(confirm)).toContain('contains a FastShaders shader');
    expect(dispatch.indexOf('loadShaderText(fsr.moduleText, model.name)')).toBeGreaterThan(confirm);
    expect(dispatch).toContain('noteRestoreLimits(!!model, !!shader || glbShader)');
  });

  it('the model is stripped before anything keeps it', () => {
    const drop = loadModel.indexOf('fsDropPayload(');
    expect(drop).toBeGreaterThan(-1);
    expect(loadModel.indexOf('state.modelBytes = ')).toBeGreaterThan(drop);
  });

  it('the work folder still lists no .glb, and no podest document spells the model opt-in', () => {
    expect(page).toMatch(/function isWorkName\(n\) \{ return \(isShaderName\(n\) && extOf\(n\) !== "txt"\) \|\| extOf\(n\) === "zip"; \}/);
    expect(page).not.toMatch(/src\s*:\s*['"]?model\b/i);
  });
});
