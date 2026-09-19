/**
 * The GLB import's REPORT (GLB Phase 5 Step 8): what one build did, as the ONE
 * type the builder returns (`GlbImportReport`, integration plan §2e), and how
 * it becomes the lines of ONE canvas import note (`glbImportReportLines`).
 *
 * PURE: no `t()` — the words live in utils/glbImportCopy.ts, which renders
 * each line in the active language when the note is drawn — and only the
 * import-free feature leaf as a value import. Every count is clamped to a
 * non-negative safe integer and every file-supplied NAME is re-sanitised here
 * (`sanitizeReportName`), even though the builder is the only writer: the
 * lines outlive the build (the store holds the note), and a name out of a
 * dropped file is the one adversarial string that reaches it. The rest of the
 * report is closed vocabulary — feature ids, reason ids — so no other text
 * from the file can reach the note at all.
 */
import { orderFeatures, type GltfFeatureId } from './gltfFeatures';
import type { GltfTextureSkip } from './gltfImportPlan';

/** Why an extracted texture was stored smaller than its source. `budget` is
 *  the PROJECT's image budget, `image-cap` the encoder's per-image one. */
export type GlbDownscaleReason = 'slot' | 'device' | 'budget' | 'import-res' | 'image-cap';

/** Why a texture a built material uses was not imported: the reader's image
 *  status or a KTX2-only texture (`GltfTextureSkip`), the encoder failing to
 *  decode it, the project's image budget running out, or the encoder's
 *  per-image cap refusing it. */
export type GlbSkipReason = GltfTextureSkip | 'decode' | 'budget' | 'image-cap';

export type GlbTextureOutcome =
  | { name: string; outcome: 'kept' }
  | { name: string; outcome: 'downscaled'; width: number; height: number; reason: GlbDownscaleReason }
  | { name: string; outcome: 'skipped'; reason: GlbSkipReason };

export interface GlbImportReport {
  /** Material sections built. */
  materials: number;
  /** Unique Texture nodes built. */
  textures: number;
  /** Texture nodes wired into two or more sections. */
  shared: number;
  /** Buildable materials past the section cap, which keep their authored
   *  materials. */
  keptAuthored: number;
  /** The section cap (`MAX_INDEX_MATERIALS`), for the kept-authored line. */
  sectionMax: number;
  /** Textures past the 64 MP guard that were decoded at a smaller size (N10);
   *  `maxSide` is the largest such decode's long side. */
  decodeDownscaled: { count: number; maxSide: number };
  /** What the built materials asked for that was not imported (closed ids). */
  notImported: readonly GltfFeatureId[];
  /** One entry per texture the build touched, in encode order. */
  outcomes: readonly GlbTextureOutcome[];
}

/** The note's lines for a build. `importNote.ts` widens its union with these;
 *  `glbImportCopy.glbReportLineText` renders them. */
export type GlbReportLine =
  | { kind: 'glb-import'; materials: number; textures: number; shared: number }
  | { kind: 'glb-kept-authored'; max: number; rest: number }
  | { kind: 'glb-decode-downscaled'; count: number; maxSide: number }
  | { kind: 'glb-not-imported'; items: readonly GltfFeatureId[] }
  | { kind: 'glb-texture-downscaled'; name: string; width: number; height: number; reason: GlbDownscaleReason }
  | { kind: 'glb-texture-skipped'; name: string; reason: GlbSkipReason }
  | { kind: 'glb-texture-more'; count: number };

/** How many per-texture lines a note carries; the rest are one count line. */
export const GLB_REPORT_TEXTURE_LINES = 6;

/** The longest name a line shows, in code points (then an ellipsis). */
export const GLB_REPORT_NAME_MAX = 48;

const DOWNSCALE_REASONS: ReadonlySet<string> = new Set<GlbDownscaleReason>(['slot', 'device', 'budget', 'import-res', 'image-cap']);
const SKIP_REASONS: ReadonlySet<string> = new Set<GlbSkipReason>([
  'external',
  'compressed-view',
  'unsupported-format',
  'damaged',
  'too-large',
  'ktx2-only',
  'decode',
  'budget',
  'image-cap',
]);

