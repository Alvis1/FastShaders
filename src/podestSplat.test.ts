/**
 * DRIFT GUARD for podest's Gaussian-splat support, by RUNNING podest's own code.
 *
 * `public/podest.html` is a standalone vanilla page, so it cannot import the
 * editor's trusted-side sniff (`src/utils/splatSniff.ts`) and carries a
 * hand-written ES5 twin, `sniffSplatHeader`, between two anchor comments. A
 * twin that drifts refuses a file the editor opens (or opens one the editor
 * refuses) with no error anywhere — the pedestal just says something the
 * editor never would. So:
 *
 *  - the twin is sliced out between its anchors and evaluated with
 *    `new Function` (the zipReader.test.ts / podestLimits.test.ts trick), then
 *    run against the SAME corpus the TS sniff is pinned by
 *    (`SPLAT_SNIFF_CASES` in src/test-utils.ts — splatSniff.test.ts proves the
 *    corpus reaches every sentence) plus a seeded fuzz, and must give the same
 *    verdict, the same facts, the same reason and the same English sentence
 *    (`fillMeshRefusal(r, r.key, 'en')`, what the editor prints);
 *  - the four literals the three copies share are compared THREE ways:
 *    src/utils/splatLimits.ts, podest's `var` lines, and the runtime's frozen
 *    `FastShadersSplat.LIMITS` literal read from public/js/fs-splat-0.1.js
 *    inside a test (never at module top level — a missing file must fail a
 *    test, not the whole suite's import);
 *  - the stage document and the VR popup are BUILT by podest's own builders
 *    with a splat and without one: the runtime tag appears only for a splat,
 *    right after the A-Frame bundle, and nothing else in a non-splat document
 *    changes.
 *
 * Nothing here touches a global (the suite runs with `isolate: false`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sniffSplat, SPLAT_KINDS, MESH_BAD_KSPLAT_KEY, MESH_BAD_PLY_KEY, MESH_BAD_SPZ_KEY, MESH_PLY_ASCII_KEY, MESH_PLY_COMPRESSED_KEY, MESH_PLY_NOT_SPLAT_KEY, MESH_PLY_SH_KEY, MESH_PLY_TRUNCATED_KEY, MESH_SPZ_TOO_LARGE_KEY, MESH_SPZ_VERSION_KEY, type SplatKind } from '@/utils/splatSniff';
import { MESH_BAD_SPLAT_KEY, MESH_SPLAT_COUNT_KEY } from '@/utils/gltfCompression';
import { fillMeshRefusal, MESH_MAX_BYTES } from '@/utils/previewMesh';
import * as LIMITS from '@/utils/splatLimits';
import { SPLAT_RUNTIME_FILE } from '@/engine/tslToShaderModule';
import { SPLAT_SNIFF_CASES, splatAscii, splatKsplat, splatPly, splatRows, splatSpzGzip } from '@/test-utils';

const page = readFileSync(new URL('../public/podest.html', import.meta.url), 'utf8');

const TWIN_START = '  // ── Gaussian-splat header sniff: twin of src/utils/splatSniff.ts';
const TWIN_END = '  // ── end of the Gaussian-splat sniff twin ──';

/** The text between two anchors; both must exist (a moved anchor fails loudly). */
function between(from: string, to: string): string {
  const a = page.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = page.indexOf(to, a + from.length);
  expect(b, `anchor not found after ${from}: ${to}`).toBeGreaterThan(a);
  return page.slice(a, b);
}

