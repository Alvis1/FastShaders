import complexityData from '@/registry/complexity.json';
import { sanitizeCostMap } from '@/utils/nodeCost';

/**
 * Provenance for an applied cost override — what benchmark produced it, and
 * whether that run could honestly price nodes. Surfaced in the CostBar and
 * persisted alongside the override so a reload still says where the numbers
 * came from.
 */
export interface CostOverrideMeta {
  source: string | null;      // file name the override was dropped from
  device: string | null;      // GPU / headset the run measured
  bench: string | null;       // 'microplane' | 'static' | 'inout' | …
  date: string | null;        // when the run was generated
  timingMethod: string | null;
  valid: boolean | null;      // did the run pass validity gating?
  reasons: string[];          // why not, when valid === false
  count: number;              // number of node types this override reprices
}

export interface ParsedCostFile {
  costs: Record<string, number>;
  meta: CostOverrideMeta;
}

/**
 * A saved measured device profile. Listed in the performance-device dropdown
 * alongside the built-in VR headsets; selecting one applies its `costs` over the
 * authored complexity.json AND its `maxPoints` budget. Built from a dropped
 * benchmark file via `profileFromParsed`.
 */
export interface CostProfile {
  id: string;                 // stable — a byte-identical re-drop replaces its entry
  label: string;              // dropdown label (device or bench name)
  maxPoints: number;          // budget the bar measures against for this profile
  maxTextureDim: number;      // image-downscale cap inherited from the device at import
  costs: Record<string, number>;
  meta: CostOverrideMeta;
}

/** Order-independent hash of a cost map, so the profile id distinguishes two
 *  runs that share coarse device|bench|date provenance but differ in numbers. */
