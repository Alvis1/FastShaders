/**
 * The GLB import's WORDS (GLB Phase 5). Every key is the English text AND its
 * lv.json `ui` key, and every multi-placeholder string is filled in ONE
 * `fillTemplate` pass, so a texture named `{reason}` is inserted verbatim and
 * never scanned for placeholders.
 *
 * Two halves: the REPORT (N10/N14 — the lines of the canvas import note a
 * build posts, `glbReportLineText`) and the DIALOG (N9/N11/N12, the buttons,
 * the progress line — `glbDialogCopy`, over a `GlbDialogPlan`). `GLB_IMPORT_KEYS`
 * is the frozen list of every dialog key, so the lv.json coverage test can
 * sweep them.
 *
 * Nothing here reads a string out of a model except a texture's NAME, which
 * `glbImportReport` sanitised before it reached a line. Features and reasons
 * are closed ids, looked up in `Map`s (a plain object answers `constructor`).
 */
import { t, type Language } from '@/i18n';
import { fillTemplate } from './fillTemplate';
import { formatMiB } from './formatSize';
import { formatImageBudget } from './imageNode';
import { GLTF_IMAGE_SKIP_KEYS, meshRefusalMessage } from './previewMeshMessage';
import type { GltfFeatureId } from './gltfFeatures';
import type { GlbDownscaleReason, GlbReportLine, GlbSkipReason } from './glbImportReport';
import type { GlbDialogPlan, GlbImportFacts } from './glbImportGate';
import type { FsExtrasRefusal } from './glbShaderExtras';

/** The report lines (N14, plus the N10 decode line). The literal 64 MP is the
 *  decode guard, MAX_SOURCE_PIXELS (pinned by glbImportCopy.test.ts). */
export const GLB_REPORT_KEYS = {
  imported: 'Imported materials: {m}, textures: {t}.',
  importedShared: 'Imported materials: {m}, textures: {t} (shared by several materials: {shared}).',
  keptAuthored:
    'The editor holds at most {max} material sections; the remaining {rest} keep the materials authored in the model.',
  decodeDownscaled:
    '{n} texture(s) were larger than 64 MP (e.g. 8192×8192) and were downscaled while decoding to {dim}.',
  notImported: 'Not imported: {list} — FastShaders has no channel for them.',
  textureDownscaled: '{name}: downscaled to {w}×{h} ({reason})',
  textureSkipped: '{name}: skipped ({reason})',
  textureMore: 'Other textures not listed: {n}',
} as const;

/** One label per closed feature id — the `{list}` items of "Not imported". */
export const GLTF_FEATURE_LABEL_KEYS: ReadonlyMap<GltfFeatureId, string> = new Map<GltfFeatureId, string>([
  ['occlusion', 'ambient occlusion'],
  ['normalScale', 'normal-map strength'],
  ['clearcoat', 'clearcoat'],
  ['transmission', 'transmission'],
  ['volume', 'volume'],
  ['ior', 'index of refraction'],
  ['specular', 'specular'],
  ['sheen', 'sheen'],
  ['iridescence', 'iridescence'],
  ['anisotropy', 'anisotropy'],
  ['dispersion', 'dispersion'],
  ['unlit', 'unlit shading'],
  ['specularGlossiness', 'specular-glossiness materials'],
  ['wrapMirrored', 'mirrored texture wrapping'],
  ['wrapMixed', 'different U and V wrapping'],
  ['texCoord', 'texture coordinate sets beyond the fourth'],
  ['alphaCutoff', 'alpha cut-off of 1 or more'],
  ['emissiveUnused', 'emissive textures with zero strength'],
  ['mixedTangents', 'normal maps shared by meshes with and without tangents'],
]);

/** Why a texture was downscaled — the `{reason}` of a downscaled line. */
export const GLB_DOWNSCALE_REASON_KEYS: ReadonlyMap<GlbDownscaleReason, string> = new Map<GlbDownscaleReason, string>([
  ['slot', 'the size used for this kind of map'],
  ['device', "the headset's texture size limit"],
  ['budget', "the project's image budget"],
  ['import-res', 'the chosen import size'],
  ['image-cap', 'the per-image size limit'],
]);