/** A downscale reason, or 'slot' for anything else. */
export function downscaleReasonOf(v: unknown): GlbDownscaleReason {
  return typeof v === 'string' && DOWNSCALE_REASONS.has(v) ? (v as GlbDownscaleReason) : 'slot';
}

/** A skip reason, or 'unsupported-format' for anything else — including the
 *  reader's `no-readable-source`, which reads as that text (§2e). */
export function skipReasonOf(v: unknown): GlbSkipReason {
  return typeof v === 'string' && SKIP_REASONS.has(v) ? (v as GlbSkipReason) : 'unsupported-format';
}

/** C0/C1 controls, the Unicode line/paragraph separators, the bidi controls
 *  (embeddings, overrides, isolates, LRM/RLM/ALM) and the BOM. */
// eslint-disable-next-line no-control-regex
const REPORT_NAME_STRIP_RE = /[\u0000-\u001F\u007F-\u009F\u2028-\u2029\u200E-\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * A file-supplied name as a report shows it: a string only (anything else is
 * '?'), controls and bidi overrides replaced by spaces, whitespace collapsed,
 * at most GLB_REPORT_NAME_MAX code points plus '…', and '?' when nothing is
 * left. Never throws: nothing is coerced, so a hostile `toString` is never
 * called.
 */
export function sanitizeReportName(raw: unknown): string {
  if (typeof raw !== 'string') return '?';
  const cleaned = raw
    .slice(0, 4096)
    .replace(REPORT_NAME_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(cleaned);
  const shown = cps.length > GLB_REPORT_NAME_MAX ? cps.slice(0, GLB_REPORT_NAME_MAX).join('').trimEnd() + '…' : cleaned;
  return shown || '?';
}

/** A non-negative safe integer (a non-finite or negative count is 0). */
function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER);
}

/** A pixel dimension clamped to 1..16384. */
function dim(v: unknown): number {
  const n = count(v);
  return n < 1 ? 1 : n > 16384 ? 16384 : n;
}

/**
 * The import note's lines for one build, in the fixed order: the summary; the
 * materials past the section cap; the N10 decode downscales; what was not
 * imported; then at most GLB_REPORT_TEXTURE_LINES per-texture outcomes (kept
 * textures are not listed) and a count of the rest.
 */
export function glbImportReportLines(r: GlbImportReport): GlbReportLine[] {
  const lines: GlbReportLine[] = [
    { kind: 'glb-import', materials: count(r.materials), textures: count(r.textures), shared: count(r.shared) },
  ];
  const rest = count(r.keptAuthored);
  if (rest > 0) lines.push({ kind: 'glb-kept-authored', max: count(r.sectionMax), rest });
  const dd = r.decodeDownscaled;
  const ddCount = count(dd?.count);
  if (ddCount > 0) lines.push({ kind: 'glb-decode-downscaled', count: ddCount, maxSide: dim(dd?.maxSide) });
  const items = orderFeatures(r.notImported);
  if (items.length > 0) lines.push({ kind: 'glb-not-imported', items });

  const listed = (Array.isArray(r.outcomes) ? r.outcomes : []).filter(
    (o): o is Exclude<GlbTextureOutcome, { outcome: 'kept' }> =>
      !!o && typeof o === 'object' && (o.outcome === 'downscaled' || o.outcome === 'skipped'),
  );
  for (const o of listed.slice(0, GLB_REPORT_TEXTURE_LINES)) {
    const name = sanitizeReportName(o.name);
    if (o.outcome === 'downscaled') {
      lines.push({
        kind: 'glb-texture-downscaled',
        name,
        width: dim(o.width),
        height: dim(o.height),
        reason: downscaleReasonOf(o.reason),
      });
    } else {
      lines.push({ kind: 'glb-texture-skipped', name, reason: skipReasonOf(o.reason) });
    }
  }
  const more = listed.length - GLB_REPORT_TEXTURE_LINES;
  if (more > 0) lines.push({ kind: 'glb-texture-more', count: more });
  return lines;
}
