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
  /**
   * Hand-authored, NOT measured — a profile made by "New profile…" or by
   * editing a downloaded one. Kept apart from `valid` on purpose: `valid`
   * answers "did the benchmark run pass its gates", which a hand-typed table
   * never ran at all. Everything user-facing reads this so typed numbers can
   * never wear the "measured" badge (the same provenance rule that keeps
   * unmeasured devices out of VR_HEADSETS).
   */
  manual: boolean;
}

/**
 * The self-identifying fields a FastShaders-WRITTEN profile file carries
 * (`buildProfileFile`) and a benchmark export never does. They are what makes
 * the download → hand-edit → re-import loop an UPDATE instead of a fork: the
 * id travels in the file, so the edited copy lands back on the same dropdown
 * row. Every field is validated on the way in — this arrives from a file.
 */
export interface ProfileIdentity {
  id: string | null;
  label: string | null;
  maxPoints: number | null;
  maxTextureDim: number | null;
}

export interface ParsedCostFile {
  costs: Record<string, number>;
  meta: CostOverrideMeta;
  /** Present only for a file this app wrote; null for every bench export. */
  self: ProfileIdentity | null;
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
 *
 * A file THIS APP wrote also carries its own identity (`parsed.self`), which
 * wins over the derived id/label/budget — that is what lets a hand-edited
 * download replace its own row instead of forking a near-duplicate on every
 * save. Three rules bound how far a file may steer that:
 *
 *  • `maxTextureDim` is `min(claimed, active)`. The cap is a SAFETY limit (it
 *    drives image downscaling for a headset), and the store's rule is that a
 *    profile inherits the active device's cap "never loosening it" — so a
 *    file may tighten its own cap and can never widen it.
 *  • A claimed id may NOT take over a MEASURED profile (`existing`): benchmark
 *    numbers are evidence that costs a device run to reproduce, and silently
 *    overwriting them with typed ones is the one destructive move in this
 *    loop. Such a file falls back to its derived id, i.e. lands as a separate
 *    (still stable, hash-derived) row. Hand-authored rows may be replaced —
 *    that IS the edit round-trip.
 *  • `maxPoints` is honoured when claimed. Unlike a bench export — which has
 *    no budget of its own and inherits the active one so the bar's scale does
 *    not jump — a written profile's budget is a number the user chose.
 */
export function profileFromParsed(
  parsed: ParsedCostFile,
  maxPoints: number,
  maxTextureDim: number,
  existing: CostProfile[] = [],
): CostProfile {
  const m = parsed.meta;
  const sigParts = [m.device, m.bench, m.date].filter(Boolean) as string[];
  const sig = [...sigParts, hashCosts(parsed.costs)].join('|');
  const derivedId = `cp:${sig}`;
  const self = parsed.self;
  const claimed = self?.id ?? null;
  const collision = claimed ? existing.find((p) => p.id === claimed) ?? null : null;
  const refused = !!(claimed && collision && !collision.meta.manual);
  const id = claimed && !refused ? claimed : derivedId;
  const label = self?.label
    || m.device || m.bench || (m.source ? m.source.replace(/\.json$/i, '') : 'measured');
  // A file claiming a measured row whose OWN derivation no longer matches that
  // row is a hand-edited copy of measured numbers — the id was refused above,
  // and the result must not keep wearing the "measured" badge either, or typed
  // values would inherit a benchmark's provenance (device, bench, date) intact.
  // A faithful copy derives back to the same id and stays measured, which is
  // what makes restoring a backup on another machine honest.
  const demoted = refused && derivedId !== claimed;
  // `valid` goes with it: it answers "did the benchmark run pass its gates",
  // and the numbers in this file are no longer that run's. device/bench/date
  // stay — they are where these values came FROM, which is worth keeping as
  // long as nothing claims they were measured.
  const meta = demoted ? { ...m, manual: true, valid: null } : m;
  return {
    id,
    // …and it says so in the dropdown: the copy keeps the run's label, so
    // without this the list shows two rows called "Quest 3" differing only by
    // a ◆/✎ mark and their numbers. The suffix is what makes them readable as
    // what they are — the run, and someone's edit of it.
    label: demoted ? `${label.slice(0, MAX_PROFILE_LABEL - 9)} (edited)` : label,
    maxPoints: self?.maxPoints ?? maxPoints,
    maxTextureDim: Math.min(self?.maxTextureDim ?? maxTextureDim, maxTextureDim),
    costs: parsed.costs,
    meta,
  };
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
    // Absent = measured, which is what every profile stored before this field
    // existed was. Read on the persisted path too, or a reload would silently
    // re-badge a hand-authored profile as a benchmark result.
    manual: o.manual === true,
  };
}

