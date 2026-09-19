import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  deriveOriginView,
  originFor,
  originPending,
  originReceiptKey,
  type LoadedOrigin,
} from './imageOriginView';
import type { ImageOriginPayload } from '@/utils/imageOriginCache';

const MENU = readFileSync(new URL('./ImageNodeSettings.tsx', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('./imageOriginView.ts', import.meta.url), 'utf8');

/**
 * The Image node's settings menu and the original it read from the cache.
 *
 * A second right-click MOVES the open context menu to another node without
 * remounting it (ContextMenu renders NodeSettingsMenu with no per-node key), so
 * ImageNodeSettings' state outlives the node it was read for. The vitest env
 * is `node` and the menu is a React component, so the menu session is MODELLED
 * here: `Session` holds what the component holds (the keyed read + the receipt
 * ref) and runs its effect's alive-guarded read; the source pins at the bottom
 * tie the model to the component. `LegacySession` is a transcription of the
 * menu as it was before the fix, run through the same sequences so each
 * scenario is proven to exercise the bug rather than pass vacuously.
 */

const pay = (tag: string, width = 1080, height = 1920): ImageOriginPayload => ({
  dataUrl: `data:image/png;base64,${tag}`,
  width,
  height,
  fileName: `${tag}.png`,
});

interface MenuNode {
  id: string;
  originId: string;
  url: string;
  resized: boolean;
}

interface Shown {
  origin: ImageOriginPayload | null;
  pending: boolean;
  restorable: boolean;
  showOriginal: boolean;
}

/** What a click on Revert would write into the node on screen, or null when
 *  the button is disabled (`disabled={!restorable || pending}`; the legacy
 *  button was `disabled={!restorable}`). */
const revertWrites = (v: Shown, legacy = false): ImageOriginPayload | null =>
  (legacy ? v.restorable : v.restorable && !v.pending) ? v.origin : null;

/** The Resolution select's lock (`disabled={busy || pending}`; `busy` is
 *  resizing || importing, and neither depends on the read modelled here). */
const resolutionLocked = (v: Shown) => v.pending;

interface Inflight {
  id: string;
  alive: boolean;
}

/** ImageNodeSettings after the fix. */
class Session {
  loaded: LoadedOrigin = null;
  receipt: string | null = null;
  private inflight: Inflight | null = null;
  private lastOriginId: string | null = null;

  /** One render for `node`, then the `[originId]` effect when the id moved. */
  show(node: MenuNode): Shown {
    const view = deriveOriginView({
      nodeId: node.id,
      originId: node.originId,
      loaded: this.loaded,
      url: node.url,
      resized: node.resized,
      receipt: this.receipt,
    });
    this.receipt = view.receipt;
    if (node.originId !== this.lastOriginId) {
      this.lastOriginId = node.originId;
      if (this.inflight) this.inflight.alive = false; // the effect's cleanup
      this.inflight = null;
      if (!node.originId) this.loaded = null;
      else this.inflight = { id: node.originId, alive: true };
    }
    return view;
  }

  /** The cache answers the read for `id` (ignored once its effect was torn down). */
  resolve(id: string, payload: ImageOriginPayload | null) {
    if (this.inflight && this.inflight.id === id && this.inflight.alive) {
      this.loaded = { id, payload };
    }
  }
}

/** ImageNodeSettings before the fix, transcribed: `origin` and `pending` as
 *  free-standing state, the latch keyed on the node id. */
class LegacySession {
  origin: ImageOriginPayload | null = null;
  pending = false;
  receipt: string | null = null;
  private inflight: Inflight | null = null;
  private lastOriginId: string | null = null;

  show(node: MenuNode): Shown {
    const restorable = this.origin !== null && this.origin.dataUrl !== node.url;
    if (node.resized || restorable) this.receipt = node.id;
    const shown = {
      origin: this.origin,
      pending: this.pending,
      restorable,
      showOriginal: node.resized || restorable || this.receipt === node.id,
    };
    if (node.originId !== this.lastOriginId) {
      this.lastOriginId = node.originId;
      if (this.inflight) this.inflight.alive = false;
      this.inflight = null;
      if (!node.originId) this.origin = null;
      else {
        this.pending = true;
        this.inflight = { id: node.originId, alive: true };
      }
    }
    return shown;
  }

  resolve(id: string, payload: ImageOriginPayload | null) {
    if (this.inflight && this.inflight.id === id && this.inflight.alive) {
      this.origin = payload;
      this.pending = false;
    }
  }
}

const pA = pay('A-original');
const pB = pay('B-original', 800, 600);
const nodeA: MenuNode = { id: 'img-a', originId: 'oa', url: 'data:image/webp;base64,A-resized', resized: true };
const nodeB: MenuNode = { id: 'img-b', originId: 'ob', url: 'data:image/webp;base64,B-resized', resized: true };
/** An untouched drop: no original stashed, payload never resized. */
const nodeC: MenuNode = { id: 'img-c', originId: '', url: 'data:image/png;base64,C', resized: false };

describe('a second right-click moves the menu to another node', () => {
  it('never shows the previous node\'s original, and Revert stays disabled until the new read answers', () => {
    const s = new Session();
    s.show(nodeA);
    s.resolve('oa', pA);
    const onA = s.show(nodeA);
    expect(onA.origin).toBe(pA);
    expect(revertWrites(onA)).toBe(pA);

    // The menu moves to B. Both the render that carries the new node id and
    // the one after B's read starts must know nothing about an original yet.
    for (const onB of [s.show(nodeB), s.show(nodeB)]) {
      expect(onB.origin).toBeNull();
      expect(onB.pending).toBe(true);
      expect(onB.restorable).toBe(false);
      expect(revertWrites(onB)).toBeNull();
      // B is resized, so the Original row is up — reading '…', not A's size.
      expect(onB.showOriginal).toBe(true);
    }

    s.resolve('ob', pB);
    const settled = s.show(nodeB);
    expect(settled.origin).toBe(pB);
    expect(settled.pending).toBe(false);
    expect(revertWrites(settled)).toBe(pB);
  });

  it('the same sequence on the pre-fix menu wrote node A\'s original into node B', () => {
    const s = new LegacySession();
    s.show(nodeA);
    s.resolve('oa', pA);
    s.show(nodeA);
    const onB = s.show(nodeB);
    expect(onB.origin).toBe(pA);
    expect(revertWrites(onB, true)).toBe(pA);
    // ...and still after B's read started, until it answered.
    expect(revertWrites(s.show(nodeB), true)).toBe(pA);
  });

  it('a read that answers after the menu moved on is not taken for the new node', () => {
    const s = new Session();
    s.show(nodeA); // read for 'oa' in flight
    s.show(nodeB); // moved before it answered
    s.resolve('oa', pA); // late — its effect was torn down
    const onB = s.show(nodeB);
    expect(onB.origin).toBeNull();
    expect(onB.pending).toBe(true);
    // Even a read that DID land for another id is not B's original.
    expect(originFor({ id: 'oa', payload: pA }, 'ob')).toBeNull();
    expect(originPending({ id: 'oa', payload: pA }, 'ob')).toBe(true);
  });

  it('moving to a node with no original mid-read unlocks the Resolution select', () => {
    const s = new Session();
    s.show(nodeA); // read for 'oa' in flight
    s.show(nodeC);
    const onC = s.show(nodeC);
    expect(onC.pending).toBe(false);
    expect(resolutionLocked(onC)).toBe(false);
    expect(onC.showOriginal).toBe(false);

    // The pre-fix menu left `pending` true for the rest of the session.
    const legacy = new LegacySession();
    legacy.show(nodeA);
    legacy.show(nodeC);
    expect(resolutionLocked(legacy.show(nodeC))).toBe(true);
  });

  it('a menu moved onto a CLONE reuses the read — same content, same original — but not the receipt', () => {
    const s = new Session();
    s.show(nodeA);
    s.resolve('oa', pA);
    s.show(nodeA);
    // Ctrl+D minted a fresh id and kept the data, so the originId is shared.
    const clone: MenuNode = { ...nodeA, id: 'img-a-copy' };
    const onClone = s.show(clone);
    expect(onClone.origin).toBe(pA);
    expect(onClone.pending).toBe(false);
    // A clone already at its original shows no Original row: A's receipt is A's.
    const revertedClone: MenuNode = { ...clone, url: pA.dataUrl, resized: false };
    s.show(nodeA);
    expect(s.show(revertedClone).showOriginal).toBe(false);
  });
});

describe('the receipt latch', () => {
  it('survives a revert, which keeps the originId', () => {
    const s = new Session();
    s.show(nodeA);
    s.resolve('oa', pA);
    expect(s.show(nodeA).showOriginal).toBe(true);
    // revertedValues: the original payload back, srcWidth/srcHeight deleted,
    // originId kept.
    const reverted: MenuNode = { ...nodeA, url: pA.dataUrl, resized: false };
    const after = s.show(reverted);
    expect(after.restorable).toBe(false);
    expect(after.showOriginal).toBe(true);
    // The receipt: "already original", not "unavailable".
    expect(after.origin).toBe(pA);
    expect(after.pending).toBe(false);
  });

  it('is dropped when the SAME node changes payload lineage', () => {
    // A texture pick (Step 6) moves originId with the payload; here the node
    // takes an untouched payload with no original at all.
    const picked: MenuNode = { ...nodeA, originId: '', url: 'data:image/png;base64,X', resized: false };
    const s = new Session();
    s.show(nodeA);
    s.resolve('oa', pA);
    s.show({ ...nodeA, url: pA.dataUrl, resized: false }); // reverted: receipt only
    for (const v of [s.show(picked), s.show(picked)]) {
      expect(v.showOriginal).toBe(false);
      expect(revertWrites(v)).toBeNull();
    }

    // The pre-fix menu: on the render before its effect ran it still held the
    // old original, which now DIFFERED from the payload — Revert live, and a
    // click would have put the old picture back over the new one. After the
    // effect, the latch (keyed on the node id alone) kept the row up as
    // "not on this device" beside a dead Revert.
    const legacy = new LegacySession();
    legacy.show(nodeA);
    legacy.resolve('oa', pA);
    legacy.show({ ...nodeA, url: pA.dataUrl, resized: false });
    expect(revertWrites(legacy.show(picked), true)).toBe(pA);
    const stale = legacy.show(picked);
    expect(stale.showOriginal).toBe(true);
    expect(stale.origin).toBeNull();
  });

  it('is keyed by node AND lineage', () => {
    expect(originReceiptKey('img-a', 'oa')).toBe('img-a|oa');
    expect(originReceiptKey('img-a', 'oa')).not.toBe(originReceiptKey('img-a', 'ob'));
    expect(originReceiptKey('img-a', 'oa')).not.toBe(originReceiptKey('img-b', 'oa'));
  });
});

describe('the pure derivation', () => {
  it('has no original and nothing pending for a node without an originId', () => {
    for (const loaded of [null, { id: 'oa', payload: pA }] as LoadedOrigin[]) {
      expect(originFor(loaded, '')).toBeNull();
      expect(originPending(loaded, '')).toBe(false);
    }
  });

  it('a read that found no record is settled, not pending', () => {
    const v = deriveOriginView({
      nodeId: 'img-a', originId: 'oa', loaded: { id: 'oa', payload: null },
      url: nodeA.url, resized: true, receipt: null,
    });
    expect(v.origin).toBeNull();
    expect(v.pending).toBe(false);
    expect(v.restorable).toBe(false);
    expect(v.showOriginal).toBe(true); // "not on this device"
  });

  it('is idempotent across a StrictMode double render', () => {
    const input = {
      nodeId: 'img-a', originId: 'oa', loaded: { id: 'oa', payload: pA } as LoadedOrigin,
      url: nodeA.url, resized: true, receipt: null,
    };
    const first = deriveOriginView(input);
    const second = deriveOriginView({ ...input, receipt: first.receipt });
    expect(second).toEqual(first);
  });
});

describe('ImageNodeSettings goes through the keyed read (source pins — the model above is only as good as these)', () => {
  it('stores one read under the id it was for, and derives origin and pending from it', () => {
    expect(MENU).toMatch(/useState<LoadedOrigin>\(null\)/);
    expect(MENU).toMatch(/if \(!originId\) \{\s*setLoaded\(null\);\s*return;\s*\}/);
    expect(MENU).toMatch(/if \(alive\) setLoaded\(\{ id: originId, payload \}\);/);
    expect(MENU).toMatch(/return \(\) => \{\s*alive = false;\s*\};\s*\}, \[originId\]\);/);
    expect(MENU).not.toMatch(/setOrigin\(|setPending\(|useState<ImageOriginPayload/);
    expect(VIEW).toContain('loaded && loaded.id === originId ? loaded.payload : null');
    expect(VIEW).toContain("originId !== '' && (loaded === null || loaded.id !== originId)");
  });

  it('reads and writes the receipt latch through deriveOriginView, keyed nodeId|originId', () => {
    expect(MENU).toMatch(
      /const view = deriveOriginView\(\{ nodeId, originId, loaded, url, resized, receipt: receiptRef\.current \}\);\s*receiptRef\.current = view\.receipt;\s*const \{ origin, pending, restorable, showOriginal \} = view;/,
    );
    expect(VIEW).toContain('return `${nodeId}|${originId}`;');
    expect(MENU).not.toMatch(/receiptRef\.current === nodeId|receiptRef\.current = nodeId/);
  });

  it('declares its hooks above the early return', () => {
    const early = MENU.indexOf("if (!node || node.data.registryType !== 'imageNode') return null;");
    expect(early).toBeGreaterThan(-1);
    for (const hook of ['useRef<string | null>(null)', 'useState<LoadedOrigin>(null)', 'useEffect(']) {
      const at = MENU.indexOf(hook);
      expect(at, hook).toBeGreaterThan(-1);
      expect(at, hook).toBeLessThan(early);
    }
  });

  it('locks Revert and the Resolution select while the read is outstanding', () => {
    expect(MENU).toMatch(/onClick=\{revert\}[\s\S]{0,200}disabled=\{!restorable \|\| pending\}/);
    expect(MENU).toMatch(/disabled=\{busy \|\| pending\}/);
    // Revert and the ladder read `origin` — the derived one, never a raw state.
    expect(MENU).toMatch(/const revert = \(\) => \{\s*if \(!origin\) return;/);
    expect(MENU).toMatch(/const ladderSource: ImageOriginPayload \| null =\s*origin \?\?/);
  });
});
