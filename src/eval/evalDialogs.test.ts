import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * The study dialogs share two rules that no single component can see broken
 * in another, so they are pinned here together (owner request, 2026-10-02).
 *
 * 1. A click OUTSIDE a study panel does nothing. The questionnaire is long and
 *    scrolls, so a scrollbar drag or a text selection released past the
 *    panel's edge lands its `click` on the backdrop; with a close handler there
 *    the form vanished mid-answer, and on the thank-you screen the Download
 *    and email buttons went with it. Each dialog closes through its own
 *    buttons (and Escape where it has a safe answer) only.
 * 2. Every study dialog carries its own EN/LV switch: they are modal, so the
 *    toolbar's button is out of reach behind the backdrop.
 * 3. Every study dialog goes through `useStudyDialog`: the app behind it is
 *    inert and every key but Tab is swallowed (studyDialog.ts says what got
 *    through before — a consent-less package among it).
 */
const DIALOGS: { file: string; screens: number }[] = [
  { file: './ConsentModal.tsx', screens: 1 },
  { file: './DataDisclosureModal.tsx', screens: 1 },
  { file: './EvalFinishModal.tsx', screens: 1 },
  // The questionnaire and its thank-you screen are two returns of one component.
  { file: './SusModal.tsx', screens: 2 },
];

/** Every opening tag whose className names the shared backdrop. */
const backdropTags = (src: string) =>
  [...src.matchAll(/<div\b[^>]*className="csv-import-modal__backdrop[^"]*"[^>]*>/g)].map((m) => m[0]);

describe('the study dialogs', () => {
  it.each(DIALOGS)('$file never closes on a click outside its panel', ({ file, screens }) => {
    const tags = backdropTags(read(file));
    expect(tags, 'no backdrop found — did the markup change shape?').toHaveLength(screens);
    for (const tag of tags) expect(tag).not.toMatch(/onClick|onPointerDown|onMouseDown/);
  });

  it.each(DIALOGS)('$file carries the language switch on every screen', ({ file, screens }) => {
    const src = read(file);
    expect(src).toMatch(/import \{ LangSwitch \} from '\.\/LangSwitch';/);
    expect(src.match(/<LangSwitch\b[^>]*\/>/g) ?? []).toHaveLength(screens);
  });

  it.each(DIALOGS)('$file goes through useStudyDialog, and nothing else listens for keys', ({ file }) => {
    const src = read(file);
    expect(src).toMatch(/import \{ useStudyDialog \} from '\.\/studyDialog';/);
    expect(src).toMatch(/useStudyDialog\(/);
    expect(src).not.toMatch(/useModalKeys\(|(window|document)\.addEventListener\('keydown'/);
  });
});

describe('useStudyDialog', () => {
  const helper = read('./studyDialog.ts');

  it('makes the app root inert while open, counted across overlapping dialogs', () => {
    // Keys alone left FOCUS free: Tab walked from the consent to EXPORT and a
    // package with no consent record was uploaded; Shift+Tab reached Monaco.
    expect(helper).toMatch(/document\.getElementById\('root'\)/);
    expect(helper).toMatch(/inertHolders \+= 1;\s*root\.inert = true;/);
    expect(helper).toMatch(/inertHolders -= 1;\s*if \(inertHolders === 0\) root\.inert = false;/);
  });

  it('swallows every key but Tab in the window capture phase, and prevents ⌘S', () => {
    // The canvas binds Delete/Backspace/X/A and ⌘Z on `window` (bubble); WINDOW
    // capture, not document, or a later dialog's listener (Details over the
    // consent) would never run. ⌘S: the code panel's handler that prevented
    // the browser's Save Page no longer sees the key.
    expect(helper).toMatch(/useModalKeys\(open, \(e\) => \{[\s\S]*?if \(e\.key !== 'Tab'\) e\.stopPropagation\(\);\s*\}, true\);/);
    expect(helper).toMatch(/if \(\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === 's'\) e\.preventDefault\(\);/);
    expect(helper).toMatch(/if \(e\.key === 'Escape'\) \{\s*e\.stopPropagation\(\);\s*onEscape\?\.\(\);/);
  });

  it('the consent is inert behind its Details dialog', () => {
    // Shift+Tab from Details landed on the hidden "I agree"; Enter recorded consent.
    expect(read('./ConsentModal.tsx')).toMatch(/panelRef\.current\.inert = showDisclosure;/);
  });

  it('the canvas keyboard navigation stands down while any modal is open', () => {
    // Its window-capture listener is registered before any dialog's, so no
    // dialog can swallow for it; focus on the page (after a click outside a
    // study dialog) is not INSIDE the dialog, so the target check missed it.
    const nav = read('../components/NodeEditor/useKeyboardNav.ts');
    expect(nav).toMatch(
      /const onKeyDown = \(e: KeyboardEvent\) => \{\s*if \(isTyping\(e\.target\)\) return;[\s\S]{0,120}document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)\) return;/,
    );
  });

  it('a tooltip still answers Escape on the consent, and never restores a stale title', () => {
    const tip = read('../components/Tooltip/TooltipLayer.tsx');
    expect(tip).toContain("window.addEventListener('keydown', onKeyDown, true);");
    expect(tip).not.toContain("document.addEventListener('keydown', onKeyDown, true);");
    expect(tip).toMatch(/host\.isConnected && !host\.hasAttribute\('title'\)\) \{/);
  });
});

describe('the questionnaire', () => {
  const sus = read('./SusModal.tsx');

  it('cannot be dismissed, or changed, while Submit packs the package', () => {
    // capturePreviewShot can take 4 s with nothing changing on screen; Escape
    // or "Back to the editor" then hid the dialog and the thank-you screen
    // (upload status, Email button) never appeared, and an answer changed
    // then was dropped while its language note was read late.
    expect(sus).toMatch(/useStudyDialog\(open, \(\) => \{\s*if \(!busy\) onClose\(\);/);
    expect(sus).toMatch(/disabled=\{busy\} onClick=\{onClose\}/);
    expect(sus).toMatch(/disabled=\{!complete \|\| busy\}/);
    expect(sus).toMatch(/setBusy\(true\);\s*try \{\s*await submitPackage\(\);/);
    expect(sus).toContain('<LangSwitch disabled={busy} />');
    // Every answer control: participant code, experience radios, the pro text
    // fields and radios, the SUS radios and the comment.
    expect((sus.match(/disabled=\{busy\}/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it('refuses to package a session that never consented', () => {
    expect(sus).toMatch(/if \(!isEvalSessionActive\(\)\) return;\s*submittingRef\.current = true;/);
  });

  it('records the language each SUS answer was given in, taken at the click', () => {
    expect(sus).toMatch(/onChange=\{\(\) => \{\s*susAnswerLangRef\.current\[i\] = language;/);
    expect(sus).toMatch(/language: answeredIn\.language,\s*languageAtSubmit: language,/);
    const snapshot = sus.indexOf('const answerLangs = susAnswerLangRef.current.slice();');
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(sus.indexOf('await capturePreviewShot()'));
    expect(sus).toContain('summarizeAnswerLanguages(answerLangs, language)');
  });

  it('builds the email draft at render, so its participant line follows a switch', () => {
    expect(sus).not.toContain('done.mailto');
    const doneBranch = sus.indexOf('if (done) {');
    const line = sus.indexOf(`t('Please attach the file "{file}" (in your Downloads folder) to this email, then press Send.', language)`);
    expect(doneBranch).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(doneBranch);
  });
});
