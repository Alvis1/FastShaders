import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MENU = readFileSync(new URL('./ImageNodeSettings.tsx', import.meta.url), 'utf8');
const IMPORT = readFileSync(new URL('../../../utils/imageImport.ts', import.meta.url), 'utf8');

/**
 * The Image node's Resolution control. Both halves are DOM-only — a canvas
 * re-encode and a React menu — and the vitest env is `node`, so the pure
 * decision (`resolutionLadder`, covered in imageCodec.test.ts) is executed and
 * everything else is source-pinned. Each pin below is a way the control goes
 * quietly wrong rather than loudly.
 */
describe('re-encoding at a chosen resolution', () => {
  it('reads the ORIGINAL, never the stored payload', () => {
    // 2048 → 1024 → 512 through the current payload stacks three lossy passes
    // and can never go back up. The original is the only source that makes the
    // ladder reversible.
    // `ladderSource` is the stashed original, or the payload itself while it
    // has never been resized — either way the ORIGINAL bytes, never a rung.
    expect(MENU).toMatch(/resizeEncodedImage\(\s*ladderSource\.dataUrl,/);
  });

  it('routes the rung that IS the original through Revert instead of re-encoding it', () => {
    // Rungs are power-of-two sizes; one is `original` only when the source was
    // already POT. With a stored original it is put back; without one the
    // payload already is it, and there is nothing to do.
    expect(MENU).toMatch(/if \(step\.original\) \{[\s\S]{0,320}?if \(origin\) revert\(\);/);
    // Keyed by size, not by divisor — a POT anchor makes "divisor 1" mean the
    // snapped original, which is usually NOT the original.
    expect(MENU).toMatch(/ladder\.find\(\(x\) => x\.key === key\)/);
    expect(MENU).not.toMatch(/divisor === 1/);
  });

  it('re-reads the node after the await, and writes ONCE', () => {
    // The menu can outlive its node (deleted elsewhere, or an undo landed
    // while it was open). One updateNodeData = one undo entry, which is what
    // lets this path await where Revert and the Data-map flip cannot.
    expect(MENU).toMatch(/const live = store\.nodes\.find\(\(n\) => n\.id === nodeId\);/);
    expect((MENU.match(/store\.updateNodeData\(nodeId/g) ?? []).length).toBe(1);
  });

  it('re-checks the project-wide image budget', () => {
    // Going back UP a rung grows the payload, exactly like a revert.
    expect(MENU).toMatch(/totalImageChars\(store\.nodes\) - currentUrl\.length \+ encoded\.dataUrl\.length/);
    expect(MENU).toMatch(/> MAX_TOTAL_IMAGE_CHARS[\s\S]{0,80}noticeOverBudget\(\)/);
  });

  it('leaves the node untouched when the encode fails', () => {
    // A resolution the user picked and did not get beats a payload silently
    // replaced by something else.
    expect(MENU).toMatch(/if \(!encoded\) return;/);
  });

  it('caps the ladder by the SELECTED DEVICE, not by the hard ceiling', () => {
    // Offering a rung the drop pipeline would immediately shrink is a control
    // that lies.
    expect(MENU).toMatch(/resolveDeviceTextureDim\(selectedHeadsetId, costProfiles\)/);
    expect(MENU).toMatch(/resolutionLadder\(ladderSource\.width, ladderSource\.height, deviceMaxDim\)/);
  });

  it('shows an off-ladder size as its own entry', () => {
    // A power-of-two-snapped payload is on no rung of a ladder built by
    // halving the original, so without this the box reads someone else's
    // number.
    expect(MENU).toMatch(/!currentStep && <option value="current">\{resolution\}<\/option>/);
  });

  it('falls back to the read-only reading, explaining why', () => {
    // The original is device-local: after sharing a project, in another
    // browser, or once it ages out of the cache there is nothing to re-encode
    // from — the same limit the Revert button already states.
    expect(MENU).toMatch(/ladder\.length > 1 \? \(/);
    expect(MENU).toMatch(/needs the stored original, which lives on this device only/);
  });
});

describe('the ladder reads the node when the payload IS the original', () => {
  const IMAGE_NODE = readFileSync(new URL('../../../utils/imageNode.ts', import.meta.url), 'utf8');

  it('falls back to the payload itself while nothing has resized it', () => {
    // The cache is written only by a snap or a resize, so for the ordinary
    // unsnapped drop there is no record — and none is needed until the first
    // pick: the payload IS the original. This is what puts the control on
    // every image node without a stash per drop.
    expect(MENU).toMatch(/const ladderSource[\s\S]{0,120}origin \?\?[\s\S]{0,200}!resized && url/);
  });

  it('stashes LAZILY, at the first resize, from the payload it replaces', () => {
    expect(MENU).toMatch(/stashImageOrigin\(ladderSource, Date\.now\(\)\)/);
    // ...and refuses the resize outright if the cache would not take it.
    expect(MENU).toMatch(/if \(!originId\) return;/);
  });

  it('gates the ladder on the cache being WILLING to hold the original', () => {
    // A >600 K payload placed under ignore-limits cannot be stashed, so
    // resizing it would ship with no way back; the read-only row then names
    // that reason rather than blaming device-local storage.
    expect(MENU).toMatch(/canKeepOriginal = origin !== null \|\| \(ladderSource !== null && canStashPayload\(ladderSource\.dataUrl\)\)/);
    expect(MENU).toMatch(/too large for a copy of the original to be kept on this device/);
  });

  it('the drop path stashes ONLY a snapped image — always-stash was reverted', () => {
    // Stashing every drop (tried 2026-09-09) let an ordinary drop evict the
    // one record that undoes a destructive snap, and made the study clean
    // slate responsible for bytes it never had to hold.
    expect(IMAGE_NODE).toMatch(/if \(!res\.potApplied \|\| !res\.original\) return \{ payload: res \};/);
    expect((IMPORT.match(/original: base,/g) ?? []).length).toBe(1);
  });

  it('latches the Original row for the menu session so the revert receipt survives', () => {
    // "differs from the original" is false on the very frame a revert lands,
    // so without the latch the block unmounted under the cursor and the
    // documented "already the original" receipt could never render.
    expect(MENU).toMatch(/receiptRef\.current === nodeId/);
    expect(MENU).toMatch(/\{showOriginal && \(/);
  });
});

describe('resizeEncodedImage', () => {
  it('resamples THROUGH a wrapped border', () => {
    // "Repeat (tile the image)" defaults ON, so a seamless tile resampled
    // against clamped edges comes back with a seam on every boundary.
    expect(IMPORT).toMatch(/drawWrappedResize\(destCanvas, pyramid, w, h\)/);
  });

  it('steps down through a 2:1 pyramid before the final resample', () => {
    // The ladder reaches 8 px. MEASURED 2026-09-10 on a period-3 stripe
    // pattern (true mean red 170): one drawImage straight to 8 px gave pixels
    // anywhere from 128 to 255 in Chrome 152, WebKit 26.5 and Firefox 153;
    // through the pyramid, 169-171 in all three.
    const body = /export async function resizeEncodedImage\([\s\S]*$/.exec(IMPORT)?.[0] ?? '';
    expect(body).toMatch(/while \(pyramid\.width >= w \* 2 && pyramid\.height >= h \* 2\)/);
    expect(body).toMatch(/Math\.floor\(pyramid\.width \/ 2\), Math\.floor\(pyramid\.height \/ 2\)/);
  });

  it('does not inherit the drop path’s halving retry', () => {
    // encodeImageFile halves when a payload will not fit — correct for a drop,
    // wrong here: it would hand back a resolution other than the one picked.
    const body = /export async function resizeEncodedImage\([\s\S]*$/.exec(IMPORT)?.[0] ?? '';
    expect(body).not.toMatch(/scale \/= 2/);
    expect(body).toMatch(/return encodeWithinBudget\(destCanvas, candidates, budget\)/);
  });

  it('keeps a lossless source lossless', () => {
    // A PNG or a lossless-WebP re-drop must not silently become a lossy WebP
    // just because the user asked for fewer pixels. WebP is read from the
    // container head, not the extension — the app's own loop produces both.
    const body = /export async function resizeEncodedImage\([\s\S]*$/.exec(IMPORT)?.[0] ?? '';
    expect(body).toMatch(/sourcePrefersLossless\('', mime, head\)/);
    expect(body).toMatch(/mime === 'image\/webp'/);
  });

  it('validates the payload it is handed', () => {
    // It comes out of IndexedDB, which is the same trust level as a
    // `.fastshader` file.
    const body = /export async function resizeEncodedImage\([\s\S]*$/.exec(IMPORT)?.[0] ?? '';
    expect(body).toMatch(/if \(!validImageDataUrl\(dataUrl\)\) return null;/);
  });
});
