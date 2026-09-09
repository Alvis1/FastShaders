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
    expect(MENU).toMatch(/resizeEncodedImage\(\s*origin\.dataUrl,/);
  });

  it('routes the top rung through Revert instead of re-encoding it', () => {
    // The original IS that rung: re-encoding would spend a lossy pass to
    // arrive at a worse copy of a file already in hand, and would let the
    // button and the dropdown disagree about what "original" means.
    expect(MENU).toMatch(/if \(divisor === 1\) \{\s*revert\(\);/);
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
    expect(MENU).toMatch(/resolutionLadder\(origin\.width, origin\.height, deviceMaxDim\)/);
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

describe('resizeEncodedImage', () => {
  it('resamples THROUGH a wrapped border', () => {
    // "Repeat (tile the image)" defaults ON, so a seamless tile resampled
    // against clamped edges comes back with a seam on every boundary.
    expect(IMPORT).toMatch(/drawWrappedResize\(destCanvas, baseCanvas, w, h\)/);
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
