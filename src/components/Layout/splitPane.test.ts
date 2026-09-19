import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source pins for the draggable-seam model, because the vitest env is `node`
 * and none of this fails loudly: a seam that lost its hit zone is merely hard
 * to grab, a retired token that crept back merely does nothing, and the two
 * hosts drifting apart merely looks slightly wrong on one of three seams.
 *
 * The model (2026-09-16): every window divider — both SplitPane seams and the
 * asset bar's top edge — is ITSELF the drag target, widened by an invisible
 * hit zone and marked on hover by the seam LENS (seamLensGeometry.ts). The old grip
 * tabs (`.fs-grip`, a diamond on a plate parked at one spot per seam) and the
 * push-the-other-divider subsystem they needed (`utils/splitClearance.ts`,
 * `utils/assetBarHeight.ts`) are gone with them.
 */

const SRC = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const SPLIT = read('components/Layout/SplitPane.tsx');
const BROWSER = read('components/NodeEditor/ContentBrowser.tsx');
const CONTROLS = read('styles/controls.css');
const TOKENS = read('styles/tokens.css');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(p);
  }
  return out;
}

describe('the seam is the drag target', () => {
  it('both hosts carry the shared seam classes and render the lens', () => {
    expect(SPLIT).toMatch(/fs-seam fs-seam--\$\{orientation\}/);
    expect(SPLIT).toContain('<SeamLens orientation={orientation} />');
    expect(BROWSER).toContain('content-browser__resizer fs-seam fs-seam--h');
    expect(BROWSER).toContain('<SeamLens orientation="h" />');
  });

  it('both hosts mark a captured drag with the same class the CSS reads', () => {
    // SplitPane names it once; ContentBrowser spells the literal.
    expect(SPLIT).toContain("const DRAGGING_CLASS = 'fs-seam--dragging'");
    expect(BROWSER).toContain("classList.add('fs-seam--dragging')");
    expect(BROWSER).toContain("classList.remove('fs-seam--dragging')");
    expect(CONTROLS).toMatch(/\.fs-seam--dragging\s*\{/);
  });

  it('widens the line into a hit zone from one token, bumped for touch', () => {
    expect(CONTROLS).toMatch(/\.fs-seam::before\s*\{/);
    expect(CONTROLS).toContain('width: var(--fs-seam-hit)');
    expect(CONTROLS).toContain('height: var(--fs-seam-hit)');
    const root = TOKENS.slice(0, TOKENS.indexOf('@media (pointer: coarse)'));
    const coarse = TOKENS.slice(TOKENS.indexOf('@media (pointer: coarse)'));
    const fine = Number(/--fs-seam-hit:\s*(\d+)px/.exec(root)?.[1]);
    const touch = Number(/--fs-seam-hit:\s*(\d+)px/.exec(coarse)?.[1]);
    expect(fine).toBeGreaterThanOrEqual(8);
    expect(touch).toBeGreaterThan(fine);
    // A finger needs the same target the old --ctl-size tab gave it.
    expect(touch).toBeGreaterThanOrEqual(28);
  });

  it('opens the lens only where hover exists', () => {
    // Touch has no hover, and an emulated `:hover` would strand a lens on the
    // seam after every tap-drag — so the opening rules live under the query.
    const open = CONTROLS.slice(CONTROLS.indexOf('@media (hover: hover)'));
    expect(open).toMatch(/\.fs-seam--v:hover \.fs-seam-lens/);
    expect(open).toMatch(/\.fs-seam--h:hover \.fs-seam-lens/);
    expect(CONTROLS).toMatch(/\.fs-seam-lens\s*\{[^}]*pointer-events:\s*none/);
  });

  it('takes iframes out of hit-testing for the whole drag', () => {
    // MEASURED: a rightward column-seam drag logged its pointerdown and then
    // nothing — the first move after the press was over the preview iframe,
    // whose document took it, so the parent's PENDING capture never
    // activated. The drag chrome stamps `fs-dragging` synchronously in the
    // press handler, which is what makes this rule land before that move.
    expect(CONTROLS).toMatch(/:root\.fs-dragging iframe\s*\{[^}]*pointer-events:\s*none/);
    // …and both hosts really do open the drag chrome on press.
    expect(SPLIT).toContain('endDragChrome.current = beginDragChrome(');
    expect(BROWSER).toContain("endDragChrome.current = beginDragChrome('row-resize')");
  });

  it('marks a junction on the host and lights the neighbour it will move', () => {
    expect(SPLIT).toContain("const CORNER_CLASS = 'fs-seam--xy'");
    expect(SPLIT).toContain("const JUNCTION_ATTR = 'data-fs-junction'");
    // The row seam is a later sibling's descendant; the bar sits in the pane
    // BEFORE the divider, so its rule needs :has() on the container.
    expect(read('components/Layout/SplitPane.css'))
      .toContain('.split-pane__divider--h[data-fs-junction="row"] ~ div .split-pane__divider--v');
    expect(read('components/NodeEditor/ContentBrowser.css'))
      .toContain(':has(> .split-pane__divider[data-fs-junction="bar"]) .content-browser');
    expect(CONTROLS).toMatch(/\.fs-seam--xy\s*\{[^}]*cursor:\s*move/);
    // …and the ring replaces the bulge there.
    expect(CONTROLS).toMatch(/\.fs-seam--xy \.fs-seam-lens__ring\s*\{[^}]*opacity:\s*1/);
    expect(CONTROLS).toMatch(/\.fs-seam--xy \.fs-seam-lens__bulge\s*\{[^}]*opacity:\s*0/);
  });

  it('drives the asset bar from its junction through ONE registered handle', () => {
    expect(SPLIT).toContain("assetBarDragHandle()?.push(");
    expect(SPLIT).toContain("assetBarDragHandle()?.commit()");
    expect(BROWSER).toContain('registerAssetBarDrag({');
    // The column seam must WIN the hit test at both crossings, or the seams
    // running up to it cover the very point the junction lives on.
    expect(read('components/Layout/SplitPane.css'))
      .toMatch(/\.split-pane__divider--h\s*\{[^}]*z-index:\s*calc\(var\(--z-controls\) \+ 1\)/);
  });
});

describe('the preview/code split has ONE floor', () => {
  it('SplitPane reads it from the store rather than restating it', () => {
    expect(SPLIT).toContain('RIGHT_SPLIT_MIN');
    expect(SPLIT).not.toMatch(/const\s+CROSS_MIN_TOP_RATIO\s*=/);
    expect(SPLIT).toMatch(/import \{[^}]*RIGHT_SPLIT_MIN[^}]*\} from '@\/store\/useAppStore'/);
  });

  it('and both hands on that seam use the same clamp', () => {
    expect(SPLIT).toContain('export const clampPreviewSplit');
    const layout = read('components/Layout/AppLayout.tsx');
    expect(layout).toContain('clamp={clampPreviewSplit}');
    expect(layout).toContain('crossRatio={rightSplitRatio}');
  });
});

describe('the retired grip cannot creep back', () => {
  const RETIRED = [
    /\.fs-grip\b/,
    /--fs-grip-/,
    /--fs-asset-bar-h/,
    /splitClearance/,
    /utils\/assetBarHeight/,
  ];

  it('no source file names the grip, its tokens, or the push subsystem', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      if (f.endsWith('splitPane.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const re of RETIRED) if (re.test(text)) offenders.push(`${f.slice(SRC.length)}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});