/** Why a texture was skipped — the `{reason}` of a skipped line: P5a's six
 *  reader fragments (the ONE copy, previewMeshMessage's GLTF_IMAGE_SKIP_KEYS)
 *  plus the encoder's three. */
export const GLB_SKIP_REASON_KEYS: ReadonlyMap<GlbSkipReason, string> = new Map<GlbSkipReason, string>([
  ...GLTF_IMAGE_SKIP_KEYS,
  ['decode', 'could not be decoded'],
  ['budget', "over the project's image budget"],
  ['image-cap', 'over the per-image size limit'],
]);

/** A feature's label in `lang` (an unknown id reads as its own id — it cannot
 *  occur: the report orders features through the closed list). */
export function gltfFeatureLabel(id: GltfFeatureId, lang: Language): string {
  const key = GLTF_FEATURE_LABEL_KEYS.get(id);
  return key ? t(key, lang) : String(id);
}

function downscaleReasonText(r: GlbDownscaleReason, lang: Language): string {
  return t(GLB_DOWNSCALE_REASON_KEYS.get(r) ?? GLB_DOWNSCALE_REASON_KEYS.get('slot')!, lang);
}

function skipReasonText(r: GlbSkipReason, lang: Language): string {
  return t(GLB_SKIP_REASON_KEYS.get(r) ?? GLB_SKIP_REASON_KEYS.get('unsupported-format')!, lang);
}

/** One report line in `lang`. Exhaustive: tsc fails on a missed kind. */
export function glbReportLineText(line: GlbReportLine, lang: Language): string {
  switch (line.kind) {
    case 'glb-import':
      return line.shared > 0
        ? fillTemplate(t(GLB_REPORT_KEYS.importedShared, lang), { m: line.materials, t: line.textures, shared: line.shared })
        : fillTemplate(t(GLB_REPORT_KEYS.imported, lang), { m: line.materials, t: line.textures });
    case 'glb-kept-authored':
      return fillTemplate(t(GLB_REPORT_KEYS.keptAuthored, lang), { max: line.max, rest: line.rest });
    case 'glb-decode-downscaled':
      return fillTemplate(t(GLB_REPORT_KEYS.decodeDownscaled, lang), { n: line.count, dim: `${line.maxSide} px` });
    case 'glb-not-imported':
      return fillTemplate(t(GLB_REPORT_KEYS.notImported, lang), {
        list: line.items.map((id) => gltfFeatureLabel(id, lang)).join(', '),
      });
    case 'glb-texture-downscaled':
      return fillTemplate(t(GLB_REPORT_KEYS.textureDownscaled, lang), {
        name: line.name,
        w: line.width,
        h: line.height,
        reason: downscaleReasonText(line.reason, lang),
      });
    case 'glb-texture-skipped':
      return fillTemplate(t(GLB_REPORT_KEYS.textureSkipped, lang), {
        name: line.name,
        reason: skipReasonText(line.reason, lang),
      });
    case 'glb-texture-more':
      return fillTemplate(t(GLB_REPORT_KEYS.textureMore, lang), { n: line.count });
  }
}

/* ── the dialog (N9 / N11 / N12) ─────────────────────────────────────────── */

/** Every key of the dialog and its notices. Frozen: the lv.json coverage
 *  test sweeps the values. `{name}` is the quoted file name — the CALLER adds
 *  the quotes, the key never contains them. */
