import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Burst-input widgets must bracket their history. `updateNodeData` pushes a
 * full-graph structuredClone unconditionally, and a range / colour / typed-
 * number input fires a change per FRAME or per KEYSTROKE — unbracketed, a
 * one-second slider scrub pushes ~60 entries and evicts the whole 50-entry
 * undo stack (MAX_HISTORY, useAppStore.ts).
 *
 * The vitest env is `node` with no jsdom, so these widgets cannot be
 * rendered. This suite pins the SOURCE instead — the designerEntry.test.ts /
 * vendorSync.test.ts pattern — so deleting a `bracket()` call fails CI
 * instead of silently restoring the flood.
 */
const SRC = __dirname;

/** The attribute block of one JSX element, located by a unique anchor. */
function element(file: string, anchor: string): string {
  const s = readFileSync(path.join(SRC, file), 'utf8');
  const i = s.indexOf(anchor);
  expect(i, `anchor not found in ${file}: ${anchor}`).toBeGreaterThan(-1);
  return s.slice(i, s.indexOf('/>', i));
}

describe('burst-input widgets bracket their history', () => {
  it('ShaderNode: the Slider range input', () => {
    const el = element('components/NodeEditor/nodes/ShaderNode.tsx', 'className="shader-node__slider nodrag"');
    expect(el, 'slider onChange must call bracket() before writing').toMatch(/onChange=\{[^}]*bracket\(\)/);
    expect(el, 'slider must close its bracket on pointerup').toContain('onPointerUp={closeBracket}');
  });

  // The inline colour swatch (stripes / dataviz) no longer brackets by hand:
  // it is the app-wide PaletteColorPicker, which opens the bracket itself when
  // told `history="bracket"`. That contract is pinned — for this site and every
  // other picker in the app — by colorPickerHistory.test.ts.

  it('menuShared: NumberRow commits inside a bracket', () => {
    const s = readFileSync(path.join(SRC, 'components/NodeEditor/menus/menuShared.tsx'), 'utf8');
    expect(s).toMatch(/Number\.isFinite\(n\)\)\s*\{\s*bracket\(\);\s*onCommit\(n\);/);
    expect(s).toMatch(/onBlur=\{\(\)\s*=>\s*\{[^}]*closeBracket\(\)/);
  });

  it('ShaderSettingsMenu: the Alpha Clip threshold slider', () => {
    const s = readFileSync(path.join(SRC, 'components/NodeEditor/menus/ShaderSettingsMenu.tsx'), 'utf8');
    expect(s).toMatch(/onChange=\{\(e\)\s*=>\s*\{\s*bracket\(\);\s*updateSettings\(\{ alphaTest: parseFloat/);
    expect(s).toContain('onPointerUp={closeBracket}');
  });
});

describe('exposed-port toggles are ONE undo entry', () => {
  const files = [
    'components/NodeEditor/menus/NodeSettingsMenu.tsx',
    'components/NodeEditor/menus/ShaderSettingsMenu.tsx',
  ];
  it('every toggleExposedPort call site runs inside asOneHistoryEntry', () => {
    for (const f of files) {
      const s = readFileSync(path.join(SRC, f), 'utf8');
      expect(s, `${f} must import asOneHistoryEntry`).toContain("from '@/utils/historyGesture'");
      const calls = s.split('toggleExposedPort(').length - 1;
      const wraps = s.split('asOneHistoryEntry(() =>').length - 1;
      expect(calls, `${f} should still call toggleExposedPort`).toBeGreaterThanOrEqual(1);
      expect(wraps, `${f}: every handler composing toggleExposedPort must be wrapped`).toBeGreaterThanOrEqual(calls);
    }
  });
});
