/**
 * Setting buttons (owner, 2026-11-26): a button that holds a setting shows the
 * option that is ON, and a right-click lists every option — wherever the
 * button had no right-click or long-press menu of its own. Node-only, so these
 * read the sources.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = (rel: string) => readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('setting buttons', () => {
  it('every setting button without a menu of its own goes through SettingButton', () => {
    // Language and theme; the language switch in dialogs, the intro and the
    // lesson panel; WGSL/GLSL, FPS and the backdrop; Draw, Eraser, Scissors.
    expect(count(src('components/Layout/Toolbar.tsx'), '<SettingButton')).toBe(2);
    expect(count(src('eval/LangSwitch.tsx'), '<SettingButton')).toBe(1);
    expect(count(src('components/Preview/ShaderPreview.tsx'), '<SettingButton')).toBe(3);
    expect(count(src('components/NodeEditor/DrawToolbar.tsx'), '<SettingButton')).toBe(3);
  });

  it('the language and theme buttons show what is on, never what a click brings', () => {
    const toolbar = src('components/Layout/Toolbar.tsx');
    expect(toolbar).toContain("{language === 'lv' ? 'LV' : 'EN'}");
    expect(toolbar).toContain("{isDark ? '☾' : '☼'}");
    expect(src('eval/LangSwitch.tsx')).toContain("{language === 'lv' ? 'LV' : 'EN'}");
  });

  it('the toolbar\'s own right-click menu leaves a setting button\'s list alone', () => {
    expect(src('components/Layout/Toolbar.tsx')).toMatch(/closest\('[^']*\.fs-setting'\)/);
  });

  it('Escape closes an open list before the dialog it sits in', () => {
    expect(src('intro/IntroWindow.tsx')).toContain('if (!closeSettingMenu()) close();');
    expect(src('eval/studyDialog.ts')).toContain('if (!closeSettingMenu()) onEscape?.();');
  });

  it('the list is drawn above every pane, but inside a dialog or a fullscreen pane', () => {
    // On the body, or the 3D view's split-pane seam is painted over it; in an
    // aria-modal dialog's own subtree, since a study dialog makes everything
    // outside it inert; in the fullscreen element, the only one drawn.
    const comp = src('components/inputs/SettingButton.tsx');
    expect(comp).toContain(`button.closest<HTMLElement>('[aria-modal="true"]') ?? pickPortalHost(fullscreenElement(), button, document.body)`);
    expect(comp).toMatch(/createPortal\([\s\S]*at\.host,\s*\)/);
    expect(src('components/inputs/SettingButton.css')).toMatch(/\.fs-setting__menu \{[^}]*position: fixed;/);
    // A press in the list never closes the popover its button sits in.
    expect(src('hooks/useDismiss.ts')).toContain(`closest?.('.fs-setting__menu')`);
  });

  it('the intro names its language switch, and only the intro', () => {
    expect(src('intro/IntroWindow.tsx')).toContain('<LangSwitch named />');
    for (const f of ['eval/ConsentModal.tsx', 'eval/SusModal.tsx', 'eval/EvalFinishModal.tsx', 'eval/DataDisclosureModal.tsx', 'tutorials/TutorialPanel.tsx']) {
      expect(src(f), f).not.toContain('<LangSwitch named');
    }
  });
});
