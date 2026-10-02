import { useAppStore } from '@/store/useAppStore';

/** The study dialogs' own EN/LV switch: they are modal, so the toolbar's button
 *  is unreachable behind the backdrop. It names the language it switches TO.
 *  `disabled` freezes it while the questionnaire packs its answers. */
export function LangSwitch({ disabled = false }: { disabled?: boolean }) {
  const lv = useAppStore((s) => s.language) === 'lv';
  const setLanguage = useAppStore((s) => s.setLanguage);
  return (
    <button
      type="button"
      className="csv-import-modal__button eval-consent__lang"
      disabled={disabled}
      onClick={() => setLanguage(lv ? 'en' : 'lv')}
      title={
        lv
          ? 'Pārslēgt uz angļu valodu (Switch to English)'
          : 'Pārslēgt uz latviešu valodu (Switch to Latvian)'
      }
      aria-label={lv ? 'Switch to English' : 'Pārslēgt uz latviešu valodu'}
    >
      {lv ? 'EN' : 'LV'}
    </button>
  );
}
