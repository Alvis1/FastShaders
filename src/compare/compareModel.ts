import { VR_HEADSETS } from '@/registry/vrHeadsets';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions, NODE_REGISTRY, nodeMatchRank } from '@/registry/nodeRegistry';
import { HIDDEN_NODE_TYPES } from '@/registry/editorVisibility';
import { getBaseCosts, sanitizeCostMap } from '@/utils/costTable';
import { freshNodeCostUnder, type CostOf } from '@/utils/typeCost';
import { toBudgetPoints } from '@/utils/budgetPoints';
import {
  parseStoredCostProfiles, parseCostFile, parseCostProfileBundle, profileFromParsed,
  type CostProfile, type CostOverrideMeta,
} from '@/utils/costOverride';
import { formatCategoryLabel, type Language } from '@/i18n';
import { foldSearchText } from '@/utils/searchFold';
import type { NodeCategory, NodeDefinition } from '@/types';

/**
 * The device-comparison page (`<base>compare/`, compare/index.html): the PURE
 * half — which devices exist, which a link selects, and what each node costs
 * on each of them.
 *
 * Store-free on purpose, like everything the page imports (bootWave.test.ts
 * walks its static graph): the store boots the editor's whole state — the
 * graph autosave, the device singletons — and a page that only READS prices
 * must not run any of it. So a column prices through `freshNodeCostUnder` with
 * its OWN table instead of selecting a device in the app's `costTable`
 * singleton, and the budget is the column's, never `getDeviceBudget()`.
 *
 * A cell is what the editor's palette tile prints while that device is
 * selected: a fresh node's price in table points, under the shipped table with
 * the device's prices laid over it (deviceCostOverrides + setCostOverrides),
 * divided by the device's budget into the fixed 100 (utils/budgetPoints.ts).
 * Every budget prints as 100, so two devices differ in node prices alone.
 */

/** The query parameter that names the columns: `?d=quest3,steamframe`. */
export const LINK_PARAM = 'd';

/** Columns at most. Past this a table stops being a comparison. */
export const MAX_COLUMNS = 8;

/** Profiles listed per source (this browser, files): both are adversarial, and
 *  each one is a chip. The app's own bundle reader stops at 100 too. */
export const MAX_LISTED_PROFILES = 100;

/** A profile file larger than this is not one: the largest bench export in
 *  ShaderCarousel/benchData (raw MicroPlane results) is 170 KB. */
export const MAX_PROFILE_FILE_BYTES = 4 * 1024 * 1024;

/** An id longer than this cannot ride a link. A file's CLAIMED id stops at 123
 *  characters (costOverride's PROFILE_ID_RE); a derived one embeds the run's
 *  device name, which a real run keeps far shorter. */
const MAX_LINK_ID_CHARS = 200;

/** A label is one chip and one column header — the app caps a profile's at 60. */
const MAX_LABEL_CHARS = 60;

/** Where a device came from: VR_HEADSETS, this browser's `fs:costProfiles`,
 *  or a file dropped on the page (session-only, never persisted). */
export type DeviceKind = 'builtin' | 'stored' | 'file';

/** The app's dropdown marks (CostBar `deviceOptionText`): ◆ a measured profile,
 *  ⚠ a benchmark run flagged invalid, ✎ a hand-authored one; '' a built-in row. */
export type DeviceMark = '' | '◆' | '⚠' | '✎';

