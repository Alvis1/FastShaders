/**
 * THE ONE COPY MODULE of the single-GLB export (Phase 7; integration §3 C14):
 * every sentence the export shows, kept out of the components so a node test
 * can render each one in both languages (the limitNoticeCopy precedent).
 * Step 4 holds the build's words — why a `.glb` could not be built, the
 * "too large to open again" pre-flight with its "Export WebP only" pair, and
 * the report lines after a build; Step 7 adds the popover, availability and
 * modal strings here too, never in a second module.
 *
 * Every sentence with a placeholder is filled in ONE `fillTemplate` pass (a
 * file name spelling `{limit}` cannot capture a later slot); a `{name}` is
 * quoted by THIS module, never inside the key; sizes print through
 * `formatMiB`, so MB means MiB and Latvian gets its decimal comma. The
 * English sentence IS the lv.json key.
 */
import { t, type Language } from '@/i18n';
import { fillTemplate } from './fillTemplate';
import { formatMiB } from './formatSize';
import type { SingleGlbTooLarge } from './exportPreflight';
import type { GlbRepackSize } from './glbRepack';
import type { SingleGlbRefusalReason } from '@/engine/exportSingleGlb';
import type { GlbSlotNote, GlbSlotProblem } from '@/engine/glbExportPlan';
import type { GlbExportAvailability } from './glbExportAvailability';
import type { Ktx2Refusal } from './ktx2Encoder';
import { FS_EMBED_ASSET_BYTES_MAX, FS_EMBED_ASSETS_MAX, FS_EMBED_TOTAL_BYTES_MAX } from '@/engine/glbShaderContract';

