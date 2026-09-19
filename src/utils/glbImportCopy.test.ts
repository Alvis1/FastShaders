/**
 * The GLB import's words (Phase 5): every key the report half uses has an
 * lv.json `ui` entry that differs from the English and carries the same
 * placeholders; the feature labels and reason keys are complete; and the
 * one literal number in the copy (64 MP) is the decode guard.
 */
import { describe, it, expect } from 'vitest';
import lv from '@/i18n/lv.json';
import {
  GLB_DOWNSCALE_REASON_KEYS,
  GLB_IMPORT_KEYS,
  GLB_REPORT_KEYS,
  GLB_SKIP_REASON_KEYS,
  GLTF_FEATURE_LABEL_KEYS,
  gltfFeatureLabel,
  glbDialogCopy,
  glbReportLineText,
} from './glbImportCopy';
import { planGlbImportDialog, type GlbDialogPlan, type GlbImportFacts, type GlbTextureFact } from './glbImportGate';
import { MESH_MAX_BYTES } from './previewMesh';
import { MAX_INDEX_MATERIALS } from '@/engine/materialPartsContract';
import { GLTF_FEATURE_IDS } from './gltfFeatures';
import { MAX_SOURCE_PIXELS } from './imageNode';
import { GLTF_IMAGE_SKIP_KEYS } from './previewMeshMessage';

const UI = (lv as { ui: Record<string, string> }).ui;

function placeholders(s: string): string[] {
  return (s.match(/\{[a-z]+\}/g) ?? []).sort();
}

function expectTranslated(key: string): void {
  const v = UI[key];
  expect(v, `lv.json ui has no entry for "${key}"`).toBeTypeOf('string');
  expect(v).not.toBe(key);
  expect(placeholders(v)).toEqual(placeholders(key));
}

describe('lv.json coverage', () => {
  it('every report key', () => {
    for (const key of Object.values(GLB_REPORT_KEYS)) expectTranslated(key);
  });

  it('every feature label, one per closed id', () => {
    expect([...GLTF_FEATURE_LABEL_KEYS.keys()].sort()).toEqual([...GLTF_FEATURE_IDS].sort());
    for (const key of GLTF_FEATURE_LABEL_KEYS.values()) expectTranslated(key);
  });

  it('every downscale and skip reason', () => {
    for (const key of GLB_DOWNSCALE_REASON_KEYS.values()) expectTranslated(key);
    for (const key of GLB_SKIP_REASON_KEYS.values()) expectTranslated(key);
  });

  it('every dialog key (GLB_IMPORT_KEYS), and the object is frozen', () => {
    for (const key of Object.values(GLB_IMPORT_KEYS)) expectTranslated(key);
    expect(Object.isFrozen(GLB_IMPORT_KEYS)).toBe(true);
    expect(GLB_IMPORT_KEYS.title).not.toContain('\u201c');
  });

  it('the owner\'s Latvian for ambient occlusion', () => {
    expect(UI['ambient occlusion']).toBe('apkārtējās gaismas aizsegums');
  });
});

describe('the reason tables', () => {
  it('the skip reasons are the reader\'s six fragments plus the encoder\'s three', () => {
    for (const [k, v] of GLTF_IMAGE_SKIP_KEYS) expect(GLB_SKIP_REASON_KEYS.get(k)).toBe(v);
    expect(GLB_SKIP_REASON_KEYS.size).toBe(GLTF_IMAGE_SKIP_KEYS.size + 3);
    expect(GLB_SKIP_REASON_KEYS.get('decode')).toBe('could not be decoded');
    expect(GLB_SKIP_REASON_KEYS.get('budget')).toBe("over the project's image budget");
  });

  it('the per-image cap has its OWN words, never the project budget\'s', () => {
    expect(GLB_SKIP_REASON_KEYS.get('image-cap')).toBe('over the per-image size limit');
    expect(GLB_DOWNSCALE_REASON_KEYS.get('image-cap')).toBe('the per-image size limit');
    expect(GLB_DOWNSCALE_REASON_KEYS.get('budget')).toBe("the project's image budget");
    expect(UI['the per-image size limit']).toBe('viena attēla izmēra ierobežojums');
    expect(UI['over the per-image size limit']).toBe('pārsniedz viena attēla izmēra ierobežojumu');
  });

  it('are Maps (a plain object answers "constructor")', () => {
    expect(GLTF_FEATURE_LABEL_KEYS).toBeInstanceOf(Map);
    expect(GLB_SKIP_REASON_KEYS).toBeInstanceOf(Map);
    expect(GLB_DOWNSCALE_REASON_KEYS).toBeInstanceOf(Map);
    expect(gltfFeatureLabel('constructor' as 'sheen', 'en')).toBe('constructor');
  });
});