export const GLB_IMPORT_KEYS = Object.freeze({
  title: 'Build a shader from {name}?',
  summary: 'Materials: {m}, textures: {t}.',
  build: "Build a shader from this model's materials (replaces the current shader)",
  modelOnly: 'Model only',
  cancel: 'Cancel',
  replaces: 'Building replaces the current shader. Undo (Ctrl+Z / ⌘Z) brings it back while this tab stays open.',
  modelReplaced: 'The current 3D model is replaced either way, and undo does not bring it back.',
  memoryOne: 'Estimated texture memory on the headset: {mb} MB (1 texture).',
  memoryMany: 'Estimated texture memory on the headset: {mb} MB ({n} textures).',
  budgetTitle: "Textures exceed this project's image budget",
  budgetMany:
    "This model's {n} textures would take about {est} of the {remaining} still free. Import them at a reduced resolution, or import the model only.",
  budgetOne:
    "This model's texture would take about {est} of the {remaining} still free. Import it at a reduced resolution, or import the model only.",
  importAt: 'Import at {res} px',
  budgetNothingFits:
    "Even at {res} px this model's textures would take about {est} of the {remaining} still free. Import the model only, or reduce its textures in your 3D software first.",
  gateBlocked:
    "This model has {n} materials. Imports are limited to {limit} — each becomes an Output section with its own textures and draw calls. Turn on “Allow more than {limit} materials” in the toolbar's right-click list to import them all.",
  gateConfirm: 'Import all {n} materials? Each adds an Output section, textures and draw calls.',
  keptAuthored:
    'The editor holds at most {max} material sections; the remaining {rest} keep the materials authored in the model.',
  allowMany: 'Allow more than {limit} materials',
  allowManyHint:
    'Lets a dropped model with more than {limit} materials build one Output section per material. Each adds textures and draw calls, and every such import still asks first.',
  progress: 'Optimizing textures: {i} of {n}',
  busy: 'Finish or cancel the open model import first.',
  buildFailed: 'Could not build a shader from {name}: {reason}. Nothing was changed.',
} as const);

/**
 * The RESTORE half (GLB Phase 7): the dialog's words when the dropped file is
 * a FastShaders single-GLB export carrying its shader, the notice when that
 * stored shader cannot be read, and the import-note line a restore posts.
 * Frozen; the lv.json coverage test sweeps the values.
 */
export const GLB_RESTORE_KEYS = Object.freeze({
  title: 'Restore the shader stored in {name}?',
  summaryProject: 'This model was exported from FastShaders with its shader and node graph.',
  summaryModule: 'This model carries a FastShaders shader without its node graph. Restoring opens it as shader code.',
  restore: 'Restore the stored shader',
  restoreTitle: 'Replaces the current shader with the one stored in this model',
  moduleEdited:
    'The shader code inside this model was changed after it was exported. Restoring uses its node graph, which does not include those changes.',
  assetsRefused: 'Embedded images that cannot be used: {n}',
  replacesRestore: 'Restoring replaces the current shader. Undo (Ctrl+Z / ⌘Z) brings it back while this tab stays open.',
  replacesBoth:
    'Restoring or building replaces the current shader. Undo (Ctrl+Z / ⌘Z) brings it back while this tab stays open.',
  unreadable: 'The shader stored in this model could not be read ({reason}).',
  refusalNotice: 'The shader stored in {name} could not be read ({reason}), so only the model was loaded.',
  restoredProject: 'Restored the shader and node graph from {name}',
  restoredScript: 'Opened the shader code stored in {name}',
} as const);

/** Why a stored shader could not be read — the `{reason}` of the two refusal
 *  sentences, one per closed reader refusal. */
export const FS_REASON_KEYS: ReadonlyMap<FsExtrasRefusal, string> = new Map<FsExtrasRefusal, string>([
  ['damaged', 'the file is damaged'],
  ['too-large', 'it is too large'],
  ['unsupported-version', 'it was saved by a newer FastShaders'],
  ['inconsistent', 'its parts contradict each other'],
]);

function fsReasonText(reason: FsExtrasRefusal, lang: Language): string {
  return t(FS_REASON_KEYS.get(reason) ?? FS_REASON_KEYS.get('damaged')!, lang);
}

