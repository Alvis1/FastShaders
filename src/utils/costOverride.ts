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

function emptyMeta(overrides: { source?: string | null } = {}): CostOverrideMeta {
  return {
    source: overrides.source ?? null,
    device: null, bench: null, date: null, timingMethod: null,
    valid: null, reasons: [], count: 0,
  };
}

/**
 * Parse a dropped JSON file into a sanitized cost override, accepting BOTH
 * shapes the bench can emit:
 *   • patch / raw complexity — `{ meta?, costs: { <nodeKey>: points } }`
 *   • suggestion             — `{ metadata, suggestions: [{ id, suggestedPoints }] }`
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