/** A top-level function of the page, up to its closing `  }` line. */
function topLevelFunction(name: string): string {
  const start = page.indexOf(`\n  function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = page.indexOf('\n  }\n', start);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end + 4);
}

type TwinVerdict =
  | { ok: true; count: number | null; shDegree: number | null; container: string }
  | { ok: false; reason: string; message: string };

interface Twin {
  sniffSplatHeader(kind: unknown, bytes: unknown): TwinVerdict;
  isSplatExt(e: unknown): boolean;
  text: Record<string, string>;
  limits: Record<string, number>;
}

function twin(): Twin {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(
    between(TWIN_START, TWIN_END) +
      '\nreturn { sniffSplatHeader: sniffSplatHeader, isSplatExt: isSplatExt, text: SPLAT_TEXT,' +
      ' limits: { SPLAT_ROW_BYTES: SPLAT_ROW_BYTES, SPLAT_MAX_COUNT: SPLAT_MAX_COUNT, SPZ_MAX_DECODED_BYTES: SPZ_MAX_DECODED_BYTES,' +
      ' PLY_HEADER_SCAN_BYTES: PLY_HEADER_SCAN_BYTES, KSPLAT_HEADER_BYTES: KSPLAT_HEADER_BYTES, SPZ_MAGIC: SPZ_MAGIC } };',
  )() as Twin;
}

/** What podest must answer for these bytes: the TS sniff's verdict, as the editor words it. */
function expected(kind: SplatKind, bytes: Uint8Array): TwinVerdict {
  const r = sniffSplat(kind, bytes);
  if ('facts' in r) return { ok: true, ...r.facts };
  return { ok: false, reason: r.refusal.reason, message: fillMeshRefusal(r.refusal, r.refusal.key, 'en') };
}

describe('podest splat sniff twin (executed against the editor corpus)', () => {
  it('is a self-contained slice that evaluates', () => {
    const t = twin();
    expect(typeof t.sniffSplatHeader).toBe('function');
    for (const k of SPLAT_KINDS) expect(t.isSplatExt(k)).toBe(true);
    for (const k of ['obj', 'glb', 'gltf', 'SPLAT', 'zip', '', null, undefined, 'constructor', '__proto__']) {
      expect(t.isSplatExt(k), String(k)).toBe(false);
    }
  });

  it('gives the TS sniff’s verdict, facts, reason and English sentence on every case', () => {
    const t = twin();
    expect(SPLAT_SNIFF_CASES.length).toBeGreaterThan(80);
    for (const c of SPLAT_SNIFF_CASES) {
      const bytes = c.bytes();
      expect(t.sniffSplatHeader(c.kind, bytes), c.name).toEqual(expected(c.kind, bytes));
    }
  });

  it('agrees on seeded random bytes for every kind, plausible prefixes included', () => {
    const t = twin();
    let seed = 0x9e3779b9;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 400; i++) {
      const b = new Uint8Array(Math.floor(rnd() * 6000));
      for (let j = 0; j < b.length; j++) b[j] = Math.floor(rnd() * 256);
      if (i % 5 === 1) b.set(splatAscii('ply\nformat binary_little_endian 1.0\nelement vertex 7\n').subarray(0, b.length));
      if (i % 5 === 2 && b.length > 2) b.set([0x1f, 0x8b, 8]);
      if (i % 5 === 3 && b.length > 2) b.set([0, 1]);
      if (i % 5 === 4 && b.length > 8) b.set([0x4e, 0x47, 0x53, 0x50, 4, 0, 0, 0]);
      for (const kind of SPLAT_KINDS) expect(t.sniffSplatHeader(kind, b), `${kind} #${i}`).toEqual(expected(kind, b));
    }
  });

  it('reads a view at a byte offset as the file it views, like the TS sniff', () => {
    const t = twin();
    for (const [kind, file] of [['ksplat', splatKsplat()], ['ply', splatPly()], ['spz', splatSpzGzip()], ['splat', splatRows(5)]] as const) {
      const backing = new Uint8Array(file.length + 13);
      backing.set(file, 7);
      const view = backing.subarray(7, 7 + file.length);
      expect(t.sniffSplatHeader(kind, view)).toEqual(expected(kind, file));
    }
  });

  it('refuses a non-Uint8Array input and an unknown kind rather than throwing, with the TS sentence', () => {
    const t = twin();
    for (const kind of SPLAT_KINDS) {
      for (const bad of [null, undefined, 'ply\nend_header', [0x1f, 0x8b], { length: 32 }, new ArrayBuffer(32)]) {
        expect(t.sniffSplatHeader(kind, bad)).toEqual(expected(kind, bad as unknown as Uint8Array));
      }
    }
    expect(t.sniffSplatHeader('obj', new Uint8Array(32))).toEqual(expected('obj' as SplatKind, new Uint8Array(32)));
    const detached = splatKsplat();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const kind of SPLAT_KINDS) expect(() => t.sniffSplatHeader(kind, detached)).not.toThrow();
  });

  it('carries every refusal sentence of the TS sniff VERBATIM, and no other', () => {
    // The case loop proves the FILLED sentences agree; this pins the table
    // itself, so a sentence no case reaches still cannot drift.
    expect(Object.values(twin().text).sort()).toEqual([
      MESH_BAD_KSPLAT_KEY,
      MESH_BAD_PLY_KEY,
      MESH_BAD_SPLAT_KEY,
      MESH_BAD_SPZ_KEY,
      MESH_PLY_ASCII_KEY,
      MESH_PLY_COMPRESSED_KEY,
      MESH_PLY_NOT_SPLAT_KEY,
      MESH_PLY_SH_KEY,
      MESH_PLY_TRUNCATED_KEY,
      MESH_SPLAT_COUNT_KEY,
      MESH_SPZ_TOO_LARGE_KEY,
      MESH_SPZ_VERSION_KEY,
    ].sort());
  });

  it('an ASCII .ply and a 33-byte .splat are refused with the editor’s words', () => {
    const t = twin();
    expect(t.sniffSplatHeader('ply', splatPly({ format: 'ascii' }))).toEqual({ ok: false, reason: 'bad-splat', message: MESH_PLY_ASCII_KEY });
    expect(t.sniffSplatHeader('splat', new Uint8Array(33))).toEqual({ ok: false, reason: 'bad-splat', message: MESH_BAD_SPLAT_KEY });
    expect(t.sniffSplatHeader('splat', new Uint8Array((LIMITS.SPLAT_MAX_COUNT + 1) * 32))).toEqual({
      ok: false,
      reason: 'splat-count',
      message: 'Too many splats (1,000,001 — max 1,000,000). Reduce the scene in SuperSplat (or splat-transform) and export it again.',
    });
  });
});

