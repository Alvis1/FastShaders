import { getNodeValues } from '@/types';
import type { AppNode } from '@/types';
import { decodeImageNode } from '@/utils/imageNode';
import { bytesToBase64 } from '@/utils/binaryCodec';

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
 */
const PLACEHOLDER_RE = /"fs-asset:([^"]+)"/g;

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
 * dimensions would leave `code` untouched and the preview stale.
 */
function hashPayload(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
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
  return String(v ?? '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[_ ]+|[_ ]+$/g, '')
    .slice(0, 48);
}

/** Human-readable byte size, ASCII only (the comment lands in exported files). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Bounded memo for the multi-MB decode + re-encode + hash. graph→code re-runs on
 * every node-identity change — including every drag frame — but an image's
 * payload never changes with node position. Keyed by the stored payload plus the
 * width/height fields (a bad dimension must still degrade to inert), i.e. every
 * input `decodeImageNode` validates. Small LRU cap bounds memory across many
 * distinct images.
 */
const IMAGE_SRC_CACHE_LIMIT = 24;
interface DecodedPayload {
  src: string;
  hash: string;
  bytes: number;
  mime: string;
}
const imageSrcCache = new Map<string, DecodedPayload | null>();

function memoPayload(key: string, compute: () => DecodedPayload | null): DecodedPayload | null {
  const hit = imageSrcCache.get(key);
  if (hit !== undefined) {
    imageSrcCache.delete(key);
    imageSrcCache.set(key, hit); // refresh LRU recency
    return hit;
  }
  const val = compute();
  imageSrcCache.set(key, val);
  if (imageSrcCache.size > IMAGE_SRC_CACHE_LIMIT) {
    const oldest = imageSrcCache.keys().next().value;
    if (oldest !== undefined) imageSrcCache.delete(oldest);
  }
  return val;
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
  const raw = String(values.imageB64 ?? '');
  const decoded = memoPayload(
    `${Number(values.width)}x${Number(values.height)}|${raw}`,
    () => {
      const d = decodeImageNode(values);
      if (!d) return null;
      return {
        src: `data:image/${d.mime};base64,${bytesToBase64(d.bytes)}`,
        hash: hashPayload(raw),
        bytes: d.bytes.length,
        mime: d.mime,
      };
    },
  );
  if (!decoded) return null;

  const key = `${safeKeyPart(nodeId)}-${decoded.hash}`;
  const name = safeFileName(values.fileName);
  const w = Number(values.width);
  const h = Number(values.height);
  const dims = Number.isFinite(w) && Number.isFinite(h) ? `${w}x${h} ` : '';
  const comment = `// ${name ? `${name}, ` : ''}${dims}${decoded.mime}, ${formatBytes(decoded.bytes)}`;

  return { key, placeholder: `${IMAGE_ASSET_PREFIX}${key}`, src: decoded.src, comment };
}

/**
 * Every Image payload in the graph, keyed by placeholder key. Pure over the
 * nodes, so any consumer can rebuild it on demand — there is no separate copy
 * to keep in sync with the store.
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
