/**
 * FNV-1a (32-bit): the ONE copy of it in the app.
 *
 * It started life as `hashPayload` inside `engine/imageAssets.ts`, where it
 * keys the `fs-asset:<node>-<hash>` placeholders (so a change to an image's
 * BYTES always changes the generated code) and the decode memo. It moved here
 * so every later caller shares this exact body instead of growing its own copy
 * — a second copy is a second chance for two sides to disagree about the key.
 * The move changed nothing about what it computes, so the placeholders it
 * produces are byte-identical (`imageGraphByteStability.test.ts`).
 *
 * NOT an identity: 32 bits collide, and a colliding pair of real base64
 * payloads of equal length is pinned in `payloadDigest.test.ts`. It is a cheap
 * BUCKET key. Every decision that treats two payloads as the same must confirm
 * by content, never by the digest alone.
 *
 * A LEAF: it imports nothing, so any module can use it without joining an
 * import cycle (the `costTable.ts` lesson).
 *
 * `imageOriginCache.ts` holds a separately seeded 128-bit, four-lane variant
 * of the same round. That is a different function with a different output, not
 * a copy of this one.
 */

/** FNV-1a over a string's UTF-16 CODE UNITS, as 8 lower-case hex digits. */
export function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The same round over BYTES, returned as an unsigned 32-bit number. For a
 * string whose code units are all below 256 it agrees with `fnv1a32Hex` over
 * that string's Latin-1 bytes. It is NOT the UTF-8 hash of a string: the two
 * are different inputs.
 */
export function fnv1a32Bytes(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