describe('the splat literals agree three ways: splatLimits.ts, podest, the runtime', () => {
  const SHARED = ['SPLAT_MAX_COUNT', 'SPZ_MAX_DECODED_BYTES', 'PLY_HEADER_SCAN_BYTES', 'KSPLAT_HEADER_BYTES', 'SPLAT_ROW_BYTES', 'SPZ_MAGIC'] as const;

  /** podest's `var NAME = <expr>;` line, EVALUATED (the caps are written as `96 * 1024 * 1024`). */
  const podestVar = (name: string): number => {
    const m = new RegExp(`\\n  var ${name} = ([^;]+);`).exec(page);
    expect(m, `podest var ${name} not found`).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const v = Number(new Function(`return (${m![1]});`)());
    expect(Number.isFinite(v), `${name} is not a finite number`).toBe(true);
    return v;
  };

  /** The runtime's frozen LIMITS literal, evaluated from the vendored bytes. */
  const runtimeLimits = (): Record<string, number> => {
    const src = readFileSync(new URL(`../public/js/${SPLAT_RUNTIME_FILE}`, import.meta.url), 'utf8');
    const m = /Object\.freeze\((\{SPLAT_ROW_BYTES:[^}]*\})\)/.exec(src);
    expect(m, 'the runtime no longer carries its LIMITS literal').not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`return (${m![1]});`)() as Record<string, number>;
  };

  it('podest’s var lines, the evaluated twin and the runtime LIMITS all equal splatLimits.ts', () => {
    const rt = runtimeLimits();
    const tw = twin().limits;
    for (const name of SHARED) {
      const mine = LIMITS[name];
      expect(podestVar(name), `podest ${name}`).toBe(mine);
      expect(tw[name], `podest twin ${name}`).toBe(mine);
      expect(rt[name], `runtime LIMITS.${name}`).toBe(mine);
    }
    // The runtime carries the advisory too; podest has no use for it.
    expect(rt.SPLAT_HEADSET_ADVISORY_COUNT).toBe(LIMITS.SPLAT_HEADSET_ADVISORY_COUNT);
  });

  it('the model byte cap stays MESH_MAX_BYTES for every kind — no per-kind cap in podest', () => {
    expect(podestVar('MAX_SAVED_MODEL')).toBe(MESH_MAX_BYTES);
    expect(page).not.toMatch(/var (MAX_SAVED_SPLAT|SPLAT_MAX_BYTES|MAX_SPLAT_BYTES)\b/);
  });
});

/* ── the documents podest builds ─────────────────────────────────────────── */

interface Scope extends Record<string, unknown> {
  stageSplat: boolean;
}