/** The EN keys, each once (glbExportCopy.test.ts checks every one has a Latvian entry). */
export const GLB_EXPORT_KEYS = {
  noModel: 'The 3D preview shows a built-in shape. Load a .glb or .gltf model onto it first — the .glb is built from that model.',
  notGltf: '{name} is an .obj file, which cannot carry textures or a shader. Load a .glb or .gltf to export one .glb.',
  externalData:
    '{name} keeps its data in separate files, so it cannot be packed into one .glb. Export it again from your 3D software as .glb or as a .gltf with embedded data.',
  moduleError: 'The shader code has an error, so there is nothing to export.',
  unreadable: 'The model could not be read.',
  tooComplex: 'This model is too complex to repack into one .glb.',
  bufferExtension: 'This model stores its data in a way FastShaders cannot repack.',
  textTooLarge: 'The shader or its project is too large to store inside a .glb.',
  mismatch: 'The model in the 3D preview is not the one this shader’s material sections were made for.',
  tooManyAssets: 'The shader uses more than {max} images; one .glb can carry at most {max}.',
  assetTooLarge: 'Image {name} is larger than {limit} MB, the most one image inside a .glb may take.',
  assetTooLargeUnnamed: 'One of the shader’s images is larger than {limit} MB, the most one image inside a .glb may take.',
  assetsTooLarge: 'The shader’s images take more than {limit} MB together, the most one .glb may carry.',
  tooLargeTitle: 'This .glb is too large to open again',
  tooLargeMessage:
    'The .glb would be {size} MB. FastShaders opens .glb files up to {limit} MB, so the editor could not load it back. Other 3D viewers and A-Frame pages would still open it.',
  textureCopies: 'Each texture is stored twice, as WebP and as a PNG or JPEG copy for viewers without WebP: {textures} MB in all.',
  webpOnlyLabel: 'Export WebP only ({size} MB)',
  webpOnlyHint: 'Viewers without WebP support will refuse a file that holds only WebP textures.',
  tooLargeKtx2: 'Of that, {size} MB are the KTX2 copies.',
  noKtx2Label: 'Export without KTX2 copies',
  // ── Phase 8: the KTX2 copies ────────────────────────────────────────────
  ktx2Row: 'Add GPU-compressed (KTX2) textures for other glTF viewers',
  ktx2RowNote:
    'FastShaders shaders keep sampling their own WebP/PNG/JPEG images; the KTX2 copies make the model lighter on the GPU in other viewers.',
  ktx2RowGlbOnly: 'KTX2 copies are added only to a single .glb export.',
  ktx2Progress: 'Compressing textures to KTX2… {done}/{total}',
  ktx2Report: 'Textures with a KTX2 copy: {n}/{total}.',
  ktx2Skipped: 'No KTX2 copy for “{name}”: {reason}',
  ktx2ReasonSize: 'its size is not a multiple of 4',
  ktx2ReasonTooLarge: 'it is larger than 4096 px',
  ktx2ReasonFailed: 'compression failed',
  ktx2ReasonInvalid: 'the encoder returned an invalid file',
  reportFallbackMissing:
    'Textures stored as WebP only, without a PNG or JPEG copy: {n}. Viewers without WebP support will refuse this file.',
  reportProblems:
    'Texture slots that other viewers will show without a texture, because the shader no longer takes them straight from the model’s textures: {n}.',
  reportApproximated: 'Some texture placements could only be approximated for other viewers.',
  // ── Step 7: the EXPORT popover, the availability line and the modal ──────
  formatBundle: 'Shader file (.js — a .zip when it carries images or the model)',
  formatGlb: 'One .glb: the 3D model with its textures and this shader inside',
  unavailableUnreadable: '{name} could not be read for packing, so it can only be exported inside a .zip.',
  meshNoteGlb: 'The .glb is the model itself — this setting applies to the shader-file format.',
  popoverNoteGlb:
    'Exports {file}. Any 3D viewer opens it as an ordinary model; in A-Frame, a-frame-shaderloader 0.8 runs the shader inside with shader="src: model". Use src: model only for files you trust.',
  exportTitleGlb:
    'Download {file} — the 3D model with its textures and this shader inside; a-frame-shaderloader 0.8 runs it with shader="src: model"',
  building: 'Building {file}…',
  asBundle: 'Export as .zip instead',
  failed: 'Could not build the .glb: {reason}',
  readyTitle: '{file} is ready',
  readyMessage: '{size} MB. Click Download to save it.',
  workFolderNoShader: '{file} carries no FastShaders shader. Drop it on the 3D preview to use it as a model.',
  tabAFrameGlb:
    'A ready-to-run VR page for the .glb. Put {file} next to it and serve the folder over http(s) — file:// blocks the model load. It needs a-frame-shaderloader 0.8, which the page loads.',
  tabThreeGlb:
    'A ready-to-run Three.js page for the .js export (not the .glb). Put {file} next to it and serve the folder over http(s) — file:// blocks the shader load.',
} as const;

const K = GLB_EXPORT_KEYS;
const NAME_MAX = 64;

/** A file-supplied name as `“…”`, capped, with its control and bidi characters neutralised. */
function quoted(name: string | undefined): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const clean = Array.from(
    name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '\uFFFD'),
  );
  const shown = clean.length > NAME_MAX ? clean.slice(0, NAME_MAX).join('') + '\u2026' : clean.join('');
  return `“${shown}”`;
}

