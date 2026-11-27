import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { useModalKeys } from '@/components/Modals/useModalKeys';
import '@/components/Modals/CsvImportModal.css';
import './AiPromptDialog.css';

/**
 * The prompt for ANOTHER AI, behind the code panel's frameless "?" (owner,
 * 2026-11-26): copy it into any AI chat, add what the shader should look like,
 * and paste the reply into the TSL panel, where Apply builds the graph — the
 * whole reply, since Apply reads the code out of its fence
 * (utils/replyProgram.ts).
 *
 * The text (src/llm/externalPrompt.ts) is loaded with import() when the
 * dialog opens, so nothing of src/llm/ rides the code panel's chunk. It is
 * English on purpose (the code is) and holds nothing of the user's graph or
 * files: only the node list, under the user's own optional-category switches.
 * Never offered in a study session (CodeEditor.tsx), and it logs nothing.
 */
export function AiPromptDialog({ onClose }: { onClose: () => void }) {
  const language = useAppStore((s) => s.language);
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([import('@/llm/catalogue'), import('@/llm/externalPrompt')])
      .then(([catalogue, prompt]) => {
        if (live) setText(prompt.externalPrompt(catalogue.buildCatalogue(useAppStore.getState().optionalCategories)));
      })
      // A chunk that cannot load leaves an empty box and Copy disabled.
      .catch(() => {
        if (live) setText('');
      });
    return () => {
      live = false;
    };
  }, []);

  // The text starts at its top, and the focus on Copy, once it is there.
  const ready = !!text;
  useEffect(() => {
    if (ready) copyRef.current?.focus();
  }, [ready]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard (an insecure context, a refusal): select the text, so
      // Ctrl+C / ⌘C copies it.
      areaRef.current?.focus();
      areaRef.current?.select();
    }
  }, [text]);

  // Keys stay in the dialog: Escape closes it, Tab walks only its own
  // controls (Shift+Tab out of the first must not reach the code panel behind
  // it), and nothing else reaches the app's shortcuts. A stopped key's own
  // action still happens, so Ctrl+A / Ctrl+C work in the text.
  useModalKeys(true, (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === -1 || at === items.length - 1 ? 0 : at + 1);
    e.preventDefault();
    items[to].focus();
  }, true);

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel ai-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-prompt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="ai-prompt-title">
          {t('TSL code from another AI', language)}
        </div>
        <ol className="ai-prompt__steps">
          <li>{t('Copy this text into an AI chat (ChatGPT, Claude, Gemini…).', language)}</li>
          <li>{t('Under it, write what the shader should look like.', language)}</li>
          <li>{t('Paste its reply into the TSL panel and press Apply.', language)}</li>
        </ol>
        {language === 'lv' && (
          <div className="csv-import-modal__message">
            {t('This text is in English, which every AI reads best. Your request can be in any language.', language)}
          </div>
        )}
        <textarea
          ref={areaRef}
          className="ai-prompt__text"
          readOnly
          lang="en"
          spellCheck={false}
          value={text ?? ''}
          aria-label={t('Text for the AI', language)}
        />
        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={onClose}>
            {t('Close', language)}
          </button>
          <button
            ref={copyRef}
            type="button"
            className="csv-import-modal__button csv-import-modal__button--primary"
            disabled={!text}
            onClick={copy}
          >
            {copied ? t('Copied', language) : t('Copy', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
