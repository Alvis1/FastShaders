/**
 * User-editable colour palettes: the model, the trust boundary, and the
 * file formats.
 *
 * SCOPE. A palette belongs to the SHADER. It rides the `fs:graph` autosave,
 * undo history and the FASTSHADERS_PROJECT_V1 block exactly like `drawings`,
 * so opening a shader gives you the palettes it was authored with. There is
 * deliberately NO cross-shader library: moving a palette between shaders is an
 * explicit export/import, which is also what makes it shareable with someone
 * who does not have your browser profile.
 *
 * PURE AND DEPENDENCY-LIGHT on purpose (only the shared hex whitelist and the
 * shared JSON reviver): this module is the trust boundary for three separate
 * ingestion paths — a shared `.js` project block, the `fs:graph` autosave, and
 * a dropped/imported palette file — and every one of them must be able to
 * import it without pulling the store or risking a cycle.
 *
 * WHY THE CAPS ARE LOAD-BEARING. Palettes ride ~51 history `structuredClone`s,
 * a `JSON.stringify` in every 300 ms autosave, and every export. Unbounded
 * input here is the same class of failure `sanitizeImageNodes` and
 * `sanitizeDataNodes` exist to prevent.
 */

import { normalizeHex } from '@/utils/colorUtils';
import { safeJsonReviver } from '@/utils/safeJson';

/** One palette. The SAME shape in the shader, in a file, and on screen. */
export interface Palette {
  /** Minted locally, NEVER trusted from a file (see sanitizePalettes). */
  id: string;
  /** Display name; control characters and bidi overrides stripped. */
  name: string;
  /** `#rrggbb`, lowercase. ORDER IS SEMANTIC — a palette is often a ramp, so
   *  this is never sorted. Duplicates are allowed for the same reason. */
  colors: string[];
  /**
   * OPTIONAL per-colour labels, POSITIONALLY ALIGNED with `colors`:
   * `names[i]` labels `colors[i]`, and an unnamed colour holds `''`.
   *
   * WHY AN ALIGNED ARRAY rather than `colors: {hex, name}[]`: the pair form
   * would change the type of every existing read, every stored payload and
   * every file, for a field most palettes do not have. This way a palette with
   * no names serializes EXACTLY as before — see the `anyName` rule in
   * `sanitizeOne`, which omits the key entirely — so no existing shader's
   * autosave, history entry or project block moves a byte.
   *
   * THE ALIGNMENT IS THE WHOLE RISK. Anything that filters, reorders, inserts
   * into or truncates `colors` must do the same to `names` in lockstep, or the
   * tooltips label the wrong swatches — a failure that looks like working
   * software. `sanitizeOne` is the single place both arrays are built (one
   * loop, so a rejected colour drops its name with it) and `paletteUi`'s edits
   * are the single place they are re-ordered.
   */
  names?: string[];
}

export const MAX_PALETTES_PER_SHADER = 16;
export const MAX_COLORS_PER_PALETTE = 64;
/** Code points, not UTF-16 units — so an emoji counts as one character. */
export const MAX_PALETTE_NAME = 32;
/**
 * Cap for ONE colour's label. Longer than a palette name because these carry a
 * qualifier that is the point of the label ("Brass (alloy, approx.)",
 * "Flesh Red (SSS radius)") — a name truncated mid-qualifier is worse than none.
 *
 * Worst case is bounded and small: 16 palettes x 64 colours x 40 code points is
 * ~41 KB of names, against a 600 K/image and 3 M/project payload budget. It
 * rides ~51 history clones like the rest of the palette data.
 */
export const MAX_COLOR_NAME = 40;
/** Checked against `File.size` BEFORE the bytes are decoded: `await
 *  file.text()` on a 500 MB file has already allocated a ~1 GB JS string, so a
 *  cap applied to the decoded text is not a cap at all. */
export const MAX_PALETTE_FILE_BYTES = 256 * 1024;
/** The paste box has no `File` to measure, so it is capped directly. A line
 *  cap would do nothing here — a single 1 GB line has no line count. */
export const MAX_PASTE_CHARS = 64_000;

/**
 * Ids that must never be minted or accepted, even though they match the id
 * charset (`_` is a word character, so `__proto__` passes `[A-Za-z0-9_-]+`).
 * `safeJsonReviver` does NOT cover this: it strips keys NAMED `__proto__`, not
 * string VALUES equal to it — and the GPL path never sees a reviver at all.
 * These ids end up as React keys and object lookups.
 */