/**
 * Namespaced, length-capped id shape a profile file may claim for itself.
 *
 * Deliberately permissive INSIDE the namespace: a derived id embeds the
 * device string verbatim (`cp:Quest 3|microplane|2026-07-23|7xmtbb`, and GPU
 * names run to `qualcomm / adreno-7xx`), so an alphanumeric charset rejected
 * the ids this module itself mints — which silently disabled identity for
 * every measured profile. What actually needs bounding is length, the `cp:`
 * namespace, and control characters (an id is rendered as an <option> value
 * and a React key). Profiles live in an ARRAY and are matched with `===`, so
 * a `__proto__`-shaped id reaches no object key.
 */
const PROFILE_ID_RE = /^cp:[^\p{C}]{1,120}$/u;
/** A label is a dropdown row — keep it short enough to stay one. */
const MAX_PROFILE_LABEL = 60;
const MIN_BUDGET = 1;
const MAX_BUDGET = 1_000_000;
const MIN_TEXTURE_DIM = 16;
const MAX_TEXTURE_DIM = 16_384;
/** Marker + version stamped into a single-profile file this app writes. */
export const PROFILE_FILE_VERSION = 1;
/** Marker key of a multi-profile bundle ("Export profiles… → all"). */
export const PROFILE_BUNDLE_KEY = 'fastShadersCostProfiles';
/** Bound on a bundle — the file is adversarial and each entry costs a parse. */
const MAX_BUNDLE_PROFILES = 100;

/**
 * Trim + cap a claimed label; null when it carries nothing usable.
 *
 * Control and format characters are stripped FIRST: `\s` neither trims nor
 * collapses them, and this string is rendered as `<option>` text — a bidi
 * override or a zero-width joiner in a profile name would reorder or fuse the
 * dropdown row around it. Same stance `PROFILE_ID_RE` takes on ids.
 */
function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\p{C}/gu, '').trim().replace(/\s+/g, ' ').slice(0, MAX_PROFILE_LABEL);
  return s || null;
}

function clampedNumber(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

/**
 * Read the self-identifying fields out of a file's `meta`. Returns null unless
 * at least one is usable, so a plain bench patch (`{ meta: { device… }, costs }`)
 * keeps behaving exactly as it did before profiles could be written by hand.
 */
function readIdentity(md: Record<string, unknown>): ProfileIdentity | null {
  const id = typeof md.id === 'string' && PROFILE_ID_RE.test(md.id) ? md.id : null;
  const label = cleanLabel(md.label);
  const maxPoints = clampedNumber(md.maxPoints, MIN_BUDGET, MAX_BUDGET);
  const maxTextureDim = clampedNumber(md.maxTextureDim, MIN_TEXTURE_DIM, MAX_TEXTURE_DIM);
  if (id === null && label === null && maxPoints === null && maxTextureDim === null) return null;
  return { id, label, maxPoints, maxTextureDim };
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
  return parseCostObject(obj, fileName);
}

/**
 * The object half of `parseCostFile`, shared with the bundle reader (whose
 * entries are already-parsed objects, not text). Same trust level either way.
 */
function parseCostObject(obj: unknown, fileName?: string): ParsedCostFile | null {
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
    manual: md.manual === true,
  };
  // Identity only ever rides the `{ meta, costs }` shape — the two benchmark
  // shapes are read from `metadata`, which the bench writes and this app never
  // does, so a run can't claim a profile row.
  const self = o.costs && typeof o.costs === 'object' ? readIdentity(md) : null;
  return { costs, meta, self };
}

/**
 * The file the CostBar writes for one profile — "Edit profile…", and
 * "Export profiles… → current". Deliberately the SAME `{ meta, costs }` shape
 * `parseCostFile` already accepts, so the download is re-importable by every
 * entrance the app has (drop, picker, bundle) with no second format to keep in
 * step; `meta.id` is what makes the re-import land back on this row.
 *
 * `count` is left out on purpose: it is derived from `costs` on the way back
 * in, and a stale hand-edited count would be a second source of truth.
 */