/** The notice for a stored shader that could not be read, so the file loaded model-only. */
export function fsRefusalNotice(fileName: string, reason: FsExtrasRefusal, lang: Language): string {
  return fillTemplate(t(GLB_RESTORE_KEYS.refusalNotice, lang), {
    name: '\u201c' + fileName + '\u201d',
    reason: fsReasonText(reason, lang),
  });
}

/** The import-note line a restore posts. */
export function glbRestoredLineText(
  line: { fileName: string; imported: 'project' | 'script' },
  lang: Language,
): string {
  const key = line.imported === 'project' ? GLB_RESTORE_KEYS.restoredProject : GLB_RESTORE_KEYS.restoredScript;
  return fillTemplate(t(key, lang), { name: '\u201c' + line.fileName + '\u201d' });
}

export interface GlbDialogLine {
  text: string;
  tone: 'normal' | 'heading' | 'warn';
}

export interface GlbDialogCopy {
  title: string;
  lines: GlbDialogLine[];
  /** The primary button's label, or null when nothing can be built. */
  primaryLabel: string | null;
  modelOnlyLabel: string;
  /** Why "Model only" is refused (the file is over the model cap), or null. */
  modelOnlyDisabledReason: string | null;
  cancelLabel: string;
  /** The progress line while building, else null. */
  progress: string | null;
  /** "Restore the stored shader" and its title, or null when not offered. */
  restoreLabel: string | null;
  restoreTitle: string | null;
}

/**
 * The dialog's every word for one plan, in `lang`. With a stored shader to
 * RESTORE (GLB Phase 7) the title asks about the restore, the restore summary
 * and its two warnings lead, the build lines follow only when a build is
 * offered, and the replace/undo line names what is offered; a refused stored
 * shader beside a build adds one warning line instead. Line order: the summary;
 * N12 memory (unless blocked); N11 (blocked → the off text; confirm → the on
 * text, plus the over-max line when materials are kept authored); N9 when the
 * budget does not fit (a heading, then the one/other message when a rung
 * fits, else the nothing-fits message); the replace/undo line; and, when a
 * model is loaded, the line saying the model is replaced either way.
 */
export function glbDialogCopy(
  plan: GlbDialogPlan,
  facts: GlbImportFacts | null,
  opts: {
    hasModel: boolean;
    phase: 'ask' | 'building';
    progress: { done: number; total: number } | null;
    /** The sanitized file name, used when there are no facts (a restore of a model the reader refused). */
    fileName?: string;
  },
  lang: Language,
): GlbDialogCopy {
  const T = (key: string) => t(key, lang);
  const lines: GlbDialogLine[] = [];
  const restore = plan.embeddedShader;
  const building = plan.gate !== null;
  const name = '\u201c' + (facts ? facts.fileName : (opts.fileName ?? '')) + '\u201d';
  if (restore) {
    lines.push({ text: T(restore.hasProject ? GLB_RESTORE_KEYS.summaryProject : GLB_RESTORE_KEYS.summaryModule), tone: 'normal' });
    if (restore.moduleEdited && restore.hasProject) lines.push({ text: T(GLB_RESTORE_KEYS.moduleEdited), tone: 'warn' });
    if (restore.assetsRefused > 0) {
      lines.push({ text: fillTemplate(T(GLB_RESTORE_KEYS.assetsRefused), { n: restore.assetsRefused }), tone: 'warn' });
    }
  } else if (plan.embeddedRefusal) {
    lines.push({
      text: fillTemplate(T(GLB_RESTORE_KEYS.unreadable), { reason: fsReasonText(plan.embeddedRefusal, lang) }),
      tone: 'warn',
    });
  }
  if (building) buildLines(plan, lines, lang);
  lines.push({
    text: T(restore ? (plan.primary !== null ? GLB_RESTORE_KEYS.replacesBoth : GLB_RESTORE_KEYS.replacesRestore) : GLB_IMPORT_KEYS.replaces),
    tone: 'normal',
  });
  if (opts.hasModel) lines.push({ text: T(GLB_IMPORT_KEYS.modelReplaced), tone: 'normal' });
  const budget = plan.budget;
  const primaryLabel =
    plan.primary === 'build'
      ? T(GLB_IMPORT_KEYS.build)
      : plan.primary === 'import-at' && budget && !budget.fits && budget.importAt !== null
        ? fillTemplate(T(GLB_IMPORT_KEYS.importAt), { res: budget.importAt })
        : null;
  return {
    title: fillTemplate(T(restore ? GLB_RESTORE_KEYS.title : GLB_IMPORT_KEYS.title), { name }),
    lines,
    primaryLabel,
    modelOnlyLabel: T(GLB_IMPORT_KEYS.modelOnly),
    modelOnlyDisabledReason: plan.modelOnlyRefusal ? meshRefusalMessage(plan.modelOnlyRefusal, lang) : null,
    cancelLabel: T(GLB_IMPORT_KEYS.cancel),
    progress:
      opts.phase === 'building' && opts.progress
        ? fillTemplate(T(GLB_IMPORT_KEYS.progress), { i: opts.progress.done, n: opts.progress.total })
        : null,
    restoreLabel: restore ? T(GLB_RESTORE_KEYS.restore) : null,
    restoreTitle: restore ? T(GLB_RESTORE_KEYS.restoreTitle) : null,
  };
}

