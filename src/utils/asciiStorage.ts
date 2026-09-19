/**
 * The ONE writer path for `fs:graph` and `fs:savedGroups`: store them as pure
 * ASCII.
 *
 * WebKit (Safari, and the macOS desktop's WKWebView) charges localStorage by
 * the stored string's in-memory width: 1 byte per character while the string
 * is 8-bit, 2 once any character above U+00FF is in it. Every Latvian
 * diacritic is above U+00FF, so a single one in a note doubled the cost of a
 * multi-megabyte autosave. MEASURED in WebKit 26.5 (Playwright webkit-2336):
 *
 *   - the quota is 5,242,880 bytes per origin, counting key + value, so
 *     `fs:graph` (8 characters) holds at most 5,242,872 8-bit characters;
 *   - a 3.5M-character value containing one U+0101 throws QuotaExceededError;
 *   - the same value escaped by `String.prototype.replace` but NOT re-encoded
 *     ALSO throws (a replace() result on a 16-bit subject stays 16-bit);
 *   - escaped AND re-encoded through TextEncoder/TextDecoder, it saves and
 *     reads back identical.
 *
 * Chromium and Firefox charge by UTF-16 length regardless, so there each
 * escaped code unit costs 6 characters instead of 1 (an emoji 12). That is
 * negligible beside the base64 image payloads, the only term that reaches
 * megabytes.
 *
 * The readers need nothing: the parse decodes the escapes before the reviver
 * sees a key, and an older build reads the escaped text just as well.
 *
 * This file must stay pure ASCII itself and must not spell the parse call
 * (asciiStorage.test.ts and safeJson.test.ts both read its source).
 */

const NON_ASCII = /[\u0080-\uffff]/g;

/**
 * Escape every UTF-16 code unit above U+007F as a backslash-u escape (lower
 * case hex, JSON's own spelling). Legal on stringify output: a non-ASCII code
 * unit can only sit inside a JSON string literal, and no JSON escape contains
 * one. Surrogate halves are escaped one at a time; the parse reassembles them.
 */
export function escapeNonAscii(json: string): string {
  return json.replace(NON_ASCII, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Stringify `value` for localStorage as pure, 8-bit ASCII. */
export function toAsciiStorageJson(value: object): string {
  const json = JSON.stringify(value);
  const escaped = escapeNonAscii(json);
  // Pure ASCII: stringify output is already 8-bit in WebKit (measured), so the
  // common case costs one regex scan and stores the bytes it always did.
  if (escaped === json) return json;
  // REQUIRED, not tidiness: replace() on a 16-bit subject returns a 16-bit
  // string even when every character is ASCII, and WebKit refuses it exactly
  // like the unescaped text (measured, WebKit 26.5). A TextDecoder result is
  // 8-bit. Never decode as 'latin1': that label is windows-1252 and garbles
  // U+0080 to U+00FF.
  return new TextDecoder().decode(new TextEncoder().encode(escaped));
}