function hashCosts(costs: Record<string, number>): string {
  const s = Object.keys(costs).sort().map((k) => `${k}:${costs[k]}`).join(',');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Build a CostProfile from a parsed benchmark file + a device's budget and
 * texture cap. The id is `device|bench|date` plus a hash of the costs, so a
 * byte-identical re-drop dedups (same id) while two genuinely different runs —
 * even with the same coarse provenance — stay distinct.
 */
export function profileFromParsed(parsed: ParsedCostFile, maxPoints: number, maxTextureDim: number): CostProfile {
  const m = parsed.meta;
  const sigParts = [m.device, m.bench, m.date].filter(Boolean) as string[];
  const sig = [...sigParts, hashCosts(parsed.costs)].join('|');
  const label = m.device || m.bench || (m.source ? m.source.replace(/\.json$/i, '') : 'measured');
  return { id: `cp:${sig}`, label, maxPoints, maxTextureDim, costs: parsed.costs, meta: m };
}

/**
 * Coerce an untrusted meta object (chiefly a persisted profile's `meta`, read
 * back from adversarial localStorage) into a full CostOverrideMeta. Never trust
 * a bare cast: a non-array/absent `reasons` otherwise crashes the CostBar's
 * `reasons.join()` at render.
 */
export function sanitizeCostMeta(m: unknown): CostOverrideMeta {
  const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const count = Number(o.count);
  return {
    source: str(o.source),
    device: str(o.device),
    bench: str(o.bench),
    date: str(o.date),
    timingMethod: str(o.timingMethod),
    valid: typeof o.valid === 'boolean' ? o.valid : null,
    reasons: Array.isArray(o.reasons) ? (o.reasons as unknown[]).filter((r): r is string => typeof r === 'string') : [],
    count: Number.isFinite(count) ? count : 0,
  };
}

const PREFIX = /^(noise_|preset_|saved_)/;

/**
 * Parse a dropped JSON file into a sanitized cost override, accepting EVERY
 * JSON shape the bench can save (only its CSV is not importable):
 *   • patch / raw complexity — `{ meta?, costs: { <nodeKey>: points } }`
 *   • suggestion             — `{ metadata, suggestions: [{ id, suggestedPoints }] }`
 *   • RAW results export     — `{ metadata, shaders: [{ id, stats }] }`
 *
 * The raw branch exists because it is the file a user most naturally grabs
 * after a run (`shadercarousel-<bench>-<date>.json` — the suggestion file is
 * its `…-complexity-suggestion-…` sibling, and rejecting the obvious one read
 * as "the drop is broken"). The bench's own suggestion emitter
 * (ShaderCarousel/lib/bench-stats.js `buildSuggestion`) just reads
 * `stats.marginalPoints`, which `annotateMarginalCost` already computed at
 * export time — so the raw file carries everything the suggestion file does,
 * and this derivation mirrors that emitter (drift is pinned by a test against
 * the committed benchData pair).
 *
 * Keys are validated against the authored table (`sanitizeCostMap` drops
 * unknown keys and non-finite/negative values — the file is adversarial), and
 * suggestion ids have their group prefix stripped (`noise_voronoi` → `voronoi`).
 * Returns `null` when the text isn't a recognizable, non-empty cost file.
 */
export function parseCostFile(text: string, fileName?: string): ParsedCostFile | null {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  let rawCosts: Record<string, unknown> | null = null;
  let md: Record<string, unknown> = {};

  if (o.costs && typeof o.costs === 'object') {
    rawCosts = o.costs as Record<string, unknown>;
    md = (o.meta && typeof o.meta === 'object' ? o.meta : {}) as Record<string, unknown>;
  } else if (Array.isArray(o.suggestions)) {
    rawCosts = {};
    for (const s of o.suggestions as Array<Record<string, unknown>>) {
      if (!s || typeof s.id !== 'string') continue;
      const pts = s.suggestedPoints;
      if (typeof pts !== 'number' || !Number.isFinite(pts)) continue;
      rawCosts[s.id.replace(PREFIX, '')] = pts;
    }
    md = (o.metadata && typeof o.metadata === 'object' ? o.metadata : {}) as Record<string, unknown>;
  } else if (Array.isArray(o.shaders)) {
    // Raw results export. Points come from stats.marginalPoints (what the
    // suggestion emitter reads); the baseline row prices nothing.
    rawCosts = {};
    let sawBaseline = false;
    const insufficient: string[] = [];
    for (const s of o.shaders as Array<Record<string, unknown>>) {
      if (!s || typeof s.id !== 'string') continue;
      if (s.id === 'ref_baseline') { sawBaseline = true; continue; }
      const stats = (s.stats && typeof s.stats === 'object' ? s.stats : {}) as Record<string, unknown>;
      if (stats.insufficientData) insufficient.push(s.id);
      const pts = stats.marginalPoints;
      if (typeof pts !== 'number' || !Number.isFinite(pts)) continue;
      rawCosts[s.id.replace(PREFIX, '')] = pts;
    }
    md = (o.metadata && typeof o.metadata === 'object' ? o.metadata : {}) as Record<string, unknown>;
    // Raw metadata carries no valid/reasons — derive them with the same gates
    // bench-stats' buildSuggestion applies, so an unpriceable run announces
    // itself here exactly as its suggestion file would.
    const reasons: string[] = [];
    if (!sawBaseline) reasons.push('baseline-missing: no ref_baseline in this run — marginal cost cannot be derived');
    if (md.vsyncClamping) reasons.push('vsync-clamped: frametimes pinned to the display refresh — values reflect display cadence, not shader cost');
    const res = (md.resolution && typeof md.resolution === 'object' ? md.resolution : null) as { width?: unknown; height?: unknown } | null;
    if (!(Number(res?.width) > 0 && Number(res?.height) > 0)) reasons.push('resolution-unknown: marginal ms could not be normalized to the reference pixel count');
    if (md.timingMethod === 'raf-delta') reasons.push('raf-delta timing: refresh-quantized frame deltas resolve budget fit, not per-node cost');
    if (insufficient.length) reasons.push(`insufficient-data: ${insufficient.join(', ')} had <2 samples`);
    md = { ...md, valid: reasons.length === 0, reasons };
  } else {
    return null;
  }

  const costs = sanitizeCostMap(rawCosts);
  if (Object.keys(costs).length === 0) return null;

  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const meta: CostOverrideMeta = {
    source: fileName ?? str(md.source) ?? null,
    device: str(md.device) ?? str(md.gpu) ?? str(md.headset) ?? null,
    bench: str(md.bench) ?? null,
    date: str(md.generatedAt) ?? str(md.date) ?? null,
    timingMethod: str(md.timingMethod) ?? null,
    valid: typeof md.valid === 'boolean' ? md.valid : null,
    reasons: Array.isArray(md.reasons) ? (md.reasons as unknown[]).filter((r): r is string => typeof r === 'string') : [],
    count: Object.keys(costs).length,
  };
  return { costs, meta };
}

/**
 * Filename for the CostBar's "⭳ complexity.json" download —
 * `complexity-<device>-<date>.json` — so successive calibration runs from
 * different devices don't all land as `complexity.json`, `complexity (1).json`…
 * in a Downloads folder with nothing telling them apart. Mirrors the bench
 * exporter's own device-slug naming (bench-stats.js `deviceSlug`). Pure.
 */
export function mergedComplexityFileName(meta: CostOverrideMeta | null): string {
  const slug = (meta?.device ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const date = (meta?.date ?? '').slice(0, 10);
  return ['complexity', slug || 'measured', date].filter(Boolean).join('-') + '.json';
}

/**
 * Build a full, committable `complexity.json` object = the authored table with
 * the active override merged over its `costs`, plus a `calibratedFrom` note in
 * `meta` recording the run. This is what the CostBar's "download merged" action
 * emits so a good override can be pasted into `src/registry/complexity.json`.
 */
export function buildMergedComplexity(
  overrides: Record<string, number>,
  meta: CostOverrideMeta | null,
): { meta: Record<string, unknown>; costs: Record<string, number> } {
  const base = complexityData as { meta?: Record<string, unknown>; costs: Record<string, number> };
  return {
    meta: {
      ...(base.meta ?? {}),
      calibratedFrom: meta
        ? { source: meta.source, device: meta.device, bench: meta.bench, date: meta.date,
            timingMethod: meta.timingMethod, valid: meta.valid, nodes: Object.keys(overrides) }
        : null,
    },
    costs: { ...base.costs, ...overrides },
  };
}
