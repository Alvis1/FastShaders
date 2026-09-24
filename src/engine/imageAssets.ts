import { getNodeValues } from '@/types';
import type { AppNode } from '@/types';
import { valueStr, valueNum } from '@/utils/valueCoerce';
import { decodeImageNode } from '@/utils/imageNode';
import { bytesToBase64 } from '@/utils/binaryCodec';
import { fnv1a32Hex } from '@/utils/payloadDigest';
import { createDigestMemo } from '@/utils/digestMemo';
import { PLATFORM_CAPS } from '@/utils/platformCaps';
// ONE byte formatter, shared with the feedback report. This file carried its
// own copy with coarser KB rounding (`2 KB` where the other says `2.0 KB`), so
// the same payload was described two different ways depending on which surface
// asked. Nothing depended on either spelling — both are comment/prose text —
// but a formatter that disagrees with itself is a drift pair waiting to be
// noticed as a bug. Its output must stay ASCII: it lands in the line comment
// beside every emitted image `.src`, which ships inside exported `.js` files.
import { formatBytes } from '@/utils/feedbackReport';
import { FS_PLACEHOLDER_RE } from './glbShaderContract';

/**
 * Image payloads are emitted into generated code as a short placeholder rather
 * than a multi-hundred-KB `data:` URL, and spliced back to the real bytes only
 * at the surfaces that actually execute or export the module.
 *
 * The editor's TSL tab word-wraps, so one 600K-char `.src = "data:..."` line
 * becomes ~8,500 visual rows per image — and `code` is regenerated on every
 * graph edit, so Monaco re-tokenizes megabytes per keystroke. Showing a
 * reference instead costs nothing in fidelity: image nodes are already ONE-WAY
 * through codeToGraph (their setup statements are inert by design — see
 * `engine/imageNode.test.ts`), so the payload in the editor was never read back.
 *
 * SECURITY: everything interpolated here is either re-derived from decoded
 * bytes (the `data:` URL, exactly as before) or hard-sanitized to a character
 * whitelist (node ids and file names are adversarial — they arrive from loaded
 * `.fastshader` projects). No attacker-controlled character can close the
 * emitted string literal or the trailing line comment.
 */

/** Marker prefix identifying a payload stand-in inside generated code. */
export const IMAGE_ASSET_PREFIX = 'fs-asset:';

/**
 * Matches a placeholder string literal. The key class is `[^"]+` so the match
 * can never run past the closing quote; an unrecognized key simply isn't in the
 * asset map and is left verbatim (the image then fails `decode()` and hits the
 * existing 1x1 black fallback).
 *
 * The LITERAL lives in engine/glbShaderContract.ts (FS_PLACEHOLDER_RE), the
 * zero-import leaf the single-GLB reader (utils/glbShaderExtras.ts) and
 * writer share: that reader may not import this module, which reaches the
 * store. This is the SAME object, not a copy.
 */
const PLACEHOLDER_RE = FS_PLACEHOLDER_RE;
/**
 * The ONE exported copy of that regex, shared by the sandboxed preview's
 * asset feed (engine/previewAssetFeed.ts, GLB Phase 6 S3) and the single-GLB
 * export's asset table (Phase 7) — whichever needs "which keys does this
 * module reference" iterates it, never a second literal. It is a /g regex:
 * iterate it with `matchAll` (which clones it) rather than `test`/`exec`,
 * whose `lastIndex` would carry over between callers.
 */
export const IMAGE_PLACEHOLDER_RE = PLACEHOLDER_RE;

export interface ImageAsset {
  /** Map key — `<sanitized node id>-<payload hash>`. */
  key: string;
  /** The full placeholder token, ready to interpolate into a string literal. */
  placeholder: string;
  /** Canonical `data:` URL re-encoded from the decoded bytes. */
  src: string;
  /** Sanitized single-line `//` comment describing the image (no leading space). */
  comment: string;
}

/**
 * FNV-1a (32-bit) over the stored payload. The hash rides in the placeholder so
 * that changing an image's BYTES always changes the generated code — consumers
 * (the debounced preview rebuild, the srcDoc memo) key their invalidation on
 * the code string, and without it swapping in a different image of identical
 * dimensions would leave `code` untouched and the preview stale. It also keys
 * the decode memo below, so the same digest decides both identities. The
 * round is `fnv1a32Hex` (utils/payloadDigest.ts), the one FNV-1a copy, moved
 * there verbatim so these placeholders are byte-identical. It is asked through
 * `payloadDigests` (below), which only remembers what that round returned, so
 * the placeholder a memo hit produces is the one a fresh hash would.
 */
function hashPayload(s: string): string {
  return payloadDigests.get(s);
}