/** Each refusal's sentence; null for the two that are never shown. */
const REFUSAL_TEXT: { readonly [R in SingleGlbRefusalReason]: ((lang: Language, name: string | null, detail: string) => string) | null } = {
  study: null,
  'no-model': (lang) => t(K.noModel, lang),
  'not-gltf': (lang, name) => fillTemplate(t(K.notGltf, lang), { name: name ?? '.obj' }),
  'external-data': (lang, name) => fillTemplate(t(K.externalData, lang), { name: name ?? '.gltf' }),
  'module-error': (lang) => t(K.moduleError, lang),
  unreadable: (lang) => t(K.unreadable, lang),
  'bad-input': (lang) => t(K.unreadable, lang),
  'too-complex': (lang) => t(K.tooComplex, lang),
  'unsupported-buffer-extension': (lang) => t(K.bufferExtension, lang),
  'module-too-large': (lang) => t(K.textTooLarge, lang),
  'project-too-large': (lang) => t(K.textTooLarge, lang),
  'model-mismatch': (lang) => t(K.mismatch, lang),
  'too-many-assets': (lang) => fillTemplate(t(K.tooManyAssets, lang), { max: FS_EMBED_ASSETS_MAX }),
  'asset-too-large': (lang, name, detail) => {
    if (detail === 'total') {
      return fillTemplate(t(K.assetsTooLarge, lang), { limit: formatMiB(FS_EMBED_TOTAL_BYTES_MAX, lang) });
    }
    const limit = formatMiB(FS_EMBED_ASSET_BYTES_MAX, lang);
    return name
      ? fillTemplate(t(K.assetTooLarge, lang), { name, limit })
      : fillTemplate(t(K.assetTooLargeUnnamed, lang), { limit });
  },
};

/**
 * Why a single `.glb` could not be built (`prepareSingleGlb`'s refusal), or
 * null for `study` / `aborted`, which are never shown. `name` is the model's
 * or the image's file name as it came (quoted and neutralised here).
 */
export function glbExportRefusalText(
  reason: SingleGlbRefusalReason | 'aborted',
  lang: Language,
  opts: { name?: string; detail?: string } = {},
): string | null {
  if (reason === 'aborted') return null;
  const render = Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, reason) ? REFUSAL_TEXT[reason] : null;
  return render ? render(lang, quoted(opts.name), opts.detail ?? '') : null;
}

/** The "too large to open again" dialog's words (N1-GLB). */
export function glbTooLargeCopy(
  tl: SingleGlbTooLarge,
  lang: Language,
): {
  title: string;
  message: string;
  webpOnlyLabel: string | null;
  webpOnlyHint: string | null;
  noKtx2Label: string | null;
} {
  let message = fillTemplate(t(K.tooLargeMessage, lang), {
    size: formatMiB(tl.sizeBytes, lang),
    limit: formatMiB(tl.limitBytes, lang),
  });
  if (tl.hasFallbacks) {
    message += ' ' + fillTemplate(t(K.textureCopies, lang), { textures: formatMiB(tl.textureBytes, lang) });
  }
  if (tl.ktx2Bytes > 0) {
    message += ' ' + fillTemplate(t(K.tooLargeKtx2, lang), { size: formatMiB(tl.ktx2Bytes, lang) });
  }
  return {
    title: t(K.tooLargeTitle, lang),
    message,
    webpOnlyLabel: tl.webpOnly ? fillTemplate(t(K.webpOnlyLabel, lang), { size: formatMiB(tl.webpOnly.sizeBytes, lang) }) : null,
    webpOnlyHint: tl.webpOnly ? t(K.webpOnlyHint, lang) : null,
    noKtx2Label: tl.noKtx2 ? t(K.noKtx2Label, lang) : null,
  };
}

/** One skipped texture's `{reason}`; every `Ktx2Refusal` has one. */
export function ktx2SkipReasonText(reason: Ktx2Refusal, lang: Language): string {
  if (reason === 'not-multiple-of-4' || reason === 'too-small') return t(K.ktx2ReasonSize, lang);
  if (reason === 'too-large') return t(K.ktx2ReasonTooLarge, lang);
  if (reason === 'encode-failed' || reason === 'aborted') return t(K.ktx2ReasonFailed, lang);
  return t(K.ktx2ReasonInvalid, lang);
}

/** At most this many skipped textures are named; the rest are only counted
 *  by the line above them. */
export const KTX2_REPORT_LINES = 3;

/**
 * The lines a finished single-GLB export reports, as import-note LINES (the
 * note stores structure, never rendered text, so it re-renders in the active
 * language — utils/importNote.ts). Count-neutral "…: {n}" forms.
 */
