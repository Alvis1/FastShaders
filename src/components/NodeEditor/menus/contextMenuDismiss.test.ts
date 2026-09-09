import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./ContextMenu.tsx', import.meta.url), 'utf8');
const NODE_EDITOR = readFileSync(new URL('../NodeEditor.tsx', import.meta.url), 'utf8');
const PICKER = readFileSync(new URL('../../inputs/PaletteColorPicker.tsx', import.meta.url), 'utf8');
const MESH_PICKER = readFileSync(new URL('../nodes/MeshTargetPicker.tsx', import.meta.url), 'utf8');

/**
 * A settings menu closes on a press anywhere else.
 *
 * The vitest env is `node`, so there is no DOM to drive the dispatcher
 * against — these are source pins on the decisions, each of which is a way the
 * closer silently stops working.
 */
describe('the context menu is dismissed by an outside press', () => {
  it('listens for POINTERDOWN in the CAPTURE phase', () => {
    // Not `click`: React Flow's node handlers stop click propagation for their
    // own gestures, which is exactly why clicking a node header left the menu
    // open — and a press that becomes a drag produces no click at all.
    expect(SRC).toMatch(/addEventListener\('pointerdown', onPointerDown, true\)/);
    expect(SRC).toMatch(/removeEventListener\('pointerdown', onPointerDown, true\)/);
  });

  it('is armed only while the menu is open', () => {
    // What stops it eating its own opening press: a right-click's pointerdown
    // precedes the contextmenu event that opens the menu.
    expect(SRC).toMatch(/if \(!open\) return;\s*const onPointerDown/);
  });

  it('ignores a press inside the menu', () => {
    expect(SRC).toMatch(/ref\.current\?\.contains\(target\)/);
  });

  it('ignores the popovers a menu opens, which portal OUT of it', () => {
    // A colour swatch in a settings menu opens PaletteColorPicker, which
    // portals to the body — so `contains` cannot see the press and picking a
    // colour would close the menu the swatch belongs to.
    expect(SRC).toMatch(/DISMISS_EXEMPT = '\.palette-pop, \.mesh-picker__pop'/);
    expect(SRC).toMatch(/target\.closest\?\.\(DISMISS_EXEMPT\)/);
    // The two exempt classes have to be the ones those popovers really use.
    expect(PICKER).toMatch(/className="palette-pop nodrag"/);
    expect(MESH_PICKER).toMatch(/className="mesh-picker__pop nodrag"/);
  });

  it('keeps the pane handler, which also clears the label peek', () => {
    // Closing twice is idempotent; the peek reset is NOT this closer's job.
    expect(NODE_EDITOR).toMatch(/onPaneClick = useCallback\(\(\) => \{\s*closeContextMenu\(\);\s*setPeekNodeId\(null\);/);
  });
});