/** Node ids reach us from imported project JSON — reduce to a literal-safe class. */
function safeKeyPart(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'image';
}

/**
 * File names are user/import supplied. Reduce to an ASCII whitelist — which
 * removes every JS line terminator (including U+2028/U+2029), the only thing
 * that could end the trailing `//` comment early — then collapse the
 * substitution runs so a hostile name degrades to something still readable.
 */
function safeFileName(v: unknown): string {
  return valueStr(v)
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[_ ]+|[_ ]+$/g, '')
    .slice(0, 48);
}

/**
 * Bounded memo for the multi-MB decode + re-encode. graph→code re-runs on every
 * node-identity change — including every drag frame — but an image's payload
 * never changes with node position. Keyed by every input `decodeImageNode`
 * validates: the width/height fields (a bad dimension must still degrade to
 * inert) plus a DIGEST of the stored payload.
 *
 * The digest is what makes the memo bounded in the way its name promises. A Map
 * retains its KEYS, so keying by the raw payload pinned a full copy of every
 * cached image — ~600K chars at the per-image soft cap, 8M at the ignore-limits
 * ceiling — on top of the re-encoded `src` the entry exists to hold, and nothing
 * clears this map when the nodes are deleted or the whole graph is replaced (NEW,
 * import). Length rides beside the 32-bit hash so a collision would need two
 * payloads of identical size AND digest; that is the same identity the emitted
 * placeholder key already trusts.
 *
 * Eviction is bounded by CHARACTERS as well as entries: a count says nothing
 * about how much is retained, and one payload at the hard ceiling outweighs
 * twenty ordinary ones.
 *
 * Both bounds are platform-sized (utils/platformCaps.ts): web 24 entries / 4M
 * chars; the desktop room 128 / 40M, which holds a whole desktop project (32M)
 * plus one image in flight — at the web bound a desktop graph would evict what
 * the next graph→code pass reuses and re-decode every image on every pass.
 */
const IMAGE_SRC_CACHE_LIMIT = PLATFORM_CAPS.imageDecodeCacheEntries;
const IMAGE_SRC_CACHE_MAX_CHARS = PLATFORM_CAPS.imageDecodeCacheChars;

/** Test hooks, no production callers (the cancelPendingGraphSave precedent). */
let counters = { digests: 0, decodes: 0 };

/**
 * The digest in front of the decode memo (utils/digestMemo.ts). Without it every
 * lookup re-ran the FNV round over the whole payload: once per Image node per
 * graph→code pass, ~7.6 ms at a 6M-char payload (measured in node), even when no
 * image had changed. It is keyed by the stored payload itself, so it keeps
 * payload strings alive, but those are the strings the store already shares
 * between nodes and history entries (Phase 2). After a NEW or an import, old
 * ones stay pinned until evicted, as the decode memo's `src` values do.
 *
 * Twice the decode memo's bounds, so for ordinary payloads this is not the
 * tighter of the two: every decode lookup is preceded by a digest lookup of the
 * same string, so the recency orders match, and a pass whose payloads fit the
 * decode memo also fits here. (A payload that fails to decode is the exception:
 * its null entry costs the decode memo nothing, while its key still counts here.)
 */
const payloadDigests = createDigestMemo(
  (s) => {
    counters.digests++;
    return fnv1a32Hex(s);
  },
  IMAGE_SRC_CACHE_LIMIT * 2,
  IMAGE_SRC_CACHE_MAX_CHARS * 2,
);
interface DecodedPayload {
  src: string;
  bytes: number;
  mime: string;
}
const imageSrcCache = new Map<string, DecodedPayload | null>();
/** Running sum of the cached `src` lengths — the only unbounded term left. */
let imageSrcCacheChars = 0;

function entryChars(v: DecodedPayload | null | undefined): number {
  return v ? v.src.length : 0;
}

function memoPayload(key: string, compute: () => DecodedPayload | null): DecodedPayload | null {
  const hit = imageSrcCache.get(key);
  if (hit !== undefined) {
    imageSrcCache.delete(key);
    imageSrcCache.set(key, hit); // refresh LRU recency
    return hit;
  }
  const val = compute();
  imageSrcCache.set(key, val);
  imageSrcCacheChars += entryChars(val);
  // `size > 1` on the byte bound keeps the entry just inserted even when it
  // alone blows the budget: a single oversized image must still be memoized, or
  // every graph→code run re-decodes it — the one cost this memo exists to avoid.
  while (
    imageSrcCache.size > IMAGE_SRC_CACHE_LIMIT ||
    (imageSrcCacheChars > IMAGE_SRC_CACHE_MAX_CHARS && imageSrcCache.size > 1)
  ) {
    const oldest = imageSrcCache.keys().next().value;
    if (oldest === undefined) break;
    imageSrcCacheChars -= entryChars(imageSrcCache.get(oldest));
    imageSrcCache.delete(oldest);
  }
  return val;
}

