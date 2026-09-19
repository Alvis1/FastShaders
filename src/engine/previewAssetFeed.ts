/**
 * The sandboxed preview's IMAGE-ASSET FEED (GLB Phase 6, S3): image payloads
 * cross into the preview document ONCE per key per document, instead of riding
 * every shader hot swap.
 *
 * Until S3 the parent inlined every `fs-asset:` placeholder back into the
 * module text before baking it and before every `fs:shader` post, so a scrub
 * on a graph holding four 5 MB images posted ~20 MB of `data:` URLs per edit
 * and the document re-minted a module Blob of that size each time. Now:
 *
 *   - the PARENT plans which payloads the live document still needs
 *     (`planPreviewAssetFeed`: keys the module references, present in the
 *     asset map, not already sent to THIS document) and posts them as
 *     `fs:image-assets` immediately before the `fs:shader` post that needs
 *     them (postMessage is FIFO per target, so they land first);
 *   - the DOCUMENT keeps a key → `blob:` URL map (`PREVIEW_ASSET_RESOLVER_SCRIPT`,
 *     seeded from `window.__fsBootAssets` at parse time) and resolves the
 *     placeholders right before a module Blob is minted — the boot blob and
 *     every hot swap alike;
 *   - the module TEXT stays placeholder-only everywhere the parent compares it
 *     (`runningModuleRef`, the receiver's `applied`), so the hot channel's
 *     idempotency compare is unchanged.
 *
 * Sandboxed preview documents ONLY. The sandbox's URL allowlist admits blob:
 * and data: alone and its opaque origin could not fetch from the app anyway,
 * which is why the bytes arrive as messages — the same route Phase 3's mesh
 * decoders take. The XR popup, the A-Frame and Three.js tabs and the export
 * still inline the `data:` URLs (`inlineImageAssetsFromNodes`): they are
 * top-level or standalone documents with no parent to feed them.
 *
 * The document is disposable, so its object URLs die with it: nothing revokes
 * a per-key URL, and a key is never re-minted (the placeholder carries the
 * payload hash, so a changed image is a NEW key). The resolver trusts the
 * parent's payloads — they are canonical `imageAssetFor` output — and refuses
 * anything but a `data:image/(png|jpeg|webp);base64,` string of base64
 * characters, so a forged entry can at most fail to resolve. Shader code
 * running in the sandbox can overwrite `window.__fsResolveAssets`, but it
 * already controls that document, so nothing is gained; it cannot read the
 * parent.
 */
import { IMAGE_PLACEHOLDER_RE } from './imageAssets';

/** The parent → sandbox message carrying `{ entries: PreviewAssetEntry[] }`. */
export const PREVIEW_ASSETS_MESSAGE = 'fs:image-assets';

export interface PreviewAssetEntry {
  /** The placeholder key (`<sanitized node id>-<payload hash>`). */
  key: string;
  /** The canonical `data:` URL. */
  src: string;
}

/**
 * Which image payloads the LIVE sandboxed preview still needs for `code`: the
 * keys the module references (first-occurrence order, each once), present in
 * `assets`, not already sent to THIS document. `sent` is never mutated; the
 * returned set is the caller's next `sent`. Pure.
 */
export function planPreviewAssetFeed(
  sent: ReadonlySet<string>,
  assets: ReadonlyMap<string, string>,
  code: string,
): { entries: PreviewAssetEntry[]; sent: Set<string> } {
  const next = new Set(sent);
  const entries: PreviewAssetEntry[] = [];
  // `matchAll` clones the /g regex, so the shared one's lastIndex is untouched.
  for (const m of code.matchAll(IMAGE_PLACEHOLDER_RE)) {
    const key = m[1];
    if (next.has(key)) continue;
    const src = assets.get(key);
    if (src === undefined) continue;
    next.add(key);
    entries.push({ key, src });
  }
  return { entries, sent: next };
}

/**
 * Runs inside the sandboxed preview document. Defines
 * `window.__fsAddAssets(list)` (maps each key to a `blob:` URL once per
 * document) and `window.__fsResolveAssets(code)` (replaces every placeholder
 * whose key is known), seeds from `window.__fsBootAssets`, and listens for
 * `fs:image-assets` from the parent. A plain `<script>` string, like the other
 * document scripts in tslToPreviewHTML.ts; `previewAssetFeed.test.ts`
 * EXECUTES it against the real Blob/URL/atob.
 *
 * Registered at TOP level (before the module blob is minted): the parent's
 * post can only land once this script has parsed, and the boot list must be
 * mapped before `__shaderCode` is resolved a few blocks below.
 */
export const PREVIEW_ASSET_RESOLVER_SCRIPT = `<script>
  (function () {
    // Null-prototype: a key comes out of a .fastshader and could spell
    // "constructor" or "__proto__" (the Map/null-proto rule every mesh-name
    // map in this app follows).
    var urls = Object.create(null);
    var SRC_RE = /^data:image\\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
    var MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
    function add(list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || typeof e.key !== "string" || typeof e.src !== "string") continue;
        if (urls[e.key] !== undefined) continue;
        var m = SRC_RE.exec(e.src);
        if (!m) continue;
        var bin;
        try { bin = atob(e.src.slice(e.src.indexOf(",") + 1)); } catch (err) { continue; }
        var bytes = new Uint8Array(bin.length);
        for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        try { urls[e.key] = URL.createObjectURL(new Blob([bytes], { type: MIME[m[1]] })); } catch (err) {}
      }
    }
    window.__fsAddAssets = add;
    window.__fsResolveAssets = function (code) {
      if (typeof code !== "string") return code;
      return code.replace(/"fs-asset:([^"]+)"/g, function (whole, key) {
        return urls[key] !== undefined ? '"' + urls[key] + '"' : whole;
      });
    };
    add(window.__fsBootAssets || []);
    // The boot list has done its job; drop the strings so the document keeps
    // one copy of each payload (the Blob), not two.
    window.__fsBootAssets = null;
    window.addEventListener("message", function (e) {
      if (e.source !== window.parent) return;
      var msg = e.data;
      if (!msg || msg.type !== "${PREVIEW_ASSETS_MESSAGE}") return;
      add(msg.entries);
    });
  })();
<${''}/script>`;
