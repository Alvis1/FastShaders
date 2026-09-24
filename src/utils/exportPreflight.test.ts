/**
 * The export pre-flight (N1) — the pure decision, its agreement with the zip
 * READER's boundary, the strings, and the wiring of the three user surfaces.
 *
 * The vitest env is `node`, so the dialog and the surfaces cannot be rendered:
 * their wiring is pinned from source, the same way every other surface here is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '@/i18n';
import { makeNode } from '@/test-utils';
import { collectImageFiles } from './imageNode';
import { buildExportBundle, type ExportMesh } from './exportBundle';
import { planExportPreflight, planDesktopOnlyExport, planSingleGlbPreflight, type ExportPreflightChoice } from './exportPreflight';
import { GLB_READ_MAX_BYTES } from './gltfCompression';
import type { GlbRepackSize } from './glbRepack';
import {
  MAX_ENTRIES,
  MAX_TOTAL_UNCOMPRESSED,
  DESKTOP_MAX_TOTAL_UNCOMPRESSED,
  READ_MAX_TOTAL_UNCOMPRESSED,
  isZipLimitError,
  readZip,
} from './zipReader';
import { preflightKeydown } from '@/components/Modals/ExportPreflightModal';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const size = (
  unpackedBytes: number,
  meshBytes = 0,
  unpackedBytesWithoutMesh = unpackedBytes,
  entryCount = 1,
  entryCountWithoutMesh = entryCount,
) => ({
  unpackedBytes,
  meshBytes,
  unpackedBytesWithoutMesh,
  entryCount,
  entryCountWithoutMesh,
});

describe('planExportPreflight: the decision', () => {
  const L = 1000;

  it('fits EXACTLY at the limit, and is too large one byte past it', () => {
    expect(planExportPreflight(size(L), L)).toBeNull();
    expect(planExportPreflight(size(L - 1), L)).toBeNull();
    expect(planExportPreflight(size(L + 1), L)).toEqual({
      sizeBytes: L + 1,
      limitBytes: L,
      entryCount: 1,
      entryLimit: MAX_ENTRIES,
      overSize: true,
      overEntries: false,
      withoutModel: null,
    });
  });

  it("asks on the ENTRY count too, at the reader's own boundary, whatever the size", () => {
    expect(planExportPreflight(size(10, 0, 10, MAX_ENTRIES))).toBeNull();
    expect(planExportPreflight(size(10, 0, 10, MAX_ENTRIES + 1))).toEqual({
      sizeBytes: 10,
      limitBytes: MAX_TOTAL_UNCOMPRESSED,
      entryCount: MAX_ENTRIES + 1,
      entryLimit: MAX_ENTRIES,
      overSize: false,
      overEntries: true,
      withoutModel: null,
    });
    // Both caps crossed: both flagged, so the dialog can name both.
    expect(planExportPreflight(size(L + 1, 0, L + 1, 9), L, 8)).toMatchObject({
      overSize: true,
      overEntries: true,
    });
    // Dropping the model's one entry brings the count back within: offered.
    expect(planExportPreflight(size(10, 4, 6, MAX_ENTRIES + 1, MAX_ENTRIES))?.withoutModel).toEqual({
      modelBytes: 4,
      sizeBytes: 6,
    });
    // The size fits without the model but the count still does not: not offered.
    expect(planExportPreflight(size(L + 500, 500, L, 10, 9), L, 8)?.withoutModel).toBeNull();
    // The count fits without the model but the size still does not: not offered.
    expect(planExportPreflight(size(L + 500, 100, L + 1, 9, 8), L, 8)?.withoutModel).toBeNull();
  });

  it("defaults to the reader's own cap", () => {
    const plan = planExportPreflight(size(MAX_TOTAL_UNCOMPRESSED + 1));
    expect(plan?.limitBytes).toBe(MAX_TOTAL_UNCOMPRESSED);
    expect(planExportPreflight(size(MAX_TOTAL_UNCOMPRESSED))).toBeNull();
  });

  it('offers the without-model export only when a model rides along AND dropping it fits', () => {
    // Dropping the model lands exactly on the limit: offered (<= fits).
    expect(planExportPreflight(size(L + 500, 500, L), L)?.withoutModel).toEqual({
      modelBytes: 500,
      sizeBytes: L,
    });
    // Comfortably under without the model.
    expect(planExportPreflight(size(L + 500, 600, L - 100), L)?.withoutModel).toEqual({
      modelBytes: 600,
      sizeBytes: L - 100,
    });
    // No model in the bundle: never offered.
    expect(planExportPreflight(size(L + 500, 0, L + 500), L)?.withoutModel).toBeNull();
    // Still over without the model: not offered (the button would not help).
    expect(planExportPreflight(size(L + 500, 100, L + 1), L)?.withoutModel).toBeNull();
  });

  it('agrees with the real builder and the real reader at an injected limit', async () => {
    const img = { name: 'tex.png', bytes: new Uint8Array(10) as Uint8Array<ArrayBuffer> };
    const glb = new Uint8Array(1000);
    glb.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    const mesh: ExportMesh = { name: 'rock.glb', kind: 'glb', bytes: glb as Uint8Array<ArrayBuffer> };
    const b = buildExportBundle('s', 'x', [img], mesh);
    const limit = b.unpackedBytesWithoutMesh;
    const plan = planExportPreflight(b, limit);
    expect(plan).not.toBeNull();
    expect(plan?.withoutModel).toEqual({ modelBytes: 1000, sizeBytes: limit });

    // The without-model export really is that size, as the reader counts it.
    const small = buildExportBundle('s', 'x', [img], null);
    const entries = await readZip(small.bytes);
    const readBack = entries.reduce((s, e) => s + e.data.length, 0);
    expect(readBack).toBe(limit);
    expect(readBack).toBeLessThanOrEqual(limit);
  });

  it('catches the ENTRY cap the real builder reaches with tiny images and the real reader refuses', async () => {
    // One `images/` entry per DISTINCT image: a zip of tiny distinct images is
    // far under every byte cap and still unreadable past MAX_ENTRIES.
    const imgs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `i${i}.png`, bytes: new Uint8Array(64) as Uint8Array<ArrayBuffer> }));
    const refusal = (bytes: Uint8Array) =>
      readZip(bytes).then(
        () => null,
        (e: unknown) => (isZipLimitError(e) ? e.kind : 'other'),
      );

    // .js + 510 images + README = 512 entries: the reader opens it, no dialog.
    const fits = buildExportBundle('s', 'x', imgs(510), null);
    expect(fits.entryCount).toBe(MAX_ENTRIES);
    expect(await refusal(fits.bytes)).toBeNull();
    expect(planExportPreflight(fits)).toBeNull();

    // One image more: tiny, refused by the reader, so the pre-flight must ask.
    const over = buildExportBundle('s', 'x', imgs(511), null);
    expect(over.unpackedBytes).toBeLessThan(MAX_TOTAL_UNCOMPRESSED / 1000);
    expect(await refusal(over.bytes)).toBe('entry-count');
    expect(planExportPreflight(over)).toMatchObject({
      overSize: false,
      overEntries: true,
      entryCount: MAX_ENTRIES + 1,
      withoutModel: null,
    });

    // A model moves the threshold one image down, and dropping it brings the
    // count back within, so the model button is offered — and its bundle opens.
    const glb = new Uint8Array(64);
    glb.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    const mesh: ExportMesh = { name: 'rock.glb', kind: 'glb', bytes: glb as Uint8Array<ArrayBuffer> };
    const withModel = buildExportBundle('s', 'x', imgs(510), mesh);
    expect(await refusal(withModel.bytes)).toBe('entry-count');
    expect(planExportPreflight(withModel)?.withoutModel).toEqual({
      modelBytes: 64,
      sizeBytes: withModel.unpackedBytesWithoutMesh,
    });
    const dropped = buildExportBundle('s', 'x', imgs(510), null);
    expect(dropped.entryCount).toBe(withModel.entryCountWithoutMesh);
    expect(await refusal(dropped.bytes)).toBeNull();
  });

  it('Ctrl+D copies do NOT reach the entry cap: byte-identical images are ONE entry', async () => {
    // What CLAUDE.md's N1 (f) and exportPreflight.ts's header say: a manual
    // entry-cap test needs DISTINCT images; 511 copies of one make 3 entries.
    const copies = Array.from({ length: MAX_ENTRIES - 1 }, (_, i) =>
      makeNode(`i${i}`, 'imageNode', { imageB64: 'data:image/png;base64,AAAA', width: 1, height: 1, fileName: 'tex.png' }),
    );
    const b = buildExportBundle('s', 'x', collectImageFiles(copies), null);
    expect(b.entryCount).toBe(3);
    expect((await readZip(b.bytes)).map((e) => e.name)).toEqual(['s.js', 'images/tex.png', 'README.txt']);
    expect(planExportPreflight(b)).toBeNull();
  });

  it("keeps `<=` the reader's boundary: every readZip cap check is a strict `>`", () => {
    const zip = read('utils/zipReader.ts');
    expect(zip).toContain('count > MAX_ENTRIES');
    // The SUM cap is readZip's `maxTotal` parameter since the desktop room
    // (default READ_MAX_TOTAL_UNCOMPRESSED); the comparison stays strict.
    expect(zip).toContain('totalDeclared > maxTotal');
    expect(zip).toContain('d.comp.length > remaining');
    expect(zip).toContain('total > maxBytes');
  });
});

describe('export pre-flight: the three user surfaces are wired, the study is not', () => {
  it('Toolbar EXPORT branches to the study finish dialog BEFORE the pre-flight', () => {
    const src = read('components/Layout/Toolbar.tsx');
    const call = src.indexOf('buildShaderExportChecked(');
    expect(call).toBeGreaterThan(-1);
    const handler = src.lastIndexOf('onClick={() => {', call);
    const evalBranch = src.lastIndexOf('if (isEvalMode()) {', call);
    expect(evalBranch).toBeGreaterThan(handler);
    expect(src.slice(evalBranch, call)).toContain('setEvalFinishOpen(true)');
    // No unchecked download left anywhere in the toolbar.
    expect(src).not.toMatch(/downloadShader\(\s*\)/);
  });

  it("NEW's export finishes the pre-flight before it claims a file, and never resets the graph", () => {
    // The two used to be ONE callback, where a cancelled pre-flight `return`ed
    // and so abandoned NEW as well. They are separate answers now: the export
    // must still bail on a cancelled pre-flight — reporting FALSE, so the
    // dialog does not say "Exported!" about a file nobody wrote — and it must
    // not touch the graph, which is the other button's job.
    const src = read('components/NodeEditor/NodeEditor.tsx');
    const start = src.indexOf('const exportCurrentShader');
    const end = src.indexOf('const startNewShader');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('await buildShaderExportChecked(');
    expect(body).toContain('if (!bundle) return false');
    expect(body).toContain('downloadShader(bundle);');
    expect(body).not.toContain('newGraph()');
    expect(src).not.toMatch(/downloadShader\(\s*\)/);
  });

  it('the Work-folder Save runs the pre-flight BEFORE it derives the target name', () => {
    const src = read('components/Layout/WorkFolder.tsx');
    const checked = src.indexOf('buildShaderExportChecked(');
    const target = src.indexOf('workFolderSaveName(tracked');
    expect(checked).toBeGreaterThan(-1);
    expect(target).toBeGreaterThan(checked);
    expect(src).not.toMatch(/buildShaderBundle\(\s*\)/);
  });

  it('the study package never pauses on the dialog', () => {
    const src = read('eval/SusModal.tsx');
    expect(src).toContain('buildShaderBundle()');
    expect(src).not.toContain('buildShaderBundleChecked');
  });

  it('the wrapper skips under isEvalMode and the model override is one build only', () => {
    const src = read('engine/exportShader.ts');
    const fn = src.slice(src.indexOf('export async function buildShaderBundleChecked'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('isEvalMode()');
    expect(body).toContain('buildShaderBundle({ includeMesh: false })');
    expect(src).toContain('opts.includeMesh ?? state.exportIncludeMesh');
    // The override is never written back to the session flag.
    expect(src).not.toContain('setExportIncludeMesh');
    // The telemetry chokepoint stays on the download tail. (A regex, not the
    // literal call text: evalHooks.test.ts scans every file under src/ for
    // that text, tests included.)
    expect(src).toMatch(/evalLog\('export'/);
  });
});

describe('export pre-flight: strings', () => {
  const STRINGS: [en: string, lv: string][] = [
    ['This export is too large to open again', 'Šis eksports ir pārāk liels, lai to atkal atvērtu'],
    [
      'The export would unpack to {size} MB. FastShaders opens files up to {limit} MB, so neither the editor nor Podest could load it back. The shader inside would still run on an A-Frame page.',
      'Izpakots eksports aizņemtu {size} MB. FastShaders atver failus līdz {limit} MB, tāpēc to nevarētu atkal atvērt ne redaktorā, ne Podest. Iekšā esošais ēnotājs A-Frame lapā tomēr darbotos.',
    ],
    [
      'The export would hold {count} files. FastShaders opens at most {max} files from one archive, so neither the editor nor Podest could load it back. The shader inside would still run on an A-Frame page.',
      'Failu skaits eksportā būtu {count}, bet FastShaders no viena arhīva atver ne vairāk kā {max} failus, tāpēc to nevarētu atkal atvērt ne redaktorā, ne Podest. Iekšā esošais ēnotājs A-Frame lapā tomēr darbotos.',
    ],
    [
      'It would also hold {count} files; FastShaders opens at most {max} from one archive.',
      'Turklāt failu skaits tajā būtu {count}, bet FastShaders no viena arhīva atver ne vairāk kā {max}.',
    ],
    ['Export without the 3D model ({model} MB)', 'Eksportēt bez 3D modeļa ({model} MB)'],
    ['Export anyway', 'Tomēr eksportēt'],
  ];

  it('names the entry cap in FILES, from the plan, and picks the sentence by which cap was crossed', () => {
    expect(modal).toMatch(/request\.overSize\s*\?\s*fillTemplate\(\s*t\('The export would unpack to/);
    expect(modal).toMatch(/:\s*fillTemplate\(\s*t\('The export would hold \{count\} files/);
    expect(modal).toMatch(/request\.overSize && request\.overEntries/);
    expect(modal.match(/count:\s*request\.entryCount,\s*max:\s*request\.entryLimit/g)).toHaveLength(2);
  });
  const modal = read('components/Modals/ExportPreflightModal.tsx');

  it.each(STRINGS)('%s has its Latvian entry and is used by the dialog', (en, lv) => {
    expect(t(en, 'lv')).toBe(lv);
    expect(t(en, 'en')).toBe(en);
    expect(modal).toContain(`t('${en}'`);
  });

  it('fills every size through formatMiB; the two-size sentence in ONE pass', () => {
    // {size} and {limit} share a sentence, so they go through fillTemplate
    // (utils/fillTemplate.ts): chained .replace() calls let a value filled
    // first capture the placeholder filled after it.
    expect(modal).toMatch(/fillTemplate\(\s*t\('The export would unpack to \{size\} MB/);
    expect(modal).toMatch(/size:\s*formatMiB\(request\.sizeBytes, language\)/);
    // The two round in OPPOSITE directions, and they share one sentence, so the
    // pair would contradict itself at the boundary if they matched: a measured
    // SIZE rounds up (the default), so one byte over never prints equal to the
    // cap; a declared CAP rounds to 'nearest', since rounding it up would claim
    // more room than is enforced. Every cap today is a whole number of MiB, so
    // no string moves — utils/formatSize.ts states the rule.
    expect(modal).toMatch(/limit:\s*formatMiB\(request\.limitBytes, language, 'nearest'\)/);
    // The lone {model} placeholder cannot capture anything; a replacer still
    // keeps a `$&` from expanding.
    expect(modal).toMatch(/\.replace\(\s*'\{model\}',\s*\(\) =>\s*formatMiB\(/);
    expect(modal).toContain("t('Cancel', language)");
  });
});

describe('export pre-flight: the dialog keeps its keys to itself', () => {
  const press = (key: string) => {
    let stopped = false;
    const answers: ExportPreflightChoice[] = [];
    preflightKeydown({ key, stopPropagation: () => { stopped = true; } }, (c) => answers.push(c));
    return { stopped, answers };
  };

  it('Escape answers Cancel AND is stopped, so the Work-folder popover keeps its "Save cancelled" message', () => {
    // Left to propagate, Escape reached useDismiss's document listener, which
    // closed the popover save()'s cancel branch had just reopened.
    expect(press('Escape')).toEqual({ stopped: true, answers: ['cancel'] });
  });

  it('every other key is swallowed without answering, and Tab stays with the browser', () => {
    expect(press('Enter')).toEqual({ stopped: true, answers: [] });
    expect(press('a')).toEqual({ stopped: true, answers: [] });
    expect(press('Tab')).toEqual({ stopped: false, answers: [] });
  });

  it('the dialog binds exactly that rule, in the capture phase on window', () => {
    const modal = read('components/Modals/ExportPreflightModal.tsx');
    expect(modal).toContain('const onKey = (e: KeyboardEvent) => preflightKeydown(e, onResolve);');
    expect(modal).toContain("window.addEventListener('keydown', onKey, true);");
  });
});

/**
 * N1's DESKTOP variant (GLB Phase 6): on the desktop build an export between
 * the web reader's cap and the desktop one is delivered and then announced as
 * "only the desktop editor can open it again". The planner takes a BYTE COUNT
 * (so a single-file export can reuse it), and vitest runs the web profile, so
 * the desktop numbers are passed explicitly here.
 */