describe('the 64 MP literal', () => {
  it('is MAX_SOURCE_PIXELS', () => {
    expect(GLB_REPORT_KEYS.decodeDownscaled).toContain('64 MP');
    expect(MAX_SOURCE_PIXELS).toBe(64_000_000);
    expect(UI[GLB_REPORT_KEYS.decodeDownscaled]).toContain('64 MP');
  });
});

describe('glbReportLineText', () => {
  it('fills every kind in both languages with no placeholder left', () => {
    const lines = [
      { kind: 'glb-import', materials: 1, textures: 2, shared: 0 },
      { kind: 'glb-import', materials: 1, textures: 2, shared: 2 },
      { kind: 'glb-kept-authored', max: 16, rest: 1 },
      { kind: 'glb-decode-downscaled', count: 1, maxSide: 4096 },
      { kind: 'glb-not-imported', items: ['occlusion', 'wrapMixed'] },
      { kind: 'glb-texture-downscaled', name: 'a', width: 1, height: 2, reason: 'import-res' },
      { kind: 'glb-texture-downscaled', name: 'b', width: 4, height: 4, reason: 'image-cap' },
      { kind: 'glb-texture-skipped', name: 'c', reason: 'ktx2-only' },
      { kind: 'glb-texture-more', count: 3 },
    ] as const;
    for (const line of lines) {
      for (const lang of ['en', 'lv'] as const) {
        const text = glbReportLineText(line, lang);
        expect(text).not.toMatch(/\{[a-z]+\}/);
        expect(text.length).toBeGreaterThan(5);
      }
    }
    expect(glbReportLineText(lines[4], 'lv')).toBe(
      'Netika importēts: apkārtējās gaismas aizsegums, atšķirīga U un V atkārtošana — FastShaders nav tiem atbilstoša kanāla.',
    );
  });
});

/* ── the dialog ──────────────────────────────────────────────────────────── */

const tex = (over: Partial<GlbTextureFact> = {}): GlbTextureFact => ({
  key: 'k', slot: 'baseColor', width: 1024, height: 1024, sourceLossless: false, materials: [0], ...over,
});
const factsOf = (over: Partial<GlbImportFacts> = {}): GlbImportFacts => ({
  kind: 'glb', fileName: 'm.glb', fileBytes: 1000, materialIndices: [0], textures: [tex()], embeddedShader: null, ...over,
});
const mats = (n: number) => Array.from({ length: n }, (_, i) => i);
const many4k = (n: number) => Array.from({ length: n }, (_, i) => tex({ key: `k${i}`, width: 4096, height: 4096 }));
const CTX = { allowManyMaterials: false, ignoreImageLimits: false, deviceMaxDim: 2048 };
const ASK = { hasModel: false, phase: 'ask' as const, progress: null };

const SHAPES: Record<string, { facts: GlbImportFacts; plan: GlbDialogPlan }> = {
  ok: (() => { const f = factsOf(); return { facts: f, plan: planGlbImportDialog(f, CTX) }; })(),
  blocked: (() => { const f = factsOf({ materialIndices: mats(12) }); return { facts: f, plan: planGlbImportDialog(f, CTX) }; })(),
  confirm: (() => { const f = factsOf({ materialIndices: mats(12) }); return { facts: f, plan: planGlbImportDialog(f, { ...CTX, allowManyMaterials: true }) }; })(),
  confirmOverMax: (() => { const f = factsOf({ materialIndices: mats(MAX_INDEX_MATERIALS + 3) }); return { facts: f, plan: planGlbImportDialog(f, { ...CTX, allowManyMaterials: true }) }; })(),
  importAt: (() => { const f = factsOf({ textures: many4k(16) }); return { facts: f, plan: planGlbImportDialog(f, CTX) }; })(),
  importAtOne: (() => { const f = factsOf({ textures: [tex({ width: 16384, height: 16384 })], materialIndices: [0] }); return { facts: f, plan: { ...planGlbImportDialog(f, CTX), budget: { fits: false, estChars: 5_000_000, remainingChars: 3_000_000, textures: 1, importAt: 512, estAtImport: 1_000_000, floorRes: 128 }, primary: 'import-at' as const, maxDim: 512 } }; })(),
  nothingFits: (() => { const f = factsOf({ textures: Array.from({ length: 256 }, (_, i) => tex({ key: `n${i}`, slot: 'normal', sourceLossless: true, width: 4096, height: 4096 })) }); return { facts: f, plan: planGlbImportDialog(f, CTX) }; })(),
  ignoreLimits: (() => { const f = factsOf({ textures: many4k(16) }); return { facts: f, plan: planGlbImportDialog(f, { ...CTX, ignoreImageLimits: true }) }; })(),
  tooLargeForModelOnly: (() => { const f = factsOf({ fileBytes: MESH_MAX_BYTES + 1 }); return { facts: f, plan: planGlbImportDialog(f, CTX) }; })(),
};

