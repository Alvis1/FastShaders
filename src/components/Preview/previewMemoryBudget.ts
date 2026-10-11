/**
 * The live preview document's RETAINED-MEMORY budget: how much a run of hot
 * swaps has left behind, and when a cold rebuild should free it.
 *
 * Every hot swap imports a fresh blob module, and the document's module map
 * keeps every module it has imported, with its module-scope `Image` element and
 * `THREE.Texture` (engine/imageTexturePlan.ts). The loader disposes materials,
 * never a module's textures. Only throwing the document away frees them.
 * Measured on the production build (review 2026-10-11, WebGPU and WebGL2
 * alike): each swap added 5.2 MB of GPU-process memory per 1024x1024 colour
 * picture and 21.6 MB per 2048x2048 one, which is 1.08 GB after 50 edits. The
 * GPU process is shared with every tab and with the editor's own compositor.
 * Without pictures, the growth is about 28 KB of JS heap per swap.
 *
 * The owner approved a BUDGET, not a fix inside the document. Tracking textures
 * in the stage failed: `globalThis.THREE.Texture` cannot be redefined on the
 * bundle's THREE. A dispose in the loader would need an additive 0.8 change and
 * a CDN purge. So ShaderPreview counts what each swap leaves behind and, past
 * the budget, bumps `coldGen` (the existing manual rebuild handle) at a QUIET
 * moment. A cold rebuild keeps what the user tuned: the camera and turntable
 * angle are restore targets, and the tuned uniforms are pushed again on
 * fs:preview-ready. It costs 0.4-0.6 s of boot on a real GPU (4-5 s on a
 * software one), a re-parse of a dropped model, and a restart of TSL `time`.
 * Podest already caps the same growth (`CYCLE_RESTART_EVERY`).
 *
 * What a swap or a re-apply charges is the module it REPLACES: the incoming
 * one is what a fresh document would hold too. (The first document is baked
 * from the empty previewCode and gets its real module by swap, so charging the
 * incoming module rebuilt an over-budget project 2 s after every boot.)
 *
 * The count is an ESTIMATE that mostly errs towards rebuilding early. It counts
 * every post, including one the receiver finds it already runs, and every
 * emitted texture, including one nothing samples. It trusts the stored
 * `width`/`height` (held to 8192 by `imageAssetFor`), so a forged size can
 * bring a rebuild forward; a size that understates the real picture delays one.
 * The one known under-count is the Environment prefilter (see
 * `moduleImageTextureBytes`).
 *
 * Pure apart from `RETAINED_BYTES_BUDGET`, which reads the build's caps once
 * (`PLATFORM_CAPS.previewRetainedBytes`).
 */
import { getNodeValues, type AppNode } from '@/types';
import { IMAGE_ASSET_PREFIX, IMAGE_PLACEHOLDER_RE, imageAssetFor } from '@/engine/imageAssets';
import { imageTextureSpecKey, readImageTextureSpec } from '@/utils/imageTextureSpec';
import { textureMemory, type TextureMemoryInput } from '@/utils/textureMemory';
import { PLATFORM_CAPS, capsFor } from '@/utils/platformCaps';

/**
 * The budget for a build: 256 MiB on the web, 1 GiB on desktop. The figures
 * live in PlatformCaps (`previewRetainedBytes`), the ONE table of web/desktop
 * differences, beside the reasons desktop gets 4x. Pure, so a test can ask for
 * either.
 */
export function retainedBytesBudget(desktop: boolean): number {
  return capsFor(desktop).previewRetainedBytes;
}

/** What THIS build applies. */
export const RETAINED_BYTES_BUDGET = PLATFORM_CAPS.previewRetainedBytes;

/**
 * Module imports per document before a rebuild, whatever their bytes: the
 * ~28 KB of JS heap each swap keeps even without a picture (400 swaps ≈ 11 MB).
 */
export const MAX_RETAINED_SWAPS = 400;

/** How long nothing may happen before the budget's rebuild runs. */
export const QUIET_REBUILD_MS = 2000;

/** How often to ask again while a pointer is down or a swap awaits its ack. */
export const QUIET_RECHECK_MS = 500;

/**
 * A pointer that has been "down" this long is treated as released. A pointerup
 * that lands inside the preview iframe never reaches this window, and a flag
 * stuck on would put the rebuild off for good while the edits went on.
 */
export const POINTER_STALE_MS = 30_000;

/** The payload-hash half of a placeholder key (`<sanitized node id>-<hash>`). */
function payloadHashOf(key: string): string {
  return key.slice(key.lastIndexOf('-') + 1);
}

/**
 * The GPU texture bytes one import of `code` creates: one texture per distinct
 * (payload x texture-object spec) the module emits, the grouping
 * engine/imageTexturePlan.ts shares textures on. Only the element owner's
 * placeholder appears in the code, so a payload is "in the module" when ANY
 * placeholder carries its hash, and every node holding it adds its spec.
 * `nodes` are the nodes `code` was generated from (the settled pair's).
 *
 * The arithmetic is utils/textureMemory.ts's `textureMemory`, the ONE copy:
 * 4 bytes per texel, a colour picture's exact mip chain (about +1/3), none for
 * a data map, and its rules for an adversarial stored size. It is the figure
 * the Material Settings menu prints. One input is left out: the PMREM prefilter
 * of a picture wired into Environment (`environment: false`). Telling which
 * picture feeds Environment needs the edges, and the settled pair carries
 * nodes only.
 */