/** Test hook: how many FNV rounds and decodes ran since the last reset. */
export function imageAssetCounters(): { digests: number; decodes: number } {
  return { ...counters };
}

/**
 * Test hook: zero the counters and empty BOTH memos, so a count starts cold.
 * With `isolate: false` another file in the worker may already have decoded the
 * same payload, which would otherwise read as a decode that never ran.
 */
export function resetImageAssetCounters(): void {
  counters = { digests: 0, decodes: 0 };
  payloadDigests.clear();
  imageSrcCache.clear();
  imageSrcCacheChars = 0;
}

/**
 * Resolve one Image node's payload into its placeholder + real `data:` URL.
 * Returns null when the stored payload fails strict validation — callers then
 * emit the inert `vec3(0, 0, 0)` fallback, exactly as before.
 */
export function imageAssetFor(
  nodeId: string,
  values: Record<string, string | number>,
): ImageAsset | null {
  // `valueStr`, not `String()`: `values` is adversarial and ToPrimitive
  // THROWS on a tampered entry — here that means inside graphToCode, inside
  // the sync engine, inside a render, with no error boundary above it. See
  // utils/valueCoerce.ts for what that costs.
  const raw = valueStr(values.imageB64);
  // Hashed outside the memo because the digest IS the cache key. No extra pass:
  // a raw-string key had to be flattened, hashed and compared in full on every
  // lookup anyway — this replaces that with one hash and a short key. The hash
  // itself is memoized too (`payloadDigests`), so a pass that changed no
  // payload runs no FNV round at all.
  const payloadHash = hashPayload(raw);
  const decoded = memoPayload(
    `${valueNum(values.width)}x${valueNum(values.height)}|${raw.length}|${payloadHash}`,
    () => {
      counters.decodes++;
      const d = decodeImageNode(values);
      if (!d) return null;
      return {
        src: `data:image/${d.mime};base64,${bytesToBase64(d.bytes)}`,
        bytes: d.bytes.length,
        mime: d.mime,
      };
    },
  );
  if (!decoded) return null;

  const key = `${safeKeyPart(nodeId)}-${payloadHash}`;
  const name = safeFileName(values.fileName);
  const w = valueNum(values.width);
  const h = valueNum(values.height);
  const dims = Number.isFinite(w) && Number.isFinite(h) ? `${w}x${h} ` : '';
  const comment = `// ${name ? `${name}, ` : ''}${dims}${decoded.mime}, ${formatBytes(decoded.bytes)}`;

  return { key, placeholder: `${IMAGE_ASSET_PREFIX}${key}`, src: decoded.src, comment };
}

/**
 * Every Image payload in the graph, keyed by placeholder key. Pure over the
 * nodes, so any consumer can rebuild it on demand — there is no separate copy
 * to keep in sync with the store.
 *
 * graphToCode emits only the OWNER's placeholder of each share group
 * (engine/imageTexturePlan.ts: nodes holding the same payload share one Image
 * element, and one texture when their texture settings match too). This map
 * still carries every node's entry, so the owner's key is
 * always present. Do not filter it down to the emitted keys here: de-duplicated
 * hashing is the payload table's job.
 */
export function collectImageAssets(nodes: AppNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes) {
    if (n.data.registryType !== 'imageNode') continue;
    const asset = imageAssetFor(n.id, getNodeValues(n));
    if (asset) out.set(asset.key, asset.src);
  }
  return out;
}

/**
 * Expand every placeholder back to its real `data:` URL. Call this at the
 * surfaces that RUN or EXPORT the module (preview iframe, XR popup, A-Frame tab,
 * Download Shader) — never for what the TSL editor displays.
 *
 * Replacement goes through a function so a `$&`/`$1` sequence inside a payload
 * could never be reinterpreted as a substitution pattern.
 */
export function inlineImageAssets(code: string, assets: Map<string, string>): string {
  if (assets.size === 0 || !code.includes(IMAGE_ASSET_PREFIX)) return code;
  return code.replace(PLACEHOLDER_RE, (whole, key: string) => {
    const src = assets.get(key);
    return src === undefined ? whole : `"${src}"`;
  });
}

/** Convenience: expand `code` using the payloads currently in `nodes`. */
export function inlineImageAssetsFromNodes(code: string, nodes: AppNode[]): string {
  if (!code.includes(IMAGE_ASSET_PREFIX)) return code;
  return inlineImageAssets(code, collectImageAssets(nodes));
}