/** The build half of the dialog's lines (summary, N12, N11, N9), unchanged from Phase 5. */
function buildLines(plan: GlbDialogPlan, lines: GlbDialogLine[], lang: Language): void {
  const T = (key: string) => t(key, lang);
  lines.push({ text: fillTemplate(T(GLB_IMPORT_KEYS.summary), { m: plan.materials, t: plan.textures }), tone: 'normal' });
  if (plan.memory) {
    const mb = formatMiB(plan.memory.bytes, lang, 'up');
    lines.push({
      text:
        plan.memory.count === 1
          ? fillTemplate(T(GLB_IMPORT_KEYS.memoryOne), { mb })
          : fillTemplate(T(GLB_IMPORT_KEYS.memoryMany), { mb, n: plan.memory.count }),
      tone: 'normal',
    });
  }
  const gate = plan.gate;
  if (gate?.state === 'blocked') {
    lines.push({ text: fillTemplate(T(GLB_IMPORT_KEYS.gateBlocked), { n: gate.n, limit: gate.limit }), tone: 'warn' });
  } else if (gate?.state === 'confirm') {
    lines.push({ text: fillTemplate(T(GLB_IMPORT_KEYS.gateConfirm), { n: gate.n }), tone: 'warn' });
    if (gate.keptAuthored > 0) {
      lines.push({ text: fillTemplate(T(GLB_IMPORT_KEYS.keptAuthored), { max: gate.max, rest: gate.keptAuthored }), tone: 'warn' });
    }
  }
  const budget = plan.budget;
  if (budget && !budget.fits) {
    lines.push({ text: T(GLB_IMPORT_KEYS.budgetTitle), tone: 'heading' });
    const remaining = formatImageBudget(budget.remainingChars);
    if (budget.importAt !== null) {
      // The textures the estimate covers (the built materials'), never every
      // fact: past the section ceiling the two differ.
      const n = budget.textures;
      lines.push({
        text:
          n === 1
            ? fillTemplate(T(GLB_IMPORT_KEYS.budgetOne), { est: formatImageBudget(budget.estChars), remaining })
            : fillTemplate(T(GLB_IMPORT_KEYS.budgetMany), { n, est: formatImageBudget(budget.estChars), remaining }),
        tone: 'warn',
      });
    } else {
      lines.push({
        text: fillTemplate(T(GLB_IMPORT_KEYS.budgetNothingFits), {
          res: budget.floorRes,
          est: formatImageBudget(budget.estAtImport),
          remaining,
        }),
        tone: 'warn',
      });
    }
  }
}