export interface CompareDevice {
  /** Unique on the page — `b:`, `s:` or `f:` before the device's own id, so a
   *  file claiming a stored profile's id (the editor's edit round-trip) is a
   *  column of its own beside it, never a replacement. */
  key: string;
  /** The id a link names: a built-in's or a stored profile's. '' for a file —
   *  another browser cannot have it, and neither can this one after a reload. */
  linkId: string;
  kind: DeviceKind;
  /** Display text, control and format characters stripped (labels come out of
   *  localStorage and files). React renders it as text either way. */
  label: string;
  mark: DeviceMark;
  /** Why a run was flagged invalid — data out of the file, shown as given
   *  (cleaned like a label, and capped). */
  reasons: string[];
  /** The benchData run a built-in row's prices come from, else null. */
  basis: string | null;
  /** The device's budget in TABLE points: what prints as 100. */
  maxPoints: number;
  /** The prices laid over the shipped table, sanitized as `setCostOverrides`
   *  sanitizes them; null = the shipped table itself. */
  costs: Readonly<Record<string, number>> | null;
  /** The profile a stored or file device was built from — a dropped file's
   *  claimed id is checked against these (`profileFromParsed`). */
  profile: CostProfile | null;
}

/** One chip and one column header's text, never a control or format character
 *  (a bidi override in a tampered profile name would reorder the row around
 *  it — the stance costOverride's `cleanLabel` takes on a file's label, which
 *  the stored-profile reader does not apply). Cut by code point. */
export function displayLabel(raw: unknown, fallback: string, max = MAX_LABEL_CHARS): string {
  if (typeof raw !== 'string') return fallback;
  const s = Array.from(raw.replace(/\p{C}/gu, '').trim().replace(/\s+/g, ' '))
    .slice(0, max)
    .join('');
  return s || fallback;
}

/** Reasons a title shows, at most this many, each cut to this length. */
const MAX_REASONS = 8;
const MAX_REASON_CHARS = 200;

function markOf(meta: CostOverrideMeta): DeviceMark {
  return meta.manual ? '✎' : meta.valid === false ? '⚠' : '◆';
}

/** The table a device prices under, as `setCostOverrides` would leave it. */
function overridesOf(costs: Readonly<Record<string, number>> | undefined | null): Record<string, number> | null {
  const clean = sanitizeCostMap(costs ?? null);
  return Object.keys(clean).length ? clean : null;
}

function profileDevice(p: CostProfile, kind: 'stored' | 'file'): CompareDevice {
  return {
    key: `${kind === 'stored' ? 's' : 'f'}:${p.id}`,
    linkId: kind === 'stored' ? p.id : '',
    kind,
    label: displayLabel(p.label, 'measured'),
    mark: markOf(p.meta),
    reasons: p.meta.valid === false
      ? p.meta.reasons.slice(0, MAX_REASONS).map((r) => displayLabel(r, '', MAX_REASON_CHARS)).filter(Boolean)
      : [],
    basis: null,
    maxPoints: p.maxPoints,
    costs: overridesOf(p.costs),
    profile: p,
  };
}

/** Every VR_HEADSETS row, in its order — the default columns. */
export function builtinDevices(): CompareDevice[] {
  return VR_HEADSETS.map((h) => ({
    key: `b:${h.id}`,
    linkId: h.id,
    kind: 'builtin' as const,
    label: h.label,
    mark: '' as const,
    reasons: [],
    basis: h.costsBasis ?? null,
    maxPoints: h.maxPoints,
    costs: overridesOf(h.costs),
    profile: null,
  }));
}

/**
 * This browser's profiles, from the raw `fs:costProfiles` string, through the
 * app's ONE reader of that key (`parseStoredCostProfiles`, which never throws
 * and sanitizes every field). First of an id wins; a profile claiming a
 * built-in's id is left out — a link naming that id means the built-in row.
 */