export function buildProfileFile(p: CostProfile): Record<string, unknown> {
  return {
    meta: {
      fastShadersProfile: PROFILE_FILE_VERSION,
      id: p.id,
      label: p.label,
      maxPoints: p.maxPoints,
      maxTextureDim: p.maxTextureDim,
      manual: p.meta.manual,
      device: p.meta.device,
      bench: p.meta.bench,
      date: p.meta.date,
      timingMethod: p.meta.timingMethod,
      valid: p.meta.valid,
      reasons: p.meta.reasons,
    },
    costs: { ...p.costs },
  };
}

/** "Export profiles… → all" — every profile in one re-importable file. */
export function buildProfileBundle(profiles: CostProfile[]): Record<string, unknown> {
  return {
    [PROFILE_BUNDLE_KEY]: PROFILE_FILE_VERSION,
    profiles: profiles.map(buildProfileFile),
  };
}

/**
 * Read a bundle back. Returns null when the text isn't one (the caller then
 * falls through to the single-file parser), and drops unreadable entries
 * rather than failing the whole import — one bad row in a hand-edited bundle
 * shouldn't cost the user the other nine.
 */
export function parseCostProfileBundle(text: string, fileName?: string): ParsedCostFile[] | null {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (!(PROFILE_BUNDLE_KEY in o) || !Array.isArray(o.profiles)) return null;
  const out: ParsedCostFile[] = [];
  for (const entry of (o.profiles as unknown[]).slice(0, MAX_BUNDLE_PROFILES)) {
    const parsed = parseCostObject(entry, fileName);
    if (parsed) out.push(parsed);
  }
  return out.length ? out : null;
}

/** `fastshaders-profile-<label>.json` — the label is what the user recognises. */
export function profileFileName(p: CostProfile): string {
  const slug = p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `fastshaders-profile-${slug || 'custom'}.json`;
}

/** Filename for the all-profiles bundle. */
export function profileBundleFileName(): string {
  return 'fastshaders-profiles.json';
}

/**
 * Costs a hand-authored profile starts from: the AUTHORED table, every node
 * at its shipped price. Deliberately not an empty map — empty is what a
 * "blank" profile sounds like, but it would be unusable in three separate
 * ways: `parseCostFile` rejects a costs-less file (so the download couldn't
 * come back), the store's boot loader drops a profile with no costs (so it
 * would vanish on reload), and a file listing no node keys gives the user
 * nothing to fill IN. Seeded, the download is a complete price list to edit,
 * and until it is edited the profile prices exactly like the authored table.
 */
export function blankProfileCosts(): Record<string, number> {
  return { ...(complexityData as { costs: Record<string, number> }).costs };
}

/**
 * How many prices a hand-authored table actually MOVED off the shipped ones.
 *
 * `meta.count` is the size of the table, which for a seeded profile is every
 * node — so a badge reading "78 nodes" beside a measured profile's "2 nodes"
 * invites exactly the wrong comparison (78 hand-set prices vs 2 measured
 * ones) when in truth nothing has been typed yet. Pure; the authored table is
 * the reference, so this answers "edited relative to what ships".
 */
export function editedCostCount(costs: Record<string, number>): number {
  const base = (complexityData as { costs: Record<string, number> }).costs;
  let n = 0;
  for (const [k, v] of Object.entries(costs)) if (base[k] !== v) n++;
  return n;
}

/**
 * A new hand-authored profile ("New profile…"). `manual` is set here and
 * never inferred later, so every surface can tell typed numbers from measured
 * ones. The id carries a time suffix because two profiles may share a label
 * and must stay separate rows.
 */
export function createManualProfile(
  label: string,
  maxPoints: number,
  maxTextureDim: number,
  now: Date = new Date(),
): CostProfile {
  const clean = cleanLabel(label) ?? 'Custom profile';
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const costs = blankProfileCosts();
  return {
    id: `cp:manual:${slug || 'profile'}-${now.getTime().toString(36)}`,
    label: clean,
    maxPoints,
    maxTextureDim,
    costs,
    meta: {
      source: null,
      device: null,
      bench: null,
      date: now.toISOString(),
      timingMethod: null,
      // NOT `false`: false means "a run was gated and failed", which would put
      // a ⚠ on a profile that never claimed to be a run at all.
      valid: null,
      reasons: [],
      count: Object.keys(costs).length,
      manual: true,
    },
  };
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
            timingMethod: meta.timingMethod, valid: meta.valid,
            // A hand-authored table says so IN the artefact: this object is
            // the provenance note that ships in the committed complexity.json,
            // where "calibrated" would otherwise imply a run happened.
            manual: meta.manual, nodes: Object.keys(overrides) }
        : null,
    },
    costs: { ...base.costs, ...overrides },
  };
}