const RESERVED_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let idCounter = 0;
/** Locally minted palette id. Deliberately not derived from file content —
 *  a foreign id is never adopted, so a crafted file cannot collide with or
 *  overwrite an existing palette. */
export function mintPaletteId(): string {
  idCounter += 1;
  return `pal${idCounter}_${(idCounter * 2654435761 % 0xffffff).toString(16)}`;
}

/**
 * Strip and bound ONE label, shared by the palette name and the per-colour
 * names — a hostile string must not get in through the newer, quieter door.
 *
 * Strips C0/C1 controls and the Unicode bidi overrides — a right-to-left
 * override in a palette name would reorder the surrounding UI text, which is
 * the classic filename-spoofing trick and is pure downside in a colour label.
 * Removing the C0 range is also what stops a name carrying a TAB or NEWLINE
 * into the line-oriented `.gpl` export, where either would forge a colour row.
 *
 * Returns `''` for nothing usable; the two exported wrappers below decide
 * whether that means "fall back to a default" or "this colour has no label".
 */
function stripLabel(raw: unknown, maxPoints: number): string {
  if (typeof raw !== 'string') return '';
  // Whitespace controls become a SPACE before the delete pass below removes
  // the rest of C0: deleting them would weld words together ("Deep\tGold" ->
  // "DeepGold"). Newline is the one that matters beyond cosmetics — an
  // unstripped \n in a name splits a `.gpl` colour line in two, and the tail
  // is then re-read as a row: `Name:` silently renames the palette, three
  // integers inject a phantom colour that shifts every later label by one.
  const spaced = raw.replace(/[\u0009-\u000d]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  const stripped = spaced.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  const trimmed = stripped.trim();
  if (!trimmed) return '';
  const points = [...trimmed];
  return points.length > maxPoints ? points.slice(0, maxPoints).join('') : trimmed;
}

/** A palette's display name. A palette always has one, so this falls back. */
export function sanitizePaletteName(raw: unknown, fallback = 'Palette'): string {
  return stripLabel(raw, MAX_PALETTE_NAME) || fallback;
}

/** One colour's label, or `''` when it has none — see `Palette.names`. */
export function sanitizeColorName(raw: unknown): string {
  return stripLabel(raw, MAX_COLOR_NAME);
}

/** Clean one palette, or null if nothing usable survives. */
function sanitizeOne(raw: unknown, seen: Set<string>): Palette | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  // THE ALIGNMENT POINT for `colors` / `names`. Both arrays are built in ONE
  // loop over the SOURCE indices, so a rejected colour takes its label with it.
  // Reading `names` in a second pass is the bug this shape exists to prevent:
  // `{colors: ['bogus', '#ff0000'], names: ['Sky', 'Gold']}` would keep one
  // colour and, from a separate pass, label it "Sky".
  const rawNames = Array.isArray(rec.names) ? rec.names : null;
  const colors: string[] = [];
  const names: string[] = [];
  let anyName = false;
  if (Array.isArray(rec.colors)) {
    for (let i = 0; i < rec.colors.length; i += 1) {
      const hex = normalizeHex(rec.colors[i]);
      if (!hex) continue;
      // A short/absent/ragged `names` array simply yields '' here — the two
      // arrays cannot go ragged because this one is built from `colors`.
      const label = rawNames ? sanitizeColorName(rawNames[i]) : '';
      colors.push(hex);
      names.push(label);
      if (label) anyName = true;
      if (colors.length >= MAX_COLORS_PER_PALETTE) break;
    }
  }
  // A palette with no usable colour is not a palette. Dropping it beats
  // keeping an empty row the user cannot tell from a rendering bug.
  if (colors.length === 0) return null;

  // The stored id is honoured only when it is safe AND unique in this batch;
  // otherwise a fresh one is minted. Reserved words are refused outright.
  const rawId = typeof rec.id === 'string' ? rec.id : '';
  let id = ID_RE.test(rawId) && !RESERVED_IDS.has(rawId) && !seen.has(rawId) ? rawId : mintPaletteId();
  while (seen.has(id)) id = mintPaletteId();
  seen.add(id);

  // The key is OMITTED when nothing is named, so a palette without labels
  // serializes byte-for-byte as it did before names existed — no existing
  // shader's autosave, history entry or project block moves.
  return anyName
    ? { id, name: sanitizePaletteName(rec.name), colors, names }
    : { id, name: sanitizePaletteName(rec.name), colors };
}