export type GlbExportNoteLine =
  | { kind: 'glb-export-fallback-missing'; count: number }
  | { kind: 'glb-export-slots-empty'; count: number }
  | { kind: 'glb-export-approximated' }
  | { kind: 'glb-export-ktx2'; count: number; total: number }
  | { kind: 'glb-export-ktx2-skipped'; name: string; reason: Ktx2Refusal };

/** What a finished export reports. `ktx2` is absent unless copies were asked
 *  for: with no encoder the export is exactly today's file and says nothing. */
export function glbExportReportNoteLines(
  size: Pick<GlbRepackSize, 'fallbackMissing'>,
  problems: readonly GlbSlotProblem[],
  notes: readonly { note: GlbSlotNote }[],
  ktx2?: { written: number; skipped: readonly { name: string; reason: Ktx2Refusal }[] },
): GlbExportNoteLine[] {
  const lines: GlbExportNoteLine[] = [];
  if (size.fallbackMissing > 0) lines.push({ kind: 'glb-export-fallback-missing', count: size.fallbackMissing });
  if (problems.length > 0) lines.push({ kind: 'glb-export-slots-empty', count: problems.length });
  if (notes.some((n) => n.note === 'uv-approximated')) lines.push({ kind: 'glb-export-approximated' });
  const total = ktx2 ? ktx2.written + ktx2.skipped.length : 0;
  if (ktx2 && total > 0) {
    lines.push({ kind: 'glb-export-ktx2', count: ktx2.written, total });
    for (const sk of ktx2.skipped.slice(0, KTX2_REPORT_LINES)) {
      lines.push({ kind: 'glb-export-ktx2-skipped', name: sk.name, reason: sk.reason });
    }
  }
  return lines;
}

/** One report line's text. */
export function glbExportNoteLineText(line: GlbExportNoteLine, lang: Language): string {
  switch (line.kind) {
    case 'glb-export-fallback-missing':
      return fillTemplate(t(K.reportFallbackMissing, lang), { n: line.count });
    case 'glb-export-slots-empty':
      return fillTemplate(t(K.reportProblems, lang), { n: line.count });
    case 'glb-export-approximated':
      return t(K.reportApproximated, lang);
    case 'glb-export-ktx2':
      return fillTemplate(t(K.ktx2Report, lang), { n: line.count, total: line.total });
    case 'glb-export-ktx2-skipped':
      return fillTemplate(t(K.ktx2Skipped, lang), {
        name: quoted(line.name)?.slice(1, -1) ?? '?',
        reason: ktx2SkipReasonText(line.reason, lang),
      });
  }
}

/** The same report as finished sentences (the pure half a node test renders). */
export function glbExportReportLines(
  size: Pick<GlbRepackSize, 'fallbackMissing'>,
  problems: readonly GlbSlotProblem[],
  notes: readonly { note: GlbSlotNote }[],
  lang: Language,
  ktx2?: { written: number; skipped: readonly { name: string; reason: Ktx2Refusal }[] },
): string[] {
  return glbExportReportNoteLines(size, problems, notes, ktx2).map((l) => glbExportNoteLineText(l, lang));
}

/**
 * Why one `.glb` is not on offer (`glbExportAvailability`) — the popover's
 * reason line under the disabled radio, and the failed dialog's `{reason}`
 * when the build refuses for the same cause. The switch is exhaustive, so a
 * new reason fails `tsc` here rather than rendering as nothing.
 */
export function glbUnavailableText(a: GlbExportAvailability, lang: Language): string | null {
  if (a.ok) return null;
  const name = quoted(a.name);
  switch (a.reason) {
    case 'no-model':
      return t(K.noModel, lang);
    case 'obj':
      return fillTemplate(t(K.notGltf, lang), { name: name ?? '.obj' });
    case 'external-data':
      return fillTemplate(t(K.externalData, lang), { name: name ?? '.gltf' });
    case 'unreadable':
      return fillTemplate(t(K.unavailableUnreadable, lang), { name: name ?? '.glb' });
  }
}
