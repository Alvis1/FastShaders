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

// ── moduleStringLiteral ─────────────────────────────────────────────────────
//
// A mesh name (and a glTF material name in a model signature) as a JS string
// literal that is safe in BOTH places the generated module lands:
//
//  - `JSON.stringify` is the base, because a name is not an identifier —
//    `Body.001` and `my mesh` are both legal, so the key must be quoted;
//  - `*/` is escaped because the exported `.js` carries the project block as a
//    BLOCK COMMENT, and an unescaped star-slash in any string of the module
//    would end that comment early;
//  - `<` is escaped because the module is inlined into an HTML `<script>` by
//    tslToPreviewHTML, and the HTML tokenizer ends that element at the first
//    `</script` in the raw text no matter that it sits inside a JS string
//    literal. A mesh name is attacker-chosen (it comes out of a dropped glTF,
//    and out of the `meshTarget` a shared `.fastshader` carries), so a name
//    spelling `x</script><img src=x onerror=…>` would close the script early
//    and run as live markup. In the sandboxed preview that is contained by the
//    opaque origin, but the XR popup is a TOP-LEVEL document at the app's real
//    origin, where it would be arbitrary code with the user's storage.
//    Escaping `<` alone is enough — every breakout sequence (`</script`,
//    `<!--`, `<script`) starts with one.
//  - U+2028/U+2029 are escaped because they are JS LINE TERMINATORS that
//    `JSON.stringify` leaves raw: `parseBody` and `scriptToTSL` match the
//    return object one LINE at a time, so a raw one splits the return line
//    and the whole return is kept as a body statement — no colorNode
//    translation, no `parts: {}`, every index section silently painting
//    nothing. A signature name admits any string, so a dropped `.glb` reaches
//    this.
//
// Every escape keeps the string's VALUE identical: `/`, `<` and the two
// separators parse back to themselves, so the emitted key still matches the
// mesh exactly.
// (`tslToPreviewHTML` escapes the whole embedded module the same way — this is
// the source-side half of a defence written at both ends, because the sink
// protects every other string in the module and this protects the key wherever
// else it is written.)
//
// Names reaching here have already passed `isUsableMeshName` (a mesh name) or
// `sanitizeModelSignature` (a signature name — which admits ANY string, `"}:,`
// included, so the escaping here is load-bearing); this is the encoding step,
// not the validation step. Moved here verbatim from graphToCode's private
// `partKeyLiteral` (GLB Phase 5 Step 5), which now aliases it.
export function moduleStringLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/\*\//g, '*\\u002F')
    .replace(/</g, '\\u003C')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The colon that separates a `parts` entry's KEY from its body.
 *
 * Not `indexOf(':')`: the key is a JSON string literal and a mesh name may
 * legally contain a colon. three's `PropertyBinding.sanitizeNodeName` strips
 * `:` so no glTF name reaches here with one — but OBJ names never pass through
 * that sanitizer, so a Maya-style `g Char:Body` really does land in the scene
 * as `Char:Body`, and `isUsableMeshName` deliberately admits it (refusing it
 * would hide a mesh that is visibly right there). Splitting on the first colon
 * cut INSIDE the literal, the body then failed the `{` check, and the whole
 * part was skipped: the canvas showed the mesh targeted, the code panel showed
 * the part, and the module silently omitted it — the mesh rendered the default
 * material with no error and no warning chip, because the name IS in the
 * inventory. Exactly the "right-looking source, wrong picture, no error"
 * failure the parts block is written to avoid.
 *
 * Walks the leading string literal honouring backslash escapes, then returns
 * the next colon. -1 when the entry does not start with a string literal (the
 * caller's `"` check rejects it anyway) or the literal never closes.
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