/**
 * THE trust boundary. Every path that can introduce palettes — the project
 * block, the `fs:graph` autosave, and an imported file — goes through this.
 */
export function sanitizePalettes(raw: unknown, cap = MAX_PALETTES_PER_SHADER): Palette[] {
  if (!Array.isArray(raw)) return [];
  const out: Palette[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const p = sanitizeOne(item, seen);
    if (!p) continue;
    out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}

/* ============================================================
 * File formats — JSON is canonical, GPL is for interop
 * ============================================================ */

/** Canonical export shape. `format` is a DISCRIMINATOR, not decoration: the
 *  app already accepts other dropped `.json` (cost profiles), so a palette
 *  file must be identifiable without guessing from its keys. */
export interface PaletteFile {
  format: 'fastshaders-palette';
  version: 1;
  palettes: Palette[];
}

export const PALETTE_FILE_FORMAT = 'fastshaders-palette';

/** Serialize palettes as the canonical JSON. Ids are omitted — they are local
 *  bookkeeping, and emitting them invites a reader to adopt them. `names` is
 *  omitted for an unlabelled palette, so such a file is byte-identical to one
 *  written before per-colour names existed. */
export function emitPaletteJson(palettes: readonly Palette[]): string {
  return JSON.stringify(
    {
      format: PALETTE_FILE_FORMAT,
      version: 1,
      palettes: palettes.map((p) => {
        const colors = [...p.colors];
        const names = p.names?.slice(0, colors.length) ?? [];
        return names.some((n) => n) ? { name: p.name, colors, names } : { name: p.name, colors };
      }),
    },
    null,
    2,
  );
}

/**
 * GIMP Palette (.gpl) — the interchange format Krita, Inkscape, Aseprite,
 * GIMP and Blender all read. Plain text, so no dependency and no binary
 * parser, which is why it is preferred over Adobe's ASE/ACO.
 */
export function emitGpl(palette: Palette): string {
  const lines = [
    'GIMP Palette',
    `Name: ${palette.name}`,
    `Columns: ${Math.min(palette.colors.length, 8)}`,
    '#',
  ];
  palette.colors.forEach((hex, i) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // GPL's fourth field IS a colour name, so a labelled palette exports its
    // labels to GIMP/Krita/Aseprite for free. Unlabelled colours keep writing
    // the hex there, which is what those apps show when a name is absent —
    // and `parseGpl` reads that back as "no name" rather than as a label.
    const label = palette.names?.[i] || hex.slice(1);
    lines.push(
      `${String(r).padStart(3, ' ')} ${String(g).padStart(3, ' ')} ${String(b).padStart(3, ' ')}\t${label}`,
    );
  });
  return lines.join('\n') + '\n';
}

const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');

/** Parse a `.gpl`. Unknown/comment lines are skipped rather than failing the
 *  file — real-world palettes carry all sorts of headers. */
export function parseGpl(text: string): Palette | null {
  const lines = text.split(/\r?\n/);
  if (!/^GIMP Palette/i.test(lines[0] ?? '')) return null;
  let name = 'Imported';
  const colors: string[] = [];
  const names: string[] = [];
  let anyName = false;
  for (const line of lines.slice(1)) {
    if (colors.length >= MAX_COLORS_PER_PALETTE) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const nameMatch = /^Name:\s*(.+)$/i.exec(trimmed);
    if (nameMatch) { name = nameMatch[1]; continue; }
    if (/^Columns:/i.test(trimmed)) continue;
    // The optional 4th field is GPL's colour name. Anchored at the end so a
    // malformed line (a negative channel, say) still fails to match and is
    // skipped rather than half-read.
    const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s+(.*))?$/.exec(trimmed);
    if (!m) continue;
    const hex = `#${toHex(+m[1])}${toHex(+m[2])}${toHex(+m[3])}`;
    // Most writers (including our own `emitGpl` for an unlabelled palette) put
    // the hex in the name column. Reading that back as a LABEL would tag every
    // colour with its own hex, which is noise in a tooltip that already shows
    // the hex.
    const raw = (m[4] ?? '').trim();
    const label = raw && raw.toLowerCase() !== hex && raw.toLowerCase() !== hex.slice(1)
      ? sanitizeColorName(raw)
      : '';
    colors.push(hex);
    names.push(label);
    if (label) anyName = true;
  }
  if (colors.length === 0) return null;
  const id = mintPaletteId();
  const clean = sanitizePaletteName(name, 'Imported');
  return anyName ? { id, name: clean, colors, names } : { id, name: clean, colors };
}