describe('glbDialogCopy', () => {
  it('every shape renders in EN and LV with no placeholder left', () => {
    for (const [name, { facts, plan }] of Object.entries(SHAPES)) {
      for (const lang of ['en', 'lv'] as const) {
        for (const opts of [ASK, { ...ASK, hasModel: true }, { hasModel: false, phase: 'building' as const, progress: { done: 2, total: 5 } }]) {
          const c = glbDialogCopy(plan, facts, opts, lang);
          const all = [c.title, ...c.lines.map((l) => l.text), c.primaryLabel ?? '', c.modelOnlyLabel, c.cancelLabel, c.modelOnlyDisabledReason ?? '', c.progress ?? ''].join('\n');
          expect(all, `${name} ${lang}`).not.toMatch(/\{[a-z]+\}/);
          expect(c.title).toContain('\u201cm.glb\u201d');
        }
      }
    }
  });

  it('the line order: summary, memory, N11, N9, replace/undo, then the model line', () => {
    const c = glbDialogCopy(SHAPES.confirmOverMax.plan, SHAPES.confirmOverMax.facts, { ...ASK, hasModel: true }, 'en');
    const texts = c.lines.map((l) => l.text);
    expect(texts[0]).toBe(`Materials: ${MAX_INDEX_MATERIALS + 3}, textures: 1.`);
    expect(texts[1]).toMatch(/^Estimated texture memory on the headset: .* MB \(1 texture\)\.$/);
    expect(texts[2]).toBe(`Import all ${MAX_INDEX_MATERIALS + 3} materials? Each adds an Output node, textures and draw calls.`);
    expect(texts[3]).toBe(`The editor holds at most ${MAX_INDEX_MATERIALS} material sections; the remaining 3 keep the materials authored in the model.`);
    expect(texts[4]).toBe('Building replaces the current shader. Undo (Ctrl+Z / ⌘Z) brings it back while this tab stays open.');
    expect(texts[5]).toBe('The current 3D model is replaced either way, and undo does not bring it back.');
    expect(c.lines.map((l) => l.tone)).toEqual(['normal', 'normal', 'warn', 'warn', 'normal', 'normal']);
  });

  it('blocked: the off text, no memory line, no primary', () => {
    const c = glbDialogCopy(SHAPES.blocked.plan, SHAPES.blocked.facts, ASK, 'en');
    expect(c.lines.map((l) => l.text)).toEqual([
      'Materials: 12, textures: 1.',
      "This model has 12 materials. Imports are limited to 10 — each becomes an Output node with its own textures and draw calls. Turn on “Allow more than 10 materials” in the toolbar's right-click list to import them all.",
      'Building replaces the current shader. Undo (Ctrl+Z / ⌘Z) brings it back while this tab stays open.',
    ]);
    expect(c.primaryLabel).toBeNull();
  });

  it('N9: the heading, the one/other message, the Import-at label; the nothing-fits variant', () => {
    const c = glbDialogCopy(SHAPES.importAt.plan, SHAPES.importAt.facts, ASK, 'en');
    const heading = c.lines.find((l) => l.tone === 'heading')!;
    expect(heading.text).toBe("Textures exceed this project's image budget");
    const msg = c.lines[c.lines.indexOf(heading) + 1].text;
    expect(msg).toMatch(/^This model's 16 textures would take about \d[\d ]* KB of the \d[\d ]* KB still free\./);
    expect(c.primaryLabel).toMatch(/^Import at (512|256|128) px$/);
    const one = glbDialogCopy(SHAPES.importAtOne.plan, SHAPES.importAtOne.facts, ASK, 'en');
    expect(one.lines.some((l) => l.text.startsWith("This model's texture would take about"))).toBe(true);
    expect(one.primaryLabel).toBe('Import at 512 px');
    const none = glbDialogCopy(SHAPES.nothingFits.plan, SHAPES.nothingFits.facts, ASK, 'en');
    expect(none.lines.some((l) => l.text.startsWith('Even at 128 px'))).toBe(true);
    expect(none.primaryLabel).toBeNull();
  });

  it('N9 counts the textures its estimate covers: past the section ceiling, the BUILT ones, as N12 does', () => {
    const n = MAX_INDEX_MATERIALS + 4;
    const f = factsOf({
      materialIndices: mats(n),
      textures: Array.from({ length: n }, (_, i) => tex({ key: `c${i}`, width: 4096, height: 4096, materials: [i] })),
    });
    const plan = planGlbImportDialog(f, { ...CTX, allowManyMaterials: true });
    expect(plan.textures).toBe(n);
    expect(plan.memory?.count).toBe(MAX_INDEX_MATERIALS);
    expect(plan.budget && !plan.budget.fits && plan.budget.importAt !== null).toBe(true);
    const texts = glbDialogCopy(plan, f, ASK, 'en').lines.map((l) => l.text);
    expect(texts.some((t) => t.startsWith('Estimated texture memory') && t.endsWith(`(${MAX_INDEX_MATERIALS} textures).`))).toBe(true);
    expect(texts.some((t) => t.startsWith(`This model's ${MAX_INDEX_MATERIALS} textures would take about`))).toBe(true);
    expect(texts.some((t) => t.startsWith(`This model's ${n} textures`))).toBe(false);
    const lvTexts = glbDialogCopy(plan, f, ASK, 'lv').lines.map((l) => l.text);
    expect(lvTexts.some((t) => t.startsWith(`Šī modeļa tekstūras (${MAX_INDEX_MATERIALS}) aizņemtu`))).toBe(true);
  });

  it('ignore-limits: no N9 at all, the plain Build label — exactly', () => {
    const c = glbDialogCopy(SHAPES.ignoreLimits.plan, SHAPES.ignoreLimits.facts, ASK, 'en');
    expect(c.lines.some((l) => l.tone === 'heading')).toBe(false);
    expect(c.primaryLabel).toBe("Build a shader from this model's materials (replaces the current shader)");
  });

  it('N12 uses the one-key at 1 and the other-key at 2 and 21; LV prints a decimal comma', () => {
    const at = (n: number) => {
      const f = factsOf({ textures: Array.from({ length: n }, (_, i) => tex({ key: `k${i}`, width: 300, height: 300 })) });
      return glbDialogCopy(planGlbImportDialog(f, CTX), f, ASK, 'en').lines[1].text;
    };
    expect(at(1)).toMatch(/\(1 texture\)\.$/);
    expect(at(2)).toMatch(/\(2 textures\)\.$/);
    expect(at(21)).toMatch(/\(21 textures\)\.$/);
    const f = factsOf({ textures: [tex({ width: 300, height: 300 })] });
    const lv = glbDialogCopy(planGlbImportDialog(f, CTX), f, ASK, 'lv').lines[1].text;
    expect(lv).toMatch(/^Aptuvenais tekstūru atmiņas patēriņš brillēs: \d+,\d MB \(1 tekstūra\)\.$/);
  });

  it('Model only carries the translated N3 sentence when the file is over the model cap', () => {
    const c = glbDialogCopy(SHAPES.tooLargeForModelOnly.plan, SHAPES.tooLargeForModelOnly.facts, ASK, 'lv');
    expect(c.modelOnlyDisabledReason).toContain('64');
    expect(c.modelOnlyDisabledReason).not.toContain('{');
    expect(glbDialogCopy(SHAPES.ok.plan, SHAPES.ok.facts, ASK, 'en').modelOnlyDisabledReason).toBeNull();
  });

  it('the building phase carries the progress line', () => {
    const c = glbDialogCopy(SHAPES.ok.plan, SHAPES.ok.facts, { hasModel: false, phase: 'building', progress: { done: 2, total: 5 } }, 'en');
    expect(c.progress).toBe('Optimizing textures: 2 of 5');
    expect(glbDialogCopy(SHAPES.ok.plan, SHAPES.ok.facts, ASK, 'en').progress).toBeNull();
  });
});
