import { useEffect } from 'react';
import { useModalKeys } from '@/components/Modals/useModalKeys';

/**
 * What every study dialog shares — the consent, its Details, the finish
 * dialog, the questionnaire and its thank-you screen. Each is modal in the
 * strict sense: while it is open, nothing behind it may change, because
 * anything that does lands in the participant's package.
 *
 * 1. The app behind it is INERT (`#root.inert`; the dialogs are portals on
 *    `document.body`, outside it). Swallowing keys alone left focus free to
 *    leave the panel: Tab from the consent walked to EXPORT behind it, and
 *    Enter there opened the questionnaire before Agree, so a package with no
 *    consent record was downloaded AND uploaded; Shift+Tab from the
 *    questionnaire reached Monaco, where typing changed the packaged shader
 *    with nothing logged; Tab reached the canvas nodes, where arrows moved
 *    them. Ref-counted, since dialogs overlap (consent → Details, finish →
 *    questionnaire inside one commit).
 * 2. Every key but Tab stops in the WINDOW capture phase (fs-review §5): the
 *    canvas and the code panel bind Delete/Backspace/X/A, ⌘Z and ⌘S on
 *    `window`, and keys pressed on the page (focus on body after a click
 *    outside) still reach window listeners, inert or not. Default actions —
 *    typing, radio arrows, a text field's own undo — are untouched; ⌘S alone
 *    is prevented, since the code panel's handler that used to prevent it no
 *    longer sees it and the browser's Save Page would open over the study.
 * 3. Escape runs `onEscape` (when the dialog has a safe answer for it) and
 *    stops there too.
 */
let inertHolders = 0;

export function useStudyDialog(open: boolean, onEscape?: () => void): void {
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById('root');
    if (!root) return;
    inertHolders += 1;
    root.inert = true;
    return () => {
      inertHolders -= 1;
      if (inertHolders === 0) root.inert = false;
    };
  }, [open]);

  useModalKeys(open, (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onEscape?.();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') e.preventDefault();
    if (e.key !== 'Tab') e.stopPropagation();
  }, true);
}