/**
 * Lenient hex scan for the paste box — the path that actually captures how
 * palettes are shared in practice (a coolors.co URL, a list of hexes from a
 * blog post, a CSS block). Reachable ONLY from an explicit paste field, never
 * from a dropped file, so its leniency cannot be used to smuggle a shader.
 *
 * Capped before scanning: the input has no `File.size` to gate on.
 */
export function parseHexList(text: unknown, name = 'Pasted'): Palette | null {
  if (typeof text !== 'string') return null;
  const src = text.length > MAX_PASTE_CHARS ? text.slice(0, MAX_PASTE_CHARS) : text;
  const colors: string[] = [];
  // Both `#rrggbb` and bare `rrggbb` (coolors.co URLs use the bare form).
  const re = /#?\b([0-9a-fA-F]{6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    colors.push(`#${m[1].toLowerCase()}`);
    if (colors.length >= MAX_COLORS_PER_PALETTE) break;
  }
  if (colors.length === 0) return null;
  return { id: mintPaletteId(), name: sanitizePaletteName(name, 'Pasted'), colors };
}

export interface PaletteParseResult {
  palettes: Palette[];
  /** Non-fatal notes for the UI (truncation, skipped entries). */
  notes: string[];
}

/**
 * Parse an imported palette FILE's text. Dispatches on content, not on the
 * extension. Returns an empty list rather than throwing — a bad file is a
 * user-facing message, not a crash.
 *
 * NOTE: callers MUST gate on `File.size <= MAX_PALETTE_FILE_BYTES` before
 * decoding; by the time text exists, an oversized file has already been
 * allocated.
 */
export function parsePaletteFile(text: string): PaletteParseResult {
  const notes: string[] = [];
  if (typeof text !== 'string' || text.length === 0) return { palettes: [], notes: ['Empty file.'] };

  if (/^\s*GIMP Palette/i.test(text)) {
    const p = parseGpl(text);
    return p
      ? { palettes: [p], notes }
      : { palettes: [], notes: ['No colours found in the .gpl file.'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text, safeJsonReviver);
  } catch {
    return { palettes: [], notes: ['Not a recognized palette file (expected JSON or .gpl).'] };
  }

  const rec = parsed as Record<string, unknown> | null;
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { palettes: [], notes: ['Not a palette file.'] };
  }
  if (rec.format !== PALETTE_FILE_FORMAT) {
    // Refuse rather than guess: a bare `{...}` could be a cost profile or a
    // shader project, and silently importing one as colours is worse than a
    // clear message.
    return { palettes: [], notes: ['Not a FastShaders palette file.'] };
  }

  const before = Array.isArray(rec.palettes) ? rec.palettes.length : 0;
  const palettes = sanitizePalettes(rec.palettes);
  if (before > palettes.length) {
    notes.push(`${before - palettes.length} palette(s) skipped or truncated.`);
  }
  return { palettes, notes };
}

/**
 * Every distinct colour currently used by the graph, in node order — backing
 * "save the shader's colours as a palette".
 *
 * Reads `values.hex` from Color / Property-Color nodes and the Output node's
 * stored channel colours, all through the same whitelist, so a tampered value
 * can never reach the palette.
 */
export function collectGraphColors(
  nodes: ReadonlyArray<{ data?: unknown }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (v: unknown) => {
    const hex = normalizeHex(v);
    if (!hex || seen.has(hex) || out.length >= MAX_COLORS_PER_PALETTE) return;
    seen.add(hex);
    out.push(hex);
  };
  for (const n of nodes) {
    const data = n?.data as Record<string, unknown> | undefined;
    if (!data) continue;
    const values = data.values as Record<string, unknown> | undefined;
    if (!values) continue;
    take(values.hex);
    // Output channels store their colour under the channel name.
    for (const key of ['color', 'emissive', 'normal', 'env']) take(values[key]);
    // Data-viz rows carry a ramp pair.
    take(values.lowColor);
    take(values.highColor);
  }
  return out;
}