export function storedDevices(raw: string | null): CompareDevice[] {
  const builtin = new Set(VR_HEADSETS.map((h) => h.id));
  const seen = new Set<string>();
  const out: CompareDevice[] = [];
  for (const p of parseStoredCostProfiles(raw)) {
    if (out.length >= MAX_LISTED_PROFILES) break;
    if (builtin.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(profileDevice(p, 'stored'));
  }
  return out;
}

/**
 * The devices one dropped or picked file holds, the app's way: an exported
 * bundle first (it has no top-level `costs`, so the single parser would find
 * nothing), then any single file the bench or the editor writes. Built with
 * `profileFromParsed` against every profile already listed (`existing`), so a
 * file can never take over a MEASURED profile's id. A bench export carries no
 * budget and inherits VR_HEADSETS[0]'s, as it would on a first import. null
 * when the text is no cost file at all.
 */
export function devicesFromFile(
  text: string,
  fileName: string,
  existing: readonly CostProfile[],
): { devices: CompareDevice[]; bundle: boolean } | null {
  const bundle = parseCostProfileBundle(text, fileName);
  const single = bundle ? null : parseCostFile(text, fileName);
  const parsedList = bundle ?? (single ? [single] : null);
  if (!parsedList) return null;
  const { maxPoints, maxTextureDim } = VR_HEADSETS[0];
  let known: CostProfile[] = [...existing];
  const out: CompareDevice[] = [];
  for (const parsed of parsedList) {
    const profile = profileFromParsed(parsed, maxPoints, maxTextureDim, known);
    // Two entries of one bundle claiming one id collapse, the later winning —
    // the store's import does the same.
    known = [...known.filter((p) => p.id !== profile.id), profile];
    const device = profileDevice(profile, 'file');
    const at = out.findIndex((d) => d.key === device.key);
    if (at >= 0) out.splice(at, 1);
    out.push(device);
  }
  return { devices: out, bundle: !!bundle };
}

/**
 * The file list after `added`: a device already listed (a re-drop of the same
 * profile) is replaced IN PLACE, so its column keeps its position; a new one
 * is appended while the list has room.
 */
export function mergeFileDevices(files: readonly CompareDevice[], added: readonly CompareDevice[]): CompareDevice[] {
  const out = [...files];
  for (const d of added) {
    const at = out.findIndex((x) => x.key === d.key);
    if (at >= 0) out[at] = d;
    else if (out.length < MAX_LISTED_PROFILES) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- the link

/**
 * The ids a link names, in order, from `location.search`. Read RAW rather
 * than through URLSearchParams: a profile id may hold a comma (a derived id
 * embeds the device name verbatim), so the writer encodes each id on its own
 * and joins them with a bare comma, and only the raw text still tells the two
 * apart. The first `d` wins, as `URLSearchParams.get` answers. Bounded —
 * the address bar is adversarial too.
 */
export function readLinkIds(search: string): string[] {
  const query = search.startsWith('?') ? search.slice(1) : search;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (name !== LINK_PARAM) continue;
    const value = eq < 0 ? '' : part.slice(eq + 1);
    const out: string[] = [];
    for (const raw of value.split(',').slice(0, MAX_COLUMNS * 4)) {
      let id: string;
      try { id = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { continue; }
      if (id && id.length <= MAX_LINK_ID_CHARS && !out.includes(id)) out.push(id);
      if (out.length >= MAX_COLUMNS) break;
    }
    return out;
  }
  return [];
}

/** `search` with the `d` parameter naming `ids` (every other parameter kept as
 *  it is); no ids, no parameter. Returns '' or a string starting with `?`. */
export function writeLinkIds(search: string, ids: readonly string[]): string {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const kept = query.split('&').filter((part) => {
    if (!part) return false;
    const eq = part.indexOf('=');
    return (eq < 0 ? part : part.slice(0, eq)) !== LINK_PARAM;
  });
  const linkable = ids.filter((id) => id && id.length <= MAX_LINK_ID_CHARS);
  if (linkable.length) kept.push(`${LINK_PARAM}=${linkable.map(encodeURIComponent).join(',')}`);
  return kept.length ? `?${kept.join('&')}` : '';
}

/** The keys a link selects: each id a built-in's, else a stored profile's;
 *  unknown ids ignored. Every built-in when nothing usable is named. */
export function selectionFromLink(ids: readonly string[], devices: readonly CompareDevice[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const d = devices.find((x) => x.kind === 'builtin' && x.linkId === id)
      ?? devices.find((x) => x.kind === 'stored' && x.linkId === id);
    if (d && !out.includes(d.key)) out.push(d.key);
    if (out.length >= MAX_COLUMNS) break;
  }
  return out.length ? out : defaultSelection(devices);
}

export function defaultSelection(devices: readonly CompareDevice[]): string[] {
  return devices.filter((d) => d.kind === 'builtin').slice(0, MAX_COLUMNS).map((d) => d.key);
}

/** The ids a link carries for a selection — a file has none (`linkId` ''). */
export function linkIdsOf(selection: readonly string[], devices: readonly CompareDevice[]): string[] {
  const out: string[] = [];
  for (const key of selection) {
    const d = devices.find((x) => x.key === key);
    if (d?.linkId) out.push(d.linkId);
  }
  return out;
}

// --------------------------------------------------------- the selection

/** A chip press: an unselected device joins as the LAST column (while there is
 *  room), a selected one leaves. */
export function toggleDevice(selection: readonly string[], key: string): string[] {
  if (selection.includes(key)) return selection.filter((k) => k !== key);
  return selection.length < MAX_COLUMNS ? [...selection, key] : [...selection];
}

/** The reference is the FIRST column, so making one the reference moves it
 *  there; the others keep their order. */
export function makeReference(selection: readonly string[], key: string): string[] {
  return selection.includes(key) ? [key, ...selection.filter((k) => k !== key)] : [...selection];
}

/** The selection without keys no longer listed (a profile deleted in another
 *  tab) — the SAME array when nothing went, so a state update can bail out. */
export function pruneSelection(selection: string[], devices: readonly CompareDevice[]): string[] {
  const keep = selection.filter((k) => devices.some((d) => d.key === k));
  return keep.length === selection.length ? selection : keep;
}

// ---------------------------------------------------------------- the rows

/**
 * Why a node on the canvas can cost something else than the fresh node a
 * cell prices (utils/nodeCost.ts `nodeCostPoints`): a variadic arithmetic
 * node is charged once per operand past the first, an Image node less for a
 * smaller picture, an RGB Curves node bakes a lookup table once a curve
 * bends, and the SDF Output's fields are charged again on every ray step.
 */
export type PriceNote = 'operands' | 'resolution' | 'curves' | 'march';

export interface CompareRow {
  type: string;
  def: NodeDefinition;
  note: PriceNote | null;
}

export interface CompareGroup {
  category: NodeCategory;
  rows: CompareRow[];
}

export function priceNoteOf(def: NodeDefinition): PriceNote | null {
  if (def.chainable) return 'operands';
  if (def.type === 'imageNode') return 'resolution';
  if (def.type === 'rgbCurves') return 'curves';
  if (def.type === 'raymarchOutput') return 'march';
  return null;
}

/**
 * The rows, grouped in CATEGORIES order (the Add-node menu's; the palette
 * moves its ready-made tabs ahead of it but keeps this order for the rest),
 * each group in registry order. A row is a node TYPE a user can put on the
 * canvas that the table prices: every definition the editor offers, plus the
 * Data node, which a CSV drop makes (it has no palette tile — it would hold
 * no data). Left out: the plain Output (the material itself; there is one per
 * graph whatever it costs), `unknown` (a placeholder for code the parser
 * does not know — nobody adds one) and anything editorVisibility.json hides.
 * Optional categories (SDF, Textures, Presets 2) are listed whether or not a
 * browser has switched them on: this page offers nothing to add.
 */
export function compareGroups(): CompareGroup[] {
  const base = getBaseCosts();
  const dataNode = NODE_REGISTRY.get('dataNode');
  const defs = [...getAllDefinitions(), ...(dataNode ? [dataNode] : [])].filter(
    (d) => d.type !== 'output' && !HIDDEN_NODE_TYPES.has(d.type) && base[d.type] !== undefined,
  );
  const groups: CompareGroup[] = [];
  for (const cat of CATEGORIES) {
    const rows = defs
      .filter((d) => d.category === cat.id)
      .map((def) => ({ type: def.type, def, note: priceNoteOf(def) }));
    if (rows.length) groups.push({ category: cat.id, rows });
  }
  return groups;
}

/** A device's price table: its prices laid over the shipped table, as the
 *  app's `getCost` reads it while that device is selected. */
export function priceTableOf(device: CompareDevice): CostOf {
  const base = getBaseCosts();
  const over = device.costs;
  return (type) => (over && Object.prototype.hasOwnProperty.call(over, type) ? over[type] : base[type] ?? 0);
}

/** A fresh node of `type` on `device`, in BUDGET points; null for a type the
 *  table does not price. The sum is never rounded here — only the print is. */
export function cellPoints(type: string, device: CompareDevice, table: CostOf = priceTableOf(device)): number | null {
  const raw = freshNodeCostUnder(type, table);
  return raw === undefined ? null : toBudgetPoints(raw, device.maxPoints);
}

/** `value − reference`, or exactly 0 when the two are one figure up to float
 *  noise (formatPoints' own slack), so "equal" never prints a difference. */
export function pointsDelta(value: number, reference: number): number {
  const d = value - reference;
  return Math.abs(d) <= 1e-9 * Math.max(1, Math.abs(value), Math.abs(reference)) ? 0 : d;
}

export interface CompareLine {
  row: CompareRow;
  /** Budget points per column, in column order. */
  values: (number | null)[];
  /** Each column against the FIRST (0 for the first itself, and for equal). */
  deltas: number[];
  /** Some column differs from the reference. */
  differs: boolean;
}

export interface CompareSection {
  category: NodeCategory;
  lines: CompareLine[];
}

export function compareTable(groups: readonly CompareGroup[], columns: readonly CompareDevice[]): CompareSection[] {
  const tables = columns.map(priceTableOf);
  return groups.map((g) => ({
    category: g.category,
    lines: g.rows.map((row) => {
      const values = columns.map((d, i) => cellPoints(row.type, d, tables[i]));
      const ref = values.length ? values[0] : null;
      const deltas = values.map((v) => (v === null || ref === null ? 0 : pointsDelta(v, ref)));
      return { row, values, deltas, differs: deltas.some((d) => d !== 0) };
    }),
  }));
}

/**
 * The sections a search and the "only differences" switch leave. A query
 * matches a node's NAMES and alias tail — `nodeMatchRank`'s tiers 0–3, the
 * Add-node menu's one rule, minus the prose tiers, which on a table grouped by
 * category would scatter nodes that merely mention the word — or its
 * category's name, so "noise" keeps the whole Noise group.
 */
export function filterSections(
  sections: readonly CompareSection[],
  query: string,
  onlyDifferences: boolean,
  lang: Language,
): CompareSection[] {
  const q = foldSearchText(query.trim());
  const out: CompareSection[] = [];
  for (const s of sections) {
    const cat = CATEGORIES.find((c) => c.id === s.category);
    const catHit = !!q && !!cat && (
      foldSearchText(cat.label).includes(q) || foldSearchText(formatCategoryLabel(cat.label, cat.id, lang)).includes(q)
    );
    const lines = s.lines.filter((l) =>
      (!onlyDifferences || l.differs) && (!q || catHit || nodeMatchRank(l.row.def, q) <= 3),
    );
    if (lines.length) out.push({ category: s.category, lines });
  }
  return out;
}

/** The UI language from the editor's stored `fs:lang` value, validated —
 *  English unless the exact string 'lv', the store's own rule (and the
 *  pre-paint guard's in compare/index.html). */
export function languageOf(stored: string | null): Language {
  return stored === 'lv' ? 'lv' : 'en';
}