/** Run one of podest's document builders against a stubbed page scope. */
function build(fn: 'buildStageDoc' | 'buildXrDoc', state: Record<string, unknown>): { html: string; scope: Scope } {
  const t = twin();
  // The real URL constructor resolves `new URL(".", href)`; only the blob half
  // is stubbed, so no global is touched.
  const RealURL = URL;
  // A function, not an arrow: podest calls it with `new`.
  const UrlStub = Object.assign(function (a: string, b?: string) { return new RealURL(a, b); }, {
    createObjectURL: () => 'blob:https://podest.test/model',
    revokeObjectURL() {},
  });
  const scope: Scope = {
    state: { bgColor: '#303540', spinning: false, spinSpeed: 1, values: {}, ...state },
    window: { location: { href: 'https://podest.test/FastShaders/podest.html', origin: 'https://podest.test' } },
    URL: UrlStub,
    Blob: class {},
    isHex6: (s: unknown) => /^#[0-9a-fA-F]{6}$/.test(String(s)),
    esc: (s: unknown) => String(s),
    DEFAULT_BG: '#303540',
    spinDur: () => 12000,
    pushFitBounds: (L: string[]) => L.push('<!--fit-bounds-->'),
    pushGltfAnim: (L: string[]) => L.push('<!--gltf-anim-->'),
    pushVrNav: (L: string[]) => L.push('<!--vr-nav-->'),
    STUDIO_LIGHTS: ['<a-light></a-light>'],
    jsonForScript: (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c'),
    DECODER_FILES: ['draco_wasm_wrapper.js'],
    DECODER_MAX_BYTES: 1048576,
    STAGE_BEAT_MS: 5000,
    ROTATIONS: { sphere: '45 45 0', model: '0 0 0' },
    primAttr: () => 'primitive: sphere',
    isObjKey: () => false,
    NAV_RADIUS: 30,
    NAV_INNER: 1.2,
    NAV_HOME: 2.5,
    vrModelUrl: null,
    isSplatExt: t.isSplatExt,
    stageSplat: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function('scope', `with (scope) { return (function () {${topLevelFunction(fn)}\nreturn ${fn};})(); }`);
  const html = (make(scope) as () => string)();
  return { html, scope };
}

const RUNTIME_TAG = `js/${SPLAT_RUNTIME_FILE}`;
const SPLAT_STATE = { geometry: 'model', modelKind: 'splat', modelBytes: new ArrayBuffer(32), modelName: 'garden.splat' };
const GLB_STATE = { geometry: 'model', modelKind: 'gltf', modelBytes: new ArrayBuffer(32), modelName: 'robot.glb' };

describe('the stage document carries the splat runtime only for a splat', () => {
  it('a splat model: the runtime tag right after the A-Frame bundle, and stageSplat recorded', () => {
    const { html, scope } = build('buildStageDoc', SPLAT_STATE);
    expect(scope.stageSplat).toBe(true);
    const a01 = html.indexOf('js/a-frame-180-a-01.min.js');
    const rt = html.indexOf(RUNTIME_TAG);
    const loader = html.indexOf('js/a-frame-shaderloader-0.8.js');
    expect(a01).toBeGreaterThan(-1);
    expect(rt).toBeGreaterThan(a01);
    expect(loader).toBeGreaterThan(rt);
    expect(html.split(RUNTIME_TAG).length - 1).toBe(1);
    // Nothing between the two tags but the newline.
    expect(html.slice(html.indexOf('</script>', a01) + '</script>'.length, html.lastIndexOf('<script', rt))).toBe('\n');
  });

  it.each([
    ['a glb model', GLB_STATE],
    ['an obj model', { ...GLB_STATE, modelKind: 'obj', modelName: 'rock.obj' }],
    ['no model', { geometry: 'sphere', modelKind: null, modelBytes: null }],
    ['a forged kind', { ...GLB_STATE, modelKind: 'splatx' }],
  ])('%s: no runtime tag, and the document is exactly the no-model one', (_why, state) => {
    const { html, scope } = build('buildStageDoc', state);
    expect(html).not.toContain(RUNTIME_TAG);
    expect(scope.stageSplat).toBe(false);
    expect(html).toBe(build('buildStageDoc', { geometry: 'sphere', modelKind: null, modelBytes: null }).html);
  });

  it('the splat document differs from the plain one by the runtime tag ALONE', () => {
    const plain = build('buildStageDoc', GLB_STATE).html.split('\n');
    const splat = build('buildStageDoc', SPLAT_STATE).html.split('\n');
    expect(splat.filter((l) => !l.includes(RUNTIME_TAG))).toEqual(plain);
  });
});

describe('the VR popup carries the splat runtime and splat-model only for a splat', () => {
  it('a splat: runtime after the bundle, one splat-model entity with fit-bounds and no gltf-anim', () => {
    for (const kind of SPLAT_KINDS) {
      const { html } = build('buildXrDoc', { ...SPLAT_STATE, modelKind: kind });
      const a01 = html.indexOf('js/a-frame-180-a-01.min.js');
      const rt = html.indexOf(RUNTIME_TAG);
      expect(rt, kind).toBeGreaterThan(a01);
      expect(html.indexOf('js/a-frame-shaderloader-0.8.js'), kind).toBeGreaterThan(rt);
      const entity = html.split('\n').find((l) => l.includes('id="preview-entity"'))!;
      expect(entity, kind).toContain(`splat-model="src: url(blob:https://podest.test/model); kind: ${kind}; size: 1.6"`);
      expect(entity, kind).toContain('fit-bounds="size: 1.6; regen: false"');
      expect(entity, kind).not.toContain('gltf-anim');
      expect(entity, kind).not.toContain('gltf-model');
    }
  });

  it('a glb keeps its gltf-model entity and no runtime tag', () => {
    const { html } = build('buildXrDoc', GLB_STATE);
    expect(html).not.toContain(RUNTIME_TAG);
    expect(html).not.toContain('splat-model');
    expect(html).toContain('gltf-model="url(blob:https://podest.test/model)"');
  });

  it('a built-in shape shows no runtime and no splat-model even with a splat loaded', () => {
    const { html } = build('buildXrDoc', { ...SPLAT_STATE, geometry: 'sphere' });
    expect(html).not.toContain(RUNTIME_TAG);
    expect(html).not.toContain('splat-model');
  });
});

describe('podest wiring (source pins)', () => {
  it('isModelName takes the four splat kinds, through the twin’s exact whitelist', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const isModelName = new Function(
      between(TWIN_START, TWIN_END) + topLevelFunction('extOf') + topLevelFunction('isModelName') + '\nreturn isModelName;',
    )() as (n: string) => boolean;
    for (const n of ['a.splat', 'b.SPZ', 'c.ply', 'd.ksplat', 'e.glb', 'f.gltf', 'g.obj']) expect(isModelName(n), n).toBe(true);
    for (const n of ['a.js', 'b.zip', 'c.splatx', 'd', 'e.ply.txt']) expect(isModelName(n), n).toBe(false);
  });

  it('loadModelBuffer sniffs a splat BEFORE anything keeps the bytes, and records the extension as the kind', () => {
    const src = topLevelFunction('loadModelBuffer');
    const sniff = src.indexOf('sniffSplatHeader(ext, new Uint8Array(ab))');
    expect(sniff).toBeGreaterThan(-1);
    expect(src.indexOf('state.modelBytes = ')).toBeGreaterThan(sniff);
    expect(src.indexOf('return false;', sniff)).toBeLessThan(src.indexOf('state.modelBytes = '));
    expect(src).toContain('state.modelKind = ext === "obj" ? "obj" : isSplatExt(ext) ? ext : "gltf";');
  });

  it('a splat needs no decoder, and setGeometry rebuilds a runtime-less stage for it', () => {
    // Executed on its own, as podestDecoders.test.ts runs it: even bytes that
    // spell a glTF decoder extension ask for nothing under a splat kind.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const decoderFiles = new Function(
      between('  var DECODER_FILES = ', '  // One fetch per file') + '\nreturn modelDecoderFiles;',
    )() as (b: unknown, k: string) => string[];
    const draco = new TextEncoder().encode('{"extensionsUsed":["KHR_draco_mesh_compression"]}').buffer;
    expect(decoderFiles(draco, 'gltf')).toHaveLength(2); // the scan itself still works
    for (const kind of SPLAT_KINDS) expect(decoderFiles(draco, kind), kind).toEqual([]);
    const geo = topLevelFunction('setGeometry');
    expect(geo).toContain('if (isSplatExt(mk) && !stageSplat) { reloadStageForSplat(); return; }');
    // The rebuild is not a failure restart: no streak, no rate limit.
    const reload = topLevelFunction('reloadStageForSplat');
    expect(reload).not.toContain('restartStreak');
    expect(reload).toContain('stage.setAttribute("srcdoc", buildStageDoc());');
  });

  it('the stage’s setModel has a splat branch: a blob, splat-model, fit-bounds, no gltf-anim; clearGeo removes it', () => {
    const line = page.split('\n').find((l) => l.includes("L.push('  function setModel("))!;
    const body = line.trim().replace(/^L\.push\('/, '').replace(/'\);$/, '');
    const attrs: [string, string][] = [];
    const entity = { setAttribute: (k: string, v: string) => attrs.push([k, v]) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const setModel = new Function(
      'window', 'FastShaders', 'entity', 'attached', 'URL', 'Blob', 'clearGeo', 'fillDec', 'reportUniforms',
      'var modelUrl=null;' + body + '\nreturn setModel;',
    )({}, undefined, entity, false, { createObjectURL: () => 'blob:s', revokeObjectURL() {} }, class {}, () => {}, () => {}, () => {});
    for (const kind of SPLAT_KINDS) {
      attrs.length = 0;
      setModel(kind, new ArrayBuffer(32), false, '0 0 0', null);
      expect(attrs, kind).toEqual([
        ['fit-bounds', 'size: 1.6; regen: false'],
        ['splat-model', `src: url(blob:s); kind: ${kind}; size: 1.6`],
        ['rotation', '0 0 0'],
      ]);
    }
    attrs.length = 0;
    setModel('gltf', new ArrayBuffer(4), false, '0 0 0', null);
    expect(attrs.map((a) => a[0])).toEqual(['fit-bounds', 'gltf-anim', 'gltf-model', 'rotation']);
    const clearGeo = page.split('\n').find((l) => l.includes("L.push('  function clearGeo("))!;
    expect(clearGeo).toContain('entity.removeAttribute("splat-model");');
  });

  it('a splat is never a part, and model-error prefers the event’s own message', () => {
    const meshList = page.split('\n').find((l) => l.includes("L.push('  function meshList("))!;
    expect(meshList).toContain('if(n.isMesh&&!n.isGaussianSplat)out.push(n);');
    // Both documents (stage and VR popup) name the splat runtime's refusal.
    expect(page.split('var dm=ev&&ev.detail&&ev.detail.message;if(typeof dm==="string")why=dm.slice(0,1000);').length - 1).toBe(2);
  });

  it('a refused model outlives the shader dropped beside it', () => {
    const files = topLevelFunction('handleFiles');
    expect(files).toContain('if (!loadModelBuffer(buf, model.name)) { modelRefusal = lastModelRefusal; return false; }');
    expect(files).toContain('if (modelRefusal) { showError(modelRefusal); return; }');
    const zip = topLevelFunction('handleZip');
    expect(zip.indexOf('if (modelRefusal && !quiet) showError(modelRefusal);')).toBeGreaterThan(zip.indexOf('loadShaderText('));
  });

  it('the session replay keeps a splat’s kind in its fallback name', () => {
    expect(topLevelFunction('applyRestored')).toContain('isSplatExt(rec.modelKind) ? "model." + rec.modelKind : "model.glb"');
  });

  it('every hint that lists model extensions lists all seven', () => {
    // The page's header comment keeps meshes and splats as two bullets.
    expect(page).toContain('    • Gaussian splat scene (.splat / .spz / .ply / .ksplat)');
    const lists = page.split('\n').filter((l) => /\.glb ?\/ ?\.gltf ?\/ ?\.obj/.test(l) && !l.trim().startsWith('•'));
    expect(lists.length).toBeGreaterThanOrEqual(4);
    for (const l of lists) {
      expect(l.replace(/\s/g, ''), l.trim()).toMatch(/\.splat\/\.spz\/\.ply\/\.ksplat/);
    }
    expect(page).toContain('accept=".js,.mjs,.tsl,.txt,.glb,.gltf,.obj,.splat,.spz,.ply,.ksplat,.zip"');
  });
});
