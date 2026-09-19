/**
 * What the Image node's settings menu knows about the node's stashed ORIGINAL,
 * derived from one read of the original cache.
 *
 * Pure and free of React so the menu-session rules can be RUN in the node test
 * env (ImageNodeSettings is a component, and vitest has no DOM). The component
 * holds the two pieces of state (`loaded` and the receipt latch) and asks this
 * module what they mean for the node currently on screen.
 *
 * TWO RULES, both there because a second right-click MOVES the open menu to
 * another node without remounting it (ContextMenu renders NodeSettingsMenu
 * with no per-node key), so the component's state outlives the node it was
 * read for:
 *
 * 1. **An original belongs to ONE `originId`.** The cache read is async, and
 *    until it answers for the id the node carries NOW, the menu has no
 *    original: `origin` is null and `pending` is true. The previous design
 *    kept "the last payload read" and cleared it only when the next read
 *    landed, so a menu moved from node A to node B kept showing A's original
 *    — with Revert LIVE, and clicking it wrote A's picture into B (the
 *    Resolution ladder would also have re-encoded from A's original). It also
 *    left `pending` stuck at true when the id went to '' mid-read, which
 *    disabled B's Resolution select for the rest of the menu session. Keying
 *    the read by its id makes both states unrepresentable: a stale read is
 *    simply a read for some other id.
 *
 * 2. **The receipt latch is keyed by `nodeId|originId`.** Once the Original
 *    row and Revert have shown, they stay for the menu session, so a revert
 *    (which keeps `originId`) can show its "already the original" receipt on
 *    the frame its own gate turns false. Keyed on the node id alone, a later
 *    change of payload lineage on the SAME node — the texture picker, which
 *    moves `originId` with the payload — would keep the row up as "not on
 *    this device" beside a dead Revert.
 *
 * Several nodes may legitimately share one `originId` (the cache is keyed by
 * CONTENT, and Ctrl+D / paste clone `data`), so a menu moved onto a clone
 * reuses the read — correct, it is the same original — while the receipt,
 * which is per node, does not carry across.
 */
import type { ImageOriginPayload } from '@/utils/imageOriginCache';

/** One completed read of the original cache: the id it was FOR, and what came
 *  back (null = no usable record). `null` as a whole = nothing read yet. */
export type LoadedOrigin = {
  readonly id: string;
  readonly payload: ImageOriginPayload | null;
} | null;

/** The original read for THIS id, or null — never another id's. */
export function originFor(loaded: LoadedOrigin, originId: string): ImageOriginPayload | null {
  return loaded && loaded.id === originId ? loaded.payload : null;
}

/** A read is outstanding exactly when the node names an original and the
 *  last completed read was for some other id (or there was none). */
export function originPending(loaded: LoadedOrigin, originId: string): boolean {
  return originId !== '' && (loaded === null || loaded.id !== originId);
}

/** The receipt latch's key: the node AND its payload lineage. */
export function originReceiptKey(nodeId: string, originId: string): string {
  return `${nodeId}|${originId}`;
}

export interface OriginViewInput {
  readonly nodeId: string;
  /** The node's `values.originId`, '' when it has none. */
  readonly originId: string;
  readonly loaded: LoadedOrigin;
  /** The node's stored payload (`values.imageB64`), '' when absent. */
  readonly url: string;
  /** The node carries the original's dimensions (`srcWidth`/`srcHeight`). */
  readonly resized: boolean;
  /** The receipt latch's current value. */
  readonly receipt: string | null;
}

export interface OriginView {
  readonly origin: ImageOriginPayload | null;
  readonly pending: boolean;
  /** An original is at hand and the stored payload differs from it. */
  readonly restorable: boolean;
  /** Render the Original row + Revert button. */
  readonly showOriginal: boolean;
  /** The value the latch holds after this render. */
  readonly receipt: string | null;
}

export function deriveOriginView(input: OriginViewInput): OriginView {
  const origin = originFor(input.loaded, input.originId);
  const pending = originPending(input.loaded, input.originId);
  const restorable = origin !== null && origin.dataUrl !== input.url;
  const key = originReceiptKey(input.nodeId, input.originId);
  const receipt = input.resized || restorable ? key : input.receipt;
  return {
    origin,
    pending,
    restorable,
    showOriginal: input.resized || restorable || receipt === key,
    receipt,
  };
}
