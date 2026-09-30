/**
 * The ONE writer path for `fs:graph` and `fs:savedGroups`: pure 8-bit ASCII.
 * WebKit charges localStorage double once any character above U+00FF is stored
 * (measured; docs/dev/storage-and-limits.md).
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
