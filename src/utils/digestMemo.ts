/**
 * A bounded string → digest memo (GLB Phase 6, S2).
 *
 * `imageAssetFor` hashes an Image node's whole stored payload before it can ask
 * its decode memo anything, because the digest IS that memo's key. graph→code
 * runs that on every pass (every drag frame replaces the nodes array), and the
 * texture planner asks once per Image node, so a graph re-hashed every payload
 * every pass even when nothing about an image had changed. MEASURED in node on a
 * 6M-char payload (the desktop per-image cap): the JS FNV loop takes ~7.6 ms, a
 * hit here on the same string object ~0 ms, and a hit on an equal copy ~0.12 ms.
 * The last case is a native comparison of the two strings, still ~60× cheaper.
 * Phase 2's payload sharing makes the same object the usual case: nodes, history
 * entries and the store share one payload string.
 *
 * LRU by entry count AND by characters. The characters are the KEYS: a Map keeps
 * every key string alive, so a count alone says nothing about what is retained,
 * and one payload at the 8M hard ceiling outweighs twenty ordinary ones. Like the
 * decode memo it serves, it keeps the entry just inserted even when that entry
 * alone is over the character budget, or an oversized payload would be re-hashed
 * on every pass (the one cost this exists to avoid).
 *
 * The character bound has to be sized for the platform. Two payloads alternating
 * under a bound that cannot hold both evict each other every time, so every
 * lookup misses (digestMemo.test.ts pins the 6M/3M case both ways).
 *
 * The digest is whatever `hash` returns. This module never computes one itself,
 * so it cannot become a second copy of the FNV round (`payloadDigest.ts` owns
 * that). A ZERO-IMPORT LEAF (the `costTable.ts` lesson).
 */
export interface DigestMemo {
  /** The digest of `s`: from the memo, or computed once and remembered. */
  get(s: string): string;
  /** Forget everything (entries and the running character count). */
  clear(): void;
  /** Entries currently held. */
  readonly size: number;
}

/**
 * @param hash      the digest function; called once per miss, never on a hit
 * @param maxEntries entry bound (≥ 1)
 * @param maxChars  bound on the summed key lengths
 */
export function createDigestMemo(
  hash: (s: string) => string,
  maxEntries: number,
  maxChars: number,
): DigestMemo {
  const entries = new Map<string, string>();
  /** Running sum of the key lengths, the only unbounded term. */
  let chars = 0;

  return {
    get(s: string): string {
      const hit = entries.get(s);
      if (hit !== undefined) {
        entries.delete(s);
        entries.set(s, hit); // refresh LRU recency
        return hit;
      }
      const digest = hash(s);
      entries.set(s, digest);
      chars += s.length;
      // `size > 1` on the character bound keeps the entry just inserted; the
      // count bound can never evict it while maxEntries ≥ 1.
      while (entries.size > maxEntries || (chars > maxChars && entries.size > 1)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        chars -= oldest.length;
        entries.delete(oldest);
      }
      return digest;
    },
    clear(): void {
      entries.clear();
      chars = 0;
    },
    get size(): number {
      return entries.size;
    },
  };
}