export function moduleImageTextureBytes(nodes: readonly AppNode[], code: string): number {
  if (!code.includes(IMAGE_ASSET_PREFIX)) return 0;
  const payloads = new Set<string>();
  // `matchAll` clones the /g regex, so the shared one's lastIndex is untouched.
  for (const m of code.matchAll(IMAGE_PLACEHOLDER_RE)) payloads.add(payloadHashOf(m[1]));
  const inputs: TextureMemoryInput[] = [];
  for (const n of nodes) {
    if (n.data.registryType !== 'imageNode') continue;
    const values = getNodeValues(n);
    // Memoized by the payload's digest, and postShaderSwap's own
    // `collectImageAssets` has just asked for the same nodes: a lookup.
    const asset = imageAssetFor(n.id, values);
    if (!asset) continue;
    const hash = payloadHashOf(asset.key);
    if (!payloads.has(hash)) continue;
    const spec = readImageTextureSpec(values);
    inputs.push({
      key: `${hash}|${imageTextureSpecKey(spec)}`,
      width: values.width,
      height: values.height,
      mipmapped: spec.colorSpace !== 'data',
      environment: false,
    });
  }
  return textureMemory(inputs).bytes;
}

/**
 * The Blob bytes an `fs:image-assets` post adds to the document. The resolver
 * mints one `blob:` URL per new key and nothing revokes it until the document
 * goes (engine/previewAssetFeed.ts). These bytes live in the browser's blob
 * storage, not on the GPU, but the same rebuild frees them, so they share the
 * one budget (review 2026-10-11, asset-feed-blobs-accumulate).
 */
export function assetFeedBytes(entries: readonly { readonly src: string }[]): number {
  let total = 0;
  for (const e of entries) {
    const body = e.src.length - (e.src.indexOf(',') + 1);
    if (body > 0) total += Math.floor((body * 3) / 4);
  }
  return total;
}

/** What the live document holds beyond what a fresh one would. */
export interface RetainedTally {
  bytes: number;
  /** Module imports charged since the document was built (swaps + re-applies). */
  swaps: number;
}

export function overBudget(
  t: Readonly<RetainedTally>,
  budget: number = RETAINED_BYTES_BUDGET,
  maxSwaps: number = MAX_RETAINED_SWAPS,
): boolean {
  return t.bytes > budget || t.swaps >= maxSwaps;
}

export interface QuietState {
  readonly now: number;
  /** The last edit, swap, re-apply, key, wheel, pointer or orbit move. */
  readonly lastActivityAt: number;
  /** When the pointer went down in this window, or null while it is up. */
  readonly pointerDownAt: number | null;
  /** A hot swap is still waiting for its gen-tagged ack. */
  readonly ackPending: boolean;
}

/**
 * 0 when the rebuild may run now. Otherwise, how many ms to wait before asking
 * again. Quiet means: no pointer held (unless it has been held past
 * POINTER_STALE_MS), no swap waiting for its ack, and QUIET_REBUILD_MS since
 * the last activity.
 */
export function quietRebuildDelay(s: QuietState): number {
  const held = s.pointerDownAt !== null && s.now - s.pointerDownAt < POINTER_STALE_MS;
  if (held || s.ackPending) return QUIET_RECHECK_MS;
  const left = s.lastActivityAt + QUIET_REBUILD_MS - s.now;
  return left > 0 ? left : 0;
}

export interface QuietRebuildOptions {
  /** Is the live document still over its budget? Asked at every tick, so a
   *  rebuild that has already reset the tally stops the timer. */
  readonly over: () => boolean;
  /** The quiet inputs, read when a tick runs (ShaderPreview's refs). */
  readonly inputs: () => Omit<QuietState, 'now'>;
  /** ShaderPreview's `setColdGen((g) => g + 1)`, the manual rebuild handle. */
  readonly rebuild: () => void;
  readonly now?: () => number;
}

export interface QuietRebuild {
  /** Start waiting for a quiet moment. A no-op while already waiting. */
  arm(): void;
  /** Stop waiting (unmount). */
  cancel(): void;
}

/**
 * The trigger: once armed, wait QUIET_REBUILD_MS, then rebuild if the document
 * is still over budget and the moment is quiet, else wait as long as
 * `quietRebuildDelay` says and ask again. One timer at a time.
 */
export function createQuietRebuild(o: QuietRebuildOptions): QuietRebuild {
  const now = o.now ?? (() => performance.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    timer = null;
    if (!o.over()) return;
    const wait = quietRebuildDelay({ now: now(), ...o.inputs() });
    if (wait > 0) {
      timer = setTimeout(check, wait);
      return;
    }
    o.rebuild();
  };
  return {
    arm() {
      if (timer === null) timer = setTimeout(check, QUIET_REBUILD_MS);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
