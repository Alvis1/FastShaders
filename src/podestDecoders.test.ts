/**
 * Podest's half of the mesh decoders (public/podest.html). Podest is a
 * standalone vanilla page the app cannot import, so these run podest's OWN
 * code, cut out of the page with `new Function` (the podestLimits.test.ts
 * pattern): which decoder files a dropped model needs (the parent's substring
 * scan, fed adversarial buffers), and what the sandboxed stage accepts from the
 * parent (its `fillDec`). The wiring around them needs a DOM the node env does
 * not have, so it is source-pinned.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DECODER_FILES, MAX_DECODER_FILE_BYTES } from './utils/meshDecoders';

const REPO = path.resolve(__dirname, '..');
const page = readFileSync(path.join(REPO, 'public/podest.html'), 'utf8');

/** The text between two anchors; both must exist (a moved anchor fails loudly). */
function between(from: string, to: string, fromIndex = 0): string {
  const a = page.indexOf(from, fromIndex);
  expect(a, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = page.indexOf(to, a + from.length);
  expect(b, `anchor not found after ${from}: ${to}`).toBeGreaterThan(a);
  return page.slice(a, b);
}

/** A top-level function's source: up to the next top-level function or section marker. */
function fnSource(name: string): string {
  const start = page.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const ends = ['\n  function ', '\n  var ', '\n  // ──']
    .map((m) => page.indexOf(m, start + 1))
    .filter((i) => i > start);
  return page.slice(start, Math.min(...ends));
}

interface ScanApi {
  files: string[];
  max: number;
  modelDecoderFiles(buf: unknown, modelKind: string): string[];
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const scan = new Function(
  between('  var DECODER_FILES = ', '  // One fetch per file') +
    '\nreturn { files: DECODER_FILES, max: DECODER_MAX_BYTES, modelDecoderFiles: modelDecoderFiles };',
)() as ScanApi;

const WRAPPER = DECODER_FILES.dracoWrapper;
const WASM = DECODER_FILES.dracoWasm;
const MESHOPT = DECODER_FILES.meshopt;
const BASIS_JS = DECODER_FILES.basisJs;
const BASIS_WASM = DECODER_FILES.basisWasm;

const fixture = (f: string): ArrayBuffer => {
  const b = readFileSync(path.join(REPO, 'src/engine/fixtures/compressed', f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const fixtureKtx2 = (f: string): ArrayBuffer => {
  const b = readFileSync(path.join(REPO, 'src/engine/fixtures/ktx2', f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** A minimal GLB whose JSON chunk is `json` (its declared length is `claim`). */
function glbWith(json: string, claim?: number): ArrayBuffer {
  const chunk = new TextEncoder().encode(json);
  const out = new Uint8Array(20 + chunk.length);
  const view = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, claim ?? chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(chunk, 20);
  return out.buffer;
}

const text = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('podest decoders: the vocabulary and the cap', () => {
  it('names the loader\'s five files and the editor\'s 1 MiB cap', () => {
    expect(scan.files).toEqual(Object.values(DECODER_FILES));
    expect(scan.files).toHaveLength(5);
    expect(scan.max).toBe(MAX_DECODER_FILE_BYTES);
  });
});

describe('podest decoders: which files a model needs (executed)', () => {
  it('a Draco GLB needs the wrapper and the wasm', () => {
    expect(scan.modelDecoderFiles(fixture('tri-draco.glb'), 'gltf')).toEqual([WRAPPER, WASM]);
  });

  it('a meshopt GLB needs the meshopt module', () => {
    expect(scan.modelDecoderFiles(fixture('quad-meshopt.glb'), 'gltf')).toEqual([MESHOPT]);
  });

  it('a KTX2 GLB needs the basis transcoder pair', () => {
    const ktx2 = fixtureKtx2('quad-uastc-required.glb');
    expect(scan.modelDecoderFiles(ktx2, 'gltf')).toEqual([BASIS_JS, BASIS_WASM]);
    // …beside Draco, it needs all four.
    expect(
      scan.modelDecoderFiles(
        text('{"extensionsUsed":["KHR_draco_mesh_compression","KHR_texture_basisu"]}'),
        'gltf',
      ),
    ).toEqual([WRAPPER, WASM, BASIS_JS, BASIS_WASM]);
  });

  it('an uncompressed GLB needs nothing', () => {
    expect(scan.modelDecoderFiles(glbWith('{"asset":{"version":"2.0"}}'), 'gltf')).toEqual([]);
  });

  it('a .gltf text is scanned whole, for both meshopt spellings', () => {
    expect(scan.modelDecoderFiles(text('{"extensionsUsed":["KHR_draco_mesh_compression"]}'), 'gltf')).toEqual([WRAPPER, WASM]);
    expect(scan.modelDecoderFiles(text('{"extensionsUsed":["KHR_meshopt_compression"]}'), 'gltf')).toEqual([MESHOPT]);
    expect(
      scan.modelDecoderFiles(text('{"extensionsUsed":["EXT_meshopt_compression","KHR_draco_mesh_compression"]}'), 'gltf'),
    ).toEqual([WRAPPER, WASM, MESHOPT]);
  });

  it('never scans an OBJ, whatever its text says', () => {
    expect(scan.modelDecoderFiles(text('# "KHR_draco_mesh_compression"\nv 0 0 0\n'), 'obj')).toEqual([]);
  });

  it('only a QUOTED extension name counts', () => {
    expect(scan.modelDecoderFiles(text('KHR_draco_mesh_compression'), 'gltf')).toEqual([]);
  });

  it('degrades to nothing, never a throw, on a truncated, mis-chunked or junk buffer', () => {
    const draco = glbWith('{"extensionsUsed":["KHR_draco_mesh_compression"]}');
    expect(scan.modelDecoderFiles(draco.slice(0, 10), 'gltf')).toEqual([]);
    const binFirst = new Uint8Array(draco.slice(0));
    new DataView(binFirst.buffer).setUint32(16, 0x004e4942, true); // a BIN chunk first
    expect(scan.modelDecoderFiles(binFirst.buffer, 'gltf')).toEqual([]);
    expect(scan.modelDecoderFiles(new Uint8Array(64).buffer, 'gltf')).toEqual([]);
    expect(scan.modelDecoderFiles(new ArrayBuffer(0), 'gltf')).toEqual([]);
    expect(scan.modelDecoderFiles(null, 'gltf')).toEqual([]);
    expect(scan.modelDecoderFiles(new Uint8Array(draco), 'gltf')).toEqual([]); // a view, not a buffer
  });

  it('clamps a JSON chunk length that overruns the buffer to what is there', () => {
    const lying = glbWith('{"extensionsUsed":["KHR_draco_mesh_compression"]}', 0x7fffffff);
    expect(scan.modelDecoderFiles(lying, 'gltf')).toEqual([WRAPPER, WASM]);
  });
});

describe('podest decoders: what the stage accepts (executed)', () => {
  const line = page.split('\n').find((l) => l.includes("L.push('  function fillDec("));
  const body = (line ?? '').trim().replace(/^L\.push\('/, '').replace(/'\);$/, '');
  type Fill = (dec: unknown) => void;
  const minted: string[] = [];
  function stage(): { table: Record<string, string>; fill: Fill } {
    const table = Object.create(null) as Record<string, string>;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fill = new Function('window', 'DEC_FILES', 'DEC_MAX', body + '\nreturn fillDec;')(
      { __fsDecoderUrls: table },
      scan.files,
      scan.max,
    ) as Fill;
    return { table, fill };
  }
  afterEach(() => {
    for (const t of minted.splice(0)) URL.revokeObjectURL(t);
  });

  it('is one pushed line that needs no unescaping', () => {
    expect(line, 'podest.html is missing its fillDec push').toBeTruthy();
    expect(body).not.toContain("\\'");
  });

  it('mints a blob: URL per known file, with its type', async () => {
    const { table, fill } = stage();
    fill({
      [WRAPPER]: 'self.x = 1;',
      [WASM]: new Uint8Array([0, 97, 115, 109]).buffer,
      [MESHOPT]: 'export {};',
      [BASIS_JS]: 'self.BASIS = 1;',
      [BASIS_WASM]: new Uint8Array([0, 97, 115, 109]).buffer,
    });
    expect(Object.keys(table).sort()).toEqual([WASM, WRAPPER, MESHOPT, BASIS_JS, BASIS_WASM].sort());
    minted.push(...Object.values(table));
    for (const u of Object.values(table)) expect(u).toMatch(/^blob:/);
  });

  it('refuses the wrong type, an empty or oversize file, and every other key', () => {
    const { table, fill } = stage();
    fill({
      [WRAPPER]: new ArrayBuffer(4), // a .js file must be text
      [WASM]: 'AGFzbQ==', // the wasm must be bytes
      [MESHOPT]: 'x'.repeat(scan.max + 1),
      [BASIS_JS]: new ArrayBuffer(4), // a .js file must be text
      [BASIS_WASM]: new ArrayBuffer(scan.max + 1),
      'evil.js': 'alert(1)',
      __proto__: { [WRAPPER]: 'inherited' },
    });
    expect(Object.keys(table)).toEqual([]);
    fill({ [WRAPPER]: '', [WASM]: new ArrayBuffer(0) });
    expect(Object.keys(table)).toEqual([]);
    fill(null);
    fill('junk');
    expect(Object.keys(table)).toEqual([]);
  });

  it('keeps a filled slot', () => {
    const { table, fill } = stage();
    fill({ [WRAPPER]: 'first' });
    const first = table[WRAPPER];
    fill({ [WRAPPER]: 'second' });
    expect(table[WRAPPER]).toBe(first);
    minted.push(first);
  });
});

describe('podest decoders: a new model forgets the last decoder error (executed)', () => {
  // The stage document outlives every drop and model-error shows
  // FastShaders.decoders.lastError first, so a stale "meshopt data would
  // unpack to ..." would be reported as the cause of an unrelated failure.
  const line = page.split('\n').find((l) => l.includes("L.push('  function setModel("));
  const body = (line ?? '').trim().replace(/^L\.push\('/, '').replace(/'\);$/, '');

  it('setModel clears it before anything else, and never throws without the loader', () => {
    expect(line, 'podest.html is missing its setModel push').toBeTruthy();
    const order: string[] = [];
    const decoders = { lastError: 'meshopt data would unpack to 300 MB', clearError() { order.push('clear'); this.lastError = ''; } };
    const entity = { setAttribute: () => order.push('attr') };
    const make = (win: object, fs: unknown) =>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(
        'window', 'FastShaders', 'entity', 'attached', 'URL', 'Blob', 'clearGeo', 'fillDec', 'reportUniforms',
        'var modelUrl=null;' + body + '\nreturn setModel;',
      )(win, fs, entity, false, { createObjectURL: () => 'blob:m', revokeObjectURL() {} }, class {}, () => order.push('clearGeo'), () => order.push('fillDec'), () => {});
    make({ FastShaders: { decoders } }, { decoders })('glb', new ArrayBuffer(4), false, '', null);
    expect(decoders.lastError).toBe('');
    expect(order.slice(0, 3)).toEqual(['clear', 'clearGeo', 'fillDec']);
    expect(() => make({}, undefined)('glb', new ArrayBuffer(4), false, '', null)).not.toThrow();
  });
});

describe('podest decoders: the wiring (source)', () => {
  it('the parent fetches js/decoders/<file> beside the page, once per file, forgetting a failure', () => {
    const src = fnSource('fetchDecoder');
    expect(src).toContain('new URL("js/decoders/" + f, window.location.href)');
    expect(src).toContain('if (decoderFetches[f] === p) delete decoderFetches[f];');
    expect(src).toContain('DECODER_MAX_BYTES');
    // Bytes vs text is decided by the SUFFIX, so both wasm files take the
    // ArrayBuffer branch and a file added to DECODER_FILES cannot be missed.
    expect(src).toContain('f.slice(-5) === ".wasm" ? ab : new TextDecoder().decode(ab)');
  });

  it('the stage table fill picks its type by the same .wasm suffix', () => {
    const line = page.split('\n').find((l) => l.includes("L.push('  function fillDec("));
    expect(line).toBeTruthy();
    expect(line!).toContain('w=n.slice(-5)===".wasm"');
    expect(line!).toContain('type:w?"application/wasm":"text/javascript"');
  });

  it('a failed file is named by its own decoder, never by an index guess', () => {
    const src = fnSource('decoderLabel');
    expect(src).toContain('if (f === DECODER_FILES[2]) return "meshopt";');
    expect(src).toContain('if (f === DECODER_FILES[3] || f === DECODER_FILES[4]) return "KTX2";');
    expect(fnSource('setGeometry')).toContain('decoderLabel(err && err.file)');
  });

  it('a model load records what it needs; a switch to it waits for the bytes, newest switch wins', () => {
    expect(fnSource('loadModelBuffer')).toContain('state.modelDecoderFiles = modelDecoderFiles(ab, state.modelKind);');
    const src = fnSource('setGeometry');
    expect(src).toContain('fetchDecoder(f)');
    expect(src.split('if (seq !== geometrySeq) return;')).toHaveLength(3);
    expect(src).toContain('if (dec) msg.decoders = dec;');
    // A failed fetch is reported AND the model still goes: the stage then fails
    // fast with model-error rather than waiting on a model that never comes.
    expect(src).toMatch(/showError\("Could not load the " \+[^;]*" decoder: "[^;]*;\s*send\(null\);/);
  });

  it('the stage configures the table right after the loader, and fills it before gltf-model is set', () => {
    const stageDoc = fnSource('buildStageDoc');
    const loader = stageDoc.indexOf(`'<script src="' + loader + '"`);
    const configure = stageDoc.indexOf(
      "L.push('<script>window.__fsDecoderUrls=Object.create(null);try{FastShaders.decoders.configure({resolve:function(f){return window.__fsDecoderUrls[f]||null;}});}catch(e){}",
    );
    const orbit = stageDoc.indexOf(`'<script src="' + orbit + '"`);
    expect(loader).toBeGreaterThan(-1);
    expect(configure).toBeGreaterThan(loader);
    expect(orbit).toBeGreaterThan(configure);
    const setModel = page.split('\n').find((l) => l.includes("L.push('  function setModel("));
    expect(setModel).toBeTruthy();
    expect(setModel!.indexOf('fillDec(dec)')).toBeGreaterThan(-1);
    expect(setModel!.indexOf('fillDec(dec)')).toBeLessThan(setModel!.indexOf('setAttribute("gltf-model"'));
    expect(page).toContain('case"fs:model":setModel(m.modelType,m.bytes,m.regen,m.rotation,m.decoders);break;');
    expect(page).toContain("L.push('  var DEC_FILES=' + jsonForScript(DECODER_FILES) + ',DEC_MAX=' + DECODER_MAX_BYTES + ';');");
  });

  it('the VR popup configures same-origin js/decoders/ URLs when it shows a dropped model', () => {
    const xr = fnSource('buildXrDoc');
    const gate = xr.indexOf('if (kind === "model" && state.modelBytes) {\n      var decUrls');
    expect(gate).toBeGreaterThan(-1);
    expect(xr).toContain('decUrls[f] = dir + "js/decoders/" + f;');
    expect(xr).toContain('FastShaders.decoders.configure({resolve:function(f){return Object.prototype.hasOwnProperty.call(__fsDec,f)?__fsDec[f]:null;}})');
    // …after the loader script, which it configures.
    expect(gate).toBeGreaterThan(xr.indexOf(`'<script src="' + loader + '"`));
  });

  it('both model-error texts name a decoder cap, and none still calls compression unsupported', () => {
    expect(page).not.toContain('DRACO/meshopt-compressed glTF - not supported');
    expect(page.split('compressed in a way Podest cannot decode').length - 1).toBe(2);
    expect(page.split('var d=window.FastShaders&&FastShaders.decoders;if(d&&typeof d.lastError==="string")why=d.lastError;').length - 1).toBe(2);
  });
});