describe('planDesktopOnlyExport: the non-blocking desktop line', () => {
  const MiB = 1024 * 1024;
  const READ = DESKTOP_MAX_TOTAL_UNCOMPRESSED;
  const WEB = MAX_TOTAL_UNCOMPRESSED;

  it('is null up to the web cap, a note just past it, a note AT the desktop cap, null past it', () => {
    expect(planDesktopOnlyExport(96 * MiB, READ, WEB)).toBeNull();
    expect(planDesktopOnlyExport(96 * MiB + 1, READ, WEB)).toEqual({ sizeBytes: 96 * MiB + 1, webLimitBytes: 96 * MiB });
    expect(planDesktopOnlyExport(256 * MiB, READ, WEB)).toEqual({ sizeBytes: 256 * MiB, webLimitBytes: 96 * MiB });
    // Above the desktop cap the blocking dialog handles it instead.
    expect(planDesktopOnlyExport(256 * MiB + 1, READ, WEB)).toBeNull();
  });

  it('is always null on the web build (default arguments: read cap = web cap)', () => {
    for (const bytes of [0, 96 * MiB, 96 * MiB + 1, 200 * MiB, 256 * MiB, 300 * MiB]) {
      expect(planDesktopOnlyExport(bytes)).toBeNull();
    }
  });

  it('a non-finite size never produces a note', () => {
    for (const bytes of [NaN, Infinity, -Infinity]) {
      expect(planDesktopOnlyExport(bytes, READ, WEB)).toBeNull();
    }
  });

  it("the blocking dialog's default limit is THIS build's read cap (the web cap here)", () => {
    expect(READ_MAX_TOTAL_UNCOMPRESSED).toBe(MAX_TOTAL_UNCOMPRESSED);
    expect(planExportPreflight(size(READ_MAX_TOTAL_UNCOMPRESSED + 1))?.limitBytes).toBe(READ_MAX_TOTAL_UNCOMPRESSED);
  });

  it('agrees with the blocking dialog at the desktop cap: one or the other, never both, never neither above web', () => {
    for (const bytes of [96 * MiB + 1, 200 * MiB, 256 * MiB, 256 * MiB + 1, 300 * MiB]) {
      const note = planDesktopOnlyExport(bytes, READ, WEB);
      const dialog = planExportPreflight(size(bytes), READ);
      expect(Boolean(note) !== Boolean(dialog), `${bytes}`).toBe(true);
    }
  });
});

