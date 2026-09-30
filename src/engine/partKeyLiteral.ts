/**
 * The module-text helpers shared by the MAIN bundle (graphToCode,
 * tslCodeProcessor) and the LAZY scriptToTSL chunk. A leaf in effect: its one
 * import, the JSON reviver, is itself a zero-import leaf, so neither side drags
 * the other's dependencies in.
 *
 *  - `moduleStringLiteral` — THE encoder of every string key and signature
 *    name written into generated code (rule R5 of materialPartsContract.ts);
 *  - `partEntryColon`     — where a `parts` entry's key ends;
 *  - `stripMirrorParts`   — drop the loader-0.6 MIRROR entries from a split
 *    `parts` list (rule R6), so a module read back never turns them into
 *    name sections.
 */
import { safeJsonReviver } from '@/utils/safeJson';

// A mesh or signature name as a JS string literal, safe in a block comment
// (star-slash), an inline <script> (`<`) and the line-at-a-time return parse
// (U+2028/9, which JSON.stringify leaves raw). Every escape keeps the VALUE;
// encoding, not validation: docs/dev/outputs-and-materials.md, per-mesh rule (5).
export function moduleStringLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/\*\//g, '*\\u002F')
    .replace(/</g, '\\u003C')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The colon that ends a `parts` entry's KEY. Not `indexOf(':')`: the key is a
 * JSON string literal and an OBJ mesh name may contain a colon (`Char:Body`), see
 * docs/dev/outputs-and-materials.md, per-mesh rule (5). -1 if it never closes.
 */
export function partEntryColon(entry: string): number {
  let i = 0;
  while (i < entry.length && /\s/.test(entry[i])) i += 1;
  if (entry[i] !== '"') return entry.indexOf(':');
  i += 1;
  for (; i < entry.length; i += 1) {
    const c = entry[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '"') break;
  }
  if (i >= entry.length) return -1;
  return entry.indexOf(':', i + 1);
}

/**
 * The name a `parts` entry's key spells, or null when it spells none this
 * layer can decode: a double-quoted JSON string literal (what the emitter
 * writes; `/`/`<` decode back to `/`/`<`), or a bare identifier (a
 * hand-written `Glass: {…}`). Anything else — a single-quoted key, a computed
 * key, a JS-only escape JSON refuses — is null, never guessed.
 */
export function partEntryKey(entry: string): string | null {
  const colon = partEntryColon(entry);
  if (colon === -1) return null;
  const raw = entry.slice(0, colon).trim();
  if (raw.startsWith('"')) {
    // The reviver is moot for a string literal, which parses to a primitive,
    // but it is the tree-wide rule (safeJson.test.ts) and costs nothing.
    try {
      const v: unknown = JSON.parse(raw, safeJsonReviver);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  return /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : null;
}

/**
 * The entries of a SPLIT `parts` list (top-level entries, already split by
 * the caller's string-aware splitter) minus every entry whose key names a
 * loader-0.6 MIRROR (rule R6): a mirror exists only in the module, as a copy of
 * a `materialParts` body, and read back as a name section it would become a
 * second, independent claim on that mesh. An entry whose key cannot be decoded
 * is KEPT — it cannot be a mirror the emitter wrote.
 */
export function stripMirrorParts(entries: readonly string[], mirror: ReadonlySet<string>): string[] {
  if (mirror.size === 0) return entries.slice();
  return entries.filter((entry) => {
    const key = partEntryKey(entry);
    return key === null || !mirror.has(key);
  });
}