describe('planSingleGlbPreflight: N1-GLB', () => {
  const L = 1000;
  const glb = (o: Partial<GlbRepackSize>): GlbRepackSize => ({
    totalBytes: 0,
    jsonBytes: 0,
    baseBinBytes: 0,
    textureImageBytes: 0,
    fallbackBytes: 0,
    assetOnlyImageBytes: 0,
    moduleBytes: 0,
    projectBytes: 0,
    textureCount: 0,
    fallbackCount: 0,
    fallbackMissing: 0,
    ktx2Bytes: 0,
    ktx2Count: 0,
    webpRequired: false,
    ...o,
  });

  it('fits EXACTLY at the limit (the reader\'s pre-read check is a strict `>`), too large one byte past it', () => {
    expect(planSingleGlbPreflight({ fallback: glb({ totalBytes: L }), required: glb({ totalBytes: L }) }, L)).toBeNull();
    expect(planSingleGlbPreflight({ fallback: glb({ totalBytes: L + 1 }), required: glb({ totalBytes: L + 1 }) }, L)).toEqual({
      sizeBytes: L + 1,
      limitBytes: L,
      textureBytes: 0,
      hasFallbacks: false,
      webpOnly: null,
      ktx2Bytes: 0,
      noKtx2: null,
    });
  });

  it('counts BOTH copies of every texture; WebP-only only with fallbacks AND when it fits', () => {
    const fallback = glb({ totalBytes: L + 300, textureImageBytes: 200, fallbackBytes: 300, fallbackCount: 2 });
    expect(planSingleGlbPreflight({ fallback, required: glb({ totalBytes: L }) }, L)).toEqual({
      sizeBytes: L + 300,
      limitBytes: L,
      textureBytes: 500,
      hasFallbacks: true,
      webpOnly: { sizeBytes: L },
      ktx2Bytes: 0,
      noKtx2: null,
    });
    expect(planSingleGlbPreflight({ fallback, required: glb({ totalBytes: L + 1 }) }, L)!.webpOnly).toBeNull();
    const none = glb({ totalBytes: L + 300, textureImageBytes: 500 });
    expect(planSingleGlbPreflight({ fallback: none, required: glb({ totalBytes: 10 }) }, L)!.webpOnly).toBeNull();
  });

  it('offers "without KTX2" only when dropping the copies ALONE fits', () => {
    const withKtx2 = glb({ totalBytes: L + 300, ktx2Bytes: 400, ktx2Count: 2 });
    const plan = planSingleGlbPreflight(
      { fallback: withKtx2, required: glb({ totalBytes: L + 300 }), noKtx2: glb({ totalBytes: L - 100 }) },
      L,
    );
    expect(plan!.ktx2Bytes).toBe(400);
    expect(plan!.noKtx2).toEqual({ sizeBytes: L - 100 });
    // …not when the file is still too large without them.
    expect(
      planSingleGlbPreflight(
        { fallback: withKtx2, required: glb({ totalBytes: L + 300 }), noKtx2: glb({ totalBytes: L + 1 }) },
        L,
      )!.noKtx2,
    ).toBeNull();
    // …and never when there are no copies to drop (every shipped build today).
    expect(
      planSingleGlbPreflight(
        { fallback: glb({ totalBytes: L + 1 }), required: glb({ totalBytes: L + 1 }), noKtx2: glb({ totalBytes: L }) },
        L,
      )!.noKtx2,
    ).toBeNull();
  });

  it('non-finite or negative sizes count as 0', () => {
    expect(planSingleGlbPreflight({ fallback: glb({ totalBytes: NaN }), required: glb({ totalBytes: -5 }) }, L)).toBeNull();
  });

  it('the default limit is the glTF reader\'s pre-read cap, which is this build\'s zip read cap', () => {
    expect(GLB_READ_MAX_BYTES).toBe(READ_MAX_TOTAL_UNCOMPRESSED);
    const at = { fallback: glb({ totalBytes: GLB_READ_MAX_BYTES }), required: glb({ totalBytes: GLB_READ_MAX_BYTES }) };
    expect(planSingleGlbPreflight(at)).toBeNull();
    const over = { fallback: glb({ totalBytes: GLB_READ_MAX_BYTES + 1 }), required: glb({ totalBytes: 1 }) };
    expect(planSingleGlbPreflight(over)!.limitBytes).toBe(GLB_READ_MAX_BYTES);
  });
});
